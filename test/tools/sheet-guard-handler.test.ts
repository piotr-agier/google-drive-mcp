import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTool, toolDefinitions } from '../../src/tools/sheets.js';
import { convertA1ToGridRange } from '../../src/utils.js';
import { splitRange } from '../../src/tools/sheetCells.js';

/** A call-counting double: dryRun must not write at all. */
function fakeCtx(grid: unknown, opts: { writeResponse?: unknown } = {}) {
  const calls = { get: 0, write: 0, lastWriteBody: null as any };
  const ctx = {
    authClient: {},
    google: {
      sheets: () => ({
        spreadsheets: {
          get: async () => { calls.get++; return { data: grid }; },
          values: {
            batchUpdate: async (p: any) => {
              calls.write++; calls.lastWriteBody = p.requestBody;
              return { data: opts.writeResponse ?? { responses: [] } };
            },
          },
        },
      }),
    },
  } as unknown as Parameters<typeof handleTool>[2];
  return { ctx, calls };
}

const gridWith = (uev: Record<string, unknown>) => ({
  properties: { title: 'Model' },
  sheets: [{ properties: { sheetId: 0, title: 'Probe' },
    data: [{ startRow: 0, startColumn: 0, rowData: [{ values: [{ userEnteredValue: uev }] }] }] }],
});

const dryFingerprint = async (grid: unknown) => {
  const { ctx } = fakeCtx(grid);
  const r = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates: [{ range: 'Probe!A1', values: [['1']] }], dryRun: true }, ctx);
  return JSON.parse(r!.content[0].text as string).fingerprint as string;
};

const writeOk = { responses: [{ updatedData: { range: 'Probe!A1', values: [['1']] } }] };

test('the tool is registered and requires spreadsheetId and updates', () => {
  const def = toolDefinitions.find(d => d.name === 'updateGoogleSheetIfUnchanged');
  assert.ok(def, 'tool must be in toolDefinitions');
  const schema = def!.inputSchema as { properties: Record<string, unknown>; required: string[] };
  assert.ok(schema.properties.expectedFingerprint && schema.properties.guardRanges && schema.properties.dryRun);
  assert.deepEqual([...schema.required].sort(), ['spreadsheetId', 'updates']);
});

test('dryRun returns a fingerprint and writes nothing at all', async () => {
  const { ctx, calls } = fakeCtx(gridWith({ formulaValue: '=A2' }));
  const result = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates: [{ range: 'Probe!A1', values: [['1']] }], dryRun: true }, ctx);
  assert.ok(result); assert.equal(result.isError, false);
  const payload = JSON.parse(result.content[0].text as string);
  assert.match(payload.fingerprint, /^v1:[0-9a-f]{64}$/);
  assert.equal(calls.write, 0, 'dryRun must not call the write API');
});

test('a fingerprint mismatch refuses, writes nothing, and returns the current contents', async () => {
  const { ctx, calls } = fakeCtx(gridWith({ formulaValue: '=A2' }));
  const result = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates: [{ range: 'Probe!A1', values: [['1']] }],
      expectedFingerprint: 'v1:' + '0'.repeat(64) }, ctx);
  assert.ok(result); assert.equal(result.isError, true);
  assert.equal(calls.write, 0, 'a refused write must not reach the API');
  const payload = JSON.parse(result.content[0].text as string);
  assert.equal(payload.refused, 'fingerprint-mismatch');
  assert.ok(payload.actualFingerprint && payload.guardContents);
});

test('a matching fingerprint writes once and returns the pre-image and postFingerprint', async () => {
  const grid = gridWith({ formulaValue: '=A2' });
  const fp = await dryFingerprint(grid);
  const { ctx, calls } = fakeCtx(grid, { writeResponse: writeOk });
  const result = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates: [{ range: 'Probe!A1', values: [['1']] }], expectedFingerprint: fp }, ctx);

  assert.ok(result); assert.equal(result.isError, false);
  assert.equal(calls.write, 1);
  assert.equal(calls.get, 1, 'exactly one read: no verification round trip');
  const payload = JSON.parse(result.content[0].text as string);
  assert.deepEqual(payload.preImage, [{ range: 'Probe!A1', values: [['=A2']] }]);
  assert.match(payload.postFingerprint, /^v1:[0-9a-f]{64}$/);
  assert.deepEqual(payload.hazards, []);
});

test('the write asks the API to return what it wrote, so no second read is needed', async () => {
  const grid = gridWith({ formulaValue: '=A2' });
  const fp = await dryFingerprint(grid);
  const { ctx, calls } = fakeCtx(grid, { writeResponse: writeOk });
  await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates: [{ range: 'Probe!A1', values: [['1']] }], expectedFingerprint: fp }, ctx);
  assert.equal(calls.lastWriteBody.includeValuesInResponse, true);
  assert.equal(calls.lastWriteBody.responseValueRenderOption, 'FORMULA');
});

test('text that looks like a formula is reported with its native form', async () => {
  const grid = gridWith({ stringValue: '=notaformula' });
  const fp = await dryFingerprint(grid);
  const { ctx } = fakeCtx(grid, { writeResponse: writeOk });
  const result = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates: [{ range: 'Probe!A1', values: [['1']] }], expectedFingerprint: fp }, ctx);
  const payload = JSON.parse(result!.content[0].text as string);
  assert.equal(payload.hazards.length, 1);
  assert.equal(payload.hazards[0].a1, 'A1');
  assert.deepEqual(payload.hazards[0].userEnteredValue, { stringValue: '=notaformula' });
});

test('a write without expectedFingerprint is rejected before any API call', async () => {
  const { ctx, calls } = fakeCtx(gridWith({ formulaValue: '=A2' }));
  const result = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates: [{ range: 'Probe!A1', values: [['1']] }] }, ctx);
  assert.ok(result); assert.equal(result.isError, true);
  assert.equal(calls.get, 0);
  assert.equal(calls.write, 0);
});

test('a guardRanges set that differs from the write range requests both, guard first', async () => {
  // Distinct from the write range, so the handler must NOT collapse this to
  // one read: two grid entries, one per requested range in guard-then-write
  // order.
  const grid = {
    properties: { title: 'Model' },
    sheets: [{ properties: { sheetId: 0, title: 'Probe' },
      data: [
        { startRow: 0, startColumn: 1, rowData: [{ values: [{ userEnteredValue: { numberValue: 9 } }] }] },
        { startRow: 0, startColumn: 0, rowData: [{ values: [{ userEnteredValue: { formulaValue: '=A2' } }] }] },
      ] }],
  };
  const captured: { ranges?: string[] } = {};
  const ctx = {
    authClient: {},
    google: { sheets: () => ({ spreadsheets: { get: async (params: any) => {
      captured.ranges = params.ranges;
      return { data: grid };
    } } }) },
  } as unknown as Parameters<typeof handleTool>[2];

  const result = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates: [{ range: 'Probe!A1', values: [['1']] }],
      guardRanges: ['Probe!B1'], dryRun: true }, ctx);
  assert.ok(result); assert.equal(result.isError, false);
  assert.deepEqual(captured.ranges, ['Probe!B1', 'Probe!A1']);
});

test('a guardRanges set equal to the write range collapses to a single read of exactly that one range', async () => {
  // Pins the branch finding 1/2's fixes touch: when the guard set equals the
  // write set the handler must read it once, not twice.
  const grid = gridWith({ formulaValue: '=A2' });
  const captured: { ranges?: string[] } = {};
  const ctx = {
    authClient: {},
    google: { sheets: () => ({ spreadsheets: { get: async (params: any) => {
      captured.ranges = params.ranges;
      return { data: grid };
    } } }) },
  } as unknown as Parameters<typeof handleTool>[2];

  const result = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates: [{ range: 'Probe!A1', values: [['1']] }], dryRun: true }, ctx);
  assert.ok(result); assert.equal(result.isError, false);
  assert.deepEqual(captured.ranges, ['Probe!A1']);
});

test('a write response missing updatedData.range fails loudly instead of yielding a meaningless postFingerprint', async () => {
  const grid = gridWith({ formulaValue: '=A2' });
  const fp = await dryFingerprint(grid);
  const { ctx, calls } = fakeCtx(grid, { writeResponse: { responses: [{}] } });
  const result = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates: [{ range: 'Probe!A1', values: [['1']] }], expectedFingerprint: fp }, ctx);
  assert.ok(result);
  assert.equal(result.isError, true, 'the write happened but the post-state is unknown, so this must fail loudly');
  assert.equal(calls.write, 1, 'the write itself must still have gone through - only the fingerprint is unavailable');
  const payload = JSON.parse(result.content[0].text as string);
  assert.equal(payload.error, 'post-write-fingerprint-unavailable');
  assert.match(payload.message, /succeeded/i);
  assert.ok(payload.preImage, 'preImage must still be reported so a manual rollback stays possible');
});

// ---------------------------------------------------------------------------
// A stateful fake spreadsheet: enough of spreadsheets.get / values.batchUpdate
// to run the tool against itself across several calls and see the ACTUAL
// resulting sheet state, not just what one call reports about itself. Ranges
// used against it are kept to plain, single-sheet A1 rectangles (no
// open-ended ranges) - all this needs to model.
// ---------------------------------------------------------------------------

type RawCell = Record<string, unknown>;

function makeStatefulCtx(sheetTitle: string, sheetId: number, initial: Record<string, RawCell>) {
  const key = (row: number, col: number) => `${row},${col}`;
  const cells = new Map<string, RawCell>();
  for (const [a1, value] of Object.entries(initial)) {
    const g = convertA1ToGridRange(a1, sheetId);
    cells.set(key(g.startRowIndex!, g.startColumnIndex!), value);
  }
  const calls = { get: 0, write: 0 };

  function rectangleOf(range: string) {
    const { cellRange } = splitRange(range);
    const g = convertA1ToGridRange(cellRange!, sheetId);
    return {
      startRow: g.startRowIndex!, startColumn: g.startColumnIndex!,
      endRow: g.endRowIndex!, endColumn: g.endColumnIndex!,
    };
  }

  // Mirrors the real API's own trimming: rows/columns are trimmed from the
  // TRAILING edge only, down to the last row/column actually holding a value
  // within the requested rectangle; an all-empty rectangle yields no rowData
  // at all - exactly the shape blockFromMatch's padding is meant to survive.
  function gridDataFor(range: string) {
    const { startRow, startColumn, endRow, endColumn } = rectangleOf(range);
    let lastRow = -1;
    for (let r = startRow; r < endRow; r++) {
      for (let c = startColumn; c < endColumn; c++) {
        if (cells.has(key(r, c))) { lastRow = r; break; }
      }
    }
    if (lastRow === -1) return { startRow, startColumn };
    const rowData = [];
    for (let r = startRow; r <= lastRow; r++) {
      let lastCol = -1;
      for (let c = startColumn; c < endColumn; c++) if (cells.has(key(r, c))) lastCol = c;
      const values = [];
      for (let c = startColumn; c <= lastCol; c++) values.push({ userEnteredValue: cells.get(key(r, c)) ?? {} });
      rowData.push({ values });
    }
    return { startRow, startColumn, rowData };
  }

  function applyWrite(range: string, values: string[][], valueInputOption: string) {
    const { startRow, startColumn } = rectangleOf(range);
    values.forEach((row, r) => row.forEach((raw, c) => {
      const k = key(startRow + r, startColumn + c);
      if (raw === '') { cells.delete(k); return; }
      if (valueInputOption === 'USER_ENTERED') {
        if (raw.startsWith('=')) { cells.set(k, { formulaValue: raw }); return; }
        if (/^(?:true|false)$/i.test(raw)) { cells.set(k, { boolValue: raw.toLowerCase() === 'true' }); return; }
        if (raw.trim() !== '' && Number.isFinite(Number(raw))) { cells.set(k, { numberValue: Number(raw) }); return; }
      }
      cells.set(k, { stringValue: raw });
    }));
  }

  function updatedDataFor(range: string) {
    const grid = gridDataFor(range) as { rowData?: { values: { userEnteredValue: RawCell }[] }[] };
    const rows = grid.rowData ?? [];
    const values = rows.map(row => row.values.map(v => {
      const uev = v.userEnteredValue;
      if (typeof uev.formulaValue === 'string') return uev.formulaValue;
      if (typeof uev.numberValue === 'number') return uev.numberValue;
      if (typeof uev.stringValue === 'string') return uev.stringValue;
      if (typeof uev.boolValue === 'boolean') return uev.boolValue;
      return '';
    }));
    return { range, values };
  }

  const ctx = {
    authClient: {},
    google: {
      sheets: () => ({
        spreadsheets: {
          get: async (params: any) => {
            calls.get++;
            const data = (params.ranges as string[]).map(r => gridDataFor(r));
            return { data: { properties: { title: 'Model' },
              sheets: [{ properties: { sheetId, title: sheetTitle }, data }] } };
          },
          values: {
            batchUpdate: async (p: any) => {
              calls.write++;
              const updates = p.requestBody.data as { range: string; values: string[][] }[];
              updates.forEach(u => applyWrite(u.range, u.values, p.requestBody.valueInputOption));
              const responses = updates.map(u => ({ updatedData: updatedDataFor(u.range) }));
              const totalUpdatedCells = updates.reduce((n, u) => n + u.values.reduce((m, row) => m + row.length, 0), 0);
              return { data: { responses, totalUpdatedCells } };
            },
          },
        },
      }),
    },
  } as unknown as Parameters<typeof handleTool>[2];

  return { ctx, calls };
}

test('a real round trip: writing into a previously empty cell and a formula cell, then applying the returned preImage, restores exactly the original state', async () => {
  const { ctx, calls } = makeStatefulCtx('Probe', 0, {
    // A1 starts out with no entry at all - genuinely empty, the case finding
    // 1 broke. A2 holds a formula.
    A2: { formulaValue: '=SUM(B1:B2)' },
  });

  const updates = [
    { range: 'Probe!A1', values: [['NEW']] },
    { range: 'Probe!A2', values: [['NEW2']] },
  ];

  const dry = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates, dryRun: true }, ctx);
  const originalFingerprint = JSON.parse(dry!.content[0].text as string).fingerprint as string;

  const write = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates, expectedFingerprint: originalFingerprint }, ctx);
  assert.equal(write!.isError, false);
  const writePayload = JSON.parse(write!.content[0].text as string);

  // Finding 1's exact bug: the empty cell's pre-image must be an empty
  // string a write can apply, not an under-covering `[]`.
  assert.deepEqual(writePayload.preImage, [
    { range: 'Probe!A1', values: [['']] },
    { range: 'Probe!A2', values: [['=SUM(B1:B2)']] },
  ]);

  const undo = await handleTool('updateGoogleSheetIfUnchanged',
    {
      spreadsheetId: 'x',
      updates: writePayload.preImage,
      guardRanges: ['Probe!A1', 'Probe!A2'],
      expectedFingerprint: writePayload.postFingerprint,
    }, ctx);
  assert.equal(undo!.isError, false, JSON.stringify(JSON.parse(undo!.content[0].text as string)));

  // Round trip complete: fingerprinting the same ranges again matches the
  // ORIGINAL fingerprint exactly - the sheet is back to what it was before
  // either write, empty cell and formula alike.
  const after = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates, dryRun: true }, ctx);
  const restoredFingerprint = JSON.parse(after!.content[0].text as string).fingerprint as string;
  assert.equal(restoredFingerprint, originalFingerprint);
  assert.equal(calls.write, 2);
});

test('the post-block geometry matches the guard geometry for the same declared range, when the write covers only part of it', async () => {
  const { ctx } = makeStatefulCtx('Probe', 0, {});
  const range = 'Probe!A1:B2'; // declared 2x2; only A1 is ever actually written.

  const dry = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates: [{ range, values: [['X']] }], dryRun: true }, ctx);
  const fp = JSON.parse(dry!.content[0].text as string).fingerprint as string;

  const write = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates: [{ range, values: [['X']] }], expectedFingerprint: fp }, ctx);
  const payload = JSON.parse(write!.content[0].text as string);

  // Re-guard the identical declared range: its fingerprint must agree with
  // postFingerprint bit for bit - both are canonical blocks padded to the
  // same A1:B2 rectangle, even though only A1 was ever actually written.
  const reguard = await handleTool('updateGoogleSheetIfUnchanged',
    { spreadsheetId: 'x', updates: [{ range, values: [['X']] }], dryRun: true }, ctx);
  const reguardFp = JSON.parse(reguard!.content[0].text as string).fingerprint as string;

  assert.equal(payload.postFingerprint, reguardFp);
});
