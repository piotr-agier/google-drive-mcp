import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENABLED_TOOLS_ENV,
  parseEnabledTools,
  checkEnabledTools,
  isToolEnabled,
} from '../src/utils/enabledTools.js';

const KNOWN = ['readGoogleDoc', 'getGoogleSheetContent', 'deleteItem', 'manage_accounts'];

test('parseEnabledTools: no flag and no env means every tool', () => {
  assert.equal(parseEnabledTools([], {}), null);
  assert.equal(parseEnabledTools([], { [ENABLED_TOOLS_ENV]: '  ' }), null);
});

test('parseEnabledTools: reads the env var', () => {
  assert.deepEqual(
    parseEnabledTools([], { [ENABLED_TOOLS_ENV]: 'readGoogleDoc, getGoogleSheetContent' }),
    new Set(['readGoogleDoc', 'getGoogleSheetContent']),
  );
});

test('parseEnabledTools: the flag wins over the env var', () => {
  assert.deepEqual(
    parseEnabledTools(['--enable-tools=readGoogleDoc'], { [ENABLED_TOOLS_ENV]: 'deleteItem' }),
    new Set(['readGoogleDoc']),
  );
});

test('parseEnabledTools: an empty list is refused, not read as every tool', () => {
  assert.throws(() => parseEnabledTools(['--enable-tools='], {}), /enable-tools/);
  assert.throws(() => parseEnabledTools([], { [ENABLED_TOOLS_ENV]: ' , ' }), new RegExp(ENABLED_TOOLS_ENV));
});

test('checkEnabledTools: an unknown name fails at start', () => {
  assert.throws(() => checkEnabledTools(new Set(['readGoogleDoc', 'readGoogleDocs']), KNOWN), /readGoogleDocs/);
  assert.doesNotThrow(() => checkEnabledTools(new Set(['readGoogleDoc']), KNOWN));
  assert.doesNotThrow(() => checkEnabledTools(null, KNOWN));
});

test('isToolEnabled: set membership, everything when unset', () => {
  const enabled = new Set(['readGoogleDoc']);
  assert.equal(isToolEnabled(enabled, 'readGoogleDoc'), true);
  assert.equal(isToolEnabled(enabled, 'deleteItem'), false);
  assert.equal(isToolEnabled(enabled, 'manage_accounts'), false);
  assert.equal(isToolEnabled(null, 'deleteItem'), true);
});
