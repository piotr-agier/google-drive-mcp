import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

// T-10b: ifRevisionId threads WriteControl.requiredRevisionId through the
// remaining write tools (T-10 covered insertText/deleteRange/findAndReplace).
describe('T-10b ifRevisionId threading', () => {
  let ctx: TestContext;

  before(async () => { ctx = await setupTestServer(); });
  after(async () => { await ctx.cleanup(); });
  beforeEach(() => {
    ctx.mocks.docs.tracker.reset();
    ctx.mocks.drive.tracker.reset();
    ctx.mocks.docs.service.documents.get._resetImpl();
    ctx.mocks.docs.service.documents.batchUpdate._resetImpl();
  });

  function lastWriteControl() {
    const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
    return calls[calls.length - 1].args[0].requestBody.writeControl;
  }

  it('style tools and bullets pass the lock', async () => {
    await callTool(ctx.client, 'applyTextStyle', { documentId: 'd', startIndex: 1, endIndex: 5, bold: true, ifRevisionId: 'rev-a' });
    assert.deepEqual(lastWriteControl(), { requiredRevisionId: 'rev-a' });

    await callTool(ctx.client, 'applyParagraphStyle', { documentId: 'd', startIndex: 1, endIndex: 5, alignment: 'CENTER', ifRevisionId: 'rev-b' });
    assert.deepEqual(lastWriteControl(), { requiredRevisionId: 'rev-b' });

    await callTool(ctx.client, 'createParagraphBullets', { documentId: 'd', startIndex: 1, endIndex: 5, ifRevisionId: 'rev-c' });
    assert.deepEqual(lastWriteControl(), { requiredRevisionId: 'rev-c' });

    await callTool(ctx.client, 'createParagraphBullets', { documentId: 'd', startIndex: 1, endIndex: 5, bulletPreset: 'NONE', ifRevisionId: 'rev-d' });
    assert.deepEqual(lastWriteControl(), { requiredRevisionId: 'rev-d' });
  });

  it('table tools pass the lock', async () => {
    ctx.mocks.drive.service.files.get._setImpl(async () => ({
      data: { id: 'd', name: 'Doc', mimeType: 'application/vnd.google-apps.document' },
    }));
    await callTool(ctx.client, 'insertTable', { documentId: 'd', rows: 2, columns: 2, index: 1, ifRevisionId: 'rev-e' });
    assert.deepEqual(lastWriteControl(), { requiredRevisionId: 'rev-e' });

    ctx.mocks.docs.service.documents.get._setImpl(async () => ({
      data: {
        body: {
          content: [{
            startIndex: 5, endIndex: 40,
            table: { tableRows: [{ tableCells: [{ startIndex: 6, endIndex: 12, content: [] }] }] },
          }],
        },
      },
    }));
    await callTool(ctx.client, 'editTableCell', { documentId: 'd', tableStartIndex: 5, rowIndex: 0, columnIndex: 0, textContent: 'x', ifRevisionId: 'rev-f' });
    assert.deepEqual(lastWriteControl(), { requiredRevisionId: 'rev-f' });
  });

  it('smart chips and footnotes pass the lock on the creating call', async () => {
    await callTool(ctx.client, 'insertSmartChip', { documentId: 'd', index: 1, chipType: 'person', personEmail: 'a@b.com', ifRevisionId: 'rev-g' });
    assert.deepEqual(lastWriteControl(), { requiredRevisionId: 'rev-g' });

    ctx.mocks.docs.service.documents.batchUpdate._setImpl(async () => ({
      data: { replies: [{ createFootnote: { footnoteId: 'fn-1' } }] },
    }));
    await callTool(ctx.client, 'createFootnote', { documentId: 'd', index: 1, content: 'note', ifRevisionId: 'rev-h' });
    const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
    const creating = calls[calls.length - 2].args[0].requestBody;
    const inserting = calls[calls.length - 1].args[0].requestBody;
    assert.deepEqual(creating.writeControl, { requiredRevisionId: 'rev-h' });
    // The content insert targets the fresh footnote segment — never locked.
    assert.equal(inserting.writeControl, undefined);
  });

  it('updateGoogleDoc: atomic tab path locks the batch; two-call path locks only the delete', async () => {
    ctx.mocks.docs.service.documents.get._setImpl(async () => ({
      data: {
        title: 'Doc',
        tabs: [{ tabProperties: { tabId: 't1' }, documentTab: { body: { content: [{ endIndex: 30 }] } } }],
        body: { content: [{ endIndex: 30 }] },
      },
    }));

    await callTool(ctx.client, 'updateGoogleDoc', { documentId: 'd', content: 'new', tabId: 't1', ifRevisionId: 'rev-i' });
    assert.deepEqual(lastWriteControl(), { requiredRevisionId: 'rev-i' });

    ctx.mocks.docs.tracker.reset();
    await callTool(ctx.client, 'updateGoogleDoc', { documentId: 'd', content: 'new', ifRevisionId: 'rev-j' });
    const calls = ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args[0].requestBody.writeControl, { requiredRevisionId: 'rev-j' });
    assert.equal(calls[1].args[0].requestBody.writeControl, undefined);
  });

  it('omitting ifRevisionId sends no writeControl (back-compat)', async () => {
    await callTool(ctx.client, 'applyTextStyle', { documentId: 'd', startIndex: 1, endIndex: 5, bold: true });
    assert.equal(lastWriteControl(), undefined);
  });
});
