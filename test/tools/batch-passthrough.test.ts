import assert from 'node:assert/strict';
import test from 'node:test';

import {
  batchGuardConfigFromEnv,
  summarizeBatchReplies,
  summarizeRequestTypes,
  validateBatchRequests,
} from '../../src/tools/batchPassthrough.js';

test('validateBatchRequests accepts well-formed request arrays', () => {
  assert.equal(
    validateBatchRequests(
      [{ insertText: { location: { index: 1 }, text: 'x' } }, { updateParagraphStyle: {} }],
      { max: 200 },
    ),
    null,
  );
});

test('validateBatchRequests refuses empties, cap overruns, multi-key entries, and non-objects', () => {
  assert.match(validateBatchRequests([], { max: 200 }) ?? '', /non-empty/);
  assert.match(validateBatchRequests([{ a: 1 }, { b: 2 }], { max: 1 }) ?? '', /cap is 1/);
  assert.match(validateBatchRequests([{ a: 1, b: 2 }], { max: 10 }) ?? '', /exactly one/);
  assert.match(validateBatchRequests(['nope'], { max: 10 }) ?? '', /not an object/);
});

test('allowlist blocks unlisted request types', () => {
  const config = { max: 10, allowlist: new Set(['insertText']) };
  assert.equal(validateBatchRequests([{ insertText: {} }], config), null);
  assert.match(validateBatchRequests([{ deleteContentRange: {} }], config) ?? '', /allowlist/);
});

test('batchGuardConfigFromEnv reads cap and allowlist from env', () => {
  process.env.GOOGLE_DRIVE_MCP_BATCH_MAX = '5';
  process.env.GOOGLE_DRIVE_MCP_BATCH_ALLOWLIST = 'insertText, updateTextStyle';
  try {
    const config = batchGuardConfigFromEnv();
    assert.equal(config.max, 5);
    assert.deepEqual([...config.allowlist!].sort(), ['insertText', 'updateTextStyle']);
  } finally {
    delete process.env.GOOGLE_DRIVE_MCP_BATCH_MAX;
    delete process.env.GOOGLE_DRIVE_MCP_BATCH_ALLOWLIST;
  }
  assert.equal(batchGuardConfigFromEnv().max, 200);
  assert.equal(batchGuardConfigFromEnv().allowlist, undefined);
});

test('reply and request summaries stay lean', () => {
  assert.equal(summarizeRequestTypes([{ insertText: {} }, { insertText: {} }, { updateTextStyle: {} }]), '2× insertText, 1× updateTextStyle');
  assert.equal(summarizeBatchReplies([{}, {}]), '2 replies, all empty (success)');
  assert.match(summarizeBatchReplies([{}, { createHeader: { headerId: 'h1' } }]), /\[1\] .*h1/);
  assert.equal(summarizeBatchReplies([]), 'no reply payloads');
});
