import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

describe('Drive tools', () => {
  let ctx: TestContext;

  before(async () => { ctx = await setupTestServer(); });
  after(async () => { await ctx.cleanup(); });
  beforeEach(() => {
    ctx.mocks.drive.tracker.reset();
  });

  // --- search ---
  describe('search', () => {
    it('happy path', async () => {
      ctx.mocks.drive.service.files.list._setImpl(async () => ({
        data: { files: [{ id: 'f1', name: 'Report.pdf', mimeType: 'application/pdf' }] },
      }));
      const res = await callTool(ctx.client, 'search', { query: 'report' });
      assert.ok(res.content[0].text.includes('Report.pdf'));
      assert.equal(res.isError, false);
    });

    it('validation error on empty args', async () => {
      const res = await callTool(ctx.client, 'search', {});
      assert.equal(res.isError, true);
    });

    it('propagates API error', async () => {
      ctx.mocks.drive.service.files.list._setImpl(async () => { throw new Error('API quota exceeded'); });
      const res = await callTool(ctx.client, 'search', { query: 'test' });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text.includes('API quota exceeded'));
      ctx.mocks.drive.service.files.list._resetImpl();
    });
  });

  // --- createTextFile ---
  describe('createTextFile', () => {
    it('happy path', async () => {
      // checkFileExists returns no match
      ctx.mocks.drive.service.files.list._setImpl(async () => ({ data: { files: [] } }));
      ctx.mocks.drive.service.files.create._setImpl(async () => ({
        data: { id: 'new-file', name: 'notes.txt' },
      }));
      const res = await callTool(ctx.client, 'createTextFile', { name: 'notes.txt', content: 'hello' });
      assert.ok(res.content[0].text.includes('notes.txt'));
      assert.equal(res.isError, false);
    });

    it('validation error on missing required fields', async () => {
      const res = await callTool(ctx.client, 'createTextFile', {});
      assert.equal(res.isError, true);
    });
  });

  // --- updateTextFile ---
  describe('updateTextFile', () => {
    it('happy path', async () => {
      ctx.mocks.drive.service.files.get._setImpl(async () => ({
        data: { mimeType: 'text/plain', name: 'notes.txt', parents: ['root'] },
      }));
      ctx.mocks.drive.service.files.update._setImpl(async () => ({
        data: { id: 'file-1', name: 'notes.txt' },
      }));
      const res = await callTool(ctx.client, 'updateTextFile', { fileId: 'file-1', content: 'updated' });
      assert.equal(res.isError, false);
    });

    it('validation error on missing required fields', async () => {
      const res = await callTool(ctx.client, 'updateTextFile', {});
      assert.equal(res.isError, true);
    });
  });

  // --- createFolder ---
  describe('createFolder', () => {
    it('happy path', async () => {
      ctx.mocks.drive.service.files.create._setImpl(async () => ({
        data: { id: 'folder-1', name: 'New Folder' },
      }));
      const res = await callTool(ctx.client, 'createFolder', { name: 'New Folder' });
      assert.ok(res.content[0].text.includes('New Folder'));
      assert.equal(res.isError, false);
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'createFolder', {});
      assert.equal(res.isError, true);
    });
  });

  // --- listFolder ---
  describe('listFolder', () => {
    it('happy path', async () => {
      ctx.mocks.drive.service.files.list._setImpl(async () => ({
        data: { files: [{ id: 'f1', name: 'File1', mimeType: 'text/plain' }] },
      }));
      const res = await callTool(ctx.client, 'listFolder', {});
      assert.equal(res.isError, false);
    });
  });

  // --- listSharedDrives ---
  describe('listSharedDrives', () => {
    it('happy path', async () => {
      ctx.mocks.drive.service.drives.list._setImpl(async () => ({
        data: { drives: [{ id: 'd1', name: 'Engineering Shared Drive', hidden: false }] },
      }));
      const res = await callTool(ctx.client, 'listSharedDrives', {});
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Engineering Shared Drive'));
      assert.ok(res.content[0].text.includes('d1'));
    });

    it('empty result', async () => {
      ctx.mocks.drive.service.drives.list._setImpl(async () => ({
        data: { drives: [] },
      }));
      const res = await callTool(ctx.client, 'listSharedDrives', {});
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('No shared drives found'));
    });

    it('pagination token forwarded', async () => {
      ctx.mocks.drive.service.drives.list._setImpl(async () => ({
        data: { drives: [{ id: 'd1', name: 'Drive A', hidden: false }], nextPageToken: 'tok2' },
      }));
      const res = await callTool(ctx.client, 'listSharedDrives', { pageSize: 1 });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('tok2'));
    });
  });

  // --- deleteItem ---
  describe('deleteItem', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'deleteItem', { itemId: 'item-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('moved to trash'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'deleteItem', {});
      assert.equal(res.isError, true);
    });
  });

  // --- renameItem ---
  describe('renameItem', () => {
    it('happy path', async () => {
      // files.get returns a non-text mimeType so validateTextFileExtension is skipped
      ctx.mocks.drive.service.files.get._setImpl(async () => ({
        data: { name: 'OldName', mimeType: 'application/vnd.google-apps.folder' },
      }));
      ctx.mocks.drive.service.files.update._setImpl(async () => ({
        data: { id: 'item-1', name: 'Renamed' },
      }));
      const res = await callTool(ctx.client, 'renameItem', { itemId: 'item-1', newName: 'Renamed' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Renamed'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'renameItem', {});
      assert.equal(res.isError, true);
    });
  });

  // --- moveItem ---
  describe('moveItem', () => {
    it('happy path', async () => {
      ctx.mocks.drive.service.files.get._setImpl(async () => ({
        data: { id: 'item-1', name: 'File', parents: ['old-parent'] },
      }));
      ctx.mocks.drive.service.files.update._setImpl(async () => ({
        data: { id: 'item-1', name: 'File' },
      }));
      const res = await callTool(ctx.client, 'moveItem', { itemId: 'item-1', destinationFolderId: 'new-parent' });
      assert.equal(res.isError, false);
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'moveItem', {});
      assert.equal(res.isError, true);
    });
  });
});
