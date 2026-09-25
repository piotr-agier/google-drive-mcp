/**
 * Proves the retry/timeout policy actually applied to tool call sites, not
 * merely that `withRetry` itself works (that's covered by test/retry.test.ts).
 *
 * Small `apiTimeout`/`retryBaseDelay` env vars are set below, before the first
 * (dynamic) import of the server module, so this file's runtimeConfig differs
 * from the 120s/1s defaults used elsewhere — Node's test runner executes each
 * test file in its own process, so this does not leak into other test files.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach, mock } from 'node:test';

process.env.GOOGLE_DRIVE_MCP_API_TIMEOUT = '100';
process.env.GOOGLE_DRIVE_MCP_RETRY_BASE_DELAY = '5';

import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';
import { UPLOAD_TIMEOUT_MS } from '../../src/utils/retry.js';

// A macrotask boundary (unaffected by the fake `setTimeout` below) so every
// microtask chain a faked timer callback kicked off — including the round
// trip through the in-memory MCP transport — has settled before we assert.
const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

// The full client -> transport -> server -> transport -> client round trip
// takes more macrotask hops to drain than a single flush; poll rather than
// guess a fixed count.
async function waitUntilSettled(isSettled: () => boolean, maxFlushes = 50): Promise<void> {
  for (let i = 0; i < maxFlushes && !isSettled(); i++) {
    await flushMicrotasks();
  }
}

async function flushTimes(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await flushMicrotasks();
}

const serviceUnavailable = () =>
  Object.assign(new Error('Service Unavailable'), { response: { status: 503 } });

describe('API call timeout/retry policy (reads vs. writes)', () => {
  let ctx: TestContext;

  before(async () => { ctx = await setupTestServer(); });
  after(async () => { await ctx.cleanup(); });
  beforeEach(() => {
    ctx.mocks.calendar.tracker.reset();
    ctx.mocks.calendar.service.events.list._resetImpl();
    ctx.mocks.calendar.service.events.insert._resetImpl();
    ctx.mocks.drive.tracker.reset();
    ctx.mocks.drive.service.files.get._resetImpl();
    ctx.mocks.drive.service.revisions.get._resetImpl();
    ctx.mocks.drive.service.files.update._resetImpl();
  });

  it('a read (calendar.events.list) is retried on a 503 and succeeds', async () => {
    let calls = 0;
    ctx.mocks.calendar.service.events.list._setImpl(async () => {
      calls++;
      if (calls < 2) throw serviceUnavailable();
      return {
        data: {
          items: [{
            id: 'event-1', summary: 'Retried Event',
            start: { dateTime: '2025-01-01T10:00:00Z' }, end: { dateTime: '2025-01-01T11:00:00Z' },
            status: 'confirmed',
          }],
        },
      };
    });

    const res = await callTool(ctx.client, 'getCalendarEvents', {});
    assert.equal(res.isError, false);
    assert.equal(calls, 2, 'expected the read to be retried once after the 503');
    assert.ok(res.content[0].text!.includes('Retried Event'));
  });

  it('a write (calendar.events.insert) is NOT retried on the same 503', async () => {
    let calls = 0;
    ctx.mocks.calendar.service.events.insert._setImpl(async () => {
      calls++;
      throw serviceUnavailable();
    });

    const res = await callTool(ctx.client, 'createCalendarEvent', {
      summary: 'Should not retry',
      start: { dateTime: '2025-06-01T10:00:00Z' },
      end: { dateTime: '2025-06-01T11:00:00Z' },
    });

    assert.equal(res.isError, true);
    assert.equal(calls, 1, 'a write must fail on the first 503 rather than retry');
    assert.ok(res.content[0].text!.includes('Service Unavailable'));
  });

  it('a write (calendar.events.insert) still fails with a timeout when the call never settles', async () => {
    let calls = 0;
    ctx.mocks.calendar.service.events.insert._setImpl(() => {
      calls++;
      return new Promise(() => {}); // never settles
    });

    const res = await callTool(ctx.client, 'createCalendarEvent', {
      summary: 'Hangs forever',
      start: { dateTime: '2025-06-01T10:00:00Z' },
      end: { dateTime: '2025-06-01T11:00:00Z' },
    });

    assert.equal(res.isError, true);
    assert.match(res.content[0].text!, /timed out/i);
    assert.equal(calls, 1, 'the hung write must not be retried either');
  });

  // Proves the fix for a review finding: a `{ responseType: 'stream' }` read's
  // promise settles once headers arrive, not once the body is fully read, so a
  // timeout around the await never reaches an in-progress transfer — meaning
  // there's no reason to withhold retries from it. drive.revisions.get here
  // stands in for restoreRevision's binary-file media fetch.
  it('a stream-mode read (drive.revisions.get) is retried on a 503 like any other read', async () => {
    let calls = 0;
    ctx.mocks.drive.service.revisions.get._setImpl(async () => {
      calls++;
      if (calls < 2) throw serviceUnavailable();
      return { data: 'fake revision bytes' };
    });

    const res = await callTool(ctx.client, 'restoreRevision', {
      fileId: 'file-1',
      revisionId: 'rev-1',
      confirm: true,
    });

    assert.equal(res.isError, false, JSON.stringify(res));
    assert.equal(calls, 2, 'expected the stream-mode read to be retried once after the 503');
  });

  // Proves the upload sites use their own generous deadline (UPLOAD_TIMEOUT_MS)
  // rather than this file's ambient 100ms apiTimeout — a config value nobody
  // else checks. Uses fake timers because the deadline is 30 real minutes;
  // the client's own default request timeout is pushed out of the way with an
  // explicit `timeout` so it cannot fire first and confound the assertion.
  it('an upload write (drive.files.create) gets its own deadline, not the small default apiTimeout', async () => {
    ctx.mocks.drive.service.files.list._setImpl(async () => ({ data: { files: [] } }));
    ctx.mocks.drive.service.files.create._setImpl(() => new Promise(() => {})); // never settles

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let settled: unknown;
      ctx.client.callTool(
        { name: 'createTextFile', arguments: { name: 'huge-upload.txt', content: 'hello' } },
        undefined,
        { timeout: UPLOAD_TIMEOUT_MS + 60_000 },
      ).then((r) => { settled = r; }, (e) => { settled = e; });

      // Let the request actually reach the handler and register the real
      // (now-faked) setTimeout inside withRetry before advancing the clock —
      // the call above hasn't run past its first `await` yet.
      await flushTimes(10);

      // Far past the file's ambient 100ms apiTimeout: still pending proves this
      // call site does not fall back to ctx.runtimeConfig.apiTimeout.
      mock.timers.tick(300_000);
      await flushMicrotasks();
      assert.equal(settled, undefined, 'must not settle at 5 minutes');

      // Just short of the upload deadline: still pending.
      mock.timers.tick(UPLOAD_TIMEOUT_MS - 300_000 - 1_000);
      await flushMicrotasks();
      assert.equal(settled, undefined, 'must not settle just before the upload deadline');

      // Past the upload deadline: now it must fail, naming exactly the
      // configured deadline — proof of the actual `apiTimeout` the wrapper
      // received, not just that some larger-than-default bound exists.
      mock.timers.tick(2_000);
      await waitUntilSettled(() => settled !== undefined);

      assert.ok(settled, 'expected the call to settle once the upload deadline passed');
      const res = settled as { isError?: boolean; content: Array<{ text: string }> };
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, new RegExp(`timed out after ${UPLOAD_TIMEOUT_MS}ms`));
    } finally {
      mock.timers.reset();
      ctx.mocks.drive.service.files.list._resetImpl();
      ctx.mocks.drive.service.files.create._resetImpl();
    }
  });
});
