import assert from 'node:assert/strict';
import test from 'node:test';

import { loadRuntimeConfig } from '../src/utils/cliArgs.js';

// ---------------------------------------------------------------------------
// Helper — save & restore GOOGLE_DRIVE_MCP_DISABLE_RESOURCES around each test
// ---------------------------------------------------------------------------
const VAR = 'GOOGLE_DRIVE_MCP_DISABLE_RESOURCES';

function withVar(value: string | undefined, fn: () => void) {
  return () => {
    const saved = process.env[VAR];
    if (value === undefined) delete process.env[VAR];
    else process.env[VAR] = value;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env[VAR];
      else process.env[VAR] = saved;
    }
  };
}

// ---------------------------------------------------------------------------
// disableResources — default
// ---------------------------------------------------------------------------
test('disableResources defaults to false when unset and no flag', withVar(undefined, () => {
  assert.equal(loadRuntimeConfig([]).disableResources, false);
}));

// ---------------------------------------------------------------------------
// disableResources — env var truthy values
// ---------------------------------------------------------------------------
for (const v of ['1', 'true', 'yes', 'on', 'enable', 'enabled', 'TRUE', '  Yes  ', 'ON', ' Enabled ']) {
  test(`disableResources is true for env value ${JSON.stringify(v)}`, withVar(v, () => {
    assert.equal(loadRuntimeConfig([]).disableResources, true);
  }));
}

// ---------------------------------------------------------------------------
// disableResources — env var falsy values
// ---------------------------------------------------------------------------
for (const v of ['0', 'false', 'no', 'off', 'disable', 'disabled', 'FALSE', 'Off', ' Disabled ']) {
  test(`disableResources is false for env value ${JSON.stringify(v)}`, withVar(v, () => {
    assert.equal(loadRuntimeConfig([]).disableResources, false);
  }));
}

// ---------------------------------------------------------------------------
// disableResources — unrecognized env value falls back to the default (false)
// ---------------------------------------------------------------------------
test('disableResources falls back to default for unrecognized env value', withVar('maybe', () => {
  assert.equal(loadRuntimeConfig([]).disableResources, false);
}));

// ---------------------------------------------------------------------------
// disableResources — --no-resources CLI flag
// ---------------------------------------------------------------------------
test('--no-resources flag sets disableResources true', withVar(undefined, () => {
  assert.equal(loadRuntimeConfig(['--no-resources']).disableResources, true);
}));

test('--no-resources flag overrides a falsy env value', withVar('0', () => {
  assert.equal(loadRuntimeConfig(['--no-resources']).disableResources, true);
}));

// ---------------------------------------------------------------------------
// disableResources — --no-resources=<bool> value form
// ---------------------------------------------------------------------------
test('--no-resources=true sets disableResources true', withVar(undefined, () => {
  assert.equal(loadRuntimeConfig(['--no-resources=true']).disableResources, true);
}));

test('--no-resources=false re-enables, overriding a truthy env value', withVar('1', () => {
  assert.equal(loadRuntimeConfig(['--no-resources=false']).disableResources, false);
}));

test('--no-resources=off re-enables resources', withVar(undefined, () => {
  assert.equal(loadRuntimeConfig(['--no-resources=off']).disableResources, false);
}));

test('--no-resources=<garbage> falls back to the bare-flag intent (disable)', withVar(undefined, () => {
  assert.equal(loadRuntimeConfig(['--no-resources=maybe']).disableResources, true);
}));

// ---------------------------------------------------------------------------
// Sanity — other runtime config defaults are unaffected
// ---------------------------------------------------------------------------
test('unrelated runtime config defaults are preserved', withVar(undefined, () => {
  const cfg = loadRuntimeConfig([]);
  assert.equal(cfg.apiTimeout, 120_000);
  assert.equal(cfg.retryMax, 3);
  assert.equal(cfg.retryBaseDelay, 1_000);
}));
