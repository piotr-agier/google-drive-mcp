import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { loadTeamConfig } from '../../src/auth/team/config.js';
import { clearAuthModeOverrides } from '../helpers/env.js';

// ---------------------------------------------------------------------------
// loadTeamConfig validation. env is passed explicitly, but the mode predicates
// it calls (isServiceAccountMode / isExternalTokenMode) read process.env
// directly, so the injected env alone does not make these hermetic: a
// mode-forcing variable in the shell makes loadTeamConfig throw on the
// team-mode incompatibility check before any of this is reached.
// ---------------------------------------------------------------------------

let overrides: { restore: () => void };
before(() => { overrides = clearAuthModeOverrides(); });
after(() => overrides.restore());

function makeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { MCP_TEAM_ISSUER_URL: 'https://drive-mcp.example.com', ...overrides };
}

test('a root issuer yields a host-root Google callback URI', () => {
  const config = loadTeamConfig({ transport: 'http', env: makeEnv() });
  assert.equal(
    config.googleRedirectUri,
    'https://drive-mcp.example.com/oauth/google/callback',
  );
});

test('MCP_HTTP_ALLOWED_HOSTS entries are lowercased for the case-sensitive SDK host check', () => {
  const config = loadTeamConfig({
    transport: 'http',
    env: makeEnv({ MCP_HTTP_ALLOWED_HOSTS: 'Extra.Example.COM, Another.Host' }),
  });
  // The SDK compares the Host header (always lowercased by URL parsing) against
  // this list case-sensitively, so mixed-case entries would never match.
  assert.ok(config.allowedHosts.includes('extra.example.com'));
  assert.ok(config.allowedHosts.includes('another.host'));
  assert.ok(config.allowedHosts.every((h) => h === h.toLowerCase()));
});

test('a path-bearing issuer URL is rejected at boot', () => {
  // new URL(callbackPath, issuer) would silently drop the base path, so the
  // derived redirect URI would not match what a reverse proxy forwards.
  assert.throws(
    () =>
      loadTeamConfig({
        transport: 'http',
        env: makeEnv({ MCP_TEAM_ISSUER_URL: 'https://example.com/mcp' }),
      }),
    /must not contain a path/,
  );
});

test('a query string or fragment on the issuer is still rejected', () => {
  assert.throws(
    () =>
      loadTeamConfig({
        transport: 'http',
        env: makeEnv({ MCP_TEAM_ISSUER_URL: 'https://example.com/?x=1' }),
      }),
    /query string or fragment/,
  );
});

// Either token variable enters external-token mode, and team mode refuses to
// run beside it. The refusal has to name the variable actually set, or a
// refresh-token-only deployment is told to unset something it never set.
test('team mode refuses beside a refresh token and names that variable', () => {
  const overrides = clearAuthModeOverrides({ GOOGLE_DRIVE_MCP_REFRESH_TOKEN: '1//refresh-only' });
  try {
    assert.throws(
      () => loadTeamConfig({ transport: 'http', env: makeEnv() }),
      (e: Error) => {
        assert.match(e.message, /incompatible with external-token mode/);
        assert.match(e.message, /Unset GOOGLE_DRIVE_MCP_REFRESH_TOKEN/);
        assert.doesNotMatch(
          e.message,
          /Unset GOOGLE_DRIVE_MCP_ACCESS_TOKEN/,
          'must not name a variable that is not set',
        );
        return true;
      },
    );
  } finally {
    overrides.restore();
  }
});

test('team mode names the access token when that is the one set', () => {
  const overrides = clearAuthModeOverrides({ GOOGLE_DRIVE_MCP_ACCESS_TOKEN: 'ya29.x' });
  try {
    assert.throws(
      () => loadTeamConfig({ transport: 'http', env: makeEnv() }),
      /Unset GOOGLE_DRIVE_MCP_ACCESS_TOKEN/,
    );
  } finally {
    overrides.restore();
  }
});
