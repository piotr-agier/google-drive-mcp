import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

// With more than one account connected, a successful write names the account
// that took it, so a write that landed on the default instead of the intended
// account is visible in the reply. With one account there is nothing to tell
// apart, and the reply is unchanged.

describe('Acting account on write replies', () => {
  let ctx: TestContext;
  let serverModule: any;

  before(async () => {
    ctx = await setupTestServer();
    serverModule = await import('../../src/index.js');
  });

  after(async () => {
    // Back to the single 'test' account for any later test in this process.
    serverModule._setAuthClientForTesting({});
    await ctx.cleanup();
  });

  beforeEach(() => {
    ctx.mocks.drive.tracker.reset();
  });

  describe('single account', () => {
    it('leaves a successful write reply unchanged', async () => {
      const res = await callTool(ctx.client, 'createFolder', { name: 'Reports' });
      assert.equal(res.isError, false);
      assert.ok(!res.content.some((b) => b.text?.includes('[acting as')), res.content[0].text);
    });
  });

  describe('several accounts', () => {
    before(async () => {
      // 'test' stays the default; 'work' and 'home' are the extra accounts.
      await serverModule._addSyntheticAccountForTesting('work', {});
      await serverModule._addSyntheticAccountForTesting('home', {});
    });

    it('ends a successful write reply with the account the call was routed to', async () => {
      const res = await callTool(ctx.client, 'createFolder', { name: 'Reports', account: 'work' });
      assert.equal(res.isError, false);
      const text = res.content[res.content.length - 1].text!;
      assert.ok(text.endsWith('\n[acting as work@example.com (work)]'), text);
      assert.equal(text.match(/\[acting as/g)?.length, 1, 'stamped once');
    });

    it('names the default account when the write gave none', async () => {
      const res = await callTool(ctx.client, 'createFolder', { name: 'Reports' });
      assert.ok(res.content[res.content.length - 1].text!.endsWith('\n[acting as test@example.com (test)]'));
    });

    it('leaves a read reply unchanged', async () => {
      const res = await callTool(ctx.client, 'search', { query: 'q', account: 'work' });
      assert.equal(res.isError, false);
      assert.ok(!res.content.some((b) => b.text?.includes('[acting as')), res.content[0].text);
    });

    it('leaves a failed write reply unchanged', async () => {
      // restoreRevision returns its API failure as an isError reply rather than
      // throwing, so this reaches the stamping step instead of the outer catch.
      ctx.mocks.drive.service.files.get._setImpl(async () => { throw new Error('Insufficient Permission'); });
      try {
        const res = await callTool(ctx.client, 'restoreRevision', {
          fileId: 'file-1', revisionId: '1', confirm: true, account: 'work',
        });
        assert.equal(res.isError, true);
        assert.equal(res.content[0].text, 'Error: Failed to restore revision: Insufficient Permission');
      } finally {
        ctx.mocks.drive.service.files.get._resetImpl();
      }
    });

    it('leaves an admin tool reply unchanged', async () => {
      const res = await callTool(ctx.client, 'manage_accounts', { action: 'list' });
      assert.notEqual(res.isError, true);
      // The reply is JSON; a stamp would make it unparseable.
      const payload = JSON.parse(res.content[0].text!);
      assert.deepEqual(payload.accounts.map((a: { alias: string }) => a.alias).sort(), ['home', 'test', 'work']);
    });
  });
});
