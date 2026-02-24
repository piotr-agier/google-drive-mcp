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
        data: {
          documentId: 'doc-1',
          title: 'Multi-Tab Doc',
          tabs: [
            {
              tabProperties: { title: 'Tab1' },
              documentTab: {
                body: {
                  content: [{ paragraph: { elements: [{ textRun: { content: 'First tab\n' }, startIndex: 1, endIndex: 11 }] } }],
                },
              },
            },
            {
              tabProperties: { title: 'Tab2' },
              documentTab: {
                body: {
                  content: [{ paragraph: { elements: [{ textRun: { content: 'Second tab\n' }, startIndex: 1, endIndex: 12 }] } }],
                },
              },
            },
          ],
        },
      }));
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('=== Tab: Tab1 ==='));
      assert.ok(res.content[0].text.includes('=== Tab: Tab2 ==='));
      assert.ok(res.content[0].text.includes('First tab'));
      assert.ok(res.content[0].text.includes('Second tab'));
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
});
