import assert from 'node:assert/strict';
import test from 'node:test';

import { describeRangeStyles, summarizeDocumentStyles } from '../../src/tools/styleProjection.js';

function run(content: string, startIndex: number, textStyle: object = {}) {
  return { textRun: { content, textStyle }, startIndex, endIndex: startIndex + content.length };
}

const doc = {
  body: {
    content: [
      {
        startIndex: 1, endIndex: 9,
        paragraph: {
          paragraphStyle: { namedStyleType: 'HEADING_1' },
          elements: [run('Heading\n', 1, { weightedFontFamily: { fontFamily: 'Arial' }, fontSize: { magnitude: 18 }, bold: true })],
        },
      },
      {
        startIndex: 9, endIndex: 14,
        paragraph: {
          paragraphStyle: {
            namedStyleType: 'NORMAL_TEXT',
            borderBottom: { color: { color: { rgbColor: { red: 1 } } }, width: { magnitude: 1, unit: 'PT' }, dashStyle: 'SOLID' },
          },
          elements: [run('Body\n', 9, { weightedFontFamily: { fontFamily: 'Arial' }, fontSize: { magnitude: 11 } })],
        },
      },
      {
        startIndex: 14, endIndex: 40,
        table: { tableRows: [{ tableCells: [{ content: [{ startIndex: 16, endIndex: 22, paragraph: { paragraphStyle: {}, elements: [run('cell\n', 16)] } }] }] }] },
      },
    ],
  },
};

test('summarizeDocumentStyles inventories fonts, named styles, borders, tables, outline', () => {
  const s = summarizeDocumentStyles(doc);
  assert.match(s, /Arial \(11\/18pt/);
  assert.match(s, /1× HEADING_1/);
  assert.match(s, /bordered paragraphs: 1 \(at 9\)/);
  assert.match(s, /tables: 1 — \[14-40\] 1×1/);
  assert.match(s, /\[1\] HEADING_1 "Heading"/);
});

test('describeRangeStyles reports paragraph borders and run styles with real indices', () => {
  const s = describeRangeStyles(doc, 9, 12);
  assert.match(s, /paragraph \[9-14\]: NORMAL_TEXT, borderBottom\(#ff0000 1PT SOLID\)/);
  assert.match(s, /run \[9-14\] "Body⏎" — Arial, 11pt/);
  assert.equal(describeRangeStyles(doc, 500, 501), 'no paragraphs overlap [500-501)');
});

test('describeRangeStyles marks in-table paragraphs', () => {
  assert.match(describeRangeStyles(doc, 16, 18), /in-table/);
});
