// The pure half of updateGoogleSheetIfUnchanged: projection of values into a
// common comparison space, the fingerprint, the pre-image, and detection of
// cells that do not survive a round trip. No network - the same split as in
// sheetCells.ts.
import { createHash } from 'node:crypto';
import { cellA1, splitRange } from './sheetCells.js';
import type { RangeMatch } from './sheetCells.js';
import { colToIndex } from '../utils.js';

/** The common comparison space. spreadsheets.get returns CellData, while a
 *  write response returns a FORMULA rendering; the two are comparable only
 *  after projection. */
export type CanonicalCell = string | number | boolean | null;

export interface CanonicalBlock {
  sheetTitle: string;
  startRow: number;
  startColumn: number;
  rows: number;
  columns: number;
  cells: CanonicalCell[][];
}

/** Empty-cell marker. Printable, and impossible as the result of
 *  JSON.stringify on any value, so "empty" never collides with an empty
 *  string. */
const EMPTY = '<empty>';

/** CellData.userEnteredValue into the canonical form. A boolean collapses to a
 *  token rather than to a JSON boolean, so that it matches the write response
 *  whichever way Google encodes it there. */
export function projectCellData(v: Record<string, unknown> | undefined): CanonicalCell {
  if (!v) return null;
  if (typeof v.formulaValue === 'string') return v.formulaValue;
  if (typeof v.numberValue === 'number') return v.numberValue;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.boolValue === 'boolean') return v.boolValue ? 'TRUE' : 'FALSE';
  return null;
}

/** A value from a write response into the same canonical form. A string is
 *  returned as it came, with no case folding: checked against the live API, a
 *  boolean arrives as a native JSON boolean on BOTH sides rather than as the
 *  string "TRUE"/"FALSE", so no uppercasing branch is needed - and without one
 *  the text "true"/"True" is not mangled into TRUE, so projectCellData and
 *  projectResponseValue agree on it. Residual risk: were Google ever to start
 *  encoding a checkbox as the string "TRUE" in a write response, a guarded
 *  write over such a cell would stop matching the fingerprint and be refused
 *  as a divergence - it would fail loudly rather than silently corrupt data,
 *  which is the safe direction to fail in. */
export function projectResponseValue(v: unknown): CanonicalCell {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  return null;
}

/** One fingerprint over all the blocks: the canonical forms are streamed into
 *  the hash in request order, separated by '\n', instead of being accumulated
 *  into an array of lines and joined before hashing - on a declared range of
 *  a couple million cells (twelve A1 characters, but each cell contributes
 *  its own array element plus a copy at join time) that doubled peak memory
 *  for no reason; createHash is already a streaming API. The byte-level form
 *  is unchanged (the same '\n' between lines, none trailing), so old
 *  fingerprints stay valid. A block's origin and dimensions go into the
 *  hash, so inserting a row inside the guarded area changes it. */
export function fingerprintOf(blocks: CanonicalBlock[]): string {
  const hash = createHash('sha256');
  let first = true;
  const feed = (line: string) => {
    if (!first) hash.update('\n', 'utf8');
    hash.update(line, 'utf8');
    first = false;
  };
  for (const b of blocks) {
    // sheetTitle is caller/API-controlled text (Google accepts a sheet title
    // containing a literal newline) and must go through JSON.stringify exactly
    // like a cell value does - raw interpolation here let a crafted title
    // "swallow" the newline-separated lines of another block and forge an
    // identical joined string, i.e. a fingerprint collision between two
    // genuinely different sheet states. See the regression tests below.
    feed(`${JSON.stringify(b.sheetTitle)}!${b.startRow},${b.startColumn}+${b.rows}x${b.columns}`);
    for (let r = 0; r < b.rows; r++) {
      for (let c = 0; c < b.columns; c++) {
        const cell = b.cells[r]?.[c] ?? null;
        feed(`${r},${c}=${cell === null ? EMPTY : JSON.stringify(cell)}`);
      }
    }
  }
  return 'v1:' + hash.digest('hex');
}

export interface PreImageRange { range: string; values: string[][] }

export interface Hazard {
  a1: string;
  reason: 'text-looks-like-formula' | 'text-looks-like-number' | 'text-looks-like-boolean';
  /** The native form - the only way to restore such a cell undistorted. */
  userEnteredValue: Record<string, unknown>;
}

/** The canonical form rendered back to a string for valueInputOption
 *  USER_ENTERED. */
export function renderForWrite(cell: CanonicalCell): string {
  if (cell === null) return '';
  if (typeof cell === 'number') return String(cell);
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  return cell;
}

/** The pre-image in ValueRange shape, so that it can be handed straight back
 *  to this same tool as `updates` to undo the write. */
export function buildPreImage(range: string, cells: CanonicalCell[][]): PreImageRange {
  return { range, values: cells.map(row => row.map(renderForWrite)) };
}

/** Cells that would not survive a round trip back through USER_ENTERED - text
 *  stored AS TEXT (usually via a leading apostrophe) that would silently
 *  change type on being written again:
 *   - starts with '=' -> becomes a formula;
 *   - reads as a finite number ("504") -> becomes a number;
 *   - equals TRUE/FALSE case-insensitively -> becomes a boolean.
 *  RAW is no rescue here: it would corrupt genuine formulas, numbers and
 *  booleans in exactly the same way.
 *
 *  The list is deliberately NOT exhaustive: date-shaped text (e.g.
 *  "2024-01-01" or "1/2") is left out of it. Google recognizes a date from the
 *  locale and the cell format, not from the string alone, so detecting one
 *  reliably would need data this layer does not have. */
export function findHazards(
  startRow: number,
  startColumn: number,
  raw: (Record<string, unknown> | undefined)[][],
): Hazard[] {
  const out: Hazard[] = [];
  raw.forEach((row, r) => {
    row.forEach((value, c) => {
      const s = value?.stringValue;
      if (typeof s !== 'string') return;

      let reason: Hazard['reason'] | null = null;
      if (s.startsWith('=')) reason = 'text-looks-like-formula';
      else if (s.trim() !== '' && Number.isFinite(Number(s))) reason = 'text-looks-like-number';
      else if (/^(?:true|false)$/i.test(s)) reason = 'text-looks-like-boolean';

      if (reason) {
        out.push({
          a1: cellA1(startRow + r, startColumn + c),
          reason,
          userEnteredValue: value as Record<string, unknown>,
        });
      }
    });
  });
  return out;
}

/** The guarded ranges. By default exactly what is being written. A declared
 *  set is taken AS IT STANDS, with no deduplication: what gets read has to be
 *  exactly what the fingerprint is computed over, or the fingerprint stops
 *  being reproducible. */
export function guardRangesFor(updates: { range: string }[], declared?: string[]): string[] {
  return declared && declared.length > 0 ? [...declared] : updates.map(u => u.range);
}

// ---------------------------------------------------------------------------
// Padding to the DECLARED A1 rectangle
// ---------------------------------------------------------------------------
//
// Google trims empty cells at the edges: spreadsheets.get returns a grid
// trimmed to the data extent (an all-empty declared range comes back with no
// rowData at all), and a write response's updatedData.values is trimmed to
// what was actually written, even though updatedData.range echoes the
// DECLARED range intact (verified live: writing a single value into a
// declared 3x3 range returns updatedData.range as the full 3x3 A1 string,
// with values trimmed to 1x1). A canonical block built from the OBSERVED
// extent alone therefore shrinks and grows with whatever Google trimmed,
// which under-covers a preImage built from it (an empty cell disappears
// instead of appearing as an empty string to clear) and makes a post-write
// block incomparable to the guard block that was fingerprinted before the
// write. Padding every block out to the range's DECLARED rectangle — missing
// cells as null — fixes both: the canonical form then depends on what was
// declared, not on what Google felt like trimming.

// A DECLARED rectangle requires BOTH anchors to carry BOTH a column and a
// row - "A1", or "A1:C3". Anything else (a dangling column-only or row-only
// side, on either anchor) is open-ended and reports no rectangle: "A1:C" and
// "A5:A" are the two forms this guards against directly (see finding A below),
// "1:3" and "A:C" the ones that were already open before it. This is
// deliberately its OWN parser rather than utils.convertA1ToGridRange, which
// does not report an open end at all - it fabricates one, defaulting a
// missing endRowIndex/endColumnIndex to startIndex+1 as though a lone anchor
// were a 1-cell range. That is correct for a genuinely bare cell ("A1") but
// silently wrong for "A1:C" (a real, explicit range whose row end was left
// open) and "A5:A" (whose row end was left open the same way): both would be
// treated as a single row, so a guard/pre-image padded to that "rectangle"
// covers only the first observed row and discards the rest - the exact bug
// this parser exists to close.
//
// Normalizes first ($ stripped, upper-cased) - the same tolerance
// collectSheetMetadata already applies before parsing (see sheetCells.ts) -
// so "a1:c3" and "A$1:C$3" are recognized as the same bounded 3x3 rectangle
// "A1:C3" is, rather than falling back to the (trimming-dependent) observed
// extent merely because of spelling.
const STRICT_RECT_RE = /^([A-Z]+)([0-9]+)(?::([A-Z]+)([0-9]+))?$/;

// Upper bound on the cell count of a DECLARED rectangle that padToDeclaredRange
// will materialize. A guard/write range names its rectangle in a handful of
// A1 characters regardless of how large that rectangle is - `Probe!A1:Z100000`
// is twelve characters for 2.6 million cells - and Google trims its response
// to the actual data extent, so the network cost of declaring an absurd range
// is nearly nil while padding it out here is not: every one of those cells
// gets allocated (mostly as null) before it can even be hashed. The cap
// mirrors the 100_000-cell ceiling this file's own maxCells/maxBytes schema
// (and getGoogleSheetCells's identical one) already impose elsewhere on
// cell-materializing budgets in this codebase: comfortably above any
// legitimate guard or write rectangle - a guard is meant to cover the
// specific block being edited, not tens of thousands of rows - while still
// refusing the pathological case with room to spare.
const MAX_DECLARED_RECTANGLE_CELLS = 100_000;

/** The declared A1 rectangle of a range, as a 0-based origin plus size — or
 *  null when the range has no bounded rectangle to pad to: an open-ended
 *  range (`A1:C`, `A5:A`, `A:C`, `5:9`) or a bare whole-sheet reference
 *  (`Probe`). Those are legitimate inputs with no fixed extent of their own,
 *  so callers fall back to the observed extent for them instead.
 *
 *  Throws when the declared rectangle IS bounded but absurdly large - see
 *  MAX_DECLARED_RECTANGLE_CELLS above - rather than materializing it. */
function declaredRectangle(range: string): { startRow: number; startColumn: number; rows: number; columns: number } | null {
  const { cellRange } = splitRange(range);
  if (cellRange === null) return null; // bare whole-sheet reference

  const normalized = cellRange.replace(/\$/g, '').toUpperCase();
  const match = normalized.match(STRICT_RECT_RE);
  if (!match) return null; // open-ended: no rectangle genuinely declared

  const [, startColLetters, startRowDigits, endColLetters, endRowDigits] = match;
  const startColumn = colToIndex(startColLetters);
  const startRow = parseInt(startRowDigits, 10) - 1;
  const endColumn = endColLetters ? colToIndex(endColLetters) + 1 : startColumn + 1;
  const endRow = endRowDigits ? parseInt(endRowDigits, 10) : startRow + 1;

  const rows = endRow - startRow;
  const columns = endColumn - startColumn;
  if (rows <= 0 || columns <= 0) return null; // reversed anchors: no rectangle to pad to

  if (rows * columns > MAX_DECLARED_RECTANGLE_CELLS) {
    throw new Error(
      `Declared range "${range}" spans ${rows * columns} cells (${rows} rows x ${columns} columns), ` +
      `which exceeds the ${MAX_DECLARED_RECTANGLE_CELLS}-cell guard/write limit. Narrow the range to ` +
      `the block actually being guarded or written.`
    );
  }

  return { startRow, startColumn, rows, columns };
}

/** Pads an observed block of cells (top-left anchored at the range's own
 *  origin — Google trims only the trailing edge, on both the read side and
 *  the write-response side, never the leading one, when an explicit range is
 *  requested) out to the full DECLARED A1 rectangle of `range`, with missing
 *  cells as null. The single shared helper for both call sites in sheets.ts:
 *  the guard/pre-image block built from a read (`blockFromMatch`, below) and
 *  the post-write block built from a write response.
 *
 *  When `range` has no bounded rectangle (open-ended, or a bare whole-sheet
 *  reference) there is nothing to pad to, so the observed block is returned
 *  as-is, anchored at `fallbackStartRow`/`fallbackStartColumn`. */
export function padToDeclaredRange(
  range: string,
  sheetTitle: string,
  observedCells: CanonicalCell[][],
  fallbackStartRow: number,
  fallbackStartColumn: number,
): CanonicalBlock {
  const rect = declaredRectangle(range);
  if (!rect) {
    const columns = observedCells.reduce((max, row) => Math.max(max, row.length), 0);
    return {
      sheetTitle, startRow: fallbackStartRow, startColumn: fallbackStartColumn,
      rows: observedCells.length, columns,
      cells: observedCells.map(row => Array.from({ length: columns }, (_, c) => row[c] ?? null)),
    };
  }
  const cells: CanonicalCell[][] = [];
  for (let r = 0; r < rect.rows; r++) {
    const src = observedCells[r];
    cells.push(Array.from({ length: rect.columns }, (_, c) => src?.[c] ?? null));
  }
  return { sheetTitle, startRow: rect.startRow, startColumn: rect.startColumn, rows: rect.rows, columns: rect.columns, cells };
}

/** A grid from the response into a canonical block, plus the raw
 *  userEnteredValue entries the hazard detection needs (text and formula are
 *  indistinguishable once projected). padToDeclaredRange stretches the block
 *  out to the DECLARED rectangle of match.range rather than to whatever Google
 *  actually returned (see the comment block above padToDeclaredRange); raw
 *  stays on the observed extent, since extra null neighbours tell the hazard
 *  detection nothing. */
export function blockFromMatch(match: RangeMatch): {
  block: CanonicalBlock;
  raw: (Record<string, unknown> | undefined)[][];
} {
  const startRow = match.grid.startRow ?? 0;
  const startColumn = match.grid.startColumn ?? 0;
  const rows = match.grid.rowData ?? [];
  const columns = rows.reduce((max, row) => Math.max(max, row.values?.length ?? 0), 0);

  const cells: CanonicalCell[][] = [];
  const raw: (Record<string, unknown> | undefined)[][] = [];
  for (let r = 0; r < rows.length; r++) {
    const values = rows[r].values ?? [];
    const cellRow: CanonicalCell[] = [];
    const rawRow: (Record<string, unknown> | undefined)[] = [];
    for (let c = 0; c < columns; c++) {
      const uev = values[c]?.userEnteredValue as Record<string, unknown> | undefined;
      cellRow.push(projectCellData(uev));
      rawRow.push(uev);
    }
    cells.push(cellRow);
    raw.push(rawRow);
  }

  const block = padToDeclaredRange(match.range, match.sheetTitle, cells, startRow, startColumn);

  return { block, raw };
}
