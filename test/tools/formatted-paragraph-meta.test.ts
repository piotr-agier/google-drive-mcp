import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDocFormattedContent } from '../../src/tools/docs.js';
import { paragraphMetaBits } from '../../src/tools/styleProjection.js';

const styledDoc = {
  body: {
    content: [
      {
        startIndex: 1,
        endIndex: 20,
        paragraph: {
          paragraphStyle: {
            namedStyleType: 'HEADING_2',
            borderBottom: { width: { magnitude: 1.5, unit: 'PT' }, dashStyle: 'SOLID', color: { color: { rgbColor: { red: 0.8, green: 0.1, blue: 0.1 } } } },
            shading: { backgroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } } },
          },
          elements: [{ startIndex: 1, endIndex: 20, textRun: { content: 'Section heading\n', textStyle: {} } }],
        },
      },
      {
        startIndex: 20,
        endIndex: 32,
        paragraph: {
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          elements: [{ startIndex: 20, endIndex: 32, textRun: { content: 'plain body\n', textStyle: {} } }],
        },
      },
    ],
  },
};

test('includeFormatting emits one ¶ meta line per non-default paragraph over its real span', () => {
  const { formattedContent } = buildDocFormattedContent(styledDoc, true);
  const metaLines = formattedContent.split('\n').filter((l) => l.includes('¶'));
  assert.equal(metaLines.length, 1);
  assert.match(metaLines[0], /^\[1-20\] ¶ HEADING_2, borderBottom\(#cc1a1a 1\.5PT SOLID\), shading\(#ffffff\)$/);
  // The plain paragraph's content is still present, unannotated.
  assert.ok(formattedContent.includes('plain body'));
});

test('paragraph meta stays out of plain reads (withFormatting=false)', () => {
  const { formattedContent } = buildDocFormattedContent(styledDoc, false);
  assert.ok(!formattedContent.includes('¶'));
});

test('paragraphMetaBits skips defaults and invisible borders', () => {
  assert.deepEqual(paragraphMetaBits({ paragraphStyle: { namedStyleType: 'NORMAL_TEXT', alignment: 'START' } }), []);
  assert.deepEqual(
    paragraphMetaBits({ paragraphStyle: { borderTop: { width: { magnitude: 0 } }, alignment: 'CENTER' } }),
    ['center'],
  );
});
