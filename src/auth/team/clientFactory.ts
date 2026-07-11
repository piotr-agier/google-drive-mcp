// ---------------------------------------------------------------------------
// TeamClientFactory — per-user (per-sub) Google client cache for team mode.
//
// Mirrors AccountClientFactory's proven mechanics (tokens-listener
// persistence, in-flight refresh dedupe, refresh buffer, invalid_grant
// detection) but keys everything by the bearer's Google `sub` and persists
// rotated tokens into the TeamStore — never into tokens.json. Keeping these
// caches inside the factory (rather than the module-level alias-keyed maps in
// index.ts) is what guarantees one user's clients can never collide with
// another's or with a local account alias.
// ---------------------------------------------------------------------------

import { OAuth2Client } from 'google-auth-library';
import { calendar_v3, drive_v3, google } from 'googleapis';
import { describeErrorForLog } from '../utils.js';
import { TeamStore, TeamUserRecord } from './types.js';

/** Buffer before access-token expiry that triggers a refresh (ms). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function isInvalidGrant(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { response?: { data?: { error?: unknown } }; message?: unknown };
  if (e.response?.data?.error === 'invalid_grant') return true;
  return typeof e.message === 'string' && e.message.includes('invalid_grant');
}

function reauthErrorMessage(email: string): string {
  return (
    `Your Google authorization for ${email} has expired or been revoked. ` +
    `Reconnect this connector (in claude.ai: Settings → Connectors → reconnect) to sign in again.`
  );
}

export class TeamClientFactory {
  private clients = new Map<string, OAuth2Client>();
  private drives = new Map<string, drive_v3.Drive>();
  private calendars = new Map<string, calendar_v3.Calendar>();
  private inflightRefresh = new Map<string, Promise<void>>();

  constructor(
    private readonly store: TeamStore,
    private readonly credentials: { client_id: string; client_secret: string },
  ) {}

  async getClient(sub: string): Promise<OAuth2Client> {
    const user = await this.store.getUser(sub);
    if (!user) {
      throw new Error(
        'Your team sign-in is no longer on file on this server. Reconnect this connector to sign in again.',
      );
    }
    if (user.needsReauth || !user.googleRefreshToken) {
      throw new Error(reauthErrorMessage(user.email));
    }
    const client = this.ensureClient(sub, user);
    await this.refreshIfNeeded(sub, client, user);
    return client;
  }

  async getDrive(sub: string): Promise<drive_v3.Drive> {
    const auth = await this.getClient(sub);
    let drive = this.drives.get(sub);
    if (!drive) {
      drive = google.drive({ version: 'v3', auth });
      this.drives.set(sub, drive);
    }
    return drive;
  }

  async getCalendar(sub: string): Promise<calendar_v3.Calendar> {
    const auth = await this.getClient(sub);
    let calendar = this.calendars.get(sub);
    if (!calendar) {
      calendar = google.calendar({ version: 'v3', auth });
      this.calendars.set(sub, calendar);
    }
    return calendar;
  }

  /** Drop every cached object for a user (re-auth, revocation, removal). */
  evict(sub: string): void {
    this.clients.delete(sub);
    this.drives.delete(sub);
    this.calendars.delete(sub);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private ensureClient(sub: string, user: TeamUserRecord): OAuth2Client {
    const existing = this.clients.get(sub);
    if (existing) return existing;

    const client = new OAuth2Client({
      clientId: this.credentials.client_id,
      clientSecret: this.credentials.client_secret,
    });
    client.setCredentials({
      access_token: user.googleAccessToken || undefined,
      refresh_token: user.googleRefreshToken,
      expiry_date: user.googleTokenExpiry || undefined,
      scope: user.grantedScopes.join(' ') || undefined,
      token_type: 'Bearer',
    });

    client.on('tokens', (newCreds) => {
      // Fire-and-forget: the library emits synchronously mid-request; persist
      // through the store's write queue. Never log the raw error (gaxios
      // embeds token material in err.config).
      this.persistRefreshedTokens(sub, newCreds).catch((err) => {
        console.error(
          `[team-auth] Failed to persist refreshed Google tokens: ${describeErrorForLog(err)}`,
        );
      });
    });

    this.clients.set(sub, client);
    return client;
  }

  private async refreshIfNeeded(
    sub: string,
    client: OAuth2Client,
    user: TeamUserRecord,
  ): Promise<void> {
    const expiry = client.credentials.expiry_date ?? user.googleTokenExpiry;
    const needsRefresh = expiry
      ? Date.now() >= expiry - REFRESH_BUFFER_MS
      : !client.credentials.access_token;
    if (!needsRefresh) return;

    const inflight = this.inflightRefresh.get(sub);
    if (inflight) return inflight;

    const p = (async () => {
      try {
        const { credentials } = await client.refreshAccessToken();
        if (!credentials.access_token) {
          throw new Error('Token refresh returned no access_token.');
        }
      } catch (err) {
        if (isInvalidGrant(err)) {
          await this.handleRevokedGrant(sub, user);
          throw new Error(reauthErrorMessage(user.email));
        }
        console.error(`[team-auth] Google token refresh failed: ${describeErrorForLog(err)}`);
        // Transient failure — let the caller's API call surface it.
      }
    })().finally(() => {
      this.inflightRefresh.delete(sub);
    });
    this.inflightRefresh.set(sub, p);
    return p;
  }

  /**
   * The user's Google grant is dead. Flag the record, drop their MCP tokens so
   * the next request 401s (which makes the MCP client re-run the OAuth flow —
   * the self-healing path), and evict the stale clients.
   */
  private async handleRevokedGrant(sub: string, user: TeamUserRecord): Promise<void> {
    try {
      await this.store.upsertUser({
        ...user,
        googleAccessToken: undefined,
        googleTokenExpiry: undefined,
        needsReauth: true,
        updatedAt: new Date().toISOString(),
      });
      await this.store.revokeTokensForSub(sub);
    } catch (err) {
      console.error(
        `[team-auth] Failed to flag revoked grant for ${user.email}: ${describeErrorForLog(err)}`,
      );
    }
    this.evict(sub);
  }

  private async persistRefreshedTokens(
    sub: string,
    newCreds: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null; scope?: string },
  ): Promise<void> {
    const current = await this.store.getUser(sub);
    if (!current) return; // user removed while a refresh was in flight
    await this.store.upsertUser({
      ...current,
      googleAccessToken: newCreds.access_token ?? current.googleAccessToken,
      googleRefreshToken: newCreds.refresh_token ?? current.googleRefreshToken,
      googleTokenExpiry: newCreds.expiry_date ?? current.googleTokenExpiry,
      grantedScopes: newCreds.scope ? newCreds.scope.split(/\s+/).filter(Boolean) : current.grantedScopes,
      updatedAt: new Date().toISOString(),
    });
  }
}
