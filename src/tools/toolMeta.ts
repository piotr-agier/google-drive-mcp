// ---------------------------------------------------------------------------
// Per-tool metadata: opKind (read/write/admin) and acceptable OAuth scopes.
//
// Consumed by the dispatch layer in src/index.ts to (a) inject the optional
// `account` parameter into non-admin tool schemas and (b) resolve which
// account(s) a tool call should target via the AccountResolver.
//
// Any-of scope semantics: an account is eligible for a tool when it has
// granted at least ONE of the acceptable scopes. For a given tool we list
// every Google scope that would allow it to run, from narrowest to broadest.
// ---------------------------------------------------------------------------

import { ToolOpKind } from '../auth/types.js';

export interface ToolMeta {
  opKind: ToolOpKind;
  acceptableScopes: string[];
}

// -- Scope constants --------------------------------------------------------

const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE = 'https://www.googleapis.com/auth/drive';
const DOCUMENTS = 'https://www.googleapis.com/auth/documents';
const SPREADSHEETS = 'https://www.googleapis.com/auth/spreadsheets';
const PRESENTATIONS = 'https://www.googleapis.com/auth/presentations';
const CALENDAR = 'https://www.googleapis.com/auth/calendar';
const CALENDAR_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const CALENDAR_READONLY = 'https://www.googleapis.com/auth/calendar.readonly';

const DRIVE_READ_SCOPES = [DRIVE_READONLY, DRIVE_FILE, DRIVE];
const DRIVE_WRITE_SCOPES = [DRIVE_FILE, DRIVE];
const DOCS_SCOPES = [DOCUMENTS];
const SHEETS_SCOPES = [SPREADSHEETS];
const SLIDES_SCOPES = [PRESENTATIONS];
const CAL_READ_SCOPES = [CALENDAR_READONLY, CALENDAR, CALENDAR_EVENTS];
const CAL_WRITE_SCOPES = [CALENDAR, CALENDAR_EVENTS];

// -- Helpers ----------------------------------------------------------------

const read = (scopes: string[]): ToolMeta => ({ opKind: 'read', acceptableScopes: scopes });
const write = (scopes: string[]): ToolMeta => ({ opKind: 'write', acceptableScopes: scopes });
const admin: ToolMeta = { opKind: 'admin', acceptableScopes: [] };

// -- Registry ---------------------------------------------------------------

export const TOOL_META: Record<string, ToolMeta> = {
  // ---- Drive ----
  search: read(DRIVE_READ_SCOPES),
  listFolder: read(DRIVE_READ_SCOPES),
  listSharedDrives: read(DRIVE_READ_SCOPES),
  downloadFile: read(DRIVE_READ_SCOPES),
  listPermissions: read(DRIVE_READ_SCOPES),
  getRevisions: read(DRIVE_READ_SCOPES),

  createTextFile: write(DRIVE_WRITE_SCOPES),
  updateTextFile: write(DRIVE_WRITE_SCOPES),
  createFolder: write(DRIVE_WRITE_SCOPES),
  deleteItem: write(DRIVE_WRITE_SCOPES),
  renameItem: write(DRIVE_WRITE_SCOPES),
  moveItem: write(DRIVE_WRITE_SCOPES),
  copyFile: write(DRIVE_WRITE_SCOPES),
  uploadFile: write(DRIVE_WRITE_SCOPES),
  addPermission: write(DRIVE_WRITE_SCOPES),
  updatePermission: write(DRIVE_WRITE_SCOPES),
  removePermission: write(DRIVE_WRITE_SCOPES),
  shareFile: write(DRIVE_WRITE_SCOPES),
  convertPdfToGoogleDoc: write(DRIVE_WRITE_SCOPES),
  bulkConvertFolderPdfs: write(DRIVE_WRITE_SCOPES),
  uploadPdfWithSplit: write(DRIVE_WRITE_SCOPES),
  restoreRevision: write(DRIVE_WRITE_SCOPES),
  createShortcut: write(DRIVE_WRITE_SCOPES),
  lockFile: write(DRIVE_WRITE_SCOPES),
  unlockFile: write(DRIVE_WRITE_SCOPES),

  // ---- Docs ----
  readGoogleDoc: read(DOCS_SCOPES),
  listDocumentTabs: read(DOCS_SCOPES),
  listComments: read(DRIVE_READ_SCOPES),
  getComment: read(DRIVE_READ_SCOPES),
  getGoogleDocContent: read(DOCS_SCOPES),
  listGoogleDocs: read(DRIVE_READ_SCOPES),
  getDocumentInfo: read(DOCS_SCOPES),
  readSmartChips: read(DOCS_SCOPES),

  createGoogleDoc: write(DOCS_SCOPES),
  updateGoogleDoc: write(DOCS_SCOPES),
  insertText: write(DOCS_SCOPES),
  deleteRange: write(DOCS_SCOPES),
  applyTextStyle: write(DOCS_SCOPES),
  applyParagraphStyle: write(DOCS_SCOPES),
  formatGoogleDocText: write(DOCS_SCOPES),
  formatGoogleDocParagraph: write(DOCS_SCOPES),
  createParagraphBullets: write(DOCS_SCOPES),
  findAndReplaceInDoc: write(DOCS_SCOPES),
  addComment: write(DRIVE_WRITE_SCOPES),
  replyToComment: write(DRIVE_WRITE_SCOPES),
  deleteComment: write(DRIVE_WRITE_SCOPES),
  insertTable: write(DOCS_SCOPES),
  editTableCell: write(DOCS_SCOPES),
  insertImageFromUrl: write(DOCS_SCOPES),
  insertLocalImage: write(DOCS_SCOPES),
  addDocumentTab: write(DOCS_SCOPES),
  renameDocumentTab: write(DOCS_SCOPES),
  insertSmartChip: write(DOCS_SCOPES),
  createFootnote: write(DOCS_SCOPES),

  // ---- Sheets ----
  getGoogleSheetContent: read(SHEETS_SCOPES),
  getSpreadsheetInfo: read(SHEETS_SCOPES),
  listSheets: read(SHEETS_SCOPES),
  listGoogleSheets: read(DRIVE_READ_SCOPES),

  createGoogleSheet: write(SHEETS_SCOPES),
  updateGoogleSheet: write(SHEETS_SCOPES),
  formatGoogleSheetCells: write(SHEETS_SCOPES),
  formatGoogleSheetText: write(SHEETS_SCOPES),
  formatGoogleSheetNumbers: write(SHEETS_SCOPES),
  setGoogleSheetBorders: write(SHEETS_SCOPES),
  mergeGoogleSheetCells: write(SHEETS_SCOPES),
  addGoogleSheetConditionalFormat: write(SHEETS_SCOPES),
  appendSpreadsheetRows: write(SHEETS_SCOPES),
  addSpreadsheetSheet: write(SHEETS_SCOPES),
  addSheet: write(SHEETS_SCOPES),
  renameSheet: write(SHEETS_SCOPES),
  deleteSheet: write(SHEETS_SCOPES),
  addDataValidation: write(SHEETS_SCOPES),
  protectRange: write(SHEETS_SCOPES),
  addNamedRange: write(SHEETS_SCOPES),

  // ---- Slides ----
  getGoogleSlidesContent: read(SLIDES_SCOPES),
  getGoogleSlidesSpeakerNotes: read(SLIDES_SCOPES),
  getSlideElementInfo: read(SLIDES_SCOPES),
  exportSlideThumbnail: read(SLIDES_SCOPES),

  createGoogleSlides: write(SLIDES_SCOPES),
  updateGoogleSlides: write(SLIDES_SCOPES),
  formatGoogleSlidesText: write(SLIDES_SCOPES),
  formatGoogleSlidesParagraph: write(SLIDES_SCOPES),
  styleGoogleSlidesShape: write(SLIDES_SCOPES),
  setGoogleSlidesBackground: write(SLIDES_SCOPES),
  createGoogleSlidesTextBox: write(SLIDES_SCOPES),
  createGoogleSlidesShape: write(SLIDES_SCOPES),
  updateGoogleSlidesSpeakerNotes: write(SLIDES_SCOPES),
  deleteGoogleSlide: write(SLIDES_SCOPES),
  duplicateSlide: write(SLIDES_SCOPES),
  reorderSlides: write(SLIDES_SCOPES),
  replaceAllTextInSlides: write(SLIDES_SCOPES),
  insertSlidesImageFromUrl: write(SLIDES_SCOPES),
  moveSlideElement: write(SLIDES_SCOPES),
  deleteSlideElement: write(SLIDES_SCOPES),
  insertSlidesLocalImage: write(SLIDES_SCOPES),

  // ---- Calendar ----
  listCalendars: read(CAL_READ_SCOPES),
  getCalendarEvents: read(CAL_READ_SCOPES),
  getCalendarEvent: read(CAL_READ_SCOPES),
  createCalendarEvent: write(CAL_WRITE_SCOPES),
  updateCalendarEvent: write(CAL_WRITE_SCOPES),
  deleteCalendarEvent: write(CAL_WRITE_SCOPES),

  // ---- Admin ----
  manage_accounts: admin,
  authGetStatus: admin,
  authListScopes: admin,
  authTestFileAccess: admin,
};

/** Tool names that bypass account resolution and always run on the default account. */
export const ADMIN_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(TOOL_META)
    .filter(([, m]) => m.opKind === 'admin')
    .map(([name]) => name),
);

/** Default meta for an unrecognized tool name — treated as a read with no scope filter. */
export const FALLBACK_META: ToolMeta = { opKind: 'read', acceptableScopes: [] };
