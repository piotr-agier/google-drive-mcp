import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { Readable } from 'node:stream';
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
    // Reset stub impls that individual blocks override on drive.files.get so a
    // per-block override (e.g. insertText/deleteRange forcing a Google-Docs
    // mimeType) does not leak into later tests and make the suite order-dependent.
    ctx.mocks.drive.service.files.get._resetImpl();
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
      assert.ok(res.content[0].text!.includes('My Doc'));
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
      assert.ok(res.content[0].text!.includes('Updated Google Doc'));

      // Non-tabId path: still two separate batchUpdate calls (existing behavior).
      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      assert.equal(calls.length, 2);
    });

    it('with tabId issues a single atomic batchUpdate scoped to the tab', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Multi-Tab Doc',
          tabs: [
            { tabProperties: { tabId: 'tab-1', title: 'Tab1' }, documentTab: { body: { content: [{ endIndex: 5 }] } } },
            { tabProperties: { tabId: 'tab-2', title: 'Tab2' }, documentTab: { body: { content: [{ endIndex: 20 }] } } },
          ],
        },
      }));
      const res = await callTool(ctx.client, 'updateGoogleDoc', { documentId: 'doc-1', content: 'New tab content', tabId: 'tab-2' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('tab: tab-2'));

      // Verify documents.get was called with includeTabsContent.
      const getCalls = ctx.mocks.docs.tracker.getCalls('documents.get');
      assert.equal(getCalls[getCalls.length - 1]?.args?.[0]?.includeTabsContent, true);

      // Exactly one batchUpdate — atomic.
      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      assert.equal(calls.length, 1);

      const requests = calls[0]?.args?.[0]?.requestBody?.requests;
      assert.equal(requests?.length, 3);
      assert.equal(requests[0].deleteContentRange.range.tabId, 'tab-2');
      assert.equal(requests[0].deleteContentRange.range.startIndex, 1);
      assert.equal(requests[0].deleteContentRange.range.endIndex, 19);
      assert.equal(requests[1].insertText.location.tabId, 'tab-2');
      assert.equal(requests[1].insertText.location.index, 1);
      assert.equal(requests[1].insertText.text, 'New tab content');
      assert.equal(requests[2].updateParagraphStyle.range.tabId, 'tab-2');
    });

    it('with tabId finds nested child tab', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Nested',
          tabs: [
            {
              tabProperties: { tabId: 'tab-1', title: 'Tab1' },
              documentTab: { body: { content: [{ endIndex: 5 }] } },
              childTabs: [
                { tabProperties: { tabId: 'tab-1-1', title: 'Child' }, documentTab: { body: { content: [{ endIndex: 8 }] } } },
              ],
            },
          ],
        },
      }));
      const res = await callTool(ctx.client, 'updateGoogleDoc', { documentId: 'doc-1', content: 'deep', tabId: 'tab-1-1' });
      assert.equal(res.isError, false);

      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      assert.equal(calls.length, 1);
      const requests = calls[0]?.args?.[0]?.requestBody?.requests;
      assert.equal(requests[0].deleteContentRange.range.tabId, 'tab-1-1');
      assert.equal(requests[0].deleteContentRange.range.endIndex, 7);
    });

    it('with tabId on empty tab: skips deleteContentRange', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Multi-Tab Doc',
          tabs: [
            { tabProperties: { tabId: 'tab-1', title: 'Empty' }, documentTab: { body: { content: [{ endIndex: 1 }] } } },
          ],
        },
      }));
      const res = await callTool(ctx.client, 'updateGoogleDoc', { documentId: 'doc-1', content: 'fresh', tabId: 'tab-1' });
      assert.equal(res.isError, false);

      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      assert.equal(calls.length, 1);
      const requests = calls[0]?.args?.[0]?.requestBody?.requests;
      assert.equal(requests?.length, 2);
      assert.ok('insertText' in requests[0]);
      assert.ok('updateParagraphStyle' in requests[1]);
    });

    it('unknown tabId returns error and issues no batchUpdate', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Multi-Tab Doc',
          tabs: [
            { tabProperties: { tabId: 'tab-1', title: 'Tab1' }, documentTab: { body: { content: [{ endIndex: 5 }] } } },
          ],
        },
      }));
      const res = await callTool(ctx.client, 'updateGoogleDoc', { documentId: 'doc-1', content: 'x', tabId: 'missing' });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text!.includes('Tab with ID "missing" not found'));
      assert.ok(res.content[0].text!.includes('listDocumentTabs'));

      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      assert.equal(calls.length, 0);
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'updateGoogleDoc', {});
      assert.equal(res.isError, true);
    });
  });

  // --- insertText ---
  describe('insertText', () => {
    beforeEach(() => {
      ctx.mocks.drive.service.files.get._setImpl(async () => ({
        data: { id: 'doc-1', name: 'My Doc', mimeType: 'application/vnd.google-apps.document', parents: ['root'] },
      }));
    });

    it('happy path', async () => {
      const res = await callTool(ctx.client, 'insertText', { documentId: 'doc-1', text: 'inserted', index: 1 });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('inserted'));
    });

    it('with tabId forwards tabId to Location', async () => {
      const res = await callTool(ctx.client, 'insertText', { documentId: 'doc-1', text: 'hello', index: 1, tabId: 'tab-7' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('tab-7'));

      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      const lastCall = calls[calls.length - 1];
      const requests = lastCall?.args?.[0]?.requestBody?.requests;
      assert.equal(requests?.length, 1);
      assert.equal(requests[0].insertText.location.tabId, 'tab-7');
      assert.equal(requests[0].insertText.location.index, 1);
      assert.equal(requests[0].insertText.text, 'hello');
    });

    it('rejects index 0 on a Google Doc (1-based)', async () => {
      const res = await callTool(ctx.client, 'insertText', { documentId: 'doc-1', text: 'x', index: 0 });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text!.includes('1-based'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'insertText', {});
      assert.equal(res.isError, true);
    });
  });

  // --- deleteRange ---
  describe('deleteRange', () => {
    beforeEach(() => {
      ctx.mocks.drive.service.files.get._setImpl(async () => ({
        data: { id: 'doc-1', name: 'My Doc', mimeType: 'application/vnd.google-apps.document', parents: ['root'] },
      }));
    });

    it('happy path', async () => {
      const res = await callTool(ctx.client, 'deleteRange', { documentId: 'doc-1', startIndex: 1, endIndex: 5 });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('deleted'));
    });

    it('with tabId forwards tabId to Range', async () => {
      const res = await callTool(ctx.client, 'deleteRange', { documentId: 'doc-1', startIndex: 1, endIndex: 5, tabId: 'tab-7' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('tab-7'));

      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      const lastCall = calls[calls.length - 1];
      const requests = lastCall?.args?.[0]?.requestBody?.requests;
      assert.equal(requests?.length, 1);
      assert.equal(requests[0].deleteContentRange.range.tabId, 'tab-7');
      assert.equal(requests[0].deleteContentRange.range.startIndex, 1);
      assert.equal(requests[0].deleteContentRange.range.endIndex, 5);
    });

    it('validation: endIndex must be > startIndex', async () => {
      const res = await callTool(ctx.client, 'deleteRange', { documentId: 'doc-1', startIndex: 5, endIndex: 2 });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text!.toLowerCase().includes('end index'));
    });

    it('rejects startIndex 0 on a Google Doc (1-based)', async () => {
      const res = await callTool(ctx.client, 'deleteRange', { documentId: 'doc-1', startIndex: 0, endIndex: 3 });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text!.includes('1-based'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'deleteRange', {});
      assert.equal(res.isError, true);
    });
  });

  // --- insertText / deleteRange on text/* files ---
  describe('text-file editing', () => {
    // files.get is a single stub reached both for the metadata read and the
    // alt:'media' content download, so branch on params.alt.
    function stubTextFile(content: string, mimeType = 'text/plain', name = 'notes.txt') {
      ctx.mocks.drive.service.files.get._setImpl(async (p: any) =>
        p?.alt === 'media'
          ? { data: Readable.from(Buffer.from(content, 'utf-8')) }
          : { data: { id: 'file-1', name, mimeType, parents: ['root'] } });
    }

    function lastWrittenBody(): Buffer {
      const updates = ctx.mocks.drive.tracker.getCalls('files.update');
      return updates[updates.length - 1].args[0].media.body as Buffer;
    }

    afterEach(() => {
      ctx.mocks.drive.service.files.get._resetImpl();
    });

    it('insertText inserts at a code-point offset', async () => {
      stubTextFile('Hello World');
      const res = await callTool(ctx.client, 'insertText', { documentId: 'file-1', text: 'X', index: 5 });
      assert.equal(res.isError, false);
      assert.equal(lastWrittenBody().toString('utf-8'), 'HelloX World');
    });

    it('insertText appends at end of file (index === length)', async () => {
      stubTextFile('abc');
      const res = await callTool(ctx.client, 'insertText', { documentId: 'file-1', text: 'Z', index: 3 });
      assert.equal(res.isError, false);
      assert.equal(lastWrittenBody().toString('utf-8'), 'abcZ');
    });

    it('insertText preserves emoji (no surrogate corruption)', async () => {
      // '😀' is one code point (2 UTF-16 units); insert after it at code-point index 1.
      stubTextFile('😀abc');
      const res = await callTool(ctx.client, 'insertText', { documentId: 'file-1', text: 'X', index: 1 });
      assert.equal(res.isError, false);
      const written = lastWrittenBody().toString('utf-8');
      assert.equal(written, '😀Xabc');
      assert.ok(!written.includes('�'));
    });

    it('insertText past end of file errors', async () => {
      stubTextFile('abc');
      const res = await callTool(ctx.client, 'insertText', { documentId: 'file-1', text: 'X', index: 99 });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text!.includes('beyond end of file'));
    });

    it('insertText rejects tabId on a text file', async () => {
      stubTextFile('abc');
      const res = await callTool(ctx.client, 'insertText', { documentId: 'file-1', text: 'X', index: 0, tabId: 'tab-1' });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text!.includes('tabId is not supported'));
    });

    it('deleteRange removes a code-point range', async () => {
      stubTextFile('Hello World');
      const res = await callTool(ctx.client, 'deleteRange', { documentId: 'file-1', startIndex: 5, endIndex: 11 });
      assert.equal(res.isError, false);
      assert.equal(lastWrittenBody().toString('utf-8'), 'Hello');
    });

    it('deleteRange preserves surrounding emoji (no surrogate corruption)', async () => {
      // 'a😀b': code points a(0) 😀(1) b(2); delete the emoji [1,2).
      stubTextFile('a😀b');
      const res = await callTool(ctx.client, 'deleteRange', { documentId: 'file-1', startIndex: 1, endIndex: 2 });
      assert.equal(res.isError, false);
      const written = lastWrittenBody().toString('utf-8');
      assert.equal(written, 'ab');
      assert.ok(!written.includes('�'));
    });

    it('deleteRange over the whole file writes empty content (not a silent no-op)', async () => {
      stubTextFile('hello\n'); // 6 code points
      const res = await callTool(ctx.client, 'deleteRange', { documentId: 'file-1', startIndex: 0, endIndex: 6 });
      assert.equal(res.isError, false);
      const updates = ctx.mocks.drive.tracker.getCalls('files.update');
      assert.equal(updates.length, 1); // the write actually happened
      const body = updates[0].args[0].media.body as Buffer;
      assert.ok(Buffer.isBuffer(body));
      assert.equal(body.length, 0); // empty Buffer is truthy → uploaded, so the file is emptied
    });

    it('editing works when metadata read fails (drive.file scope fallback → Docs API)', async () => {
      // Simulate drive.file: metadata files.get throws; media read never happens
      // because the handler falls back to the Google-Docs (batchUpdate) path.
      ctx.mocks.drive.service.files.get._setImpl(async () => { throw new Error('File not found: 404'); });
      const res = await callTool(ctx.client, 'insertText', { documentId: 'doc-1', text: 'x', index: 1 });
      assert.equal(res.isError, false);
      assert.equal(ctx.mocks.docs.tracker.getCalls('documents.batchUpdate').length, 1);
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
      assert.ok(res.content[0].text!.includes('Hello World'));
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
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1 ==='));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab2 ==='));
      assert.ok(res.content[0].text!.includes('First tab'));
      assert.ok(res.content[0].text!.includes('Second tab'));
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
      assert.ok(!res.content[0].text!.includes('First tab'));
      assert.ok(res.content[0].text!.includes('Second tab'));
    });

    it('reads specific nested tab by tabId', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.fullyNested(),
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', tabId: 'tab-1-2' });
      assert.equal(res.isError, false);
      assert.ok(!res.content[0].text!.includes('First tab'));
      assert.ok(!res.content[0].text!.includes('First child'));
      assert.ok(res.content[0].text!.includes('Second child'));
      assert.ok(!res.content[0].text!.includes('Second tab'));
    });
    
    it('reads specific nested tab by tabId when the document has only one tab with child tabs', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.singleParentNested(),
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', tabId: 'tab-1-2' });
      assert.equal(res.isError, false);
      assert.ok(!res.content[0].text!.includes('First tab'));
      assert.ok(!res.content[0].text!.includes('First child'));
      assert.ok(res.content[0].text!.includes('Second child'));
      assert.ok(!res.content[0].text!.includes('Second tab'));
    });

    it('reads deeply nested grandchild tab by tabId', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.fullyNested(),
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', tabId: 'tab-1-2-1' });
      assert.equal(res.isError, false);
      assert.ok(!res.content[0].text!.includes('First tab'));
      assert.ok(!res.content[0].text!.includes('First child'));
      assert.ok(res.content[0].text!.includes('First grandchild'));
    });

    it('reads all tabs including nested when no tabId specified', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.fullyNested(),
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      // Should include all tabs with proper hierarchy
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1 ==='));
      assert.ok(res.content[0].text!.includes('First tab'));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1.1 ==='));
      assert.ok(res.content[0].text!.includes('First child'));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1.2 ==='));
      assert.ok(res.content[0].text!.includes('Second child'));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1.2.1 ==='));
      assert.ok(res.content[0].text!.includes('First grandchild'));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab2 ==='));
      assert.ok(res.content[0].text!.includes('Second tab'));
    });
    
    it('reads all tabs including nested when no tabId specified and the document has only one tab with child tabs ', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.singleParentNested(),
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1' });
      assert.equal(res.isError, false);

      // Should include all tabs with proper hierarchy
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1 ==='));
      assert.ok(res.content[0].text!.includes('First tab'));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1.1 ==='));
      assert.ok(res.content[0].text!.includes('First child'));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1.2 ==='));
      assert.ok(res.content[0].text!.includes('Second child'));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1.2.1 ==='));
      assert.ok(res.content[0].text!.includes('First grandchild'));
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
      assert.ok(res.content[0].text!.includes('not found'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'readGoogleDoc', {});
      assert.equal(res.isError, true);
    });

    it('renders inline images as markdown with objectId in title (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with image',
          body: {
            content: [{
              paragraph: {
                elements: [
                  { inlineObjectElement: { inlineObjectId: 'obj-1' } },
                  { textRun: { content: '\n' } },
                ],
              },
            }],
          },
          inlineObjects: {
            'obj-1': {
              inlineObjectProperties: {
                embeddedObject: {
                  description: 'Architecture diagram',
                  imageProperties: { contentUri: 'https://lh3.googleusercontent.com/xyz' },
                },
              },
            },
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('![Architecture diagram](https://lh3.googleusercontent.com/xyz "objectId=obj-1")'), res.content[0].text!);
    });

    it('renders heading paragraphs as ATX hashes (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with headings',
          body: {
            content: [
              { paragraph: { paragraphStyle: { namedStyleType: 'HEADING_1' }, elements: [{ textRun: { content: 'Top level\n' } }] } },
              { paragraph: { paragraphStyle: { namedStyleType: 'HEADING_3' }, elements: [{ textRun: { content: 'Third level\n' } }] } },
              { paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [{ textRun: { content: 'Plain body\n' } }] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('# Top level\n'), text);
      assert.ok(text.includes('### Third level\n'), text);
      assert.ok(text.includes('Plain body\n'), text);
      assert.ok(!text.includes('# Plain body'), text);
    });

    it('does not emit a bare hash for an empty heading paragraph (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with empty heading',
          body: {
            content: [
              { paragraph: { paragraphStyle: { namedStyleType: 'HEADING_2' }, elements: [{ textRun: { content: '\n' } }] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(!text.includes('## '), text);
    });

    it('leaves headings unprefixed in text format', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with headings',
          body: {
            content: [
              { paragraph: { paragraphStyle: { namedStyleType: 'HEADING_1' }, elements: [{ textRun: { content: 'Top level\n' } }] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'text' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('Top level'), text);
      assert.ok(!text.includes('#'), text);
    });

    it('wraps bold, italic and strikethrough runs in emphasis (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with emphasis',
          body: {
            content: [
              { paragraph: { elements: [
                { textRun: { content: 'plain ' } },
                { textRun: { content: 'bold', textStyle: { bold: true } } },
                { textRun: { content: ' and ' } },
                { textRun: { content: 'italic', textStyle: { italic: true } } },
                { textRun: { content: ' and ' } },
                { textRun: { content: 'struck', textStyle: { strikethrough: true } } },
                { textRun: { content: '\n' } },
              ] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('plain **bold** and *italic* and ~~struck~~'), text);
    });

    it('keeps emphasis markers tight around a run that ends the paragraph (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with trailing emphasis',
          body: {
            content: [
              { paragraph: { elements: [
                { textRun: { content: 'lead ' } },
                { textRun: { content: 'bold tail\n', textStyle: { bold: true } } },
              ] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      // The newline must fall outside the markers, otherwise the emphasis never closes.
      assert.ok(text.includes('lead **bold tail**\n'), JSON.stringify(text));
      assert.ok(!text.includes('\n**'), JSON.stringify(text));
    });

    it('leaves emphasis unmarked in text format', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with emphasis',
          body: {
            content: [
              { paragraph: { elements: [
                { textRun: { content: 'bold', textStyle: { bold: true } } },
                { textRun: { content: '\n' } },
              ] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'text' });
      assert.equal(res.isError, false);
      assert.ok(!res.content[0].text!.includes('*'), res.content[0].text!);
    });

    it('renders bulleted and numbered list items with nesting (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with lists',
          body: {
            content: [
              { paragraph: { bullet: { listId: 'l1', nestingLevel: 0 }, elements: [{ textRun: { content: 'first\n' } }] } },
              { paragraph: { bullet: { listId: 'l1', nestingLevel: 1 }, elements: [{ textRun: { content: 'nested\n' } }] } },
              { paragraph: { bullet: { listId: 'l2', nestingLevel: 0 }, elements: [{ textRun: { content: 'step one\n' } }] } },
            ],
          },
          lists: {
            l1: { listProperties: { nestingLevels: [{ glyphSymbol: '●' }, { glyphSymbol: '○' }] } },
            l2: { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }] } },
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('- first\n'), JSON.stringify(text));
      assert.ok(text.includes('  - nested\n'), JSON.stringify(text));
      assert.ok(text.includes('1. step one\n'), JSON.stringify(text));
    });

    it('renders a bulleted heading as a list item, not a heading (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with bulleted heading',
          body: {
            content: [
              { paragraph: { paragraphStyle: { namedStyleType: 'HEADING_2' }, bullet: { listId: 'l1', nestingLevel: 0 }, elements: [{ textRun: { content: 'item\n' } }] } },
            ],
          },
          lists: { l1: { listProperties: { nestingLevels: [{ glyphSymbol: '●' }] } } },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('- item\n'), JSON.stringify(text));
      assert.ok(!text.includes('## item'), JSON.stringify(text));
    });

    it('renders tables as pipe tables (format=markdown)', async () => {
      const cell = (content: string) => ({ content: [{ paragraph: { elements: [{ textRun: { content } }] } }] });
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with table',
          body: {
            content: [
              { table: { tableRows: [
                { tableCells: [cell('Owner'), cell('Role')] },
                { tableCells: [cell('Eero'), cell('CEO')] },
              ] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('| Owner | Role |'), JSON.stringify(text));
      assert.ok(text.includes('| --- | --- |'), JSON.stringify(text));
      assert.ok(text.includes('| Eero | CEO |'), JSON.stringify(text));
    });

    it('escapes pipe characters inside table cells (format=markdown)', async () => {
      const cell = (content: string) => ({ content: [{ paragraph: { elements: [{ textRun: { content } }] } }] });
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with pipe',
          body: {
            content: [
              { table: { tableRows: [{ tableCells: [cell('a | b'), cell('c')] }] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('| a \\| b | c |'), JSON.stringify(res.content[0].text!));
    });

    it('separates consecutive paragraphs with a blank line (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with paragraphs',
          body: {
            content: [
              { paragraph: { elements: [{ textRun: { content: 'First para\n' } }] } },
              { paragraph: { elements: [{ textRun: { content: 'Second para\n' } }] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      // A single newline is only a soft break — the two paragraphs would render
      // as one.
      assert.ok(text.includes('First para\n\nSecond para\n'), JSON.stringify(text));
    });

    it('separates a heading from the paragraph that follows it (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with heading',
          body: {
            content: [
              { paragraph: { paragraphStyle: { namedStyleType: 'HEADING_1' }, elements: [{ textRun: { content: 'Section\n' } }] } },
              { paragraph: { elements: [{ textRun: { content: 'Body\n' } }] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('# Section\n\nBody\n'), JSON.stringify(res.content[0].text!));
    });

    it('keeps consecutive list items on adjacent lines (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with list',
          body: {
            content: [
              { paragraph: { bullet: { listId: 'l1', nestingLevel: 0 }, elements: [{ textRun: { content: 'one\n' } }] } },
              { paragraph: { bullet: { listId: 'l1', nestingLevel: 0 }, elements: [{ textRun: { content: 'two\n' } }] } },
            ],
          },
          lists: { l1: { listProperties: { nestingLevels: [{ glyphSymbol: '●' }] } } },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      // Blank lines between items would make the list loose.
      assert.ok(res.content[0].text!.includes('- one\n- two\n'), JSON.stringify(res.content[0].text!));
    });

    it('maps TITLE and SUBTITLE named styles to headings (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with title styles',
          body: {
            content: [
              { paragraph: { paragraphStyle: { namedStyleType: 'TITLE' }, elements: [{ textRun: { content: 'The Title\n' } }] } },
              { paragraph: { paragraphStyle: { namedStyleType: 'SUBTITLE' }, elements: [{ textRun: { content: 'The Subtitle\n' } }] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('# The Title\n'), JSON.stringify(text));
      assert.ok(text.includes('## The Subtitle\n'), JSON.stringify(text));
    });

    it('does not repeat the document title when the body carries the same TITLE paragraph', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Quarterly Review',
          body: {
            content: [
              { paragraph: { paragraphStyle: { namedStyleType: 'TITLE' }, elements: [{ textRun: { content: 'Quarterly Review\n' } }] } },
              { paragraph: { elements: [{ textRun: { content: 'Body\n' } }] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.equal(text, '# Quarterly Review\n\nBody\n');
    });

    it('still prepends the document title when the body has no matching TITLE paragraph', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Real Title',
          body: {
            content: [
              { paragraph: { paragraphStyle: { namedStyleType: 'TITLE' }, elements: [{ textRun: { content: 'Something else\n' } }] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      assert.equal(res.content[0].text!, '# Real Title\n\n# Something else\n');
    });

    it('indents a nested item past an ordered parent marker (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with ordered nesting',
          body: {
            content: [
              { paragraph: { bullet: { listId: 'l1', nestingLevel: 0 }, elements: [{ textRun: { content: 'step one\n' } }] } },
              { paragraph: { bullet: { listId: 'l1', nestingLevel: 1 }, elements: [{ textRun: { content: 'detail\n' } }] } },
            ],
          },
          lists: {
            l1: { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }, { glyphSymbol: '○' }] } },
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      // `1. ` is three columns wide, so a two-space indent would leave the child
      // outside the parent item and CommonMark would render a sibling list.
      assert.ok(text.includes('1. step one\n   - detail\n'), JSON.stringify(text));
    });

    it('pads rows so a merged header cell does not truncate body columns (format=markdown)', async () => {
      const cell = (content: string, columnSpan?: number) => ({
        content: [{ paragraph: { elements: [{ textRun: { content } }] } }],
        ...(columnSpan ? { tableCellStyle: { columnSpan } } : {}),
      });
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with merged header',
          body: {
            content: [
              { table: { tableRows: [
                { tableCells: [cell('Quarterly plan', 3)] },
                { tableCells: [cell('a'), cell('b'), cell('c')] },
              ] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      // GFM sizes the table from the header: a one-column header would drop
      // columns b and c from the rendering entirely.
      assert.ok(text.includes('| Quarterly plan |  |  |\n| --- | --- | --- |\n| a | b | c |'), JSON.stringify(text));
    });

    it('preserves multi-paragraph table cell structure with <br> (format=markdown)', async () => {
      const multiCell = {
        content: [
          { paragraph: { bullet: { listId: 'l1', nestingLevel: 0 }, elements: [{ textRun: { content: 'item one\n' } }] } },
          { paragraph: { bullet: { listId: 'l1', nestingLevel: 0 }, elements: [{ textRun: { content: 'item two\n' } }] } },
        ],
      };
      const cell = (content: string) => ({ content: [{ paragraph: { elements: [{ textRun: { content } }] } }] });
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with multiline cell',
          body: {
            content: [
              { table: { tableRows: [{ tableCells: [multiCell, cell('other')] }] } },
            ],
          },
          lists: { l1: { listProperties: { nestingLevels: [{ glyphSymbol: '●' }] } } },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      // Space-joining would render "- item one - item two" with no boundary.
      assert.ok(text.includes('| - item one<br>- item two | other |'), JSON.stringify(text));
    });

    it('does not fuse emphasis delimiters between abutting styled runs (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with abutting runs',
          body: {
            content: [
              { paragraph: { elements: [
                { textRun: { content: 're', textStyle: { bold: true } } },
                { textRun: { content: 'ally', textStyle: { bold: true, italic: true } } },
                { textRun: { content: '\n' } },
              ] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      // Wrapping each run separately yields `**re*****ally***`, which renders as
      // literal asterisks.
      assert.ok(!text.includes('*****'), JSON.stringify(text));
      assert.ok(text.includes('**re*ally***\n'), JSON.stringify(text));
    });

    it('merges runs that Docs split without a style change (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with split run',
          body: {
            content: [
              { paragraph: { elements: [
                { textRun: { content: 'bold ', textStyle: { bold: true } } },
                { textRun: { content: 'across runs', textStyle: { bold: true } } },
                { textRun: { content: '\n' } },
              ] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('**bold across runs**\n'), JSON.stringify(res.content[0].text!));
    });

    it('escapes markdown metacharacters in document text (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with metacharacters',
          body: {
            content: [
              { paragraph: { elements: [
                { textRun: { content: 'a*b', textStyle: { bold: true } } },
                { textRun: { content: ' and [1]\n' } },
              ] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      // Unescaped, the inner `*` pairs with a surrounding marker and breaks the
      // bold span.
      assert.ok(text.includes('**a\\*b**'), JSON.stringify(text));
      assert.ok(text.includes('\\[1\\]'), JSON.stringify(text));
    });

    it('leaves intraword underscores unescaped (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with snake_case',
          body: {
            content: [
              { paragraph: { elements: [{ textRun: { content: 'call snake_case_name now\n' } }] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      // CommonMark does not treat intraword `_` as emphasis, so escaping it
      // would only add noise.
      assert.ok(res.content[0].text!.includes('snake_case_name'), JSON.stringify(res.content[0].text!));
    });

    it('renders person, rich link, footnote and horizontal rule elements (format=markdown)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with inline elements',
          body: {
            content: [
              { paragraph: { elements: [
                { textRun: { content: 'Owner: ' } },
                { person: { personProperties: { name: 'Ada', email: 'ada@example.com' } } },
                { textRun: { content: ' see ' } },
                { richLink: { richLinkProperties: { title: 'Spec', uri: 'https://example.com/spec' } } },
                { footnoteReference: { footnoteNumber: '1' } },
                { textRun: { content: '\n' } },
              ] } },
              { paragraph: { elements: [{ horizontalRule: {} }] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('@Ada (ada@example.com)'), JSON.stringify(text));
      assert.ok(text.includes('[Spec](https://example.com/spec)'), JSON.stringify(text));
      assert.ok(text.includes('[^1]'), JSON.stringify(text));
      assert.ok(text.includes('---'), JSON.stringify(text));
    });

    it('leaves person chips out of text format', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with person',
          body: {
            content: [
              { paragraph: { elements: [
                { textRun: { content: 'Owner: ' } },
                { person: { personProperties: { name: 'Ada', email: 'ada@example.com' } } },
                { textRun: { content: '\n' } },
              ] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'text' });
      assert.equal(res.isError, false);
      // Text output is unchanged by the markdown work.
      assert.ok(!res.content[0].text!.includes('@Ada'), JSON.stringify(res.content[0].text!));
    });

    it('keeps tables tab-separated in text format', async () => {
      const cell = (content: string) => ({ content: [{ paragraph: { elements: [{ textRun: { content } }] } }] });
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with table',
          body: {
            content: [
              { table: { tableRows: [{ tableCells: [cell('Owner'), cell('Role')] }] } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'text' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('Owner\tRole\t'), JSON.stringify(text));
      assert.ok(!text.includes('|'), JSON.stringify(text));
    });

    it('renders inline images as a single-line placeholder (format=text)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with image',
          body: {
            content: [{
              paragraph: {
                elements: [
                  { textRun: { content: 'Before ' } },
                  { inlineObjectElement: { inlineObjectId: 'obj-1' } },
                  { textRun: { content: ' after\n' } },
                ],
              },
            }],
          },
          inlineObjects: {
            'obj-1': {
              inlineObjectProperties: {
                embeddedObject: { imageProperties: { contentUri: 'https://lh3.googleusercontent.com/xyz' } },
              },
            },
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('[image: objectId=obj-1 contentUri=https://lh3.googleusercontent.com/xyz]'), text);
      // no markdown syntax in text format
      assert.ok(!text.includes('!['), 'text format should not emit markdown image syntax');
    });

    it('falls back to [image] when the inlineObjects map is missing', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with orphan image',
          body: {
            content: [{
              paragraph: {
                elements: [
                  { inlineObjectElement: { inlineObjectId: 'obj-1' } },
                  { textRun: { content: '\n' } },
                ],
              },
            }],
            // no inlineObjects map
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('[image]'), res.content[0].text!);
    });

    it('resolves a multi-tab image against the correct tab inlineObjects map', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Multi-tab image doc',
          tabs: [
            {
              tabProperties: { tabId: 'tab-1', title: 'Tab1' },
              documentTab: {
                body: { content: [{ paragraph: { elements: [{ textRun: { content: 'First tab\n' } }] } }] },
                inlineObjects: {},
              },
            },
            {
              tabProperties: { tabId: 'tab-2', title: 'Tab2' },
              documentTab: {
                body: {
                  content: [{
                    paragraph: {
                      elements: [
                        { inlineObjectElement: { inlineObjectId: 'obj-2' } },
                        { textRun: { content: '\n' } },
                      ],
                    },
                  }],
                },
                inlineObjects: {
                  'obj-2': {
                    inlineObjectProperties: {
                      embeddedObject: { imageProperties: { contentUri: 'https://lh3.googleusercontent.com/tab2' } },
                    },
                  },
                },
              },
            },
          ],
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('contentUri=https://lh3.googleusercontent.com/tab2'), res.content[0].text!);
    });

    it('readGoogleDocPaginated carries inline images (proves format threading)', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Paginated image doc',
          body: {
            content: [{
              paragraph: {
                elements: [
                  { inlineObjectElement: { inlineObjectId: 'obj-1' } },
                  { textRun: { content: '\n' } },
                ],
              },
            }],
          },
          inlineObjects: {
            'obj-1': {
              inlineObjectProperties: {
                embeddedObject: {
                  description: 'Diagram',
                  imageProperties: { contentUri: 'https://lh3.googleusercontent.com/xyz' },
                },
              },
            },
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDocPaginated', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const envelope = JSON.parse(res.content[0].text!);
      assert.ok(envelope.content.includes('![Diagram](https://lh3.googleusercontent.com/xyz "objectId=obj-1")'), envelope.content);
    });

    it('prefers the durable sourceUri over the ephemeral contentUri in markdown', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with sourced image',
          body: {
            content: [{
              paragraph: {
                elements: [
                  { inlineObjectElement: { inlineObjectId: 'obj-1' } },
                  { textRun: { content: '\n' } },
                ],
              },
            }],
          },
          inlineObjects: {
            'obj-1': {
              inlineObjectProperties: {
                embeddedObject: {
                  description: 'Diagram',
                  imageProperties: {
                    contentUri: 'https://lh3.googleusercontent.com/ephemeral',
                    sourceUri: 'https://example.com/durable.png',
                  },
                },
              },
            },
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('![Diagram](https://example.com/durable.png "objectId=obj-1")'), text);
      assert.ok(!text.includes('lh3.googleusercontent.com'), 'ephemeral contentUri must not be used when a sourceUri exists');
    });

    it('percent-encodes spaces and parentheses in the markdown image URL', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with spaced uri',
          body: {
            content: [{
              paragraph: {
                elements: [
                  { inlineObjectElement: { inlineObjectId: 'obj-1' } },
                  { textRun: { content: '\n' } },
                ],
              },
            }],
          },
          inlineObjects: {
            'obj-1': {
              inlineObjectProperties: {
                embeddedObject: {
                  imageProperties: { sourceUri: 'https://example.com/a b(1).png' },
                },
              },
            },
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-1', format: 'markdown' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('![](https://example.com/a%20b%281%29.png "objectId=obj-1")'), text);
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
      assert.ok(res.content[0].text!.includes('applied text style'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'applyTextStyle', {});
      assert.equal(res.isError, true);
    });

    it('accepts baselineOffset as the only style option', async () => {
      const res = await callTool(ctx.client, 'applyTextStyle', {
        documentId: 'doc-1', startIndex: 1, endIndex: 5, baselineOffset: 'SUPERSCRIPT',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('applied text style'));
    });

    it('rejects an invalid baselineOffset value', async () => {
      const res = await callTool(ctx.client, 'applyTextStyle', {
        documentId: 'doc-1', startIndex: 1, endIndex: 5, baselineOffset: 'MIDDLE',
      });
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
      assert.ok(res.content[0].text!.includes('applied paragraph style'));
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
      assert.ok(res.content[0].text!.includes('Replaced'));
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
      assert.ok(res.content[0].text!.includes('found 2 occurrence'));
    });

    it('with tabId scopes replacement via tabsCriteria', async () => {
      const res = await callTool(ctx.client, 'findAndReplaceInDoc', {
        documentId: 'doc-1', findText: 'Hello', replaceText: 'Hi', tabId: 'tab-2',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('tab-2'));

      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      const lastCall = calls[calls.length - 1];
      const requests = lastCall?.args?.[0]?.requestBody?.requests;
      assert.equal(requests?.length, 1);
      assert.deepEqual(requests[0].replaceAllText.tabsCriteria, { tabIds: ['tab-2'] });
      assert.equal(requests[0].replaceAllText.containsText.text, 'Hello');
    });

    it('without tabId omits tabsCriteria', async () => {
      const res = await callTool(ctx.client, 'findAndReplaceInDoc', {
        documentId: 'doc-1', findText: 'Hello', replaceText: 'Hi',
      });
      assert.equal(res.isError, false);

      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      const lastCall = calls[calls.length - 1];
      const requests = lastCall?.args?.[0]?.requestBody?.requests;
      assert.equal(requests[0].replaceAllText.tabsCriteria, undefined);
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
      assert.ok(res.content[0].text!.includes('Nice!'));
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
      assert.ok(res.content[0].text!.includes('next-page'));
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
      assert.ok(res.content[0].text!.includes('Comment added'));
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
      assert.ok(res.content[0].text!.includes('Reply added'));
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
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1 ==='));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab2 ==='));
      assert.ok(res.content[0].text!.includes('First tab'));
      assert.ok(res.content[0].text!.includes('Second tab'));
    });

    it('reads multi-tab document with nested tabs', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.fullyNested(),
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      // Should include all tabs with proper hierarchy
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1 ==='));
      assert.ok(res.content[0].text!.includes('First tab'));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1.1 ==='));
      assert.ok(res.content[0].text!.includes('First child'));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1.2 ==='));
      assert.ok(res.content[0].text!.includes('Second child'));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1.2.1 ==='));
      assert.ok(res.content[0].text!.includes('First grandchild'));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab2 ==='));
      assert.ok(res.content[0].text!.includes('Second tab'));
    });

    it('reads multi-tab document with nested tabs when the document has only one parent tab with child tabs', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: mockDocs.singleParentNested(),
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      // Should include all tabs with proper hierarchy
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1 ==='));
      assert.ok(res.content[0].text!.includes('First tab'));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1.1 ==='));
      assert.ok(res.content[0].text!.includes('First child'));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1.2 ==='));
      assert.ok(res.content[0].text!.includes('Second child'));
      assert.ok(res.content[0].text!.includes('=== Tab: Tab1.2.1 ==='));
      assert.ok(res.content[0].text!.includes('First grandchild'));
    });

    it('falls back to body for single-tab doc', async () => {
      // Default mock has no tabs array, just body.content
      ctx.mocks.docs.service.documents.get._resetImpl();
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('Hello World'));
      assert.ok(!res.content[0].text!.includes('=== Tab:'));
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
      const text = res.content[0].text!;
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
      const text = res.content[0].text!;
      assert.ok(!text.includes('font='), 'should not include font metadata');
      assert.ok(!text.includes('--- Fonts summary ---'), 'should not include fonts summary');
      assert.ok(text.includes('Normal text'), 'should still include text content');
    });

    it('surfaces superscript/subscript runs on the formatted read path', async () => {
      // Without this, text written by applyTextStyle({ baselineOffset })
      // reads back indistinguishable from unformatted text.
      const styledRun = (content: string, baselineOffset: string, startIndex: number, endIndex: number) => ({
        textRun: { content, textStyle: { baselineOffset } },
        startIndex,
        endIndex,
      });
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Baseline Doc',
          tabs: [
            {
              tabProperties: { title: 'Main' },
              documentTab: {
                body: {
                  content: [{
                    paragraph: {
                      elements: [
                        styledRun('E = mc\n', 'NONE', 1, 8),
                        styledRun('2\n', 'SUPERSCRIPT', 8, 10),
                        styledRun('H2O\n', 'SUBSCRIPT', 10, 14),
                      ],
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
      const text = res.content[0].text!;
      assert.ok(text.includes('baseline=superscript'), 'should mark the superscript run');
      assert.ok(text.includes('baseline=subscript'), 'should mark the subscript run');
      // NONE is what the API reports for ordinary text; emitting it would force
      // a meta line onto every unformatted run.
      assert.ok(!text.includes('baseline=none'), 'should not mark normal-baseline runs');
      const normalLine = text.split('\n').find((l) => l.includes('E = mc'))!;
      assert.ok(!normalLine.includes('baseline='), 'normal run should carry no baseline marker');
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
      const text = res.content[0].text!;
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
      assert.ok(res.content[0].text!.includes('Content here'));
      assert.ok(!res.content[0].text!.includes('=== Tab:'));
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
      assert.ok(res.content[0].text!.includes('@Alice (alice@example.com)'));
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
      assert.ok(res.content[0].text!.includes('[Design Doc](https://docs.google.com/doc/123)'));
    });

    it('extracts inline images with description, uri, and size on one line', async () => {
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
                    embeddedObject: {
                      description: 'Architecture diagram',
                      imageProperties: {
                        contentUri: 'https://lh3.googleusercontent.com/xyz',
                        sourceUri: 'https://example.com/a.png',
                      },
                      size: {
                        width: { magnitude: 468, unit: 'PT' },
                        height: { magnitude: 286, unit: 'PT' },
                      },
                    },
                  },
                },
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      // The whole image token must live on a single line.
      const imageLine = text.split('\n').find(l => l.includes('objectId=obj-1'));
      assert.ok(imageLine, 'image token should be present on one line');
      assert.ok(imageLine!.includes('alt="Architecture diagram"'));
      assert.ok(imageLine!.includes('contentUri=https://lh3.googleusercontent.com/xyz'));
      assert.ok(imageLine!.includes('sourceUri=https://example.com/a.png'));
      assert.ok(imageLine!.includes('size=468x286pt'));
    });

    it('surfaces sourceUri when contentUri is absent', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with source-only image',
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
                    embeddedObject: {
                      imageProperties: { sourceUri: 'https://example.com/a.png' },
                    },
                  },
                },
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('sourceUri=https://example.com/a.png'));
      assert.ok(!text.includes('contentUri='), 'contentUri should be omitted when absent');
    });

    it('escapes brackets and quotes in image alt text', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with bracketed alt',
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
                    embeddedObject: {
                      description: 'Chart [v2] "final"',
                      imageProperties: { contentUri: 'https://lh3.googleusercontent.com/xyz' },
                    },
                  },
                },
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('alt="Chart \\[v2\\] \\"final\\""'), `alt not escaped: ${text}`);
    });

    it('labels an inline image with its true 1-index span, not the placeholder length', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with indexed image',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [{
                  paragraph: {
                    elements: [
                      { textRun: { content: 'See ' }, startIndex: 1, endIndex: 5 },
                      { inlineObjectElement: { inlineObjectId: 'obj-1' }, startIndex: 5, endIndex: 6 },
                      { textRun: { content: ' here\n' }, startIndex: 6, endIndex: 12 },
                    ],
                  },
                }],
              },
              inlineObjects: {
                'obj-1': {
                  inlineObjectProperties: {
                    embeddedObject: {
                      imageProperties: { contentUri: 'https://lh3.googleusercontent.com/' + 'x'.repeat(120) },
                    },
                  },
                },
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      const imageLine = text.split('\n').find(l => l.includes('objectId=obj-1'));
      assert.ok(imageLine, 'image token should be present');
      // The displayed edit range must be the image's real 1-index span [5-6],
      // never [5 .. 5+placeholderLength] (which would over-delete following text).
      assert.ok(imageLine!.startsWith('[5-6] '), `expected [5-6] span, got: ${imageLine}`);
    });

    it('keeps a multi-line alt-text description on a single placeholder line', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with multi-line alt',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [{
                  paragraph: {
                    elements: [
                      { inlineObjectElement: { inlineObjectId: 'obj-1' }, startIndex: 1, endIndex: 2 },
                      { textRun: { content: '\n' }, startIndex: 2, endIndex: 3 },
                    ],
                  },
                }],
              },
              inlineObjects: {
                'obj-1': {
                  inlineObjectProperties: {
                    embeddedObject: {
                      description: 'Line one\nLine two',
                      imageProperties: { contentUri: 'https://lh3.googleusercontent.com/xyz' },
                    },
                  },
                },
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      const imageLine = text.split('\n').find(l => l.includes('objectId=obj-1'));
      assert.ok(imageLine, 'image token should be present on one line');
      // The newline in the alt text must be collapsed to a space, not leak into output.
      assert.ok(imageLine!.includes('alt="Line one Line two"'), `alt not single-lined: ${imageLine}`);
    });

    it('escapes square brackets in image URIs so the placeholder is not truncated', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with bracketed uri',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [{
                  paragraph: {
                    elements: [
                      { inlineObjectElement: { inlineObjectId: 'obj-1' }, startIndex: 1, endIndex: 2 },
                      { textRun: { content: '\n' }, startIndex: 2, endIndex: 3 },
                    ],
                  },
                }],
              },
              inlineObjects: {
                'obj-1': {
                  inlineObjectProperties: {
                    embeddedObject: {
                      imageProperties: { sourceUri: 'https://example.com/a]b.png' },
                    },
                  },
                },
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      const imageLine = text.split('\n').find(l => l.includes('objectId=obj-1'));
      assert.ok(imageLine, 'image token should be present');
      // The `]` in the URI must be escaped so it does not close the [image: ...] delimiter early.
      assert.ok(imageLine!.includes('sourceUri=https://example.com/a\\]b.png'), `uri not escaped: ${imageLine}`);
      assert.ok(imageLine!.trimEnd().endsWith(']'), 'placeholder should still be closed by a trailing ]');
    });

    it('renders inline images inside table cells without embedded pipes', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with table image',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [{
                  startIndex: 0,
                  endIndex: 2,
                  table: {
                    tableRows: [{
                      tableCells: [{
                        content: [{
                          paragraph: {
                            elements: [
                              { inlineObjectElement: { inlineObjectId: 'obj-1' }, startIndex: 1, endIndex: 2 },
                            ],
                          },
                        }],
                      }],
                    }],
                  },
                }],
              },
              inlineObjects: {
                'obj-1': {
                  inlineObjectProperties: {
                    embeddedObject: {
                      imageProperties: { contentUri: 'https://lh3.googleusercontent.com/xyz' },
                    },
                  },
                },
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      const imageLine = text.split('\n').find(l => l.includes('objectId=obj-1'));
      assert.ok(imageLine, 'image token should appear in the table row');
      // The token itself (from `[image:` to its closing `]`) must contain no `|`,
      // so it can't break the surrounding `| cell |` table structure.
      const start = imageLine!.indexOf('[image:');
      const token = imageLine!.slice(start, imageLine!.indexOf(']', start) + 1);
      assert.ok(!token.includes('|'), `image token should not contain a pipe: ${token}`);
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
      assert.ok(res.content[0].text!.includes('[^1]'));
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
      assert.ok(res.content[0].text!.includes('---'));
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
      const text = res.content[0].text!;
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
      assert.ok(res.content[0].text!.includes('[image]'), 'should show placeholder even without inlineObjects map');
    });

    it('extracts tables as markdown', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with table',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [
                  { paragraph: { elements: [{ textRun: { content: 'Before table\n' }, startIndex: 0, endIndex: 13 }] } },
                  {
                    table: {
                      tableRows: [
                        { tableCells: [
                          { content: [{ paragraph: { elements: [{ textRun: { content: 'Owner' }, startIndex: 14, endIndex: 19 }] } }] },
                          { content: [{ paragraph: { elements: [{ textRun: { content: 'Role' }, startIndex: 20, endIndex: 24 }] } }] },
                        ]},
                        { tableCells: [
                          { content: [{ paragraph: { elements: [{ textRun: { content: 'Eero' }, startIndex: 25, endIndex: 29 }] } }] },
                          { content: [{ paragraph: { elements: [{ textRun: { content: 'CEO' }, startIndex: 30, endIndex: 33 }] } }] },
                        ]},
                      ],
                    },
                    startIndex: 13,
                    endIndex: 50,
                  },
                  { paragraph: { elements: [{ textRun: { content: 'After table\n' }, startIndex: 50, endIndex: 62 }] } },
                ],
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('| Owner | Role |'));
      assert.ok(res.content[0].text!.includes('| --- | --- |'));
      assert.ok(res.content[0].text!.includes('| Eero | CEO |'));
      assert.ok(res.content[0].text!.includes('Before table'));
      assert.ok(res.content[0].text!.includes('After table'));
    });

    it('extracts table of contents content', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with TOC',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [
                  {
                    tableOfContents: {
                      content: [
                        { paragraph: { elements: [{ textRun: { content: '1. Introduction\n' }, startIndex: 0, endIndex: 16 }] } },
                        { paragraph: { elements: [{ textRun: { content: '2. Overview\n' }, startIndex: 16, endIndex: 28 }] } },
                      ],
                    },
                  },
                  { paragraph: { elements: [{ textRun: { content: 'Body text here\n' }, startIndex: 28, endIndex: 43 }] } },
                ],
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('1. Introduction'));
      assert.ok(res.content[0].text!.includes('2. Overview'));
      assert.ok(res.content[0].text!.includes('Body text here'));
    });

    it('extracts multi-row table with empty cells', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with sparse table',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [{
                  table: {
                    tableRows: [
                      { tableCells: [
                        { content: [{ paragraph: { elements: [{ textRun: { content: 'Field' }, startIndex: 1, endIndex: 6 }] } }] },
                        { content: [{ paragraph: { elements: [{ textRun: { content: 'Value' }, startIndex: 7, endIndex: 12 }] } }] },
                      ]},
                      { tableCells: [
                        { content: [{ paragraph: { elements: [{ textRun: { content: 'Status' }, startIndex: 13, endIndex: 19 }] } }] },
                        { content: [] },
                      ]},
                    ],
                  },
                  startIndex: 0,
                  endIndex: 30,
                }],
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('| Field | Value |'));
      assert.ok(res.content[0].text!.includes('| Status |  |'));
    });

    it('escapes pipe characters in cell text', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with pipes in cells',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [{
                  table: {
                    tableRows: [
                      { tableCells: [
                        { content: [{ paragraph: { elements: [{ textRun: { content: 'Choice' }, startIndex: 1, endIndex: 7 }] } }] },
                      ]},
                      { tableCells: [
                        { content: [{ paragraph: { elements: [{ textRun: { content: 'Option A | Option B' }, startIndex: 8, endIndex: 27 }] } }] },
                      ]},
                    ],
                  },
                  startIndex: 0,
                  endIndex: 30,
                }],
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('Option A \\| Option B'), 'pipe in cell text should be escaped');
      assert.ok(!text.includes('| Option A | Option B |'), 'unescaped pipe should not produce extra columns');
    });

    it('joins multi-paragraph cells with spaces', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1',
          title: 'Doc with multi-paragraph cell',
          tabs: [{
            tabProperties: { title: 'Main' },
            documentTab: {
              body: {
                content: [{
                  table: {
                    tableRows: [
                      { tableCells: [
                        { content: [{ paragraph: { elements: [{ textRun: { content: 'Header' }, startIndex: 1, endIndex: 7 }] } }] },
                      ]},
                      { tableCells: [
                        { content: [
                          { paragraph: { elements: [{ textRun: { content: 'Hello\n' }, startIndex: 8, endIndex: 14 }] } },
                          { paragraph: { elements: [{ textRun: { content: 'World\n' }, startIndex: 14, endIndex: 20 }] } },
                        ]},
                      ]},
                    ],
                  },
                  startIndex: 0,
                  endIndex: 25,
                }],
              },
            },
          }],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      const text = res.content[0].text!;
      assert.ok(text.includes('Hello World'), 'multi-paragraph cell should join with space');
      assert.ok(!text.includes('HelloWorld'), 'paragraphs should not be concatenated without separator');
    });
  });

  // --- getGoogleDocImage ---
  describe('getGoogleDocImage', () => {
    const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex'); // PNG signature, stand-in bytes
    // Exact ArrayBuffer (Buffer.from(...).buffer is a shared/pooled 8KB buffer).
    const pngArrayBuffer = () => new Uint8Array(PNG_BYTES).buffer;
    const imageDocData = {
      documentId: 'doc-1', title: 'Doc with image',
      body: {
        content: [{
          paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: 'obj-1' } }] },
        }],
      },
      inlineObjects: {
        'obj-1': {
          inlineObjectProperties: {
            embeddedObject: { imageProperties: { contentUri: 'https://lh3.googleusercontent.com/xyz' } },
          },
        },
      },
    };

    afterEach(() => {
      ctx.resetAuthRequest();
    });

    it('returns a native MCP image block by default', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: imageDocData }));
      let requestedUrl = '';
      ctx.setAuthRequest(async (opts: any) => {
        requestedUrl = opts.url;
        return { data: pngArrayBuffer(), headers: { 'content-type': 'image/png' } };
      });
      const res = await callTool(ctx.client, 'getGoogleDocImage', { documentId: 'doc-1', inlineObjectId: 'obj-1' });
      assert.equal(res.isError, false);
      assert.equal(requestedUrl, 'https://lh3.googleusercontent.com/xyz');
      assert.equal(res.content[0].type, 'image');
      assert.equal(res.content[0].mimeType, 'image/png');
      assert.equal(res.content[0].data, PNG_BYTES.toString('base64'));
    });

    it('strips charset from the content-type header', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: imageDocData }));
      ctx.setAuthRequest(async () => ({ data: pngArrayBuffer(), headers: { 'content-type': 'image/jpeg; charset=binary' } }));
      const res = await callTool(ctx.client, 'getGoogleDocImage', { documentId: 'doc-1', inlineObjectId: 'obj-1' });
      assert.equal(res.isError, false);
      assert.equal(res.content[0].mimeType, 'image/jpeg');
    });

    it('returns a base64 JSON envelope when outputFormat=base64', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: imageDocData }));
      ctx.setAuthRequest(async () => ({ data: pngArrayBuffer(), headers: { 'content-type': 'image/png' } }));
      const res = await callTool(ctx.client, 'getGoogleDocImage', { documentId: 'doc-1', inlineObjectId: 'obj-1', outputFormat: 'base64' });
      assert.equal(res.isError, false);
      assert.equal(res.content[0].type, 'text');
      const envelope = JSON.parse(res.content[0].text!);
      assert.equal(envelope.inlineObjectId, 'obj-1');
      assert.equal(envelope.mimeType, 'image/png');
      assert.equal(envelope.byteLength, PNG_BYTES.byteLength);
      assert.equal(envelope.dataBase64, PNG_BYTES.toString('base64'));
    });

    it('resolves an inline object from a multi-tab document', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Multi-tab image doc',
          tabs: [
            { tabProperties: { tabId: 'tab-1', title: 'Tab1' }, documentTab: { body: { content: [] }, inlineObjects: {} } },
            {
              tabProperties: { tabId: 'tab-2', title: 'Tab2' },
              documentTab: {
                body: { content: [] },
                inlineObjects: {
                  'obj-2': {
                    inlineObjectProperties: {
                      embeddedObject: { imageProperties: { contentUri: 'https://lh3.googleusercontent.com/tab2' } },
                    },
                  },
                },
              },
            },
          ],
        },
      }));
      let requestedUrl = '';
      ctx.setAuthRequest(async (opts: any) => {
        requestedUrl = opts.url;
        return { data: pngArrayBuffer(), headers: { 'content-type': 'image/png' } };
      });
      const res = await callTool(ctx.client, 'getGoogleDocImage', { documentId: 'doc-1', inlineObjectId: 'obj-2' });
      assert.equal(res.isError, false);
      assert.equal(requestedUrl, 'https://lh3.googleusercontent.com/tab2');
    });

    it('errors when the inlineObjectId is not found', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: imageDocData }));
      const res = await callTool(ctx.client, 'getGoogleDocImage', { documentId: 'doc-1', inlineObjectId: 'nope' });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text!.includes('not found'));
    });

    it('errors when the inline object has no fetchable image content', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with chart',
          body: { content: [] },
          inlineObjects: {
            'obj-1': { inlineObjectProperties: { embeddedObject: { title: 'A chart' } } },
          },
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocImage', { documentId: 'doc-1', inlineObjectId: 'obj-1' });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text!.includes('no fetchable image content'));
    });

    it('surfaces the external sourceUri instead of a misleading no-image error', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Doc with source-only image',
          body: { content: [] },
          inlineObjects: {
            'obj-1': {
              inlineObjectProperties: {
                embeddedObject: { imageProperties: { sourceUri: 'https://example.com/a.png' } },
              },
            },
          },
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocImage', { documentId: 'doc-1', inlineObjectId: 'obj-1' });
      assert.equal(res.isError, true);
      const text = res.content[0].text!;
      assert.ok(text.includes('https://example.com/a.png'), text);
      assert.ok(!text.includes('embedded chart or drawing'), 'should not use the no-image message when a sourceUri exists');
    });

    it('reports a non-contradictory decimal size when the image exceeds the 40 MB cap', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: imageDocData }));
      const oversized = new Uint8Array(42257613).buffer; // ~40.3 MB, just over the 40 MB cap
      ctx.setAuthRequest(async () => ({ data: oversized, headers: { 'content-type': 'image/png' } }));
      const res = await callTool(ctx.client, 'getGoogleDocImage', { documentId: 'doc-1', inlineObjectId: 'obj-1' });
      assert.equal(res.isError, true);
      const text = res.content[0].text!;
      assert.ok(text.includes('40.3 MB'), `expected decimal size, got: ${text}`);
      assert.ok(text.includes('limit 40 MB'), text);
      assert.ok(!text.includes('(40 MB,'), 'must not round to a self-contradictory "40 MB, limit 40 MB"');
    });

    it('validation error when inlineObjectId is missing', async () => {
      const res = await callTool(ctx.client, 'getGoogleDocImage', { documentId: 'doc-1' });
      assert.equal(res.isError, true);
    });
  });

  // --- readGoogleDocPaginated ---
  describe('readGoogleDocPaginated', () => {
    const longDoc = (text: string) => ({
      documentId: 'doc-1', title: 'Big Doc',
      body: { content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }] },
    });

    it('returns first page with hasMore and nextOffset', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: longDoc('X'.repeat(120)) }));
      const res = await callTool(ctx.client, 'readGoogleDocPaginated', { documentId: 'doc-1', offset: 0, limit: 50 });
      assert.equal(res.isError, false);
      const r = JSON.parse(res.content[0].text!);
      assert.equal(r.content.length, 50);
      assert.equal(r.outputLength, 120);
      assert.equal(r.documentLength, 120);
      assert.equal(r.hasMore, true);
      assert.equal(r.nextOffset, 50);
    });

    it('last page reports hasMore false and nextOffset at end', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: longDoc('Y'.repeat(40)) }));
      const res = await callTool(ctx.client, 'readGoogleDocPaginated', { documentId: 'doc-1', offset: 0, limit: 50000 });
      const r = JSON.parse(res.content[0].text!);
      assert.equal(r.content.length, 40);
      assert.equal(r.hasMore, false);
      assert.equal(r.nextOffset, 40);
    });

    it('offset beyond document returns empty content', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: longDoc('Z'.repeat(30)) }));
      const res = await callTool(ctx.client, 'readGoogleDocPaginated', { documentId: 'doc-1', offset: 9999, limit: 50 });
      const r = JSON.parse(res.content[0].text!);
      assert.equal(r.content, '');
      assert.equal(r.hasMore, false);
      assert.equal(r.nextOffset, 30);
    });

    it('markdown format includes the title in the first page', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: longDoc('Body text\n') }));
      const res = await callTool(ctx.client, 'readGoogleDocPaginated', { documentId: 'doc-1', format: 'markdown', offset: 0, limit: 50000 });
      const r = JSON.parse(res.content[0].text!);
      assert.ok(r.content.startsWith('# Big Doc'), 'first page should start with the markdown title');
      assert.ok(r.outputLength > r.documentLength, 'outputLength includes the title prefix, documentLength does not');
    });

    it('does not split a markdown table across pages', async () => {
      const cell = (content: string) => ({ content: [{ paragraph: { elements: [{ textRun: { content } }] } }] });
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'Paged',
          body: {
            content: [
              { paragraph: { elements: [{ textRun: { content: 'Intro paragraph\n' } }] } },
              { table: { tableRows: [
                { tableCells: [cell('Owner'), cell('Role')] },
                { tableCells: [cell('Eero'), cell('CEO')] },
              ] } },
            ],
          },
        },
      }));
      // A limit that lands between the header row and the separator row.
      const first = await callTool(ctx.client, 'readGoogleDocPaginated', { documentId: 'doc-1', format: 'markdown', offset: 0, limit: 50 });
      const p1 = JSON.parse(first.content[0].text!);
      // The whole table moves to the next page rather than leaving a headerless
      // fragment behind.
      assert.ok(!p1.content.includes('|'), JSON.stringify(p1.content));
      assert.equal(p1.hasMore, true);

      const second = await callTool(ctx.client, 'readGoogleDocPaginated', { documentId: 'doc-1', format: 'markdown', offset: p1.nextOffset, limit: 50 });
      const p2 = JSON.parse(second.content[0].text!);
      assert.ok(p2.content.includes('| Owner | Role |\n| --- | --- |\n| Eero | CEO |'), JSON.stringify(p2.content));
    });

    it('still advances when a single table is larger than the page limit', async () => {
      const cell = (content: string) => ({ content: [{ paragraph: { elements: [{ textRun: { content } }] } }] });
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({
        data: {
          documentId: 'doc-1', title: 'T',
          body: {
            content: [
              { table: { tableRows: Array.from({ length: 8 }, (_, i) => ({ tableCells: [cell(`row ${i}`), cell('value')] })) } },
            ],
          },
        },
      }));
      const res = await callTool(ctx.client, 'readGoogleDocPaginated', { documentId: 'doc-1', format: 'markdown', offset: 0, limit: 40 });
      const r = JSON.parse(res.content[0].text!);
      // No forward progress would be an infinite pagination loop.
      assert.ok(r.nextOffset > 0, JSON.stringify(r));
      assert.ok(r.content.length > 0, JSON.stringify(r));
    });

    it('reads a specific tab by tabId', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: mockDocs.multiTab() }));
      const res = await callTool(ctx.client, 'readGoogleDocPaginated', { documentId: 'doc-1', tabId: 'tab-2', offset: 0, limit: 50000 });
      const r = JSON.parse(res.content[0].text!);
      assert.ok(r.content.includes('Second tab'));
      assert.ok(!r.content.includes('First tab'));
    });

    it('returns error for unknown tabId', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: mockDocs.multiTab() }));
      const res = await callTool(ctx.client, 'readGoogleDocPaginated', { documentId: 'doc-1', tabId: 'nope' });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text!.includes('not found'));
    });

    it('rejects the removed json format', async () => {
      const res = await callTool(ctx.client, 'readGoogleDocPaginated', { documentId: 'doc-1', format: 'json' });
      assert.equal(res.isError, true);
    });

    it('validation error when documentId missing', async () => {
      const res = await callTool(ctx.client, 'readGoogleDocPaginated', {});
      assert.equal(res.isError, true);
    });
  });

  // --- getGoogleDocContentPaginated ---
  describe('getGoogleDocContentPaginated', () => {
    const indexedDoc = () => ({
      documentId: 'doc-1', title: 'Indexed Doc',
      body: { content: [
        { paragraph: { elements: [{ textRun: { content: 'Alpha\n' }, startIndex: 1, endIndex: 7 }] } },
        { paragraph: { elements: [{ textRun: { content: 'Bravo\n' }, startIndex: 7, endIndex: 13 }] } },
        { paragraph: { elements: [{ textRun: { content: 'Charlie\n' }, startIndex: 13, endIndex: 21 }] } },
      ] },
    });
    const oneLongLine = () => ({
      documentId: 'doc-1', title: 'One Long Line',
      body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Q'.repeat(200) + '\n' }, startIndex: 1, endIndex: 202 }] } }] },
    });

    it('returns indexed content with hasMore and nextOffset', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: indexedDoc() }));
      const res = await callTool(ctx.client, 'getGoogleDocContentPaginated', { documentId: 'doc-1', offset: 0, limit: 50000 });
      assert.equal(res.isError, false);
      const r = JSON.parse(res.content[0].text!);
      assert.ok(r.content.includes('[1-6] Alpha'));
      assert.ok(r.content.includes('[7-12] Bravo'));
      assert.equal(r.hasMore, false);
      assert.equal(typeof r.outputLength, 'number');
      assert.equal(typeof r.documentLength, 'number');
    });

    it('snaps the page end to a line boundary so index prefixes are never split', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: indexedDoc() }));
      const page1 = await callTool(ctx.client, 'getGoogleDocContentPaginated', { documentId: 'doc-1', offset: 0, limit: 50 });
      const r1 = JSON.parse(page1.content[0].text!);
      assert.ok(r1.content.endsWith('\n'), 'snapped page must end on a newline');
      assert.ok(r1.content.includes('[1-6] Alpha'), 'the Alpha line must be whole');
      assert.ok(!r1.content.includes('[7-12'), 'the Bravo prefix must not be partially included');
      assert.equal(r1.hasMore, true);

      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: indexedDoc() }));
      const page2 = await callTool(ctx.client, 'getGoogleDocContentPaginated', { documentId: 'doc-1', offset: r1.nextOffset, limit: 50 });
      const r2 = JSON.parse(page2.content[0].text!);
      assert.ok(r2.content.startsWith('[7-12] Bravo'), 'next page must start at a clean index prefix');
    });

    it('makes forward progress when a single line exceeds the limit', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: oneLongLine() }));
      const page1 = await callTool(ctx.client, 'getGoogleDocContentPaginated', { documentId: 'doc-1', offset: 0, limit: 50 });
      const r1 = JSON.parse(page1.content[0].text!);

      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: oneLongLine() }));
      const page2 = await callTool(ctx.client, 'getGoogleDocContentPaginated', { documentId: 'doc-1', offset: r1.nextOffset, limit: 50 });
      const r2 = JSON.parse(page2.content[0].text!);
      assert.ok(r2.nextOffset > r1.nextOffset, 'pagination must advance even with no newline in the window');
      assert.ok(r2.content.length > 0, 'page must not be empty');
      assert.equal(r2.hasMore, true);
    });

    it('offset beyond document returns empty content', async () => {
      ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: indexedDoc() }));
      const res = await callTool(ctx.client, 'getGoogleDocContentPaginated', { documentId: 'doc-1', offset: 999999, limit: 50 });
      const r = JSON.parse(res.content[0].text!);
      assert.equal(r.content, '');
      assert.equal(r.hasMore, false);
      assert.equal(r.nextOffset, r.outputLength);
    });

    it('validation error when documentId missing', async () => {
      const res = await callTool(ctx.client, 'getGoogleDocContentPaginated', {});
      assert.equal(res.isError, true);
    });
  });

  describe('deleteComment', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'deleteComment', { documentId: 'doc-1', commentId: 'c1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('deleted'));
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

      // tabId must live INSIDE tabProperties — Google rejects the payload if it's at the request root.
      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      const lastCall = calls[calls.length - 1];
      const requests = lastCall?.args?.[0]?.requestBody?.requests;
      assert.equal(requests?.length, 1);
      const req = requests[0].updateDocumentTabProperties;
      assert.equal(req.tabProperties.tabId, 'tab-1');
      assert.equal(req.tabProperties.title, 'Renamed');
      assert.equal(req.fields, 'title');
      assert.equal(req.tabId, undefined, 'tabId must not be at the request root');
    });

    it('insertSmartChip happy path', async () => {
      const res = await callTool(ctx.client, 'insertSmartChip', { documentId: 'doc-1', index: 1, chipType: 'person', personEmail: 'user@example.com' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('user@example.com'));

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

  describe('createFootnote', () => {
    beforeEach(() => {
      ctx.mocks.docs.service.documents.batchUpdate._setImpl(async () => ({
        data: { replies: [{ createFootnote: { footnoteId: 'fn-123' } }] },
      }));
    });

    after(() => {
      ctx.mocks.docs.service.documents.batchUpdate._resetImpl();
    });

    it('creates footnote at index without content', async () => {
      const res = await callTool(ctx.client, 'createFootnote', { documentId: 'doc-1', index: 5 });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('fn-123'));
      assert.ok(res.content[0].text!.includes('at index 5'));

      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      assert.equal(calls.length, 1);
      const req = calls[0].args[0].requestBody.requests[0];
      assert.ok('createFootnote' in req);
      assert.equal(req.createFootnote.location.index, 5);
    });

    it('creates footnote with content (two batchUpdate calls)', async () => {
      const res = await callTool(ctx.client, 'createFootnote', { documentId: 'doc-1', index: 3, content: 'See reference.' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('Content inserted'));

      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      assert.equal(calls.length, 2);

      // Second call should insertText into the footnote segment
      const secondReq = calls[1].args[0].requestBody.requests[0];
      assert.ok('insertText' in secondReq);
      assert.equal(secondReq.insertText.location.segmentId, 'fn-123');
      assert.equal(secondReq.insertText.text, 'See reference.');
    });

    it('creates footnote with endOfSegment', async () => {
      const res = await callTool(ctx.client, 'createFootnote', { documentId: 'doc-1', endOfSegment: true });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('end of document'));

      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      const req = calls[0].args[0].requestBody.requests[0];
      assert.ok('createFootnote' in req);
      assert.deepEqual(req.createFootnote.endOfSegmentLocation, { segmentId: '' });
    });

    it('rejects when neither index nor endOfSegment provided', async () => {
      const res = await callTool(ctx.client, 'createFootnote', { documentId: 'doc-1' });
      assert.equal(res.isError, true);
    });

    it('threads tabId into the footnote-reference location (#114)', async () => {
      const res = await callTool(ctx.client, 'createFootnote', { documentId: 'doc-1', index: 5, tabId: 'tab-2' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('in tab tab-2'));

      const req = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate')[0].args[0].requestBody.requests[0];
      assert.equal(req.createFootnote.location.index, 5);
      assert.equal(req.createFootnote.location.tabId, 'tab-2');
    });

    it('threads tabId into endOfSegmentLocation (#114)', async () => {
      const res = await callTool(ctx.client, 'createFootnote', { documentId: 'doc-1', endOfSegment: true, tabId: 'tab-2' });
      assert.equal(res.isError, false);

      const req = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate')[0].args[0].requestBody.requests[0];
      assert.deepEqual(req.createFootnote.endOfSegmentLocation, { segmentId: '', tabId: 'tab-2' });
    });

    it('threads tabId AND segmentId into the footnote-body insert (#114)', async () => {
      const res = await callTool(ctx.client, 'createFootnote', { documentId: 'doc-1', index: 3, content: 'See ref.', tabId: 'tab-2' });
      assert.equal(res.isError, false);

      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      assert.equal(calls.length, 2);
      const secondReq = calls[1].args[0].requestBody.requests[0];
      assert.equal(secondReq.insertText.location.segmentId, 'fn-123');
      assert.equal(secondReq.insertText.location.tabId, 'tab-2');
    });

    it('omits tabId from locations when none is given (#114)', async () => {
      const res = await callTool(ctx.client, 'createFootnote', { documentId: 'doc-1', index: 5 });
      assert.equal(res.isError, false);
      assert.ok(!res.content[0].text!.includes('in tab'));

      const req = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate')[0].args[0].requestBody.requests[0];
      assert.equal(req.createFootnote.location.tabId, undefined);
    });

    it('returns partial-success error when content insertion fails', async () => {
      let callCount = 0;
      ctx.mocks.docs.service.documents.batchUpdate._setImpl(async () => {
        callCount++;
        if (callCount === 1) {
          return { data: { replies: [{ createFootnote: { footnoteId: 'fn-orphan' } }] } };
        }
        throw new Error('Simulated Docs API failure');
      });

      const res = await callTool(ctx.client, 'createFootnote', {
        documentId: 'doc-1', index: 3, content: 'Some text',
      });

      assert.equal(res.isError, true);
      assert.ok(res.content[0].text!.includes('fn-orphan'));
      assert.ok(res.content[0].text!.includes('failed to insert content'));
      assert.ok(res.content[0].text!.includes('Simulated Docs API failure'));

      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      assert.equal(calls.length, 2);
    });
  });

  // --- #114: tabId honored in table/format/smartchip editing handlers ---
  describe('tabId scoping for editing tools (#114)', () => {
    // A document content element holding a single 1x1 table at startIndex 5.
    const tableContent = () => [{
      startIndex: 5,
      table: { tableRows: [{ tableCells: [{ startIndex: 10, endIndex: 20, content: [] }] }] },
    }];

    after(() => {
      ctx.mocks.docs.service.documents.get._resetImpl();
      ctx.mocks.docs.service.documents.batchUpdate._resetImpl();
    });

    const lastRequests = () => {
      const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
      return calls[calls.length - 1]?.args?.[0]?.requestBody?.requests;
    };

    describe('insertTable', () => {
      it('omits tabId from the location by default', async () => {
        const res = await callTool(ctx.client, 'insertTable', { documentId: 'doc-1', rows: 2, columns: 2, index: 1 });
        assert.equal(res.isError, false);
        assert.ok(!res.content[0].text!.includes('in tab'));
        assert.equal(lastRequests()[0].insertTable.location.tabId, undefined);
      });

      it('threads tabId into the location', async () => {
        const res = await callTool(ctx.client, 'insertTable', { documentId: 'doc-1', rows: 2, columns: 2, index: 1, tabId: 'tab-2' });
        assert.equal(res.isError, false);
        assert.ok(res.content[0].text!.includes('in tab tab-2'));
        const req = lastRequests()[0].insertTable;
        assert.equal(req.location.tabId, 'tab-2');
        assert.equal(req.location.index, 1);
      });
    });

    describe('insertSmartChip', () => {
      it('omits tabId from the location by default', async () => {
        const res = await callTool(ctx.client, 'insertSmartChip', { documentId: 'doc-1', index: 1, chipType: 'person', personEmail: 'a@b.com' });
        assert.equal(res.isError, false);
        assert.equal(lastRequests()[0].insertPerson.location.tabId, undefined);
      });

      it('threads tabId into the location', async () => {
        const res = await callTool(ctx.client, 'insertSmartChip', { documentId: 'doc-1', index: 1, chipType: 'person', personEmail: 'a@b.com', tabId: 'tab-2' });
        assert.equal(res.isError, false);
        assert.ok(res.content[0].text!.includes('in tab tab-2'));
        assert.equal(lastRequests()[0].insertPerson.location.tabId, 'tab-2');
      });
    });

    // The no-tabId path must stay byte-for-byte the cheap one: a narrow-field
    // GET (never includeTabsContent) and no tabId leaking into the range. These
    // guard the findTextRange/getParagraphRange tab/no-tab branching (#114).
    const lastGet = () => {
      const calls = ctx.mocks.docs.tracker.getCalls('documents.get');
      return calls[calls.length - 1]?.args?.[0];
    };
    const assertNoTabGets = () => {
      for (const c of ctx.mocks.docs.tracker.getCalls('documents.get')) {
        assert.ok(!c.args?.[0]?.includeTabsContent, 'default path must not use includeTabsContent');
      }
      assert.ok(typeof lastGet()?.fields === 'string', 'default path must use a narrow field mask');
    };

    describe('applyTextStyle', () => {
      it('uses the narrow-field GET and leaks no tabId by default (textToFind)', async () => {
        ctx.mocks.docs.service.documents.get._resetImpl(); // genuine default mock
        const res = await callTool(ctx.client, 'applyTextStyle', { documentId: 'doc-1', textToFind: 'Hello', bold: true });
        assert.equal(res.isError, false);
        assert.ok(!res.content[0].text!.includes('in tab'));
        assertNoTabGets();
        assert.equal(lastRequests()[0].updateTextStyle.range.tabId, undefined);
      });

      it('threads tabId into the range (explicit-index mode)', async () => {
        const res = await callTool(ctx.client, 'applyTextStyle', { documentId: 'doc-1', startIndex: 1, endIndex: 5, bold: true, tabId: 'tab-2' });
        assert.equal(res.isError, false);
        assert.ok(res.content[0].text!.includes('in tab tab-2'));
        assert.equal(lastRequests()[0].updateTextStyle.range.tabId, 'tab-2');
      });

      it('resolves textToFind within the target tab', async () => {
        ctx.mocks.docs.service.documents.get._setImpl(async () => ({
          data: { tabs: [
            { tabProperties: { tabId: 'tab-1' }, documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Other\n' }, startIndex: 1, endIndex: 7 }] } }] } } },
            { tabProperties: { tabId: 'tab-2' }, documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Find me here\n' }, startIndex: 1, endIndex: 14 }] } }] } } },
          ] },
        }));
        const res = await callTool(ctx.client, 'applyTextStyle', { documentId: 'doc-1', textToFind: 'Find me', bold: true, tabId: 'tab-2' });
        assert.equal(res.isError, false);

        const getCalls = ctx.mocks.docs.tracker.getCalls('documents.get');
        assert.equal(getCalls[getCalls.length - 1]?.args?.[0]?.includeTabsContent, true);
        assert.equal(lastRequests()[0].updateTextStyle.range.tabId, 'tab-2');
        ctx.mocks.docs.service.documents.get._resetImpl();
      });

      it('returns the standard not-found error for an unknown tabId (textToFind)', async () => {
        ctx.mocks.docs.service.documents.get._setImpl(async () => ({
          data: { tabs: [{ tabProperties: { tabId: 'tab-1' }, documentTab: { body: { content: [] } } }] },
        }));
        const before = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate').length;
        const res = await callTool(ctx.client, 'applyTextStyle', { documentId: 'doc-1', textToFind: 'x', bold: true, tabId: 'missing' });
        assert.equal(res.isError, true);
        assert.ok(res.content[0].text!.includes('Tab with ID "missing" not found'));
        assert.ok(res.content[0].text!.includes('listDocumentTabs'));
        assert.equal(ctx.mocks.docs.tracker.getCalls('documents.batchUpdate').length, before);
        ctx.mocks.docs.service.documents.get._resetImpl();
      });

      it('sends baselineOffset in the updateTextStyle payload with a matching field mask', async () => {
        const res = await callTool(ctx.client, 'applyTextStyle', { documentId: 'doc-1', startIndex: 1, endIndex: 5, baselineOffset: 'SUBSCRIPT' });
        assert.equal(res.isError, false);
        const req = lastRequests()[0].updateTextStyle;
        assert.equal(req.textStyle.baselineOffset, 'SUBSCRIPT');
        assert.ok(req.fields.split(',').includes('baselineOffset'));
      });

      it('passes NONE through so existing super/subscript can be reset', async () => {
        const res = await callTool(ctx.client, 'applyTextStyle', { documentId: 'doc-1', startIndex: 1, endIndex: 5, baselineOffset: 'NONE' });
        assert.equal(res.isError, false);
        const req = lastRequests()[0].updateTextStyle;
        assert.equal(req.textStyle.baselineOffset, 'NONE');
        assert.ok(req.fields.split(',').includes('baselineOffset'));
      });

      it('appends baselineOffset to the field mask alongside other style options', async () => {
        // Guards the append path: with a single style option the mask is a
        // one-element string, so an overwriting mask builder would look correct.
        const res = await callTool(ctx.client, 'applyTextStyle', {
          documentId: 'doc-1', startIndex: 1, endIndex: 5, bold: true, baselineOffset: 'SUPERSCRIPT',
        });
        assert.equal(res.isError, false);
        const req = lastRequests()[0].updateTextStyle;
        assert.equal(req.textStyle.bold, true);
        assert.equal(req.textStyle.baselineOffset, 'SUPERSCRIPT');
        assert.deepEqual(req.fields.split(',').sort(), ['baselineOffset', 'bold']);
      });

      it('accepts baselineOffset through the formatGoogleDocText alias', async () => {
        const res = await callTool(ctx.client, 'formatGoogleDocText', {
          documentId: 'doc-1', startIndex: 1, endIndex: 5, baselineOffset: 'SUPERSCRIPT',
        });
        assert.equal(res.isError, false);
        const req = lastRequests()[0].updateTextStyle;
        assert.equal(req.textStyle.baselineOffset, 'SUPERSCRIPT');
        assert.ok(req.fields.split(',').includes('baselineOffset'));
      });
    });

    describe('applyParagraphStyle', () => {
      it('uses narrow-field GETs and leaks no tabId by default (textToFind)', async () => {
        ctx.mocks.docs.service.documents.get._resetImpl(); // genuine default mock
        const res = await callTool(ctx.client, 'applyParagraphStyle', { documentId: 'doc-1', textToFind: 'Hello', alignment: 'CENTER' });
        assert.equal(res.isError, false);
        assert.ok(!res.content[0].text!.includes('in tab'));
        assertNoTabGets();
        assert.equal(lastRequests()[0].updateParagraphStyle.range.tabId, undefined);
      });

      it('resolves indexWithinParagraph within the target tab', async () => {
        ctx.mocks.docs.service.documents.get._setImpl(async () => ({
          data: { tabs: [
            { tabProperties: { tabId: 'tab-2' }, documentTab: { body: { content: [{ startIndex: 1, endIndex: 14, paragraph: { elements: [] } }] } } },
          ] },
        }));
        const res = await callTool(ctx.client, 'applyParagraphStyle', { documentId: 'doc-1', indexWithinParagraph: 2, alignment: 'CENTER', tabId: 'tab-2' });
        assert.equal(res.isError, false);
        assert.ok(res.content[0].text!.includes('in tab tab-2'));
        assert.equal(lastRequests()[0].updateParagraphStyle.range.tabId, 'tab-2');
        ctx.mocks.docs.service.documents.get._resetImpl();
      });

      it('resolves tab-scoped textToFind with a single GET (#114 follow-up)', async () => {
        ctx.mocks.docs.service.documents.get._setImpl(async () => ({
          data: { tabs: [
            { tabProperties: { tabId: 'tab-2' }, documentTab: { body: { content: [
              { startIndex: 1, endIndex: 14, paragraph: { elements: [{ textRun: { content: 'Find me here\n' }, startIndex: 1, endIndex: 14 }] } },
            ] } } },
          ] },
        }));
        const res = await callTool(ctx.client, 'applyParagraphStyle', { documentId: 'doc-1', textToFind: 'Find me', alignment: 'CENTER', tabId: 'tab-2' });
        assert.equal(res.isError, false);
        assert.ok(res.content[0].text!.includes('in tab tab-2'));

        // The whole point of the optimization: range + enclosing-paragraph
        // resolution share one includeTabsContent fetch, not two.
        const getCalls = ctx.mocks.docs.tracker.getCalls('documents.get');
        assert.equal(getCalls.length, 1, 'tab-scoped textToFind must resolve from a single GET');
        assert.equal(getCalls[0].args[0].includeTabsContent, true);

        const range = lastRequests()[0].updateParagraphStyle.range;
        assert.equal(range.tabId, 'tab-2');
        assert.equal(range.startIndex, 1);
        assert.equal(range.endIndex, 14);
        ctx.mocks.docs.service.documents.get._resetImpl();
      });

      it('returns the standard not-found error and issues no batchUpdate for an unknown tabId (textToFind)', async () => {
        ctx.mocks.docs.service.documents.get._setImpl(async () => ({
          data: { tabs: [{ tabProperties: { tabId: 'tab-1' }, documentTab: { body: { content: [] } } }] },
        }));
        const before = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate').length;
        const res = await callTool(ctx.client, 'applyParagraphStyle', { documentId: 'doc-1', textToFind: 'x', alignment: 'CENTER', tabId: 'missing' });
        assert.equal(res.isError, true);
        assert.ok(res.content[0].text!.includes('Tab with ID "missing" not found'));
        assert.ok(res.content[0].text!.includes('listDocumentTabs'));
        assert.equal(ctx.mocks.docs.tracker.getCalls('documents.batchUpdate').length, before);
        ctx.mocks.docs.service.documents.get._resetImpl();
      });
    });

    describe('createParagraphBullets', () => {
      it('uses the narrow-field GET and leaks no tabId by default (textToFind)', async () => {
        ctx.mocks.docs.service.documents.get._resetImpl(); // genuine default mock
        const res = await callTool(ctx.client, 'createParagraphBullets', { documentId: 'doc-1', textToFind: 'Hello', bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' });
        assert.equal(res.isError, false);
        assert.ok(!res.content[0].text!.includes('in tab'));
        assertNoTabGets();
        assert.equal(lastRequests()[0].createParagraphBullets.range.tabId, undefined);
      });

      it('threads tabId into the range (explicit-index mode)', async () => {
        const res = await callTool(ctx.client, 'createParagraphBullets', { documentId: 'doc-1', startIndex: 1, endIndex: 5, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE', tabId: 'tab-2' });
        assert.equal(res.isError, false);
        assert.ok(res.content[0].text!.includes('in tab tab-2'));
        assert.equal(lastRequests()[0].createParagraphBullets.range.tabId, 'tab-2');
      });

      it('threads tabId into the range when removing bullets (NONE)', async () => {
        const res = await callTool(ctx.client, 'createParagraphBullets', { documentId: 'doc-1', startIndex: 1, endIndex: 5, bulletPreset: 'NONE', tabId: 'tab-2' });
        assert.equal(res.isError, false);
        assert.equal(lastRequests()[0].deleteParagraphBullets.range.tabId, 'tab-2');
      });
    });

    describe('editTableCell', () => {
      it('operates on the default body and emits no tabId when none is given', async () => {
        ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: { body: { content: tableContent() } } }));
        const res = await callTool(ctx.client, 'editTableCell', { documentId: 'doc-1', tableStartIndex: 5, rowIndex: 0, columnIndex: 0, textContent: 'Hi' });
        assert.equal(res.isError, false);
        assert.ok(!res.content[0].text!.includes('in tab'));
        const reqs = lastRequests();
        for (const r of reqs) {
          const inner = r.deleteContentRange ?? r.insertText;
          assert.equal((inner.range ?? inner.location).tabId, undefined);
        }
        ctx.mocks.docs.service.documents.get._resetImpl();
      });

      it('finds the table inside the target tab and threads tabId into every request', async () => {
        ctx.mocks.docs.service.documents.get._setImpl(async () => ({
          data: { tabs: [{ tabProperties: { tabId: 'tab-2' }, documentTab: { body: { content: tableContent() } } }] },
        }));
        const res = await callTool(ctx.client, 'editTableCell', { documentId: 'doc-1', tableStartIndex: 5, rowIndex: 0, columnIndex: 0, textContent: 'Hi', bold: true, alignment: 'CENTER', tabId: 'tab-2' });
        assert.equal(res.isError, false);
        assert.ok(res.content[0].text!.includes('in tab tab-2'));

        const getCalls = ctx.mocks.docs.tracker.getCalls('documents.get');
        assert.equal(getCalls[getCalls.length - 1]?.args?.[0]?.includeTabsContent, true);

        const reqs = lastRequests();
        assert.ok(reqs.length >= 3);
        assert.equal(reqs.find((r: any) => r.deleteContentRange).deleteContentRange.range.tabId, 'tab-2');
        assert.equal(reqs.find((r: any) => r.insertText).insertText.location.tabId, 'tab-2');
        assert.equal(reqs.find((r: any) => r.updateTextStyle).updateTextStyle.range.tabId, 'tab-2');
        assert.equal(reqs.find((r: any) => r.updateParagraphStyle).updateParagraphStyle.range.tabId, 'tab-2');
        ctx.mocks.docs.service.documents.get._resetImpl();
      });

      it('returns the standard not-found error and issues no batchUpdate for an unknown tabId', async () => {
        ctx.mocks.docs.service.documents.get._setImpl(async () => ({
          data: { tabs: [{ tabProperties: { tabId: 'tab-1' }, documentTab: { body: { content: tableContent() } } }] },
        }));
        const before = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate').length;
        const res = await callTool(ctx.client, 'editTableCell', { documentId: 'doc-1', tableStartIndex: 5, rowIndex: 0, columnIndex: 0, textContent: 'Hi', tabId: 'missing' });
        assert.equal(res.isError, true);
        assert.ok(res.content[0].text!.includes('Tab with ID "missing" not found'));
        assert.equal(ctx.mocks.docs.tracker.getCalls('documents.batchUpdate').length, before);
        ctx.mocks.docs.service.documents.get._resetImpl();
      });
    });
  });
});
