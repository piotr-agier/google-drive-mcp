// Compact paragraph-style annotation for the indexed reads: the answer to
// "what styling is on this paragraph?" without a full-document JSON read.

/**
 * Docs `OptionalColor` (`{ color: { rgbColor } }`) to `#rrggbb`, or null when
 * the color carries no `rgbColor`. Borders, shading, and text runs all use this
 * one shape, so rounding stays consistent across every surface that prints a
 * color. Lives here rather than in `docs.ts` only because `docs.ts` imports
 * this module; keeping the helper on this side avoids an import cycle.
 */
export function rgbColorToHex(color: any): string | null {
  if (!color?.color?.rgbColor) return null;
  const rgb = color.color.rgbColor;
  const r = Math.round((rgb.red || 0) * 255);
  const g = Math.round((rgb.green || 0) * 255);
  const b = Math.round((rgb.blue || 0) * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

const BORDER_KEYS = ['borderTop', 'borderBottom', 'borderLeft', 'borderRight', 'borderBetween'] as const;

// Docs carries empty border objects (width 0/unset) on many paragraphs; only a
// positive width renders. Counting the empties made a 9-rule doc report 97.
function borderVisible(b: any): boolean {
  return !!b && (b.width?.magnitude ?? 0) > 0;
}

/**
 * Compact non-default paragraph meta bits for formatted reads: named style,
 * alignment, visible borders, shading. Empty for a plain NORMAL_TEXT paragraph
 * so unformatted content stays annotation-free.
 */
export function paragraphMetaBits(paragraph: any): string[] {
  const style = paragraph?.paragraphStyle ?? {};
  const bits: string[] = [];
  if (style.namedStyleType && style.namedStyleType !== 'NORMAL_TEXT') bits.push(style.namedStyleType);
  if (style.alignment && style.alignment !== 'START') bits.push(style.alignment.toLowerCase());
  for (const k of BORDER_KEYS) {
    if (borderVisible(style[k])) {
      const b = style[k];
      bits.push(`${k}(${rgbColorToHex(b.color) ?? 'auto'} ${b.width?.magnitude ?? '?'}${b.width?.unit ?? ''} ${b.dashStyle ?? ''})`.replace(/\s+\)/, ')'));
    }
  }
  // Guard on the resolved hex, not the object: a backgroundColor carrying no
  // rgbColor resolves to null and printed the literal `shading(null)`.
  const shade = rgbColorToHex(style.shading?.backgroundColor);
  if (shade) bits.push(`shading(${shade})`);
  return bits;
}
