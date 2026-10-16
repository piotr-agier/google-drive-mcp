import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

// Each integration file runs in its own process. Keep read retries fast while
// retaining a nonzero retry policy so the single-attempt write assertions matter.
process.env.GOOGLE_DRIVE_MCP_RETRY_BASE_DELAY = '1';

const providerFailure = () => Object.assign(new Error('PRIVATE_PROVIDER_DETAIL'), {
  response: { status: 503, data: { private: 'PRIVATE_PROVIDER_DETAIL' } },
});

describe('Native Workspace creation in the destination', () => {
  let ctx: TestContext;
  before(async () => { ctx = await setupTestServer(); });
  after(async () => { await ctx.cleanup(); });
  beforeEach(() => {
    for (const mock of [ctx.mocks.drive, ctx.mocks.sheets, ctx.mocks.slides]) mock.tracker.reset();
    for (const stub of [
      ctx.mocks.drive.service.files.list, ctx.mocks.drive.service.files.create,
      ctx.mocks.sheets.service.spreadsheets.get, ctx.mocks.sheets.service.spreadsheets.batchUpdate,
      ctx.mocks.sheets.service.spreadsheets.values.update,
      ctx.mocks.slides.service.presentations.get, ctx.mocks.slides.service.presentations.batchUpdate,
      ctx.mocks.slides.service.presentations.pages.get,
    ]) stub._resetImpl();
    ctx.mocks.drive.service.files.create._setImpl(async () => ({ data: { id: 'native-file' } }));
    // Reproduce an account that can create in the destination, but cannot
    // create in personal Drive through the editor API.
    ctx.mocks.sheets.service.spreadsheets.create._setImpl(async () => {
      throw Object.assign(new Error('Editor creation forbidden'), { response: { status: 403 } });
    });
    ctx.mocks.slides.service.presentations.create._setImpl(async () => {
      throw Object.assign(new Error('Editor creation forbidden'), { response: { status: 403 } });
    });
    ctx.mocks.sheets.service.spreadsheets.get._setImpl(async () => ({ data: {
      sheets: [{ properties: { sheetId: 73, title: 'Localized tab', gridProperties: { rowCount: 20, columnCount: 10 } } }],
    } }));
    ctx.mocks.slides.service.presentations.get._setImpl(async () => ({ data: { slides: [] } }));
  });

  const cases = [
    { tool: 'createGoogleSheet', mime: 'application/vnd.google-apps.spreadsheet', args: { data: [['A', 'B']] } },
    { tool: 'createGoogleSlides', mime: 'application/vnd.google-apps.presentation', args: { slides: [{ title: 'Title', content: 'Body' }] } },
  ];

  for (const { tool, mime, args } of cases) {
    describe(tool, () => {
      it('creates directly in a shared destination while editor creation is forbidden', async () => {
        const result = await callTool(ctx.client, tool, { name: "Plan's title", parentFolderId: 'shared-parent', ...args });
        assert.equal(result.isError, false, result.content[0].text);
        const calls = ctx.mocks.drive.tracker.getCalls('files.create');
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].args[0].requestBody, { name: "Plan's title", mimeType: mime, parents: ['shared-parent'] });
        assert.equal(calls[0].args[0].supportsAllDrives, true);
        assert.ok(calls[0].args[1].signal instanceof AbortSignal);
        assert.match(result.content[0].text!, /ID: native-file/);
        assert.match(result.content[0].text!, /Plan's title/);
        assert.equal(ctx.mocks.drive.tracker.getCalls('files.update').length, 0);
        assert.equal(ctx.mocks.sheets.tracker.getCalls('spreadsheets.create').length, 0);
        assert.equal(ctx.mocks.slides.tracker.getCalls('presentations.create').length, 0);
        const query = ctx.mocks.drive.tracker.getCalls('files.list')[0].args[0].q;
        assert.match(query, /'shared-parent' in parents/);
        assert.ok(query.includes("Plan\\'s title"));
      });

      it('preserves the default root destination', async () => {
        const result = await callTool(ctx.client, tool, { name: 'Root file', ...args });
        assert.equal(result.isError, false, result.content[0].text);
        assert.deepEqual(ctx.mocks.drive.tracker.getCalls('files.create')[0].args[0].requestBody.parents, ['root']);
        assert.match(ctx.mocks.drive.tracker.getCalls('files.list')[0].args[0].q, /'root' in parents/);
      });

      it('uses the existing folder path resolver', async () => {
        ctx.mocks.drive.service.files.list._setImpl(async (request) => ({ data: {
          files: request.q.includes('mimeType =') ? [{ id: 'resolved-folder' }] : [],
        } }));
        const result = await callTool(ctx.client, tool, { name: 'Path file', parentFolderId: '/Planning', ...args });
        assert.equal(result.isError, false, result.content[0].text);
        assert.deepEqual(ctx.mocks.drive.tracker.getCalls('files.create')[0].args[0].requestBody.parents, ['resolved-folder']);
        assert.match(ctx.mocks.drive.tracker.getCalls('files.list')[1].args[0].q, /'resolved-folder' in parents/);
      });

      it('keeps the duplicate guard ahead of creation', async () => {
        ctx.mocks.drive.service.files.list._setImpl(async () => ({ data: { files: [{ id: 'existing-file' }] } }));
        const result = await callTool(ctx.client, tool, { name: 'Existing', parentFolderId: 'shared-parent', ...args });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text!, /already exists/);
        assert.match(result.content[0].text!, /existing-file/);
        assert.equal(ctx.mocks.drive.tracker.getCalls('files.create').length, 0);
        assert.equal(ctx.mocks.sheets.tracker.calls.length + ctx.mocks.slides.tracker.calls.length, 0);
      });

      it('stops before editor operations when Drive returns no ID', async () => {
        ctx.mocks.drive.service.files.create._setImpl(async () => ({ data: {} }));
        const result = await callTool(ctx.client, tool, { name: 'Missing ID', ...args });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text!, /no file ID/i);
        assert.equal(ctx.mocks.drive.tracker.getCalls('files.create').length, 1);
        assert.equal(ctx.mocks.sheets.tracker.calls.length + ctx.mocks.slides.tracker.calls.length, 0);
      });

      it('never retries an ambiguous create or exposes the provider error', async () => {
        ctx.mocks.drive.service.files.create._setImpl(async () => { throw providerFailure(); });
        const result = await callTool(ctx.client, tool, { name: 'Ambiguous', ...args });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text!, /creation outcome.*uncertain/i);
        assert.doesNotMatch(result.content[0].text!, /PRIVATE_PROVIDER_DETAIL/);
        assert.equal(ctx.mocks.drive.tracker.getCalls('files.create').length, 1);
        assert.equal(ctx.mocks.sheets.tracker.calls.length + ctx.mocks.slides.tracker.calls.length, 0);
      });
    });
  }

  it('initializes the actual sheet ID as Sheet1 with minimum grid dimensions and RAW values', async () => {
    const data = [['=SUM(1,2)', 'literal']];
    const result = await callTool(ctx.client, 'createGoogleSheet', { name: 'Grid', data });
    assert.equal(result.isError, false, result.content[0].text);
    const read = ctx.mocks.sheets.tracker.getCalls('spreadsheets.get')[0];
    assert.equal(read.args[0].spreadsheetId, 'native-file');
    assert.ok(read.args[1].signal instanceof AbortSignal);
    const init = ctx.mocks.sheets.tracker.getCalls('spreadsheets.batchUpdate')[0];
    assert.equal(init.args[0].spreadsheetId, 'native-file');
    assert.deepEqual(init.args[0].requestBody.requests, [{ updateSheetProperties: {
      properties: { sheetId: 73, title: 'Sheet1', gridProperties: { rowCount: 1000, columnCount: 26 } },
      fields: 'title,gridProperties.rowCount,gridProperties.columnCount',
    } }]);
    assert.ok(init.args[1].signal instanceof AbortSignal);
    const write = ctx.mocks.sheets.tracker.getCalls('spreadsheets.values.update')[0];
    assert.deepEqual(write.args[0], { spreadsheetId: 'native-file', range: 'Sheet1!A1', valueInputOption: 'RAW', requestBody: { values: data } });
    assert.ok(write.args[1].signal instanceof AbortSignal);
  });

  it('sizes for all ragged rows and preserves USER_ENTERED', async () => {
    const data = Array.from({ length: 1001 }, () => ['short']);
    data[1000] = Array.from({ length: 31 }, (_, i) => String(i));
    await callTool(ctx.client, 'createGoogleSheet', { name: 'Ragged', data, valueInputOption: 'USER_ENTERED' });
    const properties = ctx.mocks.sheets.tracker.getCalls('spreadsheets.batchUpdate')[0].args[0].requestBody.requests[0].updateSheetProperties.properties;
    assert.deepEqual(properties.gridProperties, { rowCount: 1001, columnCount: 31 });
    assert.equal(ctx.mocks.sheets.tracker.getCalls('spreadsheets.values.update')[0].args[0].valueInputOption, 'USER_ENTERED');
  });

  for (const data of [[], [[]], [[], []]]) {
    it(`accepts an empty data matrix ${JSON.stringify(data)} without a values write`, async () => {
      const result = await callTool(ctx.client, 'createGoogleSheet', { name: 'Empty', data });
      assert.equal(result.isError, false, result.content[0].text);
      assert.equal(ctx.mocks.sheets.tracker.getCalls('spreadsheets.values.update').length, 0);
    });
  }

  it('reports a partial spreadsheet if metadata has no usable tab ID', async () => {
    ctx.mocks.sheets.service.spreadsheets.get._setImpl(async () => ({ data: { sheets: [{ properties: { title: 'Unknown' } }] } }));
    const result = await callTool(ctx.client, 'createGoogleSheet', { name: 'No tab ID', data: [['a']] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text!, /ID: native-file/);
    assert.match(result.content[0].text!, /spreadsheet metadata/);
    assert.equal(ctx.mocks.sheets.tracker.getCalls('spreadsheets.batchUpdate').length, 0);
    assert.equal(ctx.mocks.sheets.tracker.getCalls('spreadsheets.values.update').length, 0);
  });

  for (const [method, stage] of [['batchUpdate', 'sheet initialization'], ['values.update', 'data insertion']]) {
    it(`reports a partial spreadsheet and does not retry ${stage}`, async () => {
      const stub = method === 'batchUpdate' ? ctx.mocks.sheets.service.spreadsheets.batchUpdate : ctx.mocks.sheets.service.spreadsheets.values.update;
      stub._setImpl(async () => { throw providerFailure(); });
      const result = await callTool(ctx.client, 'createGoogleSheet', { name: 'Partial', data: [['a']] });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text!, /ID: native-file/);
      assert.ok(result.content[0].text!.includes(stage));
      assert.doesNotMatch(result.content[0].text!, /PRIVATE_PROVIDER_DETAIL/);
      assert.equal(ctx.mocks.sheets.tracker.getCalls(`spreadsheets.${method}`).length, 1);
      assert.equal(ctx.mocks.drive.tracker.getCalls('files.create').length, 1);
      assert.equal(ctx.mocks.drive.tracker.getCalls('files.delete').length, 0);
    });
  }

  it('preserves slide count, generated IDs, layouts, and title/body insertion', async () => {
    const slides = [{ title: 'First', content: 'First body' }, { title: 'Second', content: 'Second body' }];
    ctx.mocks.slides.service.presentations.pages.get._setImpl(async (request) => ({ data: { pageElements: [
      { objectId: `${request.pageObjectId}_title`, shape: { placeholder: { type: 'TITLE' } } },
      { objectId: `${request.pageObjectId}_body`, shape: { placeholder: { type: 'BODY' } } },
    ] } }));
    const result = await callTool(ctx.client, 'createGoogleSlides', { name: 'Deck', slides });
    assert.equal(result.isError, false, result.content[0].text);
    const writes = ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate');
    assert.equal(writes.length, 4);
    assert.equal(new Set(writes.filter((_, i) => i % 2 === 0).map(c => c.args[0].requestBody.requests[0].createSlide.objectId)).size, 2);
    for (let i = 0; i < slides.length; i++) {
      const create = writes[i * 2].args[0];
      assert.equal(create.presentationId, 'native-file');
      const slide = create.requestBody.requests[0].createSlide;
      assert.match(slide.objectId, /^slide_[a-z0-9-]{8}$/);
      assert.equal(slide.slideLayoutReference.predefinedLayout, 'TITLE_AND_BODY');
      assert.deepEqual(writes[i * 2 + 1].args[0].requestBody.requests, [
        { insertText: { objectId: `${slide.objectId}_title`, text: slides[i].title, insertionIndex: 0 } },
        { insertText: { objectId: `${slide.objectId}_body`, text: slides[i].content, insertionIndex: 0 } },
      ]);
    }
    assert.match(result.content[0].text!, /https:\/\/docs.google.com\/presentation\/d\/native-file/);
  });

  it('removes every real starter slide before adding exactly the requested slides', async () => {
    ctx.mocks.slides.service.presentations.get._setImpl(async () => ({ data: { slides: [
      { objectId: 'actual-starter-1' }, { objectId: 'actual-starter-2' },
    ] } }));
    const result = await callTool(ctx.client, 'createGoogleSlides', { name: 'Starter deck', slides: [{ title: 'Only', content: 'Requested' }] });
    assert.equal(result.isError, false, result.content[0].text);
    const read = ctx.mocks.slides.tracker.getCalls('presentations.get')[0];
    assert.equal(read.args[0].presentationId, 'native-file');
    assert.equal(read.args[0].fields, 'slides(objectId)');
    const writes = ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate');
    assert.equal(writes.length, 3);
    assert.deepEqual(writes[0].args[0].requestBody.requests, [
      { deleteObject: { objectId: 'actual-starter-1' } }, { deleteObject: { objectId: 'actual-starter-2' } },
    ]);
    assert.ok(writes.every(call => call.args[0].presentationId === 'native-file' && call.args[1].signal instanceof AbortSignal));
    assert.ok(writes[1].args[0].requestBody.requests[0].createSlide);
    assert.equal(writes[2].args[0].requestBody.requests.length, 2);
  });

  it('reports a partial presentation without retrying starter removal', async () => {
    ctx.mocks.slides.service.presentations.get._setImpl(async () => ({ data: { slides: [{ objectId: 'starter' }] } }));
    ctx.mocks.slides.service.presentations.batchUpdate._setImpl(async () => { throw providerFailure(); });
    const result = await callTool(ctx.client, 'createGoogleSlides', { name: 'Partial', slides: [{ title: 'Only', content: 'Body' }] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text!, /starter slide removal/);
    assert.match(result.content[0].text!, /ID: native-file/);
    assert.doesNotMatch(result.content[0].text!, /PRIVATE_PROVIDER_DETAIL/);
    assert.equal(ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate').length, 1);
  });

  it('stops with a partial presentation if a starter has no ID', async () => {
    ctx.mocks.slides.service.presentations.get._setImpl(async () => ({ data: { slides: [{}] } }));
    const result = await callTool(ctx.client, 'createGoogleSlides', { name: 'Invalid starter', slides: [{ title: 'Only', content: 'Body' }] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text!, /presentation metadata/);
    assert.match(result.content[0].text!, /ID: native-file/);
    assert.equal(ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate').length, 0);
  });

  it('stops with a partial presentation if title/body placeholders are missing', async () => {
    ctx.mocks.slides.service.presentations.pages.get._setImpl(async () => ({ data: { pageElements: [] } }));
    const result = await callTool(ctx.client, 'createGoogleSlides', { name: 'No placeholders', slides: [{ title: 'Only', content: 'Body' }] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text!, /placeholder lookup/);
    assert.match(result.content[0].text!, /ID: native-file/);
    assert.equal(ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate').length, 1);
  });

  for (const { tool, args } of cases) {
    it(`${tool} retains normal read retries during metadata initialization`, async () => {
      const stub = tool === 'createGoogleSheet' ? ctx.mocks.sheets.service.spreadsheets.get : ctx.mocks.slides.service.presentations.get;
      let attempts = 0;
      stub._setImpl(async () => {
        if (++attempts === 1) throw providerFailure();
        return { data: tool === 'createGoogleSheet' ? { sheets: [{ properties: { sheetId: 0 } }] } : { slides: [] } };
      });
      const result = await callTool(ctx.client, tool, { name: 'Retry metadata', ...args });
      assert.equal(result.isError, false, result.content[0].text);
      assert.equal(attempts, 2);
      assert.equal(ctx.mocks.drive.tracker.getCalls('files.create').length, 1);
    });

    it(`${tool} reports a safe partial ID when metadata reads fail`, async () => {
      const stub = tool === 'createGoogleSheet' ? ctx.mocks.sheets.service.spreadsheets.get : ctx.mocks.slides.service.presentations.get;
      stub._setImpl(async () => { throw new Error('PRIVATE_PROVIDER_DETAIL'); });
      const result = await callTool(ctx.client, tool, { name: 'Partial metadata', ...args });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text!, /ID: native-file/);
      assert.match(result.content[0].text!, /metadata/);
      assert.doesNotMatch(result.content[0].text!, /PRIVATE_PROVIDER_DETAIL/);
    });
  }

  it('retains validation rejecting an empty slide list', async () => {
    const result = await callTool(ctx.client, 'createGoogleSlides', { name: 'Empty', slides: [] });
    assert.equal(result.isError, true);
    assert.equal(ctx.mocks.drive.tracker.getCalls('files.create').length, 0);
  });

  for (const stage of ['slide creation', 'placeholder lookup', 'text insertion']) {
    it(`reports the partial presentation and failed ${stage} stage`, async () => {
      if (stage === 'placeholder lookup') {
        ctx.mocks.slides.service.presentations.pages.get._setImpl(async () => { throw new Error('PRIVATE_PROVIDER_DETAIL'); });
      } else {
        ctx.mocks.slides.service.presentations.batchUpdate._setImpl(async (request) => {
          if (Boolean(request.requestBody.requests[0].createSlide) === (stage === 'slide creation')) throw providerFailure();
          return { data: {} };
        });
      }
      const result = await callTool(ctx.client, 'createGoogleSlides', { name: 'Partial', slides: [{ title: 'Title', content: 'Body' }] });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text!, /ID: native-file/);
      assert.ok(result.content[0].text!.includes(stage));
      assert.doesNotMatch(result.content[0].text!, /PRIVATE_PROVIDER_DETAIL/);
      assert.equal(ctx.mocks.drive.tracker.getCalls('files.create').length, 1);
      assert.equal(ctx.mocks.drive.tracker.getCalls('files.delete').length, 0);
      assert.equal(ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate').length, stage === 'text insertion' ? 2 : 1);
    });
  }
});
