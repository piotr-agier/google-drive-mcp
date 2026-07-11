// ---------------------------------------------------------------------------
// In-memory TeamStore. Also the base class for FileTeamStore: every durable
// mutation is routed through `mutateDurable`, which the file store overrides
// to serialize through its write queue. Pending authorizations and
// authorization codes are in-memory in BOTH implementations — their single-use
// `consume*` operations are a synchronous Map get+delete, which is what makes
// them atomic (no await between check and removal).
// ---------------------------------------------------------------------------

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  AccessTokenRecord,
  AuthorizationCodeRecord,
  DEFAULT_TEAM_STORE_CAPS,
  MAX_CHALLENGE_LOOKUPS,
  PendingAuthorization,
  RefreshTokenRecord,
  TeamStore,
  TeamStoreCapacityError,
  TeamStoreCaps,
  TeamUserRecord,
} from './types.js';

export class InMemoryTeamStore implements TeamStore {
  protected clients = new Map<string, OAuthClientInformationFull>();
  protected users = new Map<string, TeamUserRecord>();
  protected accessTokens = new Map<string, AccessTokenRecord>();
  protected refreshTokens = new Map<string, RefreshTokenRecord>();
  protected readonly caps: TeamStoreCaps;

  private pendingAuthorizations = new Map<string, PendingAuthorization>();
  private authorizationCodes = new Map<string, AuthorizationCodeRecord>();

  constructor(opts: { caps?: Partial<TeamStoreCaps> } = {}) {
    this.caps = { ...DEFAULT_TEAM_STORE_CAPS, ...opts.caps };
  }

  async init(): Promise<void> {
    // Nothing to load.
  }

  /**
   * Run a mutation of the durable sections (clients/users/tokens). The file
   * store overrides this to wrap the mutation in its serialized
   * merge-from-disk → mutate → atomic-write cycle; here it just runs.
   */
  protected async mutateDurable<T>(mutate: () => T): Promise<T> {
    return mutate();
  }

  // -------------------------------------------------------------------------
  // Registered clients (DCR)
  // -------------------------------------------------------------------------

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async saveClient(client: OAuthClientInformationFull): Promise<void> {
    await this.mutateDurable(() => {
      if (!this.clients.has(client.client_id) && this.clients.size >= this.caps.maxClients) {
        throw new TeamStoreCapacityError('registered clients', this.caps.maxClients);
      }
      this.clients.set(client.client_id, client);
    });
  }

  // -------------------------------------------------------------------------
  // Pending authorizations (in-memory only)
  // -------------------------------------------------------------------------

  async savePendingAuthorization(pending: PendingAuthorization): Promise<void> {
    if (this.pendingAuthorizations.size >= this.caps.maxPendingAuthorizations) {
      // Expired entries don't count against a live flow; drop them first.
      this.sweepPendingAndCodes(Date.now());
    }
    if (this.pendingAuthorizations.size >= this.caps.maxPendingAuthorizations) {
      throw new TeamStoreCapacityError(
        'pending authorizations',
        this.caps.maxPendingAuthorizations,
      );
    }
    this.pendingAuthorizations.set(pending.googleState, pending);
  }

  async consumePendingAuthorization(googleState: string): Promise<PendingAuthorization | undefined> {
    const pending = this.pendingAuthorizations.get(googleState);
    if (!pending) return undefined;
    this.pendingAuthorizations.delete(googleState);
    return pending.expiresAt > Date.now() ? pending : undefined;
  }

  // -------------------------------------------------------------------------
  // Authorization codes (in-memory only)
  // -------------------------------------------------------------------------

  async saveAuthorizationCode(code: AuthorizationCodeRecord): Promise<void> {
    this.authorizationCodes.set(code.codeHash, code);
  }

  async peekAuthorizationCode(codeHash: string): Promise<AuthorizationCodeRecord | undefined> {
    const code = this.authorizationCodes.get(codeHash);
    if (!code) return undefined;
    if (code.expiresAt <= Date.now()) {
      this.authorizationCodes.delete(codeHash);
      return undefined;
    }
    code.challengeLookups += 1;
    if (code.challengeLookups > MAX_CHALLENGE_LOOKUPS) {
      this.authorizationCodes.delete(codeHash);
      return undefined;
    }
    return code;
  }

  async consumeAuthorizationCode(codeHash: string): Promise<AuthorizationCodeRecord | undefined> {
    const code = this.authorizationCodes.get(codeHash);
    if (!code) return undefined;
    this.authorizationCodes.delete(codeHash);
    return code.expiresAt > Date.now() ? code : undefined;
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async getUser(sub: string): Promise<TeamUserRecord | undefined> {
    return this.users.get(sub);
  }

  async upsertUser(user: TeamUserRecord): Promise<void> {
    await this.mutateDurable(() => {
      if (!this.users.has(user.sub) && this.users.size >= this.caps.maxUsers) {
        throw new TeamStoreCapacityError('team users', this.caps.maxUsers);
      }
      this.users.set(user.sub, user);
    });
  }

  // -------------------------------------------------------------------------
  // MCP tokens
  // -------------------------------------------------------------------------

  async saveAccessToken(token: AccessTokenRecord): Promise<void> {
    await this.mutateDurable(() => {
      this.evictOldestIfAtCap(this.accessTokens, token.sub, (t) => t.expiresAt);
      this.accessTokens.set(token.tokenHash, token);
    });
  }

  async getAccessToken(tokenHash: string): Promise<AccessTokenRecord | undefined> {
    return this.accessTokens.get(tokenHash);
  }

  async deleteAccessToken(tokenHash: string): Promise<void> {
    await this.mutateDurable(() => {
      this.accessTokens.delete(tokenHash);
    });
  }

  async saveRefreshToken(token: RefreshTokenRecord): Promise<void> {
    await this.mutateDurable(() => {
      this.evictOldestIfAtCap(
        this.refreshTokens,
        token.sub,
        (t) => t.createdAt,
        (t) => t.supersededByHash === undefined,
      );
      this.refreshTokens.set(token.tokenHash, token);
    });
  }

  async getRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | undefined> {
    return this.refreshTokens.get(tokenHash);
  }

  async updateRefreshToken(token: RefreshTokenRecord): Promise<void> {
    await this.mutateDurable(() => {
      this.refreshTokens.set(token.tokenHash, token);
    });
  }

  async revokeTokensForSub(sub: string): Promise<void> {
    await this.mutateDurable(() => {
      for (const [hash, token] of this.accessTokens) {
        if (token.sub === sub) this.accessTokens.delete(hash);
      }
      for (const [hash, token] of this.refreshTokens) {
        if (token.sub === sub) this.refreshTokens.delete(hash);
      }
    });
  }

  async revokeTokenFamily(familyId: string): Promise<void> {
    await this.mutateDurable(() => {
      for (const [hash, token] of this.accessTokens) {
        if (token.familyId === familyId) this.accessTokens.delete(hash);
      }
      for (const [hash, token] of this.refreshTokens) {
        if (token.familyId === familyId) this.refreshTokens.delete(hash);
      }
    });
  }

  async sweepExpired(now: number = Date.now()): Promise<void> {
    this.sweepPendingAndCodes(now);
    await this.mutateDurable(() => {
      for (const [hash, token] of this.accessTokens) {
        if (token.expiresAt <= now) this.accessTokens.delete(hash);
      }
      // Superseded refresh tokens are kept until expiresAt as reuse-detection
      // tombstones (post-grace reuse must still trigger family revocation).
      for (const [hash, token] of this.refreshTokens) {
        if (token.expiresAt <= now) this.refreshTokens.delete(hash);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private sweepPendingAndCodes(now: number): void {
    for (const [state, pending] of this.pendingAuthorizations) {
      if (pending.expiresAt <= now) this.pendingAuthorizations.delete(state);
    }
    for (const [hash, code] of this.authorizationCodes) {
      if (code.expiresAt <= now) this.authorizationCodes.delete(hash);
    }
  }

  /** Evict the caller's oldest token when their per-sub cap is reached, so one
   * reconnect-looping client cannot grow the store without bound. */
  private evictOldestIfAtCap<T extends { sub: string }>(
    map: Map<string, T>,
    sub: string,
    ageOf: (token: T) => number,
    counts: (token: T) => boolean = () => true,
  ): void {
    let count = 0;
    let oldestHash: string | undefined;
    let oldestAge = Infinity;
    for (const [hash, token] of map) {
      if (token.sub !== sub || !counts(token)) continue;
      count += 1;
      const age = ageOf(token);
      if (age < oldestAge) {
        oldestAge = age;
        oldestHash = hash;
      }
    }
    if (count >= this.caps.maxTokensPerSub && oldestHash !== undefined) {
      map.delete(oldestHash);
    }
  }
}
