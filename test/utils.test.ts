import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getExtensionFromFilename,
  getMimeTypeFromFilename,
  escapeDriveQuery,
  parseA1Range,
  colToIndex,
  convertA1ToGridRange,
} from '../src/utils.js';

// ---------------------------------------------------------------------------
// getExtensionFromFilename
// ---------------------------------------------------------------------------
test('getExtensionFromFilename returns lowercase extension', () => {
  assert.equal(getExtensionFromFilename('report.PDF'), 'pdf');
});

test('getExtensionFromFilename returns last extension for dotted names', () => {
  assert.equal(getExtensionFromFilename('archive.tar.gz'), 'gz');
});

test('getExtensionFromFilename returns empty string for no extension', () => {
  assert.equal(getExtensionFromFilename('Makefile'), 'makefile');
});

// ---------------------------------------------------------------------------
// getMimeTypeFromFilename
// ---------------------------------------------------------------------------
test('getMimeTypeFromFilename returns text/plain for .txt', () => {
  assert.equal(getMimeTypeFromFilename('notes.txt'), 'text/plain');
});

test('getMimeTypeFromFilename returns text/markdown for .md', () => {
  assert.equal(getMimeTypeFromFilename('README.md'), 'text/markdown');
});

test('getMimeTypeFromFilename falls back to text/plain for unknown', () => {
  assert.equal(getMimeTypeFromFilename('data.csv'), 'text/plain');
});

// ---------------------------------------------------------------------------
// escapeDriveQuery
// ---------------------------------------------------------------------------
test('escapeDriveQuery passes clean strings through', () => {
  assert.equal(escapeDriveQuery('hello world'), 'hello world');
});

test('escapeDriveQuery escapes single quotes', () => {
  assert.equal(escapeDriveQuery("it's"), "it\\'s");
});

test('escapeDriveQuery escapes backslashes', () => {
  assert.equal(escapeDriveQuery('path\\file'), 'path\\\\file');
});

test('escapeDriveQuery escapes backslash before quote', () => {
  assert.equal(escapeDriveQuery("a\\'b"), "a\\\\\\'b");
});

// ---------------------------------------------------------------------------
// parseA1Range
// ---------------------------------------------------------------------------
test('parseA1Range defaults to Sheet1 when no prefix', () => {
  const result = parseA1Range('A1:B2');
  assert.equal(result.sheetName, 'Sheet1');
  assert.equal(result.cellRange, 'A1:B2');
});

test('parseA1Range extracts unquoted sheet name', () => {
  const result = parseA1Range('Data!C3:D4');
  assert.equal(result.sheetName, 'Data');
  assert.equal(result.cellRange, 'C3:D4');
});

test('parseA1Range strips surrounding single quotes from sheet name', () => {
  const result = parseA1Range("'My Sheet'!A1:B2");
  assert.equal(result.sheetName, 'My Sheet');
  assert.equal(result.cellRange, 'A1:B2');
});

test('parseA1Range handles sheet name with embedded quote', () => {
  // Google Sheets escapes embedded quotes by doubling: 'Sheet''s Name'
  const result = parseA1Range("'Sheet''s Name'!A1");
  assert.equal(result.sheetName, "Sheet''s Name");
  assert.equal(result.cellRange, 'A1');
});

test('parseA1Range handles single cell without sheet prefix', () => {
  const result = parseA1Range('Z99');
  assert.equal(result.sheetName, 'Sheet1');
  assert.equal(result.cellRange, 'Z99');
});

// ---------------------------------------------------------------------------
// colToIndex
// ---------------------------------------------------------------------------
test('colToIndex converts A to 0', () => {
  assert.equal(colToIndex('A'), 0);
});

test('colToIndex converts Z to 25', () => {
  assert.equal(colToIndex('Z'), 25);
});

test('colToIndex converts AA to 26', () => {
  assert.equal(colToIndex('AA'), 26);
});

test('colToIndex converts AZ to 51', () => {
  assert.equal(colToIndex('AZ'), 51);
});

test('colToIndex converts BA to 52', () => {
  assert.equal(colToIndex('BA'), 52);
});

// ---------------------------------------------------------------------------
// convertA1ToGridRange
// ---------------------------------------------------------------------------
test('convertA1ToGridRange parses single cell A1', () => {
  const result = convertA1ToGridRange('A1', 0);
  assert.deepEqual(result, {
    sheetId: 0,
    startColumnIndex: 0,
    startRowIndex: 0,
    endColumnIndex: 1,
    endRowIndex: 1,
  });
});

test('convertA1ToGridRange parses range B2:D5', () => {
  const result = convertA1ToGridRange('B2:D5', 3);
  assert.deepEqual(result, {
    sheetId: 3,
    startColumnIndex: 1,
    startRowIndex: 1,
    endColumnIndex: 4,
    endRowIndex: 5,
  });
});

test('convertA1ToGridRange parses full-column range A:C', () => {
  const result = convertA1ToGridRange('A:C', 0);
  assert.deepEqual(result, {
    sheetId: 0,
    startColumnIndex: 0,
    endColumnIndex: 3,
  });
});

test('convertA1ToGridRange parses full-row range 1:3', () => {
  const result = convertA1ToGridRange('1:3', 0);
  assert.deepEqual(result, {
    sheetId: 0,
    startRowIndex: 0,
    endRowIndex: 3,
  });
});

test('convertA1ToGridRange throws on invalid notation', () => {
  assert.throws(() => convertA1ToGridRange('invalid!', 0), /Invalid A1 notation/);
});
