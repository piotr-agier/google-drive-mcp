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

    it('validation error when both localPath and contentBase64 are provided', async () => {
      const res = await callTool(ctx.client, 'uploadFile', {
        localPath: '/tmp/a.png',
        contentBase64: 'aGVsbG8=',
      });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text.includes('exactly one'));
    });

    it('creates a new file from contentBase64', async () => {
      const res = await callTool(ctx.client, 'uploadFile', {
        contentBase64: Buffer.from('hello world').toString('base64'),
        name: 'hello.png',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Uploaded:'));
      const creates = ctx.mocks.drive.tracker.getCalls('files.create');
      assert.equal(creates.length, 1);
      assert.equal(creates[0].args[0].requestBody.name, 'hello.png');
      assert.equal(creates[0].args[0].media.mimeType, 'image/png');
      assert.equal(ctx.mocks.drive.tracker.getCalls('files.update').length, 0);
    });

    it('error when creating from contentBase64 without a name', async () => {
      const res = await callTool(ctx.client, 'uploadFile', {
        contentBase64: 'aGVsbG8=',
      });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text.includes('name is required'));
    });

    it('uploads a new version of an existing file when fileId is provided', async () => {
      const res = await callTool(ctx.client, 'uploadFile', {
        fileId: 'file-1',
        contentBase64: Buffer.from('new content').toString('base64'),
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Updated (new version)'));
      const updates = ctx.mocks.drive.tracker.getCalls('files.update');
      assert.equal(updates.length, 1);
      assert.equal(updates[0].args[0].fileId, 'file-1');
      // No MIME hint given: reuses the existing file's MIME type (from files.get)
      assert.equal(updates[0].args[0].media.mimeType, 'text/plain');
      assert.equal(ctx.mocks.drive.tracker.getCalls('files.create').length, 0);
    });

    it('rejects fileId combined with convertToGoogleFormat', async () => {
      const res = await callTool(ctx.client, 'uploadFile', {
        fileId: 'file-1',
        contentBase64: 'aGVsbG8=',
        convertToGoogleFormat: true,
      });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text.includes('convertToGoogleFormat'));
    });

    it('rejects fileId combined with parentFolderId', async () => {
      const res = await callTool(ctx.client, 'uploadFile', {
        fileId: 'file-1',
        contentBase64: 'aGVsbG8=',
        parentFolderId: '/Work',
      });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text.includes('parentFolderId'));
    });

    it('rejects in-place update of a Google Workspace file without explicit mimeType', async () => {
      ctx.mocks.drive.service.files.get._setImpl(async () => ({
        data: { mimeType: 'application/vnd.google-apps.document' },
      }));
      try {
        const res = await callTool(ctx.client, 'uploadFile', {
          fileId: 'doc-1',
          contentBase64: 'aGVsbG8=',
        });
        assert.equal(res.isError, true);
        assert.ok(res.content[0].text.includes('Google Workspace file'));
      } finally {
        ctx.mocks.drive.service.files.get._resetImpl();
      }
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
