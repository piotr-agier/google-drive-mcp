import assert from 'node:assert/strict';
import test from 'node:test';

import { collectDocPlainText, countOccurrences, diagnoseZeroMatch } from '../../src/tools/findDiagnostics.js';

function para(text: string) {
  return { paragraph: { elements: [{ textRun: { content: text } }] } };
}

const fixtureDoc = {
  body: {
    content: [
      para('Hello world\n'),
      {
        table: {
          tableRows: [
            { tableCells: [{ content: [para('cell world\n')] }, { content: [para('fee 500\n')] }] },
            { tableCells: [{ content: [para('total 500\n')] }] },
          ],
        },
      },
    ],
  },
  headers: { h1: { content: [para('header world\n')] } },
  footers: { f1: { content: [para('page footer\n')] } },
};

const tabbedDoc = {
  tabs: [
    {
      tabProperties: { tabId: 't.0' },
      documentTab: { body: { content: [para('alpha target\n')] } },
      childTabs: [
        {
          tabProperties: { tabId: 't.1' },
          documentTab: { body: { content: [para('beta target\n')] } },
        },
      ],
    },
  ],
};

test('collectDocPlainText walks body, nested tables, headers, and footers', () => {
  const text = collectDocPlainText(fixtureDoc);
  assert.equal(countOccurrences(text, 'world', true), 3);
  assert.equal(countOccurrences(text, '500', true), 2);
  assert.equal(countOccurrences(text, 'page footer', true), 1);
});

test('collectDocPlainText scopes to one tab and reaches child tabs', () => {
  assert.equal(countOccurrences(collectDocPlainText(tabbedDoc), 'target', true), 2);
  assert.equal(countOccurrences(collectDocPlainText(tabbedDoc, 't.1'), 'target', true), 1);
  assert.equal(countOccurrences(collectDocPlainText(tabbedDoc, 't.1'), 'alpha', true), 0);
});

test('countOccurrences is literal (no regex) and honors matchCase', () => {
  assert.equal(countOccurrences('a.b a.b aXb', 'a.b', true), 2);
  assert.equal(countOccurrences('Foo foo FOO', 'foo', false), 3);
  assert.equal(countOccurrences('Foo foo FOO', 'foo', true), 1);
  assert.equal(countOccurrences('anything', '', true), 0);
});

test('diagnoseZeroMatch names non-breaking spaces (letterspaced wordmarks)', () => {
  const hint = diagnoseZeroMatch('S & E wordmark', 'S & E', true);
  assert.match(hint ?? '', /U\+00A0/);
});

test('diagnoseZeroMatch names curly-quote mismatches', () => {
  const hint = diagnoseZeroMatch('it’s here', "it's here", true);
  assert.match(hint ?? '', /curly quotes/);
});

test('diagnoseZeroMatch spots pre-existing &amp; entities', () => {
  const hint = diagnoseZeroMatch('Production &amp; Publishing', 'Production & Publishing', true);
  assert.match(hint ?? '', /&amp;/);
});

test('diagnoseZeroMatch suggests matchCase relaxation, and stays null with no lookalikes', () => {
  assert.match(diagnoseZeroMatch('HELLO', 'hello', true) ?? '', /case-insensitive/);
  assert.equal(diagnoseZeroMatch('completely different', 'missing text', false), null);
});
