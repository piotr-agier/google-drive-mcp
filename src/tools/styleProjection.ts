// Compact paragraph-style annotation for the indexed reads: the answer to
// "what styling is on this paragraph?" without a full-document JSON read.

function hex(color: any): string | null {
  const rgb = color?.color?.rgbColor ?? color?.rgbColor;
  if (!rgb) return null;
  const c = (v: number | undefined) => Math.round((v ?? 0) * 255).toString(16).padStart(2, '0');
  return `#${c(rgb.red)}${c(rgb.green)}${c(rgb.blue)}`;
}

const BORDER_KEYS = ['borderTop', 'borderBottom', 'borderLeft', 'borderRight', 'borderBetween'] as const;

// Docs carries empty border objects (width 0/unset) on many paragraphs; only a
// positive width renders. Counting the empties made a 9-rule doc report 97.
function borderVisible(b: any): boolean {
  return !!b && (b.width?.magnitude ?? 0) > 0;
}
/**
 * Compact non-default paragraph meta bits for formatted reads (R-4):
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
  // Guard on the resolved hex, not the object: a backgroundColor carrying no
  // rgbColor resolves to null and printed the literal `shading(null)`.
  const shade = hex(style.shading?.backgroundColor);
  if (shade) bits.push(`shading(${shade})`);
  return bits;
}
