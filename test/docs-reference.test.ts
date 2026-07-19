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

function withoutFencedCode(markdown: string): string {
  let insideFence = false;
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        insideFence = !insideFence;
        return '';
      }
      return insideFence ? '' : line;
    })
    .join('\n');
}

function githubHeadingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const occurrences = new Map<string, number>();

  // Fenced blocks are dropped first so that shell comments such as `# Check ports`
  // are not collected as headings.
  for (const line of withoutFencedCode(markdown).split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;

    const base = match[2]
      .trim()
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      // GitHub drops these formatting markers but keeps `_`, so headings naming an
      // identifier (`manage_accounts`, `MCP_TESTING`) must keep their underscores.
      .replace(/[`*~]/g, '')
      .replace(/[^\p{L}\p{N}\-_ ]/gu, '')
      .replace(/\s+/g, '-');
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    anchors.add(occurrence === 0 ? base : `${base}-${occurrence}`);
  }

  return anchors;
}

function markdownWithoutCode(markdown: string): string {
  return withoutFencedCode(markdown).replace(/`[^`\n]*`/g, '');
}

// fs.existsSync is case-insensitive on the macOS and Windows filesystems this is
// developed on, while GitHub and Linux CI are case-sensitive. Compare every segment
// against the real directory entry so a miscased link fails here rather than in a
// reader's browser.
function existsWithExactCase(absolute: string): boolean {
  if (!fs.existsSync(absolute)) return false;

  let current = path.resolve(absolute);
  while (current !== repositoryRoot && current !== path.dirname(current)) {
    const parent = path.dirname(current);
    if (!fs.readdirSync(parent).includes(path.basename(current))) return false;
    current = parent;
  }

  return true;
}

describe('Documentation reference', () => {
  const files = [
    path.join(repositoryRoot, 'README.md'),
    path.join(repositoryRoot, 'CHANGELOG.md'),
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

        if (!existsWithExactCase(target)) {
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
    // Sample output inside a fenced block can look exactly like a tool bullet.
    const documented = [...withoutFencedCode(toolReference).matchAll(/^- \*\*([A-Za-z_][A-Za-z0-9_]*)\*\*/gm)]
      .map((match) => match[1]);
    const registered = Object.keys(TOOL_META);

    assert.equal(new Set(documented).size, documented.length, 'tool names must not be duplicated');
    assert.deepEqual(documented.sort(), registered.sort());
  });

  it('states the registered tool count in the README and the tool reference', () => {
    const registered = String(Object.keys(TOOL_META).length);
    const failures: string[] = [];

    for (const file of ['README.md', path.join('docs', 'tools.md')]) {
      const markdown = fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
      const stated = [...markdown.matchAll(/\b(\d+)\s+(?:MCP\s+)?tools\b/g)].map((match) => match[1]);

      if (stated.length === 0) {
        failures.push(`${file} -> states no tool count`);
        continue;
      }

      for (const count of stated) {
        if (count !== registered) {
          failures.push(`${file} -> states ${count} tools, expected ${registered}`);
        }
      }
    }

    assert.deepEqual(failures, []);
  });

  it('publishes every guide the README links to', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { files: string[] };
    const published = new Set(manifest.files);
    const readme = markdownWithoutCode(fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8'));
    const linked = [...readme.matchAll(/\]\((docs\/[^)#\s]+)/g)].map((match) => match[1]);

    assert.notEqual(linked.length, 0, 'the README must link to the guides in docs/');
    assert.deepEqual(
      [...new Set(linked)].filter((guide) => !published.has(guide)).sort(),
      [],
      'each docs/ guide linked from the README must be listed individually in package.json "files"',
    );
  });
});
