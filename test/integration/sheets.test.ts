import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

describe('Sheets tools', () => {
  let ctx: TestContext;

  before(async () => { ctx = await setupTestServer(); });
  after(async () => { await ctx.cleanup(); });
  beforeEach(() => {
    ctx.mocks.drive.tracker.reset();
    ctx.mocks.sheets.tracker.reset();
  });

  // Helper to set up common Sheets mock that many formatting tests need
  function setupSheetsMock() {
    ctx.mocks.sheets.service.spreadsheets.get._setImpl(async () => ({
      data: {
        spreadsheetId: 'sheet-1',
        properties: { title: 'Test Sheet' },
        sheets: [{ properties: { sheetId: 0, title: 'Sheet1', gridProperties: { rowCount: 100, columnCount: 26 } } }],
      },
    }));
  }

  // --- createGoogleSheet ---
  describe('createGoogleSheet', () => {
    it('happy path', async () => {
      ctx.mocks.drive.service.files.list._setImpl(async () => ({ data: { files: [] } }));
      ctx.mocks.sheets.service.spreadsheets.create._setImpl(async () => ({
        data: { spreadsheetId: 'sheet-new' },
      }));
      const res = await callTool(ctx.client, 'createGoogleSheet', {
        name: 'My Sheet', data: [['A', 'B'], ['1', '2']],
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('My Sheet'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'createGoogleSheet', {});
      assert.equal(res.isError, true);
    });
  });

  // --- updateGoogleSheet ---
  describe('updateGoogleSheet', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'updateGoogleSheet', {
        spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B2', data: [['a', 'b']],
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Updated'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'updateGoogleSheet', {});
      assert.equal(res.isError, true);
    });
  });

  // --- getGoogleSheetContent ---
  describe('getGoogleSheetContent', () => {
    it('happy path', async () => {
      ctx.mocks.sheets.service.spreadsheets.values.get._setImpl(async () => ({
        data: { values: [['Name', 'Age'], ['Alice', '30']] },
      }));
      const res = await callTool(ctx.client, 'getGoogleSheetContent', {
        spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B2',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Alice'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'getGoogleSheetContent', {});
      assert.equal(res.isError, true);
    });
  });

  // --- formatGoogleSheetCells ---
  describe('formatGoogleSheetCells', () => {
    it('happy path', async () => {
      setupSheetsMock();
      const res = await callTool(ctx.client, 'formatGoogleSheetCells', {
        spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B2',
        horizontalAlignment: 'CENTER',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Formatted'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'formatGoogleSheetCells', {});
      assert.equal(res.isError, true);
    });
  });

  // --- formatGoogleSheetText ---
  describe('formatGoogleSheetText', () => {
    it('happy path', async () => {
      setupSheetsMock();
      const res = await callTool(ctx.client, 'formatGoogleSheetText', {
        spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B2', bold: true,
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('text formatting'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'formatGoogleSheetText', {});
      assert.equal(res.isError, true);
    });
  });

  // --- formatGoogleSheetNumbers ---
  describe('formatGoogleSheetNumbers', () => {
    it('happy path', async () => {
      setupSheetsMock();
      const res = await callTool(ctx.client, 'formatGoogleSheetNumbers', {
        spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B2', pattern: '#,##0.00',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('number formatting'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'formatGoogleSheetNumbers', {});
      assert.equal(res.isError, true);
    });
  });

  // --- setGoogleSheetBorders ---
  describe('setGoogleSheetBorders', () => {
    it('happy path', async () => {
      setupSheetsMock();
      const res = await callTool(ctx.client, 'setGoogleSheetBorders', {
        spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B2', style: 'SOLID',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('borders'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'setGoogleSheetBorders', {});
      assert.equal(res.isError, true);
    });
  });

  // --- mergeGoogleSheetCells ---
  describe('mergeGoogleSheetCells', () => {
    it('happy path', async () => {
      setupSheetsMock();
      const res = await callTool(ctx.client, 'mergeGoogleSheetCells', {
        spreadsheetId: 'sheet-1', range: 'Sheet1!A1:C3', mergeType: 'MERGE_ALL',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Merged'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'mergeGoogleSheetCells', {});
      assert.equal(res.isError, true);
    });
  });

  // --- addGoogleSheetConditionalFormat ---
  describe('addGoogleSheetConditionalFormat', () => {
    it('happy path', async () => {
      setupSheetsMock();
      const res = await callTool(ctx.client, 'addGoogleSheetConditionalFormat', {
        spreadsheetId: 'sheet-1',
        range: 'Sheet1!A1:B2',
        condition: { type: 'NUMBER_GREATER', value: '100' },
        format: { backgroundColor: { red: 1, green: 0, blue: 0 } },
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('conditional formatting'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'addGoogleSheetConditionalFormat', {});
      assert.equal(res.isError, true);
    });
  });

  // --- getSpreadsheetInfo ---
  describe('getSpreadsheetInfo', () => {
    it('happy path', async () => {
      setupSheetsMock();
      const res = await callTool(ctx.client, 'getSpreadsheetInfo', { spreadsheetId: 'sheet-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Test Sheet'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'getSpreadsheetInfo', {});
      assert.equal(res.isError, true);
    });
  });

  // --- appendSpreadsheetRows ---
  describe('appendSpreadsheetRows', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'appendSpreadsheetRows', {
        spreadsheetId: 'sheet-1', range: 'A1', values: [['x', 'y']],
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('appended'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'appendSpreadsheetRows', {});
      assert.equal(res.isError, true);
    });
  });

  // --- addSpreadsheetSheet ---
  describe('addSpreadsheetSheet', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'addSpreadsheetSheet', {
        spreadsheetId: 'sheet-1', sheetTitle: 'Sheet2',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Sheet2'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'addSpreadsheetSheet', {});
      assert.equal(res.isError, true);
    });
  });

  // --- listSheets / renameSheet / deleteSheet ---
  describe('sheet lifecycle tools', () => {
    it('listSheets happy path', async () => {
      setupSheetsMock();
      const res = await callTool(ctx.client, 'listSheets', { spreadsheetId: 'sheet-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Sheet1'));
    });

    it('renameSheet happy path', async () => {
      const res = await callTool(ctx.client, 'renameSheet', { spreadsheetId: 'sheet-1', sheetId: 0, newTitle: 'Renamed' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Renamed'));
    });

    it('deleteSheet happy path', async () => {
      const res = await callTool(ctx.client, 'deleteSheet', { spreadsheetId: 'sheet-1', sheetId: 0 });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Deleted sheet'));
    });
  });

  // --- governance helpers ---
  describe('validation/protection/named-range tools', () => {
    it('addDataValidation happy path', async () => {
      setupSheetsMock();
      const res = await callTool(ctx.client, 'addDataValidation', {
        spreadsheetId: 'sheet-1', range: 'Sheet1!A1:A10', conditionType: 'ONE_OF_LIST', values: ['A', 'B'],
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Added data validation'));
    });

    it('protectRange happy path', async () => {
      setupSheetsMock();
      const res = await callTool(ctx.client, 'protectRange', {
        spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B10', description: 'Lock critical',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Protected range'));
    });

    it('addNamedRange happy path', async () => {
      setupSheetsMock();
      const res = await callTool(ctx.client, 'addNamedRange', {
        spreadsheetId: 'sheet-1', name: 'InputRange', range: 'Sheet1!A1:B10',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Added named range'));
    });
  });

  // --- listGoogleSheets ---
  describe('listGoogleSheets', () => {
    it('happy path', async () => {
      ctx.mocks.drive.service.files.list._setImpl(async () => ({
        data: { files: [{ id: 'sheet-1', name: 'Budget', modifiedTime: '2025-01-01', webViewLink: 'https://link', owners: [{ displayName: 'Owner' }] }] },
      }));
      const res = await callTool(ctx.client, 'listGoogleSheets', {});
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Budget'));
    });
  });

  // --- copyFile ---
  describe('copyFile', () => {
    it('happy path', async () => {
      ctx.mocks.drive.service.files.get._setImpl(async () => ({
        data: { name: 'Original', parents: ['root'] },
      }));
      const res = await callTool(ctx.client, 'copyFile', { fileId: 'file-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('copied'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'copyFile', {});
      assert.equal(res.isError, true);
    });
  });
});
