import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

describe('Upload & Download tools', () => {
  let ctx: TestContext;

  before(async () => { ctx = await setupTestServer(); });
  after(async () => { await ctx.cleanup(); });
  beforeEach(() => {
    ctx.mocks.drive.tracker.reset();
  });

  // --- uploadFile ---
  describe('uploadFile', () => {
    it('validation error on missing args', async () => {
      const res = await callTool(ctx.client, 'uploadFile', {});
      assert.equal(res.isError, true);
    });

    it('error when file does not exist', async () => {
      const res = await callTool(ctx.client, 'uploadFile', { localPath: '/nonexistent/file.txt' });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text.includes('not found'));
    });
  });

  // --- downloadFile ---
  describe('downloadFile', () => {
    it('validation error on missing args', async () => {
      const res = await callTool(ctx.client, 'downloadFile', {});
      assert.equal(res.isError, true);
    });
  });
});
