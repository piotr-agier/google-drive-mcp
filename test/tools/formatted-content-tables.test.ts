import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDocFormattedContent } from '../../src/tools/docs.js';

function run(content: string, startIndex: number) {
  return { textRun: { content }, startIndex, endIndex: startIndex + content.length };
}
function tableEl(startIndex: number, endIndex: number, cellTexts: string[][], cellStart: number) {
  let idx = cellStart;
  return {
    startIndex,
    endIndex,
    table: {
      tableRows: cellTexts.map((row) => ({
        tableCells: row.map((text) => {
          const cell = { content: [{ paragraph: { elements: [run(text + '\n', idx)] } }] };
          idx += text.length + 2;
          return cell;
        }),
      })),
    },
  };
}

// Two tables — the field bug reported the 2nd/3rd tables' printed row ranges
// overlapping the first table's range (fabricated from markdown line lengths).
const doc = {
  body: {
    content: [
      { paragraph: { elements: [run('Intro\n', 1)] } },
      tableEl(7, 40, [['alpha', 'beta']], 9),
      { paragraph: { elements: [run('After\n', 40)] } },
      tableEl(46, 90, [['gamma', 'delta']], 48),
    ],
  },
};

test('tables emit exactly one real-span line each; no fabricated per-row ranges', () => {
  const { formattedContent, totalLength } = buildDocFormattedContent(doc, false);
  const bracketLines = formattedContent.split('\n').filter((l) => /^\[\d+-\d+\]/.test(l));

  const tableLines = bracketLines.filter((l) => l.includes('<table'));
  assert.equal(tableLines.length, 2);
  assert.match(tableLines[0], /^\[7-40\]/);
  assert.match(tableLines[1], /^\[46-90\]/);

  // Every emitted range must be a real doc range: within [1, 90] and, for
  // non-table lines, derived from paragraph indices — the old bug emitted
  // ranges past the element's real end (markdown length arithmetic).
  for (const line of bracketLines) {
    const m = line.match(/^\[(\d+)-(\d+)\]/)!;
    const [s, e] = [Number(m[1]), Number(m[2])];
    assert.ok(s >= 1 && e <= 90, `range [${s}-${e}] escapes the document`);
  }

  // The rendering is still present for humans.
  assert.match(formattedContent, /alpha.*beta/s);
  assert.equal(totalLength, 90);
});
