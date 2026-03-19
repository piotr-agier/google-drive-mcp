import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isExternalTokenMode,
  isServiceAccountMode,
  validateExternalTokenConfig,
  createExternalOAuth2Client,
} from '../src/auth/externalAuth.js';

// ---------------------------------------------------------------------------
// Helpers — save & restore env vars around each test
// ---------------------------------------------------------------------------
const EXTERNAL_VARS = [
  'GOOGLE_DRIVE_MCP_ACCESS_TOKEN',
  'GOOGLE_DRIVE_MCP_REFRESH_TOKEN',
  'GOOGLE_DRIVE_MCP_CLIENT_ID',
  'GOOGLE_DRIVE_MCP_CLIENT_SECRET',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

function clearExternalEnv() {
  for (const v of EXTERNAL_VARS) delete process.env[v];
}

function withEnv(vars: Record<string, string>, fn: () => void | Promise<void>) {
  return async () => {
    const saved: Record<string, string | undefined> = {};
    for (const v of EXTERNAL_VARS) saved[v] = process.env[v];
    clearExternalEnv();
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    try {
      await fn();
    } finally {
      clearExternalEnv();
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// isExternalTokenMode
// ---------------------------------------------------------------------------
test('isExternalTokenMode returns true when access token is set', withEnv(
  { GOOGLE_DRIVE_MCP_ACCESS_TOKEN: 'ya29.test' },
  () => { assert.equal(isExternalTokenMode(), true); },
));

test('isExternalTokenMode returns false when access token is not set', withEnv(
  {},
  () => { assert.equal(isExternalTokenMode(), false); },
));

// ---------------------------------------------------------------------------
// isServiceAccountMode
// ---------------------------------------------------------------------------
test('isServiceAccountMode returns true when GOOGLE_APPLICATION_CREDENTIALS is set', withEnv(
  { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa-key.json' },
  () => { assert.equal(isServiceAccountMode(), true); },
));

test('isServiceAccountMode returns false when not set', withEnv(
  {},
  () => { assert.equal(isServiceAccountMode(), false); },
));

// ---------------------------------------------------------------------------
// validateExternalTokenConfig
// ---------------------------------------------------------------------------
test('validates successfully with access token only', withEnv(
  { GOOGLE_DRIVE_MCP_ACCESS_TOKEN: 'ya29.test' },
  () => { assert.doesNotThrow(() => validateExternalTokenConfig()); },
));

test('throws on empty access token', withEnv(
  { GOOGLE_DRIVE_MCP_ACCESS_TOKEN: '  ' },
  () => {
    assert.throws(
      () => validateExternalTokenConfig(),
      /GOOGLE_DRIVE_MCP_ACCESS_TOKEN is set but empty/,
    );
  },
));

test('throws when refresh token set without client credentials', withEnv(
  {
    GOOGLE_DRIVE_MCP_ACCESS_TOKEN: 'ya29.test',
    GOOGLE_DRIVE_MCP_REFRESH_TOKEN: '1//refresh',
  },
  () => {
    assert.throws(
      () => validateExternalTokenConfig(),
      /GOOGLE_DRIVE_MCP_CLIENT_ID and\/or.*GOOGLE_DRIVE_MCP_CLIENT_SECRET are missing/,
    );
  },
));

test('throws when only client ID provided without client secret', withEnv(
  {
    GOOGLE_DRIVE_MCP_ACCESS_TOKEN: 'ya29.test',
    GOOGLE_DRIVE_MCP_CLIENT_ID: 'id.apps.googleusercontent.com',
  },
  () => {
    assert.throws(
      () => validateExternalTokenConfig(),
      /Both GOOGLE_DRIVE_MCP_CLIENT_ID and GOOGLE_DRIVE_MCP_CLIENT_SECRET must be provided together/,
    );
  },
));

test('validates successfully with full credential set', withEnv(
  {
    GOOGLE_DRIVE_MCP_ACCESS_TOKEN: 'ya29.test',
    GOOGLE_DRIVE_MCP_REFRESH_TOKEN: '1//refresh',
    GOOGLE_DRIVE_MCP_CLIENT_ID: 'id.apps.googleusercontent.com',
    GOOGLE_DRIVE_MCP_CLIENT_SECRET: 'GOCSPX-secret',
  },
  () => { assert.doesNotThrow(() => validateExternalTokenConfig()); },
));

// ---------------------------------------------------------------------------
// createExternalOAuth2Client
// ---------------------------------------------------------------------------
test('creates OAuth2Client with access token', withEnv(
  { GOOGLE_DRIVE_MCP_ACCESS_TOKEN: 'ya29.test-token' },
  () => {
    const client = createExternalOAuth2Client();
    assert.equal(client.credentials.access_token, 'ya29.test-token');
    assert.equal(client.credentials.refresh_token, undefined);
  },
));

test('creates OAuth2Client with full credentials', withEnv(
  {
    GOOGLE_DRIVE_MCP_ACCESS_TOKEN: 'ya29.test-token',
    GOOGLE_DRIVE_MCP_REFRESH_TOKEN: '1//refresh-token',
    GOOGLE_DRIVE_MCP_CLIENT_ID: 'test-client-id',
    GOOGLE_DRIVE_MCP_CLIENT_SECRET: 'test-client-secret',
  },
  () => {
    const client = createExternalOAuth2Client();
    assert.equal(client.credentials.access_token, 'ya29.test-token');
    assert.equal(client.credentials.refresh_token, '1//refresh-token');
  },
));

// ---------------------------------------------------------------------------
// authenticate() integration — priority order
// ---------------------------------------------------------------------------
test('authenticate prefers service account over external token', withEnv(
  {
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/nonexistent-sa-key.json',
    GOOGLE_DRIVE_MCP_ACCESS_TOKEN: 'ya29.test',
  },
  async () => {
    // Service account mode should be chosen, but it will fail because the key
    // file doesn't exist. The important thing is that it doesn't fall through
    // to external token mode.
    const { authenticate } = await import('../src/auth.js');
    await assert.rejects(
      () => authenticate(),
      // GoogleAuth will throw about the missing key file
      (err: any) => err !== undefined,
    );
    // Confirm service account mode was selected (external token mode would succeed)
    assert.equal(isServiceAccountMode(), true);
    assert.equal(isExternalTokenMode(), true); // both set, but SA takes priority
  },
));

test('authenticate uses external token when no service account', withEnv(
  {
    GOOGLE_DRIVE_MCP_ACCESS_TOKEN: 'ya29.test',
  },
  async () => {
    const { authenticate } = await import('../src/auth.js');
    const client = await authenticate();
    assert.equal(client.credentials.access_token, 'ya29.test');
  },
));
