import assert from 'node:assert/strict';
import test from 'node:test';

import { InvalidGrantError, InvalidScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Response } from 'express';

import type { TeamConfig } from '../../src/auth/team/config.js';
import type { GoogleIdp, GoogleTokenResult } from '../../src/auth/team/googleIdp.js';
import { InMemoryTeamStore } from '../../src/auth/team/memoryStore.js';
import { TeamOAuthProvider } from '../../src/auth/team/provider.js';
import { sha256Hex } from '../../src/auth/team/tokens.js';
import type { TeamUserRecord } from '../../src/auth/team/types.js';

// ---------------------------------------------------------------------------
// TeamOAuthProvider unit tests — the checks the SDK deliberately leaves to the
// provider: code↔client binding, redirect_uri equality at exchange, single-use
// codes, refresh rotation with reuse detection, and seconds-based expiry.
// ---------------------------------------------------------------------------

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';

function makeConfig(overrides: Partial<TeamConfig> = {}): TeamConfig {
  return {
    issuerUrl: new URL('http://127.0.0.1:3100'),
    googleRedirectUri: 'http://127.0.0.1:3100/oauth/google/callback',
    allowedDomains: [],
    allowedRedirectUris: [],
    tokenTtlMs: 3600_000,
    store: 'memory',
    storePath: '/unused',
    allowedHosts: ['127.0.0.1'],
    googleScopes: [DRIVE_SCOPE, DOCS_SCOPE, 'openid'],
    advertisedScopes: [DRIVE_SCOPE, DOCS_SCOPE],
    ...overrides,
  };
}

class FakeIdp implements GoogleIdp {
  buildConsentUrl(state: string): string {
    return `https://fake-google.example/consent?state=${encodeURIComponent(state)}`;
  }
  async exchangeCode(): Promise<GoogleTokenResult> {
    throw new Error('not used in provider tests');
  }
  async revokeGrant(): Promise<void> {}
}

const CLIENT_A: OAuthClientInformationFull = {
  client_id: 'client-a',
  redirect_uris: ['https://client-a.example/cb'],
};
const CLIENT_B: OAuthClientInformationFull = {
  client_id: 'client-b',
  redirect_uris: ['https://client-b.example/cb'],
};

function makeUser(sub: string): TeamUserRecord {
  const now = new Date().toISOString();
  return {
    sub,
    email: `${sub}@example.com`,
    googleRefreshToken: `g-rt-${sub}`,
    grantedScopes: [DRIVE_SCOPE],
    createdAt: now,
    updatedAt: now,
  };
}

interface Harness {
  store: InMemoryTeamStore;
  provider: TeamOAuthProvider;
}

function makeHarness(configOverrides: Partial<TeamConfig> = {}): Harness {
  const store = new InMemoryTeamStore();
  const provider = new TeamOAuthProvider({
    store,
    idp: new FakeIdp(),
    config: makeConfig(configOverrides),
  });
  return { store, provider };
}

/** Drive authorize() and return the state we sent to Google. */
async function authorize(
  h: Harness,
  opts: { client?: OAuthClientInformationFull; scopes?: string[]; state?: string } = {},
): Promise<string> {
  let redirectedTo: string | undefined;
  const res = { redirect: (url: string) => void (redirectedTo = url) } as unknown as Response;
  await h.provider.authorize(
    opts.client ?? CLIENT_A,
    {
      state: opts.state ?? 'client-state-1',
      scopes: opts.scopes,
      codeChallenge: 'challenge-1',
      redirectUri: (opts.client ?? CLIENT_A).redirect_uris[0],
    },
    res,
  );
  assert.ok(redirectedTo!.startsWith('https://fake-google.example/consent?state='));
  return new URL(redirectedTo!).searchParams.get('state')!;
}

/** Complete the Google leg by hand: consume pending, mint a code record. */
async function mintCode(
  h: Harness,
  googleState: string,
  sub = 'sub-1',
): Promise<{ raw: string; sub: string }> {
  const pending = await h.store.consumePendingAuthorization(googleState);
  assert.ok(pending, 'pending authorization must exist');
  await h.store.upsertUser(makeUser(sub));
  const raw = `test-code-${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  await h.store.saveAuthorizationCode({
    codeHash: sha256Hex(raw),
    clientId: pending.clientId,
    sub,
    codeChallenge: pending.codeChallenge,
    redirectUri: pending.redirectUri,
    scopes: pending.scopes,
    resource: pending.resource,
    createdAt: now,
    expiresAt: now + 60_000,
    challengeLookups: 0,
  });
  return { raw, sub };
}

test('authorize stores the pending request and defaults scopes to the configured set', async () => {
  const h = makeHarness();
  const googleState = await authorize(h);
  const pending = await h.store.consumePendingAuthorization(googleState);
  assert.ok(pending);
  assert.equal(pending.clientId, 'client-a');
  assert.equal(pending.clientState, 'client-state-1');
  assert.equal(pending.codeChallenge, 'challenge-1');
  assert.deepEqual(pending.scopes, [DRIVE_SCOPE, DOCS_SCOPE]);
});

test('authorize intersects requested scopes with the configured set', async () => {
  const h = makeHarness();
  const googleState = await authorize(h, { scopes: [DRIVE_SCOPE, 'https://evil.example/scope'] });
  const pending = await h.store.consumePendingAuthorization(googleState);
  assert.deepEqual(pending!.scopes, [DRIVE_SCOPE]);
});

test('authorize rejects a request with no supported scopes', async () => {
  const h = makeHarness();
  await assert.rejects(
    () => authorize(h, { scopes: ['https://evil.example/scope'] }),
    InvalidScopeError,
  );
});

test('challengeForAuthorizationCode returns the stored challenge only to the owning client', async () => {
  const h = makeHarness();
  const { raw } = await mintCode(h, await authorize(h));
  assert.equal(await h.provider.challengeForAuthorizationCode(CLIENT_A, raw), 'challenge-1');
  await assert.rejects(
    () => h.provider.challengeForAuthorizationCode(CLIENT_B, raw),
    InvalidGrantError,
  );
});

test('exchangeAuthorizationCode mints a token pair and the code is single-use', async () => {
  const h = makeHarness();
  const { raw } = await mintCode(h, await authorize(h));

  const tokens = await h.provider.exchangeAuthorizationCode(
    CLIENT_A,
    raw,
    undefined,
    CLIENT_A.redirect_uris[0],
  );
  assert.ok(tokens.access_token.startsWith('mcp_at_'));
  assert.ok(tokens.refresh_token!.startsWith('mcp_rt_'));
  assert.equal(tokens.expires_in, 3600);
  assert.equal(tokens.scope, `${DRIVE_SCOPE} ${DOCS_SCOPE}`);

  await assert.rejects(
    () => h.provider.exchangeAuthorizationCode(CLIENT_A, raw, undefined, CLIENT_A.redirect_uris[0]),
    InvalidGrantError,
  );
});

test('exchangeAuthorizationCode rejects a code minted for another client', async () => {
  const h = makeHarness();
  const { raw } = await mintCode(h, await authorize(h));
  await assert.rejects(
    () => h.provider.exchangeAuthorizationCode(CLIENT_B, raw, undefined, CLIENT_A.redirect_uris[0]),
    InvalidGrantError,
  );
  // The failed attempt consumed the code: the legitimate client is locked out
  // too, which is the correct fail-closed behavior for a phished code.
  await assert.rejects(
    () => h.provider.exchangeAuthorizationCode(CLIENT_A, raw, undefined, CLIENT_A.redirect_uris[0]),
    InvalidGrantError,
  );
});

test('exchangeAuthorizationCode re-validates redirect_uri against the authorization request', async () => {
  const h = makeHarness();
  const { raw } = await mintCode(h, await authorize(h));
  await assert.rejects(
    () =>
      h.provider.exchangeAuthorizationCode(CLIENT_A, raw, undefined, 'https://attacker.example/cb'),
    InvalidGrantError,
  );
});

test('verifyAccessToken returns AuthInfo with seconds-based expiry and the user identity', async () => {
  const h = makeHarness();
  const { raw, sub } = await mintCode(h, await authorize(h));
  const tokens = await h.provider.exchangeAuthorizationCode(
    CLIENT_A,
    raw,
    undefined,
    CLIENT_A.redirect_uris[0],
  );

  const info = await h.provider.verifyAccessToken(tokens.access_token);
  assert.equal(info.clientId, 'client-a');
  assert.deepEqual(info.scopes, [DRIVE_SCOPE, DOCS_SCOPE]);
  assert.equal(info.extra?.sub, sub);
  assert.equal(info.extra?.email, `${sub}@example.com`);
  // requireBearerAuth compares expiresAt against Date.now()/1000: a
  // milliseconds value (>= 1e11 for any modern date) would never expire.
  assert.ok(typeof info.expiresAt === 'number' && info.expiresAt < 1e11, 'expiresAt must be SECONDS');
  assert.ok(info.expiresAt! > Date.now() / 1000);
});

test('verifyAccessToken rejects unknown tokens, expired tokens, and needsReauth users', async () => {
  const h = makeHarness();
  await assert.rejects(() => h.provider.verifyAccessToken('mcp_at_bogus'), InvalidTokenError);

  const { raw, sub } = await mintCode(h, await authorize(h));
  const tokens = await h.provider.exchangeAuthorizationCode(
    CLIENT_A,
    raw,
    undefined,
    CLIENT_A.redirect_uris[0],
  );

  // Google grant died between mint and use: the token must stop working.
  await h.store.upsertUser({ ...makeUser(sub), needsReauth: true });
  await assert.rejects(() => h.provider.verifyAccessToken(tokens.access_token), InvalidTokenError);

  // Expired token: reject and forget.
  await h.store.upsertUser(makeUser(sub));
  const record = await h.store.getAccessToken(sha256Hex(tokens.access_token));
  await h.store.saveAccessToken({ ...record!, expiresAt: Date.now() - 1 });
  await assert.rejects(() => h.provider.verifyAccessToken(tokens.access_token), InvalidTokenError);
});

async function mintPair(h: Harness) {
  const { raw, sub } = await mintCode(h, await authorize(h));
  const tokens = await h.provider.exchangeAuthorizationCode(
    CLIENT_A,
    raw,
    undefined,
    CLIENT_A.redirect_uris[0],
  );
  return { tokens, sub };
}

test('exchangeRefreshToken rotates: new pair works, old token stays valid within the grace window', async () => {
  const h = makeHarness();
  const { tokens } = await mintPair(h);

  const rotated = await h.provider.exchangeRefreshToken(CLIENT_A, tokens.refresh_token!);
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  await h.provider.verifyAccessToken(rotated.access_token);

  // A client that lost the rotation response may retry with the old token.
  const retried = await h.provider.exchangeRefreshToken(CLIENT_A, tokens.refresh_token!);
  assert.ok(retried.access_token);
});

test('refresh-token reuse after the grace window revokes the whole family', async () => {
  const h = makeHarness();
  const { tokens } = await mintPair(h);

  const rotated = await h.provider.exchangeRefreshToken(CLIENT_A, tokens.refresh_token!);

  // Force the tombstone past its grace window.
  const oldRecord = await h.store.getRefreshToken(sha256Hex(tokens.refresh_token!));
  await h.store.updateRefreshToken({ ...oldRecord!, graceUntil: Date.now() - 1 });

  await assert.rejects(
    () => h.provider.exchangeRefreshToken(CLIENT_A, tokens.refresh_token!),
    InvalidGrantError,
  );
  // Theft response: the successor tokens die with the family.
  await assert.rejects(() => h.provider.verifyAccessToken(rotated.access_token), InvalidTokenError);
  await assert.rejects(
    () => h.provider.exchangeRefreshToken(CLIENT_A, rotated.refresh_token!),
    InvalidGrantError,
  );
});

test('exchangeRefreshToken allows scope narrowing but rejects expansion, and checks the client', async () => {
  const h = makeHarness();
  const { tokens } = await mintPair(h);

  await assert.rejects(
    () => h.provider.exchangeRefreshToken(CLIENT_B, tokens.refresh_token!),
    InvalidGrantError,
  );

  const narrowed = await h.provider.exchangeRefreshToken(CLIENT_A, tokens.refresh_token!, [
    DRIVE_SCOPE,
  ]);
  assert.equal(narrowed.scope, DRIVE_SCOPE);

  await assert.rejects(
    () =>
      h.provider.exchangeRefreshToken(CLIENT_A, narrowed.refresh_token!, [
        DRIVE_SCOPE,
        'https://www.googleapis.com/auth/calendar',
      ]),
    InvalidScopeError,
  );
});

test('revokeToken kills an access token directly and a refresh token by family', async () => {
  const h = makeHarness();
  const { tokens } = await mintPair(h);

  await h.provider.revokeToken(CLIENT_A, { token: tokens.access_token });
  await assert.rejects(() => h.provider.verifyAccessToken(tokens.access_token), InvalidTokenError);

  await h.provider.revokeToken(CLIENT_A, { token: tokens.refresh_token! });
  await assert.rejects(
    () => h.provider.exchangeRefreshToken(CLIENT_A, tokens.refresh_token!),
    InvalidGrantError,
  );

  // Unknown token: silent no-op per RFC 7009.
  await h.provider.revokeToken(CLIENT_A, { token: 'mcp_at_unknown' });
});

test('a phished code cannot be brute-forced: challenge lookups are capped', async () => {
  const h = makeHarness();
  const { raw } = await mintCode(h, await authorize(h));
  for (let i = 0; i < 3; i++) {
    await h.provider.challengeForAuthorizationCode(CLIENT_A, raw);
  }
  await assert.rejects(
    () => h.provider.challengeForAuthorizationCode(CLIENT_A, raw),
    InvalidGrantError,
  );
  // The code itself is burned too.
  await assert.rejects(
    () => h.provider.exchangeAuthorizationCode(CLIENT_A, raw, undefined, CLIENT_A.redirect_uris[0]),
    InvalidGrantError,
  );
});
