import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

describe('Docs tools', () => {
  let ctx: TestContext;

  before(async () => { ctx = await setupTestServer(); });
  after(async () => { await ctx.cleanup(); });
  beforeEach(() => {
    ctx.mocks.drive.tracker.reset();
    ctx.mocks.docs.tracker.reset();
  });

  // --- createGoogleDoc ---
  describe('createGoogleDoc', () => {
    it('happy path', async () => {
      ctx.mocks.drive.service.files.list._setImpl(async () => ({ data: { files: [] } }));
      ctx.mocks.drive.service.files.create._setImpl(async () => ({
        data: { id: 'doc-1', name: 'My Doc', webViewLink: 'https://docs.google.com/doc-1' },
      }));
      const res = await callTool(ctx.client, 'createGoogleDoc', { name: 'My Doc', content: 'Hello' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('My Doc'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'createGoogleDoc', {});
      assert.equal(res.isError, true);
    });
  });

  // --- updateGoogleDoc ---
  describe('updateGoogleDoc', () => {
    it('happy path', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'My Doc',
          body: { content: [{ endIndex: 10 }] },
        },
      }));
      const res = await callTool(ctx.client, 'updateGoogleDoc', { documentId: 'doc-1', content: 'New content' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Updated Google Doc'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'updateGoogleDoc', {});
      assert.equal(res.isError, true);
    });
  });

  // --- insertText ---
  describe('insertText', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'insertText', { documentId: 'doc-1', text: 'inserted', index: 1 });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('inserted'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'insertText', {});
      assert.equal(res.isError, true);
    });
  });

  // --- deleteRange ---
  describe('deleteRange', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'deleteRange', { documentId: 'doc-1', startIndex: 1, endIndex: 5 });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('deleted'));
    });

    it('validation: endIndex must be > startIndex', async () => {
      const res = await callTool(ctx.client, 'deleteRange', { documentId: 'doc-1', startIndex: 5, endIndex: 2 });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text.toLowerCase().includes('end index'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'deleteRange', {});
      assert.equal(res.isError, true);
    });
  });

  // --- readGoogleDoc ---
  describe('readGoogleDoc', () => {
    it('happy path (text format)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'My Doc',
          body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Hello World\n' } }] } }] },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Hello World'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'readGoogleDoc', {});
      assert.equal(res.isError, true);
    });
  });

  // --- listDocumentTabs ---
  describe('listDocumentTabs', () => {
    it('happy path', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: { documentId: 'doc-1', title: 'My Doc', body: { content: [] } },
      }));
      const res = await callTool(ctx.client, 'listDocumentTabs', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'listDocumentTabs', {});
      assert.equal(res.isError, true);
    });
  });

  // --- applyTextStyle ---
  describe('applyTextStyle', () => {
    it('happy path with index range', async () => {
      const res = await callTool(ctx.client, 'applyTextStyle', {
        documentId: 'doc-1', startIndex: 1, endIndex: 5, bold: true,
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('applied text style'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'applyTextStyle', {});
      assert.equal(res.isError, true);
    });
  });

  // --- applyParagraphStyle ---
  describe('applyParagraphStyle', () => {
    it('happy path with index range', async () => {
      const res = await callTool(ctx.client, 'applyParagraphStyle', {
        documentId: 'doc-1', startIndex: 1, endIndex: 5, alignment: 'CENTER',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('applied paragraph style'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'applyParagraphStyle', {});
      assert.equal(res.isError, true);
    });
  });

  // --- listComments ---
  describe('listComments', () => {
    it('happy path', async () => {
      ctx.mocks.drive.service.comments.list._setImpl(async () => ({
        data: { comments: [{ id: 'c1', content: 'Nice!', author: { displayName: 'User' }, createdTime: '2025-01-01' }] },
      }));
      const res = await callTool(ctx.client, 'listComments', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Nice!'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'listComments', {});
      assert.equal(res.isError, true);
    });
  });

  // --- getComment ---
  describe('getComment', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'getComment', { documentId: 'doc-1', commentId: 'c1' });
      assert.equal(res.isError, false);
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'getComment', {});
      assert.equal(res.isError, true);
    });
  });

  // --- addComment ---
  describe('addComment', () => {
    it('happy path', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'My Doc',
          body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Hello World\n' }, startIndex: 1, endIndex: 13 }] } }] },
        },
      }));
      const res = await callTool(ctx.client, 'addComment', {
        documentId: 'doc-1', startIndex: 1, endIndex: 5, commentText: 'Great!',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Comment added'));
    });

    it('validation: endIndex must be > startIndex', async () => {
      const res = await callTool(ctx.client, 'addComment', {
        documentId: 'doc-1', startIndex: 5, endIndex: 2, commentText: 'test',
      });
      assert.equal(res.isError, true);
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'addComment', {});
      assert.equal(res.isError, true);
    });
  });

  // --- replyToComment ---
  describe('replyToComment', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'replyToComment', {
        documentId: 'doc-1', commentId: 'c1', replyText: 'Thanks!',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Reply added'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'replyToComment', {});
      assert.equal(res.isError, true);
    });
  });

  // --- deleteComment ---
  describe('deleteComment', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'deleteComment', { documentId: 'doc-1', commentId: 'c1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('deleted'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'deleteComment', {});
      assert.equal(res.isError, true);
    });
  });
});
