import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

describe('createDocFromHTML', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await setupTestServer();
  });

  after(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    ctx.mocks.drive.tracker.reset();
    ctx.mocks.docs.tracker.reset();

    // Reset mock implementations to defaults
    ctx.mocks.drive.service.files.list._resetImpl();
    ctx.mocks.drive.service.files.create._resetImpl();
  });

  it('creates a doc from HTML', async () => {
    // checkFileExists calls files.list — return empty (no duplicate)
    ctx.mocks.drive.service.files.list._setImpl(async () => ({
      data: { files: [] },
    }));
    // files.create returns the new doc
    ctx.mocks.drive.service.files.create._setImpl(async () => ({
      data: {
        id: 'html-doc-1',
        name: 'My HTML Doc',
        webViewLink: 'https://docs.google.com/html-doc-1',
      },
    }));

    const res = await callTool(ctx.client, 'createDocFromHTML', {
      html: '<h1>Title</h1><p>Body text</p>',
      name: 'My HTML Doc',
    });

    assert.equal(res.isError, false);
    assert.ok(res.content[0].text.includes('Created Google Doc from HTML'));
    assert.ok(res.content[0].text.includes('html-doc-1'));

    // Verify files.create was called with text/html media mimeType
    const createCalls = ctx.mocks.drive.tracker.getCalls('files.create');
    assert.ok(createCalls.length >= 1);
    const createArg = createCalls[createCalls.length - 1].args[0];
    assert.equal(createArg.media.mimeType, 'text/html');
    assert.equal(createArg.requestBody.mimeType, 'application/vnd.google-apps.document');
  });

  it('rejects duplicate name', async () => {
    // checkFileExists calls files.list — return an existing file
    ctx.mocks.drive.service.files.list._setImpl(async () => ({
      data: { files: [{ id: 'existing-doc-99', name: 'Duplicate Doc', mimeType: 'application/vnd.google-apps.document' }] },
    }));

    const res = await callTool(ctx.client, 'createDocFromHTML', {
      html: '<p>Some content</p>',
      name: 'Duplicate Doc',
    });

    assert.equal(res.isError, true);
    assert.ok(res.content[0].text.includes('already exists'));
    assert.ok(res.content[0].text.includes('existing-doc-99'));
  });

  it('validation error for missing html', async () => {
    const res = await callTool(ctx.client, 'createDocFromHTML', { name: 'No HTML' });
    assert.equal(res.isError, true);
  });

  it('validation error for missing name', async () => {
    const res = await callTool(ctx.client, 'createDocFromHTML', { html: '<p>Hello</p>' });
    assert.equal(res.isError, true);
  });
});
