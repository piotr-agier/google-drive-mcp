// -----------------------------------------------------------------------------
// Pure utility functions extracted from index.ts for testability
// -----------------------------------------------------------------------------

/**
 * Get file extension from a filename (lowercase).
 */
export function getExtensionFromFilename(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || '';
}

export const TEXT_MIME_TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
};

/**
 * Get the MIME type for a text file from its filename.
 * Falls back to 'text/plain' for unknown extensions.
 */
export function getMimeTypeFromFilename(filename: string): string {
  const ext = getExtensionFromFilename(filename);
  return TEXT_MIME_TYPES[ext] || 'text/plain';
}

/**
 * Escape a string for use in a Google Drive API query.
 * Escapes backslashes and single quotes.
 */
export function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Parse a Sheets A1 range reference (e.g. "'My Sheet'!A1:B2") into its
 * sheet name and cell range components.
 *
 * - Strips surrounding single quotes from the sheet name
 * - Defaults to 'Sheet1' when no sheet prefix is present
 */
export function parseA1Range(range: string): { sheetName: string; cellRange: string } {
  if (range.includes('!')) {
    const sheetName = range.split('!')[0].replace(/^'+|'+$/g, '');
    const cellRange = range.split('!')[1];
    return { sheetName, cellRange };
  }
  return { sheetName: 'Sheet1', cellRange: range };
}

/**
 * Convert column letters to a zero-based index (A=0, B=1, ... Z=25, AA=26).
 */
export function colToIndex(col: string): number {
  let num = 0;
  for (let i = 0; i < col.length; i++) {
    num = num * 26 + (col.charCodeAt(i) - 'A'.charCodeAt(0) + 1);
  }
  return num - 1;
}

export interface GridRange {
  sheetId: number;
  startColumnIndex?: number;
  startRowIndex?: number;
  endColumnIndex?: number;
  endRowIndex?: number;
}

/**
 * Convert an A1 notation string (e.g. "A1:C5") into a Sheets GridRange object.
 * Supports ranges, single cells, full-row ("1:3"), and full-column ("A:C") notation.
 */
export function convertA1ToGridRange(a1Notation: string, sheetId: number): GridRange {
  const rangeRegex = /^([A-Z]*)([0-9]*)(:([A-Z]*)([0-9]*))?$/;
  const match = a1Notation.match(rangeRegex);

  if (!match) {
    throw new Error(`Invalid A1 notation: ${a1Notation}`);
  }

  const [, startCol, startRow, , endCol, endRow] = match;

  const gridRange: GridRange = { sheetId };

  if (startCol) gridRange.startColumnIndex = colToIndex(startCol);
  if (startRow) gridRange.startRowIndex = parseInt(startRow) - 1;

  if (endCol) {
    gridRange.endColumnIndex = colToIndex(endCol) + 1;
  } else if (startCol && !endCol) {
    gridRange.endColumnIndex = gridRange.startColumnIndex! + 1;
  }

  if (endRow) {
    gridRange.endRowIndex = parseInt(endRow);
  } else if (startRow && !endRow) {
    gridRange.endRowIndex = gridRange.startRowIndex! + 1;
  }

  return gridRange;
}
