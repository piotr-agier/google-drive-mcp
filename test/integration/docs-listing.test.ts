import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

describe('Docs listing tools', () => {
  let ctx: TestContext;

  before(async () => { ctx = await setupTestServer(); });
  after(async () => { await ctx.cleanup(); });
  beforeEach(() => {
    ctx.mocks.drive.tracker.reset();
  });

  // --- listGoogleDocs ---
  describe('listGoogleDocs', () => {
    it('happy path', async () => {
      ctx.mocks.drive.service.files.list._setImpl(async () => ({
        data: {
          files: [{
            id: 'doc-1', name: 'My Document', modifiedTime: '2025-01-01',
            webViewLink: 'https://docs.google.com/doc-1',
            owners: [{ displayName: 'Owner', emailAddress: 'owner@test.com' }],
          }],
        },
      }));
      const res = await callTool(ctx.client, 'listGoogleDocs', {});
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('My Document'));
    });

    it('no results', async () => {
      ctx.mocks.drive.service.files.list._setImpl(async () => ({ data: { files: [] } }));
      const res = await callTool(ctx.client, 'listGoogleDocs', {});
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('No Google Docs'));
    });
  });

  // --- getDocumentInfo ---
  describe('getDocumentInfo', () => {
    it('happy path', async () => {
      ctx.mocks.drive.service.files.get._setImpl(async () => ({
        data: {
          id: 'doc-1', name: 'My Document', mimeType: 'application/vnd.google-apps.document',
          createdTime: '2025-01-01', modifiedTime: '2025-01-02',
          webViewLink: 'https://docs.google.com/doc-1', shared: true,
          owners: [{ displayName: 'Owner', emailAddress: 'owner@test.com' }],
        },
      }));
      const res = await callTool(ctx.client, 'getDocumentInfo', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('My Document'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'getDocumentInfo', {});
      assert.equal(res.isError, true);
    });
  });
});
