// ---------------------------------------------------------------------------
// Shared OAuth scope constants & resolution
// ---------------------------------------------------------------------------

export const SCOPE_ALIASES: Record<string, string> = {
  drive: 'https://www.googleapis.com/auth/drive',
  'drive.file': 'https://www.googleapis.com/auth/drive.file',
  'drive.readonly': 'https://www.googleapis.com/auth/drive.readonly',
  documents: 'https://www.googleapis.com/auth/documents',
  spreadsheets: 'https://www.googleapis.com/auth/spreadsheets',
  presentations: 'https://www.googleapis.com/auth/presentations',
  calendar: 'https://www.googleapis.com/auth/calendar',
  'calendar.events': 'https://www.googleapis.com/auth/calendar.events',
};

export const SCOPE_PRESETS: Record<string, string[]> = {
  readonly: ['drive.readonly'],
  'content-editor': ['drive.file', 'documents', 'spreadsheets', 'presentations'],
  full: ['drive', 'documents', 'spreadsheets', 'presentations', 'calendar', 'calendar.events'],
};

export const DEFAULT_SCOPES: readonly string[] = [
  'drive', 'drive.file', 'drive.readonly',
  'documents', 'spreadsheets', 'presentations',
  'calendar', 'calendar.events',
].map((s) => SCOPE_ALIASES[s]);

/**
 * Resolve OAuth scopes from `GOOGLE_DRIVE_MCP_SCOPES` env var.
 * Accepts comma-separated aliases (e.g. "drive,documents") or full URLs.
 * Throws on unknown aliases so mis-configurations surface immediately.
 */
export function resolveOAuthScopes(): string[] {
  const raw = process.env.GOOGLE_DRIVE_MCP_SCOPES?.trim();
  if (!raw) return [...DEFAULT_SCOPES];

  const scopes = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (SCOPE_ALIASES[s]) return SCOPE_ALIASES[s];
      if (s.startsWith('https://')) return s;
      const known = Object.keys(SCOPE_ALIASES).join(', ');
      throw new Error(
        `Unknown OAuth scope alias "${s}". Use a full URL (https://...) or one of: ${known}`
      );
    });

  if (scopes.length === 0) return [...DEFAULT_SCOPES];
  return [...new Set(scopes)];
}
