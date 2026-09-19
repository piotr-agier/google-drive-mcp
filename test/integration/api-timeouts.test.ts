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
import { describe, it, before, after, beforeEach } from 'node:test';

process.env.GOOGLE_DRIVE_MCP_API_TIMEOUT = '100';
process.env.GOOGLE_DRIVE_MCP_RETRY_BASE_DELAY = '5';

import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

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
});
