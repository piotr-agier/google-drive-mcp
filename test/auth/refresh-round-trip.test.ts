import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { AccountStore } from '../../src/auth/accountStore.js';
import { AccountClientFactory } from '../../src/auth/accountClientFactory.js';
import type { AccountRecord } from '../../src/auth/types.js';

// ---------------------------------------------------------------------------
// Token-refresh round-trip.
//
// AccountClientFactory wires a `'tokens'` listener on every per-alias
// OAuth2Client. When Google's library emits that event after a refresh, the
// listener must merge the new credentials with the existing record (especially
// preserving `refreshToken`, which Google rarely rotates) and persist back to
// AccountStore. This test drives that path with a real OAuth2Client (no
// network) by emitting the event manually.
// ---------------------------------------------------------------------------

async function setupTmpCredentials(): Promise<{
  tokenPath: string;
  credsPath: string;
  cleanup: () => Promise<void>;
  saved: Record<string, string | undefined>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-mcp-refresh-'));
  const tokenPath = path.join(dir, 'tokens.json');
  const credsPath = path.join(dir, 'gcp-oauth.keys.json');

  // Minimal valid credentials file — only client_id is needed for OAuth2Client
  // construction; no network is hit during this test.
  await fs.writeFile(
    credsPath,
    JSON.stringify({
      installed: {
        client_id: 'test-client-id.apps.googleusercontent.com',
        client_secret: 'test-client-secret',
        redirect_uris: ['http://localhost:3000/oauth2callback'],
      },
    }),
  );

  const saved = {
    GOOGLE_DRIVE_MCP_TOKEN_PATH: process.env.GOOGLE_DRIVE_MCP_TOKEN_PATH,
    GOOGLE_DRIVE_OAUTH_CREDENTIALS: process.env.GOOGLE_DRIVE_OAUTH_CREDENTIALS,
  };
  process.env.GOOGLE_DRIVE_MCP_TOKEN_PATH = tokenPath;
  process.env.GOOGLE_DRIVE_OAUTH_CREDENTIALS = credsPath;

  const cleanup = async () => {
    if (saved.GOOGLE_DRIVE_MCP_TOKEN_PATH === undefined)
      delete process.env.GOOGLE_DRIVE_MCP_TOKEN_PATH;
    else process.env.GOOGLE_DRIVE_MCP_TOKEN_PATH = saved.GOOGLE_DRIVE_MCP_TOKEN_PATH;
    if (saved.GOOGLE_DRIVE_OAUTH_CREDENTIALS === undefined)
      delete process.env.GOOGLE_DRIVE_OAUTH_CREDENTIALS;
    else process.env.GOOGLE_DRIVE_OAUTH_CREDENTIALS = saved.GOOGLE_DRIVE_OAUTH_CREDENTIALS;
  };

  return { tokenPath, credsPath, cleanup, saved };
}

function makeRecord(overrides: Partial<AccountRecord> = {}): AccountRecord {
  const now = new Date().toISOString();
  return {
    alias: 'work',
    email: 'work@example.com',
    sub: 'sub-work',
    accessToken: 'old-access',
    refreshToken: 'persistent-refresh',
    scope: 'https://www.googleapis.com/auth/drive',
    tokenType: 'Bearer',
    expiryDate: Date.now() - 60_000, // already expired so refresh logic could fire
    addedAt: now,
    lastRefreshedAt: now,
    ...overrides,
  };
}

/** Wait until `predicate()` returns truthy or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

test('factory persists new access_token from a "tokens" event into AccountStore', async () => {
  const { tokenPath, cleanup } = await setupTmpCredentials();
  try {
    const store = new AccountStore({ filePath: tokenPath, mode: 'local-oauth' });
    await store.reload();
    await store.upsert(makeRecord());

    const factory = new AccountClientFactory(store);
    const client = await factory.getClient('work');

    // Synthesize a refresh-event with a new access_token but no refresh_token
    // (Google's typical case — the existing refresh token must be preserved).
    const newAccess = `new-access-${Date.now()}`;
    const newExpiry = Date.now() + 3600_000;
    client.emit('tokens', {
      access_token: newAccess,
      expiry_date: newExpiry,
      // No refresh_token — must NOT clobber the existing one.
    });

    await waitFor(() => store.get('work')?.accessToken === newAccess);

    const updated = store.get('work')!;
    assert.equal(updated.accessToken, newAccess);
    assert.equal(updated.expiryDate, newExpiry);
    assert.equal(updated.refreshToken, 'persistent-refresh');
    assert.notEqual(updated.lastRefreshedAt, makeRecord().lastRefreshedAt);

    // File on disk reflects the change too.
    const onDisk = JSON.parse(await fs.readFile(tokenPath, 'utf-8'));
    assert.equal(onDisk.accounts.work.accessToken, newAccess);
    assert.equal(onDisk.accounts.work.refreshToken, 'persistent-refresh');
  } finally {
    await cleanup();
  }
});

test('factory accepts a rotated refresh_token when Google does send one', async () => {
  const { tokenPath, cleanup } = await setupTmpCredentials();
  try {
    const store = new AccountStore({ filePath: tokenPath, mode: 'local-oauth' });
    await store.reload();
    await store.upsert(makeRecord());

    const factory = new AccountClientFactory(store);
    const client = await factory.getClient('work');

    client.emit('tokens', {
      access_token: 'rotated-access',
      refresh_token: 'rotated-refresh',
      expiry_date: Date.now() + 3600_000,
    });

    await waitFor(() => store.get('work')?.refreshToken === 'rotated-refresh');
    assert.equal(store.get('work')!.accessToken, 'rotated-access');
  } finally {
    await cleanup();
  }
});

test('factory caches the same OAuth2Client for the same alias across calls', async () => {
  const { tokenPath, cleanup } = await setupTmpCredentials();
  try {
    const store = new AccountStore({ filePath: tokenPath, mode: 'local-oauth' });
    await store.reload();
    await store.upsert(makeRecord());

    const factory = new AccountClientFactory(store);
    const a = await factory.getClient('work');
    const b = await factory.getClient('work');
    assert.equal(a, b, 'same alias should yield the same cached client instance');
  } finally {
    await cleanup();
  }
});

test('factory yields distinct OAuth2Client instances for distinct aliases', async () => {
  const { tokenPath, cleanup } = await setupTmpCredentials();
  try {
    const store = new AccountStore({ filePath: tokenPath, mode: 'local-oauth' });
    await store.reload();
    await store.upsert(makeRecord({ alias: 'work' }));
    await store.upsert(makeRecord({ alias: 'personal', sub: 'sub-personal', refreshToken: 'rt-personal' }));

    const factory = new AccountClientFactory(store);
    const work = await factory.getClient('work');
    const personal = await factory.getClient('personal');
    assert.notEqual(work, personal, 'distinct aliases must yield distinct clients');
  } finally {
    await cleanup();
  }
});

test('factory.evict drops the cached client so the next getClient rebuilds', async () => {
  const { tokenPath, cleanup } = await setupTmpCredentials();
  try {
    const store = new AccountStore({ filePath: tokenPath, mode: 'local-oauth' });
    await store.reload();
    await store.upsert(makeRecord());

    const factory = new AccountClientFactory(store);
    const before = await factory.getClient('work');
    factory.evict('work');
    const after = await factory.getClient('work');
    assert.notEqual(before, after, 'evict should force a fresh client on next getClient');
  } finally {
    await cleanup();
  }
});

test('factory surfaces invalid_grant as an actionable reconnect error (finding 5)', async () => {
  const { tokenPath, cleanup } = await setupTmpCredentials();
  try {
    const store = new AccountStore({ filePath: tokenPath, mode: 'local-oauth' });
    await store.reload();
    // Future expiry so the first getClient does NOT trigger a refresh.
    await store.upsert(makeRecord({ expiryDate: Date.now() + 3600_000 }));

    const factory = new AccountClientFactory(store);
    const client = await factory.getClient('work');

    // Make the cached client look expired and its refresh fail with invalid_grant.
    client.setCredentials({ ...client.credentials, expiry_date: Date.now() - 60_000 });
    (client as unknown as { refreshAccessToken: () => Promise<never> }).refreshAccessToken =
      async () => {
        const err = new Error('invalid_grant') as Error & {
          response?: { data?: { error?: string } };
        };
        err.response = { data: { error: 'invalid_grant' } };
        throw err;
      };

    await assert.rejects(
      () => factory.getClient('work'),
      (err: Error) => {
        assert.match(err.message, /revoked or has expired/);
        assert.match(err.message, /manage_accounts add work/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});
