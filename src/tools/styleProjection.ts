// Read-side style projections: the ~300-token answers to "what styles does
// this doc use?" and "what's the styling at this spot?" — the questions that
// previously cost a full-document JSON read (~162k characters for 3 pages).

/* eslint-disable @typescript-eslint/no-explicit-any */

function hex(color: any): string | null {
  const rgb = color?.color?.rgbColor ?? color?.rgbColor;
  if (!rgb) return null;
  const c = (v: number | undefined) => Math.round((v ?? 0) * 255).toString(16).padStart(2, '0');
  return `#${c(rgb.red)}${c(rgb.green)}${c(rgb.blue)}`;
}

interface ParaVisit {
  paragraph: any;
  startIndex: number;
  endIndex: number;
  inTable: boolean;
}

function visitParagraphs(docData: any, cb: (v: ParaVisit) => void, onTable?: (t: any) => void): void {
  function walk(content: any[] | undefined, inTable: boolean): void {
    for (const el of content ?? []) {
      if (el.paragraph && el.startIndex != null && el.endIndex != null) {
        cb({ paragraph: el.paragraph, startIndex: el.startIndex, endIndex: el.endIndex, inTable });
      } else if (el.table?.tableRows) {
        if (onTable) onTable(el);
        for (const row of el.table.tableRows) {
          for (const cell of row.tableCells ?? []) walk(cell.content, true);
        }
      } else if (el.tableOfContents?.content) {
        walk(el.tableOfContents.content, inTable);
      }
    }
  }
  function tabLike(t: any): void {
    walk(t?.body?.content, false);
    for (const m of [t?.headers, t?.footers, t?.footnotes]) {
      if (!m) continue;
      for (const k of Object.keys(m)) walk(m[k]?.content, false);
    }
  }
  if (Array.isArray(docData?.tabs) && docData.tabs.length > 0) {
    const visit = (tabs: any[]): void => {
      for (const tab of tabs) {
        tabLike(tab.documentTab ?? {});
        if (Array.isArray(tab.childTabs)) visit(tab.childTabs);
      }
    };
    visit(docData.tabs);
  } else {
    tabLike(docData);
  }
}

const BORDER_KEYS = ['borderTop', 'borderBottom', 'borderLeft', 'borderRight', 'borderBetween'] as const;

// Docs carries empty border objects (width 0/unset) on many paragraphs; only a
// positive width renders. Counting the empties made a 9-rule doc report 97.
function borderVisible(b: any): boolean {
  return !!b && (b.width?.magnitude ?? 0) > 0;
}

/** Compact whole-document style inventory. Aims for a few hundred tokens. */
export function summarizeDocumentStyles(docData: any): string {
  const fonts = new Map<string, { sizes: Set<number>; chars: number }>();
  const namedStyles = new Map<string, number>();
  const fgColors = new Set<string>();
  const bgColors = new Set<string>();
  const borderedParas: number[] = [];
  const shadedParas: number[] = [];
  const headings: string[] = [];
  const tables: string[] = [];
  let paraCount = 0;

  visitParagraphs(
    docData,
    ({ paragraph, startIndex }) => {
      paraCount++;
      const ps = paragraph.paragraphStyle ?? {};
      const named = ps.namedStyleType ?? 'NORMAL_TEXT';
      namedStyles.set(named, (namedStyles.get(named) ?? 0) + 1);
      if (BORDER_KEYS.some((k) => borderVisible(ps[k]))) borderedParas.push(startIndex);
      if (ps.shading?.backgroundColor) shadedParas.push(startIndex);
      let text = '';
      for (const pe of paragraph.elements ?? []) {
        if (pe.textRun) {
          text += pe.textRun.content ?? '';
          const ts = pe.textRun.textStyle ?? {};
          const family = ts.weightedFontFamily?.fontFamily;
          if (family) {
            let f = fonts.get(family);
            if (!f) fonts.set(family, (f = { sizes: new Set(), chars: 0 }));
            if (ts.fontSize?.magnitude != null) f.sizes.add(ts.fontSize.magnitude);
            f.chars += (pe.textRun.content ?? '').length;
          }
          const fg = hex(ts.foregroundColor);
          const bg = hex(ts.backgroundColor);
          if (fg && fg !== '#000000') fgColors.add(fg);
          if (bg) bgColors.add(bg);
        }
      }
      if (/^HEADING_[1-6]$|^TITLE$|^SUBTITLE$/.test(named) && headings.length < 20) {
        headings.push(`[${startIndex}] ${named} "${text.trim().slice(0, 60)}"`);
      }
    },
    (tableEl) => {
      const rows = tableEl.table.tableRows?.length ?? 0;
      const cols = tableEl.table.tableRows?.[0]?.tableCells?.length ?? 0;
      tables.push(`[${tableEl.startIndex}-${tableEl.endIndex}] ${rows}×${cols}`);
    },
  );

  const fontLines = [...fonts.entries()]
    .sort((a, b) => b[1].chars - a[1].chars)
    .map(([family, f]) => `${family} (${[...f.sizes].sort((x, y) => x - y).join('/') || '?'}pt, ${f.chars} chars)`);
  const namedLine = [...namedStyles.entries()].map(([k, n]) => `${n}× ${k}`).join(', ');

  const lines = [
    `paragraphs: ${paraCount} (${namedLine})`,
    `fonts: ${fontLines.join('; ') || 'default only'}`,
    `text colors: ${[...fgColors].join(', ') || 'default'}${bgColors.size ? `; highlights: ${[...bgColors].join(', ')}` : ''}`,
    `bordered paragraphs: ${borderedParas.length}${borderedParas.length ? ` (at ${borderedParas.slice(0, 12).join(', ')}${borderedParas.length > 12 ? ', …' : ''})` : ''}`,
    `shaded paragraphs: ${shadedParas.length}${shadedParas.length ? ` (at ${shadedParas.slice(0, 12).join(', ')})` : ''}`,
    `tables: ${tables.length}${tables.length ? ` — ${tables.join('; ')}` : ''}`,
  ];
  if (headings.length) lines.push(`outline:\n  ${headings.join('\n  ')}`);
  return lines.join('\n');
}

/**
 * Compact non-default paragraph meta bits for formatted reads:
 * named style, alignment, visible borders, shading. Empty for a plain
 * NORMAL_TEXT paragraph so unformatted content stays annotation-free.
 */
export function paragraphMetaBits(paragraph: any): string[] {
  const style = paragraph?.paragraphStyle ?? {};
  const bits: string[] = [];
  if (style.namedStyleType && style.namedStyleType !== 'NORMAL_TEXT') bits.push(style.namedStyleType);
  if (style.alignment && style.alignment !== 'START') bits.push(style.alignment.toLowerCase());
  for (const k of BORDER_KEYS) {
    if (borderVisible(style[k])) {
      const b = style[k];
      bits.push(`${k}(${hex(b.color) ?? 'auto'} ${b.width?.magnitude ?? '?'}${b.width?.unit ?? ''} ${b.dashStyle ?? ''})`.replace(/\s+\)/, ')'));
    }
  }
  if (style.shading?.backgroundColor) bits.push(`shading(${hex(style.shading.backgroundColor)})`);
  return bits;
}

/** Compact style description of everything overlapping [startIndex, endIndex). */
export function describeRangeStyles(docData: any, startIndex: number, endIndex: number): string {
  const out: string[] = [];
  visitParagraphs(docData, ({ paragraph, startIndex: ps, endIndex: pe, inTable }) => {
    if (pe <= startIndex || ps >= endIndex) return;
    const style = paragraph.paragraphStyle ?? {};
    const bits: string[] = [style.namedStyleType ?? 'NORMAL_TEXT'];
    if (style.alignment && style.alignment !== 'START') bits.push(style.alignment.toLowerCase());
    for (const k of BORDER_KEYS) {
      if (borderVisible(style[k])) {
        const b = style[k];
        bits.push(`${k}(${hex(b.color) ?? 'auto'} ${b.width?.magnitude ?? '?'}${b.width?.unit ?? ''} ${b.dashStyle ?? ''})`.replace(/\s+\)/, ')'));
      }
    }
    if (style.shading?.backgroundColor) bits.push(`shading(${hex(style.shading.backgroundColor)})`);
    for (const k of ['indentFirstLine', 'indentStart', 'indentEnd', 'spaceAbove', 'spaceBelow'] as const) {
      if (style[k]?.magnitude) bits.push(`${k}=${style[k].magnitude}${style[k].unit ?? ''}`);
    }
    if (paragraph.bullet) bits.push(`bullet(list ${paragraph.bullet.listId ?? '?'})`);
    if (inTable) bits.push('in-table');
    out.push(`paragraph [${ps}-${pe}]: ${bits.join(', ')}`);

    for (const el of paragraph.elements ?? []) {
      if (!el.textRun || el.startIndex == null || el.endIndex == null) continue;
      if (el.endIndex <= startIndex || el.startIndex >= endIndex) continue;
      const ts = el.textRun.textStyle ?? {};
      const rb: string[] = [];
      if (ts.weightedFontFamily?.fontFamily) rb.push(ts.weightedFontFamily.fontFamily);
      if (ts.fontSize?.magnitude != null) rb.push(`${ts.fontSize.magnitude}pt`);
      for (const flag of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
        if (ts[flag]) rb.push(flag);
      }
      const fg = hex(ts.foregroundColor);
      const bg = hex(ts.backgroundColor);
      if (fg) rb.push(fg);
      if (bg) rb.push(`bg ${bg}`);
      if (ts.baselineOffset && ts.baselineOffset !== 'NONE') rb.push(ts.baselineOffset.toLowerCase());
      if (ts.link?.url) rb.push(`link ${ts.link.url}`);
      const text = (el.textRun.content ?? '').replace(/\n/g, '⏎').slice(0, 60);
      out.push(`  run [${el.startIndex}-${el.endIndex}] "${text}"${rb.length ? ` — ${rb.join(', ')}` : ' — default style'}`);
    }
  });
  return out.length ? out.join('\n') : `no paragraphs overlap [${startIndex}-${endIndex})`;
}
