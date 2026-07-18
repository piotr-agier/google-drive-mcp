import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { TOOL_META } from '../src/tools/toolMeta.js';

const repositoryRoot = process.cwd();

function markdownFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.md') ? [absolute] : [];
  });
}

function githubHeadingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const occurrences = new Map<string, number>();

  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;

    const base = match[2]
      .trim()
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[`*_~]/g, '')
      .replace(/[^\p{L}\p{N}\-_ ]/gu, '')
      .replace(/\s+/g, '-');
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    anchors.add(occurrence === 0 ? base : `${base}-${occurrence}`);
  }

  return anchors;
}

function markdownWithoutCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
}

describe('Documentation reference', () => {
  const files = [
    path.join(repositoryRoot, 'README.md'),
    ...markdownFiles(path.join(repositoryRoot, 'docs')),
  ];

  it('has no broken relative Markdown links or heading fragments', () => {
    const failures: string[] = [];

    for (const source of files) {
      const markdown = markdownWithoutCode(fs.readFileSync(source, 'utf8'));
      const links = markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+[^)]*)?\)/g);

      for (const link of links) {
        const destination = link[1];
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(destination)) continue;

        const [rawTarget, rawFragment] = destination.split('#', 2);
        const target = rawTarget
          ? path.resolve(path.dirname(source), decodeURIComponent(rawTarget))
          : source;

        if (!fs.existsSync(target)) {
          failures.push(`${path.relative(repositoryRoot, source)} -> missing ${rawTarget}`);
          continue;
        }

        if (rawFragment && fs.statSync(target).isFile()) {
          const anchors = githubHeadingAnchors(fs.readFileSync(target, 'utf8'));
          const fragment = decodeURIComponent(rawFragment).toLowerCase();
          if (!anchors.has(fragment)) {
            failures.push(
              `${path.relative(repositoryRoot, source)} -> missing #${fragment} in ${path.relative(repositoryRoot, target)}`,
            );
          }
        }
      }
    }

    assert.deepEqual(failures, []);
  });

  it('documents every registered tool exactly once by name', () => {
    const toolReference = fs.readFileSync(path.join(repositoryRoot, 'docs', 'tools.md'), 'utf8');
    const documented = [...toolReference.matchAll(/^- \*\*([A-Za-z_][A-Za-z0-9_]*)\*\*/gm)]
      .map((match) => match[1]);
    const registered = Object.keys(TOOL_META);

    assert.equal(new Set(documented).size, documented.length, 'tool names must not be duplicated');
    assert.deepEqual(documented.sort(), registered.sort());
  });
});
