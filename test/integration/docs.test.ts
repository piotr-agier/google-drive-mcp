import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

// Create reusable mock document structures for testing common document and tab configurations
const mockDocs = {
  // Simple single-tab document
  singleTab: (content = 'Hello World\n') => ({
    documentId: 'doc-1',
    title: 'My Doc',
    body: {
      content: [{ paragraph: { elements: [{ textRun: { content } }] } }],
    },
  }),

  // Multi-tab document
  multiTab: () => ({
    documentId: 'doc-1',
    title: 'Multi-Tab Doc',
    tabs: [
      {
        tabProperties: { tabId: 'tab-1', title: 'Tab1' },
        documentTab: {
          body: { content: [{ paragraph: { elements: [{ textRun: { content: 'First tab\n' }, startIndex: 1, endIndex: 11 }] } }] },
        },
      },
      {
        tabProperties: { tabId: 'tab-2', title: 'Tab2' },
        documentTab: {
          body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Second tab\n' }, startIndex: 1, endIndex: 12 }] } }] },
        },
      },
    ],
  }),

  // Fully nested document (all 3 levels)
  fullyNested: () => ({
    documentId: 'doc-1',
    title: 'Nested Tab Doc',
    tabs: [
      {
        tabProperties: { tabId: 'tab-1', title: 'Tab1' },
        documentTab: {
          body: { content: [{ paragraph: { elements: [{ textRun: { content: 'First tab\n' }, startIndex: 1, endIndex: 11 }] } }] },
        },
        childTabs: [
          {
            tabProperties: { tabId: 'tab-1-1', title: 'Tab1.1' },
            documentTab: {
              body: { content: [{ paragraph: { elements: [{ textRun: { content: 'First child\n' }, startIndex: 1, endIndex: 13 }] } }] },
            },
          },
          {
            tabProperties: { tabId: 'tab-1-2', title: 'Tab1.2' },
            documentTab: {
              body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Second child\n' }, startIndex: 1, endIndex: 14 }] } }] },
            },
            childTabs: [
              {
                tabProperties: { tabId: 'tab-1-2-1', title: 'Tab1.2.1' },
                documentTab: {
                  body: { content: [{ paragraph: { elements: [{ textRun: { content: 'First grandchild\n' }, startIndex: 1, endIndex: 18 }] } }] },
                },
              },
            ],
          },
        ],
      },
      {
        tabProperties: { tabId: 'tab-2', title: 'Tab2' },
        documentTab: {
          body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Second tab\n' }, startIndex: 1, endIndex: 12 }] } }] },
        },
      },
    ],
  }),

  // Single parent with nested children (for edge case testing)
  singleParentNested: () => ({
    documentId: 'doc-1', title: 'Nested Tab Doc',
    tabs: [
      {
        tabProperties: { tabId: 'tab-1', title: 'Tab1' },
        documentTab: {
          body: { content: [{ paragraph: { elements: [{ textRun: { content: 'First tab\n' }, startIndex: 1, endIndex: 11 }] } }] },
        },
        childTabs: [
          {
            tabProperties: { tabId: 'tab-1-1', title: 'Tab1.1' },
            documentTab: {
              body: { content: [{ paragraph: { elements: [{ textRun: { content: 'First child\n' }, startIndex: 1, endIndex: 13 }] } }] },
            },
          },
          {
            tabProperties: { tabId: 'tab-1-2', title: 'Tab1.2' },
            documentTab: {
              body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Second child\n' }, startIndex: 1, endIndex: 14 }] } }] },
            },
            childTabs: [
              {
                tabProperties: { tabId: 'tab-1-2-1', title: 'Tab1.2.1' },
                documentTab: {
                  body: { content: [{ paragraph: { elements: [{ textRun: { content: 'First grandchild\n' }, startIndex: 1, endIndex: 18 }] } }] },
                },
              },
            ],
          },
        ],
      },
    ],
  }),
};

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

    it('reads multi-tab document', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Multi-Tab Doc',
          tabs: [
            {
              tabProperties: { tabId: 'tab-1', title: 'Tab1' },
              documentTab: {
                body: { content: [{ paragraph: { elements: [{ textRun: { content: 'First tab\n' } }] } }] },
              },
            },
            {
              tabProperties: { tabId: 'tab-2', title: 'Tab2' },
              documentTab: {
                body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Second tab\n' } }] } }] },
              },
            },
          ],
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('=== Tab: Tab1 ==='));
      assert.ok(res.content[0].text.includes('=== Tab: Tab2 ==='));
      assert.ok(res.content[0].text.includes('First tab'));
      assert.ok(res.content[0].text.includes('Second tab'));
    });

    it('reads specific tab by tabId', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Multi-Tab Doc',
          tabs: [
            {
              tabProperties: { tabId: 'tab-1', title: 'Tab1' },
              documentTab: {
                body: { content: [{ paragraph: { elements: [{ textRun: { content: 'First tab\n' } }] } }] },
              },
            },
            {
              tabProperties: { tabId: 'tab-2', title: 'Tab2' },
              documentTab: {
                body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Second tab\n' } }] } }] },
              },
            },
          ],
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', tabId: 'tab-2' });
      assert.equal(res.isError, false);
      assert.ok(!res.content[0].text.includes('First tab'));
      assert.ok(res.content[0].text.includes('Second tab'));
    });

    it('reads specific nested tab by tabId', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.fullyNested(),
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', tabId: 'tab-1-2' });
      assert.equal(res.isError, false);
      assert.ok(!res.content[0].text.includes('First tab'));
      assert.ok(!res.content[0].text.includes('First child'));
      assert.ok(res.content[0].text.includes('Second child'));
      assert.ok(!res.content[0].text.includes('Second tab'));
    });
    
    it('reads specific nested tab by tabId when the document has only one tab with child tabs', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.singleParentNested(),
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', tabId: 'tab-1-2' });
      assert.equal(res.isError, false);
      assert.ok(!res.content[0].text.includes('First tab'));
      assert.ok(!res.content[0].text.includes('First child'));
      assert.ok(res.content[0].text.includes('Second child'));
      assert.ok(!res.content[0].text.includes('Second tab'));
    });

    it('reads deeply nested grandchild tab by tabId', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.fullyNested(),
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', tabId: 'tab-1-2-1' });
      assert.equal(res.isError, false);
      assert.ok(!res.content[0].text.includes('First tab'));
      assert.ok(!res.content[0].text.includes('First child'));
      assert.ok(res.content[0].text.includes('First grandchild'));
    });

    it('reads all tabs including nested when no tabId specified', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.fullyNested(),
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      // Should include all tabs with proper hierarchy
      assert.ok(res.content[0].text.includes('=== Tab: Tab1 ==='));
      assert.ok(res.content[0].text.includes('First tab'));
      assert.ok(res.content[0].text.includes('=== Tab: Tab1.1 ==='));
      assert.ok(res.content[0].text.includes('First child'));
      assert.ok(res.content[0].text.includes('=== Tab: Tab1.2 ==='));
      assert.ok(res.content[0].text.includes('Second child'));
      assert.ok(res.content[0].text.includes('=== Tab: Tab1.2.1 ==='));
      assert.ok(res.content[0].text.includes('First grandchild'));
      assert.ok(res.content[0].text.includes('=== Tab: Tab2 ==='));
      assert.ok(res.content[0].text.includes('Second tab'));
    });
    
    it('reads all tabs including nested when no tabId specified and the document has only one tab with child tabs ', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.singleParentNested(),
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1' });
      assert.equal(res.isError, false);

      // Should include all tabs with proper hierarchy
      assert.ok(res.content[0].text.includes('=== Tab: Tab1 ==='));
      assert.ok(res.content[0].text.includes('First tab'));
      assert.ok(res.content[0].text.includes('=== Tab: Tab1.1 ==='));
      assert.ok(res.content[0].text.includes('First child'));
      assert.ok(res.content[0].text.includes('=== Tab: Tab1.2 ==='));
      assert.ok(res.content[0].text.includes('Second child'));
      assert.ok(res.content[0].text.includes('=== Tab: Tab1.2.1 ==='));
      assert.ok(res.content[0].text.includes('First grandchild'));
    });

    it('returns error for unknown tabId', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Multi-Tab Doc',
          tabs: [
            {
              tabProperties: { tabId: 'tab-1', title: 'Tab1' },
              documentTab: {
                body: { content: [{ paragraph: { elements: [{ textRun: { content: 'First tab\n' } }] } }] },
              },
            },
          ],
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', tabId: 'nonexistent' });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text.includes('not found'));
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

  // --- formatGoogleDocText / formatGoogleDocParagraph aliases ---
  describe('format alias tools', () => {
    it('formatGoogleDocText delegates successfully', async () => {
      const res = await callTool(ctx.client, 'formatGoogleDocText', {
        documentId: 'doc-1', startIndex: 1, endIndex: 5, bold: true,
      });
      assert.equal(res.isError, false);
    });

    it('formatGoogleDocParagraph delegates successfully', async () => {
      const res = await callTool(ctx.client, 'formatGoogleDocParagraph', {
        documentId: 'doc-1', startIndex: 1, endIndex: 5, alignment: 'CENTER',
      });
      assert.equal(res.isError, false);
    });
  });

  // --- findAndReplaceInDoc ---
  describe('findAndReplaceInDoc', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'findAndReplaceInDoc', {
        documentId: 'doc-1', findText: 'Hello', replaceText: 'Hi',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Replaced'));
    });

    it('dryRun counts matches without replacing', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'My Doc',
          body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Hello Hello World\n' } }] } }] },
        },
      }));
      const res = await callTool(ctx.client, 'findAndReplaceInDoc', {
        documentId: 'doc-1', findText: 'Hello', replaceText: 'Hi', dryRun: true,
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('found 2 occurrence'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'findAndReplaceInDoc', {});
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

    it('passes pagination params', async () => {
      ctx.mocks.drive.service.comments.list._setImpl(async () => ({
        data: { comments: [{ id: 'c1', content: 'Hi', author: { displayName: 'User' }, createdTime: '2025-01-01' }] },
      }));
      await callTool(ctx.client, 'listComments', { documentId: 'doc-1', pageSize: 10, pageToken: 'tok' });
      const calls = ctx.mocks.drive.tracker.getCalls('comments.list');
      const lastArgs = calls[calls.length - 1].args[0];
      assert.equal(lastArgs.pageSize, 10);
      assert.equal(lastArgs.pageToken, 'tok');
    });

    it('returns nextPageToken', async () => {
      ctx.mocks.drive.service.comments.list._setImpl(async () => ({
        data: {
          comments: [{ id: 'c1', content: 'Hi', author: { displayName: 'User' }, createdTime: '2025-01-01' }],
          nextPageToken: 'next-page',
        },
      }));
      const res = await callTool(ctx.client, 'listComments', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('next-page'));
    });

    it('passes includeDeleted', async () => {
      ctx.mocks.drive.service.comments.list._setImpl(async () => ({
        data: { comments: [] },
      }));
      await callTool(ctx.client, 'listComments', { documentId: 'doc-1', includeDeleted: true });
      const calls = ctx.mocks.drive.tracker.getCalls('comments.list');
      const lastArgs = calls[calls.length - 1].args[0];
      assert.equal(lastArgs.includeDeleted, true);
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
  // --- getGoogleDocContent ---
  describe('getGoogleDocContent', () => {
    it('reads multi-tab document', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.multiTab(),
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('=== Tab: Tab1 ==='));
      assert.ok(res.content[0].text.includes('=== Tab: Tab2 ==='));
      assert.ok(res.content[0].text.includes('First tab'));
      assert.ok(res.content[0].text.includes('Second tab'));
    });

    it('reads multi-tab document with nested tabs', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.fullyNested(),
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      // Should include all tabs with proper hierarchy
      assert.ok(res.content[0].text.includes('=== Tab: Tab1 ==='));
      assert.ok(res.content[0].text.includes('First tab'));
      assert.ok(res.content[0].text.includes('=== Tab: Tab1.1 ==='));
      assert.ok(res.content[0].text.includes('First child'));
      assert.ok(res.content[0].text.includes('=== Tab: Tab1.2 ==='));
      assert.ok(res.content[0].text.includes('Second child'));
      assert.ok(res.content[0].text.includes('=== Tab: Tab1.2.1 ==='));
      assert.ok(res.content[0].text.includes('First grandchild'));
      assert.ok(res.content[0].text.includes('=== Tab: Tab2 ==='));
      assert.ok(res.content[0].text.includes('Second tab'));
    });

    it('reads multi-tab document with nested tabs when the document has only one parent tab with child tabs', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.singleParentNested(),
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      // Should include all tabs with proper hierarchy
      assert.ok(res.content[0].text.includes('=== Tab: Tab1 ==='));
      assert.ok(res.content[0].text.includes('First tab'));
      assert.ok(res.content[0].text.includes('=== Tab: Tab1.1 ==='));
      assert.ok(res.content[0].text.includes('First child'));
      assert.ok(res.content[0].text.includes('=== Tab: Tab1.2 ==='));
      assert.ok(res.content[0].text.includes('Second child'));
      assert.ok(res.content[0].text.includes('=== Tab: Tab1.2.1 ==='));
      assert.ok(res.content[0].text.includes('First grandchild'));
    });

    it('falls back to body for single-tab doc', async () => {
      // Default mock has no tabs array, just body.content
      ctx.mocks.docs.service.documents.get._resetImpl();
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Hello World'));
      assert.ok(!res.content[0].text.includes('=== Tab:'));
    });

    it('includes formatting when includeFormatting is true', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Styled Doc',
          tabs: [
            {
              tabProperties: { title: 'Main' },
              documentTab: {
                body: {
                  content: [{
                    paragraph: {
                      elements: [{
                        textRun: {
                          content: 'Bold heading\n',
                          textStyle: {
                            bold: true,
                            weightedFontFamily: { fontFamily: 'Roboto' },
                            fontSize: { magnitude: 18 },
                            foregroundColor: { color: { rgbColor: { red: 1, green: 0, blue: 0 } } },
                          },
                        },
                        startIndex: 1,
                        endIndex: 14,
                      }],
                    },
                  }],
                },
              },
            },
          ],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1', includeFormatting: true });
      assert.equal(res.isError, false);
      const text = res.content[0].text;
      assert.ok(text.includes('font="Roboto"'), 'should include font name');
      assert.ok(text.includes('size=18pt'), 'should include font size');
      assert.ok(text.includes('style=bold'), 'should include bold style');
      assert.ok(text.includes('color=#ff0000'), 'should include foreground color');
      assert.ok(text.includes('--- Fonts summary ---'), 'should include fonts summary');
      assert.ok(text.includes('Roboto: sizes [18 pt], styles [bold]'), 'fonts summary should list Roboto with sizes and styles');
    });

    it('excludes formatting by default', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Styled Doc',
          tabs: [
            {
              tabProperties: { title: 'Main' },
              documentTab: {
                body: {
                  content: [{
                    paragraph: {
                      elements: [{
                        textRun: {
                          content: 'Normal text\n',
                          textStyle: {
                            bold: true,
                            weightedFontFamily: { fontFamily: 'Arial' },
                            fontSize: { magnitude: 12 },
                          },
                        },
                        startIndex: 1,
                        endIndex: 13,
                      }],
                    },
                  }],
                },
              },
            },
          ],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      const text = res.content[0].text;
      assert.ok(!text.includes('font='), 'should not include font metadata');
      assert.ok(!text.includes('--- Fonts summary ---'), 'should not include fonts summary');
      assert.ok(text.includes('Normal text'), 'should still include text content');
    });

    it('includes formatting with multi-tab', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Multi-Tab Styled',
          tabs: [
            {
              tabProperties: { title: 'Tab1' },
              documentTab: {
                body: {
                  content: [{
                    paragraph: {
                      elements: [{
                        textRun: {
                          content: 'First\n',
                          textStyle: { italic: true, weightedFontFamily: { fontFamily: 'Georgia' }, fontSize: { magnitude: 14 } },
                        },
                        startIndex: 1,
                        endIndex: 7,
                      }],
                    },
                  }],
                },
              },
            },
            {
              tabProperties: { title: 'Tab2' },
              documentTab: {
                body: {
                  content: [{
                    paragraph: {
                      elements: [{
                        textRun: {
                          content: 'Second\n',
                          textStyle: { bold: true, weightedFontFamily: { fontFamily: 'Georgia' }, fontSize: { magnitude: 10 } },
                        },
                        startIndex: 1,
                        endIndex: 8,
                      }],
                    },
                  }],
                },
              },
            },
          ],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1', includeFormatting: true });
      assert.equal(res.isError, false);
      const text = res.content[0].text;
      assert.ok(text.includes('=== Tab: Tab1 ==='), 'should have tab headers');
      assert.ok(text.includes('=== Tab: Tab2 ==='), 'should have tab headers');
      assert.ok(text.includes('style=italic'), 'should show italic in Tab1');
      assert.ok(text.includes('style=bold'), 'should show bold in Tab2');
      assert.ok(text.includes('--- Fonts summary ---'), 'should include fonts summary');
      assert.ok(text.includes('Georgia: sizes [10, 14 pt], styles [bold, italic]'), 'fonts summary should aggregate Georgia with sizes and styles');
    });

    it('includes tab headers only when multiple tabs', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Single-Tab Doc',
          tabs: [
            {
              tabProperties: { title: 'Only Tab' },
              documentTab: {
                body: {
                  content: [{ paragraph: { elements: [{ textRun: { content: 'Content here\n' }, startIndex: 1, endIndex: 14 }] } }],
                },
              },
            },
          ],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Content here'));
      assert.ok(!res.content[0].text.includes('=== Tab:'));
    });

    it('extracts person chips', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with chips',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [{
                  paragraph: {
                    elements: [
                      { textRun: { content: 'Assigned to ' }, startIndex: 0, endIndex: 12 },
                      { person: { personProperties: { name: 'Alice', email: 'alice@example.com' } }, startIndex: 12, endIndex: 13 },
                      { textRun: { content: '\n' }, startIndex: 13, endIndex: 14 },
                    ],
                  },
                }],
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('@Alice (alice@example.com)'));
    });

    it('extracts rich links as markdown', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with links',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [{
                  paragraph: {
                    elements: [
                      { textRun: { content: 'See ' }, startIndex: 0, endIndex: 4 },
                      { richLink: { richLinkProperties: { title: 'Design Doc', uri: 'https://docs.google.com/doc/123' } }, startIndex: 4, endIndex: 5 },
                      { textRun: { content: '\n' }, startIndex: 5, endIndex: 6 },
                    ],
                  },
                }],
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('[Design Doc](https://docs.google.com/doc/123)'));
    });

    it('extracts inline images with description', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with image',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [{
                  paragraph: {
                    elements: [
                      { inlineObjectElement: { inlineObjectId: 'obj-1' }, startIndex: 0, endIndex: 1 },
                      { textRun: { content: '\n' }, startIndex: 1, endIndex: 2 },
                    ],
                  },
                }],
              },
              inlineObjects: {
                'obj-1': {
                  inlineObjectProperties: {
                    embeddedObject: { description: 'Architecture diagram' },
                  },
                },
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('[image: Architecture diagram]'));
    });

    it('extracts footnote references', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with footnote',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [{
                  paragraph: {
                    elements: [
                      { textRun: { content: 'Important claim' }, startIndex: 0, endIndex: 15 },
                      { footnoteReference: { footnoteNumber: '1', footnoteId: 'fn-1' }, startIndex: 15, endIndex: 16 },
                      { textRun: { content: '\n' }, startIndex: 16, endIndex: 17 },
                    ],
                  },
                }],
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('[^1]'));
    });

    it('extracts horizontal rules', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with hr',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [
                  { paragraph: { elements: [{ textRun: { content: 'Above\n' }, startIndex: 0, endIndex: 6 }] } },
                  { paragraph: { elements: [{ horizontalRule: {}, startIndex: 6, endIndex: 7 }] } },
                  { paragraph: { elements: [{ textRun: { content: 'Below\n' }, startIndex: 7, endIndex: 13 }] } },
                ],
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('---'));
    });

    it('escapes brackets in rich link titles', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with bracketed link',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [{
                  paragraph: {
                    elements: [
                      { richLink: { richLinkProperties: { title: 'Budget [Draft]', uri: 'https://docs.google.com/doc/456' } }, startIndex: 0, endIndex: 1 },
                      { textRun: { content: '\n' }, startIndex: 1, endIndex: 2 },
                    ],
                  },
                }],
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      const text = res.content[0].text;
      assert.ok(text.includes('Budget \\[Draft\\]'), 'brackets in title should be escaped');
      assert.ok(text.includes('(https://docs.google.com/doc/456)'), 'URL should be preserved');
    });

    it('shows [image] placeholder when inlineObjects map is missing', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with orphan image',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [{
                  paragraph: {
                    elements: [
                      { textRun: { content: 'Before ' }, startIndex: 0, endIndex: 7 },
                      { inlineObjectElement: { inlineObjectId: 'obj-1' }, startIndex: 7, endIndex: 8 },
                      { textRun: { content: ' after\n' }, startIndex: 8, endIndex: 15 },
                    ],
                  },
                }],
              },
              // no inlineObjects map
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('[image]'), 'should show placeholder even without inlineObjects map');
    });
  });

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

  describe('v1.6.0 docs tab/chip tools', () => {
    it('addDocumentTab happy path', async () => {
      const res = await callTool(ctx.client, 'addDocumentTab', { documentId: 'doc-1', title: 'New Tab' });
      assert.equal(res.isError, false);
    });

    it('renameDocumentTab happy path', async () => {
      const res = await callTool(ctx.client, 'renameDocumentTab', { documentId: 'doc-1', tabId: 'tab-1', title: 'Renamed' });
      assert.equal(res.isError, false);
    });

    it('insertSmartChip happy path', async () => {
      const res = await callTool(ctx.client, 'insertSmartChip', { documentId: 'doc-1', index: 1, chipType: 'person', personEmail: 'user@example.com' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('user@example.com'));

      // Verify the batchUpdate request uses insertPerson (not insertInlineObject)
      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      const lastCall = calls[calls.length - 1];
      const requests = lastCall?.args?.[0]?.requestBody?.requests;
      assert.ok(requests?.length === 1);
      assert.ok('insertPerson' in requests[0], 'request should use insertPerson');
      assert.equal(requests[0].insertPerson.personProperties.email, 'user@example.com');
    });

    it('insertSmartChip rejects missing email', async () => {
      const res = await callTool(ctx.client, 'insertSmartChip', { documentId: 'doc-1', index: 1, chipType: 'person' });
      assert.equal(res.isError, true);
    });

    it('readSmartChips happy path', async () => {
      const res = await callTool(ctx.client, 'readSmartChips', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
    });
  });
});
