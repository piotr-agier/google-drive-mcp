import assert from 'node:assert/strict';
import test from 'node:test';
import { clearAuthModeOverrides } from '../helpers/env.js';
import { allAuthModeOverrideEnvVars, getActiveAuthMode } from '../../src/auth/externalAuth.js';

// A test that needs the local OAuth path must not be at the mercy of the shell
// it runs in: any mode-forcing variable left in the environment changes the
// mode under it. This asserts the helper clears the whole map, so adding a
// variable to the map later cannot leave a gap here.
test('clearAuthModeOverrides unsets every mode-forcing variable', () => {
  const planted: Record<string, string | undefined> = {};
  for (const name of allAuthModeOverrideEnvVars()) {
    planted[name] = process.env[name];
    process.env[name] = 'planted-by-the-test';
  }
  const restore = clearAuthModeOverrides();
  try {
    for (const name of allAuthModeOverrideEnvVars()) {
      assert.equal(process.env[name], undefined, `${name} must be cleared`);
    }
    assert.equal(getActiveAuthMode(), 'oauth', 'with nothing forcing a mode, OAuth is the mode');
  } finally {
    restore.restore();
    for (const [k, v] of Object.entries(planted)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('clearAuthModeOverrides restores what it found', () => {
  process.env.GOOGLE_DRIVE_MCP_REFRESH_TOKEN = 'pre-existing';
  const restore = clearAuthModeOverrides();
  assert.equal(process.env.GOOGLE_DRIVE_MCP_REFRESH_TOKEN, undefined);
  restore.restore();
  assert.equal(process.env.GOOGLE_DRIVE_MCP_REFRESH_TOKEN, 'pre-existing');
  delete process.env.GOOGLE_DRIVE_MCP_REFRESH_TOKEN;
});
