import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
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

    it('passes corpora=allDrives to include shared drives', async () => {
      ctx.mocks.drive.service.files.list._setImpl(async () => ({
        data: { files: [{ id: 'f1', name: 'SharedFile.txt', mimeType: 'text/plain' }] },
      }));
      await callTool(ctx.client, 'search', { query: 'shared' });

      const listCalls = ctx.mocks.drive.tracker.getCalls('files.list');
      assert.ok(listCalls.length >= 1);
      const args = listCalls[listCalls.length - 1].args[0];
      assert.equal(args.corpora, 'allDrives');
      assert.equal(args.includeItemsFromAllDrives, true);
      assert.equal(args.supportsAllDrives, true);
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

  // --- listPermissions ---
  describe('listPermissions', () => {
    it('happy path includes inherited/direct marker', async () => {
      ctx.mocks.drive.service.permissions.list._setImpl(async () => ({
        data: {
          permissions: [
            {
              id: 'perm-1',
              type: 'user',
              emailAddress: 'user@example.com',
              role: 'reader',
              permissionDetails: [{ inherited: true, inheritedFrom: 'folder-123', permissionType: 'file' }],
            },
            {
              id: 'perm-2',
              type: 'user',
              emailAddress: 'owner@example.com',
              role: 'owner',
              permissionDetails: [{ inherited: false, permissionType: 'file' }],
            },
          ],
        },
      }));

      const res = await callTool(ctx.client, 'listPermissions', { fileId: 'file-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('[inherited from folder-123]'));
      assert.ok(res.content[0].text.includes('[direct]'));

      const listCalls = ctx.mocks.drive.tracker.getCalls('permissions.list');
      assert.ok(listCalls.length >= 1);
      assert.ok(listCalls[0].args[0].fields.includes('permissionDetails(inherited,inheritedFrom,permissionType)'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'listPermissions', {});
      assert.equal(res.isError, true);
    });
  });

  // --- addPermission / shareFile ---
  describe('permission mutations', () => {
    it('addPermission happy path', async () => {
      const res = await callTool(ctx.client, 'addPermission', {
        fileId: 'file-1', emailAddress: 'user@example.com', role: 'reader', type: 'user',
      });
      assert.equal(res.isError, false);
    });

    it('shareFile happy path', async () => {
      const res = await callTool(ctx.client, 'shareFile', {
        fileId: 'file-1', emailAddress: 'user@example.com', role: 'writer',
      });
      assert.equal(res.isError, false);
    });

    it('shareFile updates existing user permission (idempotent)', async () => {
      ctx.mocks.drive.service.permissions.list._setImpl(async () => ({
        data: { permissions: [{ id: 'perm-1', type: 'user', emailAddress: 'user@example.com', role: 'reader' }] },
      }));

      const res = await callTool(ctx.client, 'shareFile', {
        fileId: 'file-1', emailAddress: 'user@example.com', role: 'writer',
      });

      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Updated existing permission'));

      const createCalls = ctx.mocks.drive.tracker.getCalls('permissions.create');
      const updateCalls = ctx.mocks.drive.tracker.getCalls('permissions.update');
      assert.equal(createCalls.length, 0);
      assert.ok(updateCalls.length >= 1);
    });

    it('updatePermission happy path', async () => {
      const res = await callTool(ctx.client, 'updatePermission', {
        fileId: 'file-1', permissionId: 'perm-1', role: 'commenter',
      });
      assert.equal(res.isError, false);
    });

    it('removePermission happy path', async () => {
      const res = await callTool(ctx.client, 'removePermission', {
        fileId: 'file-1', permissionId: 'perm-1',
      });
      assert.equal(res.isError, false);
    });

    it('removePermission by email lookup', async () => {
      ctx.mocks.drive.service.permissions.list._setImpl(async () => ({
        data: { permissions: [{ id: 'perm-1', type: 'user', emailAddress: 'user@example.com' }] },
      }));
      const res = await callTool(ctx.client, 'removePermission', {
        fileId: 'file-1', emailAddress: 'user@example.com',
      });
      assert.equal(res.isError, false);
    });

    it('shareFile no-op when role already matches', async () => {
      ctx.mocks.drive.service.permissions.list._setImpl(async () => ({
        data: { permissions: [{ id: 'perm-1', type: 'user', emailAddress: 'user@example.com', role: 'writer' }] },
      }));

      const res = await callTool(ctx.client, 'shareFile', {
        fileId: 'file-1', emailAddress: 'user@example.com', role: 'writer',
      });

      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('No changes needed'));
    });
  });

  // --- auth diagnostics ---
  describe('auth diagnostics', () => {
    it('authGetStatus returns status payload', async () => {
      const res = await callTool(ctx.client, 'authGetStatus', {});
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Auth status'));
    });

    it('authListScopes returns scopes payload', async () => {
      const res = await callTool(ctx.client, 'authListScopes', {});
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('requestedScopes'));
    });

    it('authTestFileAccess works without fileId', async () => {
      const res = await callTool(ctx.client, 'authTestFileAccess', {});
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Auth access check OK'));
    });

    it('authTestFileAccess with specific fileId', async () => {
      ctx.mocks.drive.service.files.get._setImpl(async () => ({
        data: { id: 'file-1', name: 'TestDoc', mimeType: 'application/vnd.google-apps.document' },
      }));
      const res = await callTool(ctx.client, 'authTestFileAccess', { fileId: 'file-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('"mode":"file"') || res.content[0].text.includes('"mode": "file"'));
    });

  });

  // --- revisions ---
  describe('revisions', () => {
    it('getRevisions happy path', async () => {
      const res = await callTool(ctx.client, 'getRevisions', { fileId: 'file-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Revisions for file file-1'));
    });

    it('restoreRevision requires confirmation', async () => {
      const res = await callTool(ctx.client, 'restoreRevision', { fileId: 'file-1', revisionId: '1' });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text.includes('confirm=true'));
    });

    it('restoreRevision happy path (workspace file) includes formatting warning', async () => {
      ctx.mocks.drive.service.files.get._setImpl(async () => ({ data: { name: 'Doc', mimeType: 'application/vnd.google-apps.document' } }));
      ctx.mocks.drive.service.revisions.get._setImpl(async () => ({
        data: {
          id: '1',
          exportLinks: {
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'https://example.com/export.docx',
            'application/pdf': 'https://example.com/export.pdf',
          },
        },
      }));
      ctx.mocks.drive.service.files.update._setImpl(async () => ({ data: { id: 'file-1', name: 'Doc' } }));

      const res = await callTool(ctx.client, 'restoreRevision', { fileId: 'file-1', revisionId: '1', confirm: true });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Restored file file-1'));
      assert.ok(res.content[0].text.includes('restored via export/import'), 'Should include workspace formatting warning');

      // Should use revisions.get for exportLinks, not files.export
      const revGetCalls = ctx.mocks.drive.tracker.getCalls('revisions.get');
      assert.ok(revGetCalls.length >= 1, 'Should use revisions.get to fetch exportLinks');
    });

    it('restoreRevision happy path (binary file) without workspace warning', async () => {
      ctx.mocks.drive.service.files.get._setImpl(async () => ({ data: { name: 'photo.jpg', mimeType: 'image/jpeg' } }));
      ctx.mocks.drive.service.revisions.get._setImpl(async () => ({ data: Buffer.from('binary-content') }));
      ctx.mocks.drive.service.files.update._setImpl(async () => ({ data: { id: 'file-1', name: 'photo.jpg' } }));

      const res = await callTool(ctx.client, 'restoreRevision', { fileId: 'file-1', revisionId: '2', confirm: true });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Restored file file-1'));
      assert.ok(!res.content[0].text.includes('export/import'), 'Should NOT include workspace warning for binary files');

      const revGetCalls = ctx.mocks.drive.tracker.getCalls('revisions.get');
      assert.ok(revGetCalls.length >= 1, 'Should use revisions.get for binary download');
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

  describe('v1.6.0 pdf conversion tools', () => {
    it('convertPdfToGoogleDoc happy path', async () => {
      ctx.mocks.drive.service.files.get._setImpl(async () => ({ data: { id: 'pdf-1', name: 'A.pdf', mimeType: 'application/pdf', parents: ['root'] } }));
      ctx.mocks.drive.service.files.copy._setImpl(async () => ({ data: { id: 'doc-1', name: 'A (Doc)', webViewLink: 'https://doc' } }));
      const res = await callTool(ctx.client, 'convertPdfToGoogleDoc', { fileId: 'pdf-1' });
      assert.equal(res.isError, false);
    });

    it('bulkConvertFolderPdfs happy path', async () => {
      ctx.mocks.drive.service.files.list._setImpl(async () => ({ data: { files: [{ id: 'p1', name: 'X.pdf' }] } }));
      ctx.mocks.drive.service.files.copy._setImpl(async () => ({ data: { id: 'd1', name: 'X (Doc)' } }));
      const res = await callTool(ctx.client, 'bulkConvertFolderPdfs', { folderId: 'folder-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Success=1'));
    });

    it('uploadPdfWithSplit performs real split uploads', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'gdrive-mcp-test-'));
      try {
        const pdfPath = join(tempDir, 'source.pdf');
        const pdf = await PDFDocument.create();
        pdf.addPage();
        pdf.addPage();
        pdf.addPage();
        const bytes = await pdf.save();
        await writeFile(pdfPath, bytes);

        let counter = 0;
        ctx.mocks.drive.service.files.create._setImpl(async ({ requestBody }: any) => {
          counter += 1;
          return { data: { id: `part-${counter}`, name: requestBody?.name } };
        });

        const res = await callTool(ctx.client, 'uploadPdfWithSplit', {
          localPath: pdfPath,
          split: true,
          maxPagesPerChunk: 2,
          namePrefix: 'invoice',
        });

        assert.equal(res.isError, false);
        assert.ok(res.content[0].text.includes('Uploaded split PDF into 2 part(s)'));
        assert.ok(res.content[0].text.includes('invoice-part-1.pdf'));
        assert.ok(res.content[0].text.includes('invoice-part-2.pdf'));

        const createCalls = ctx.mocks.drive.tracker.getCalls('files.create');
        assert.equal(createCalls.length, 2);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
