import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { setupTestServer, type TestContext } from '../helpers/setup-server.js';

const EXPECTED_TOOL_COUNT = 116;

const EXPECTED_TOOLS = [
  'manage_accounts',
  'search', 'createTextFile', 'updateTextFile', 'readTextFile', 'createFolder', 'listFolder', 'listSharedDrives',
  'deleteItem', 'renameItem', 'moveItem',
  'createGoogleDoc', 'createDocFromHTML', 'updateGoogleDoc', 'insertText', 'deleteRange',
  'readGoogleDoc', 'readGoogleDocPaginated', 'listDocumentTabs', 'applyTextStyle', 'applyParagraphStyle', 'formatGoogleDocText', 'formatGoogleDocParagraph', 'createParagraphBullets', 'findAndReplaceInDoc',
  'listComments', 'getComment', 'addComment', 'replyToComment', 'deleteComment',
  'createGoogleSheet', 'updateGoogleSheet', 'getGoogleSheetContent',
  'formatGoogleSheetCells', 'formatGoogleSheetText', 'formatGoogleSheetNumbers',
  'setGoogleSheetBorders', 'mergeGoogleSheetCells', 'addGoogleSheetConditionalFormat',
  'getSpreadsheetInfo', 'appendSpreadsheetRows', 'addSpreadsheetSheet', 'addSheet', 'listSheets', 'renameSheet', 'deleteSheet', 'addDataValidation', 'protectRange', 'addNamedRange',
  'setColumnWidth', 'setRowHeight', 'autoResizeColumns', 'autoResizeRows', 'hideSheetDimension', 'showSheetDimension',
  'listGoogleSheets', 'copyFile',
  'createGoogleSlides', 'updateGoogleSlides',
  'getGoogleDocContent', 'getGoogleDocContentPaginated', 'getGoogleDocImage', 'getGoogleSlidesContent',
  'formatGoogleSlidesText', 'formatGoogleSlidesParagraph',
  'styleGoogleSlidesShape', 'setGoogleSlidesBackground',
  'createGoogleSlidesTextBox', 'createGoogleSlidesShape',
  'getGoogleSlidesSpeakerNotes', 'updateGoogleSlidesSpeakerNotes', 'deleteGoogleSlide', 'duplicateSlide', 'reorderSlides', 'replaceAllTextInSlides', 'exportSlideThumbnail',
  'insertSlidesImageFromUrl', 'insertSlidesLocalImage', 'moveSlideElement', 'deleteSlideElement', 'getSlideElementInfo',
  'createShortcut',
  'lockFile', 'unlockFile',
  'uploadFile', 'downloadFile', 'listPermissions', 'addPermission', 'updatePermission', 'removePermission', 'shareFile', 'getRevisions', 'restoreRevision', 'authGetStatus', 'authListScopes', 'authTestFileAccess',
  'listCalendars', 'getCalendarEvents', 'getCalendarEvent',
  'createCalendarEvent', 'updateCalendarEvent', 'deleteCalendarEvent',
  'insertTable', 'editTableCell', 'insertImageFromUrl', 'insertLocalImage',
  'listGoogleDocs', 'getDocumentInfo', 'addDocumentTab', 'renameDocumentTab', 'insertSmartChip', 'readSmartChips', 'createFootnote',
  'convertPdfToGoogleDoc', 'bulkConvertFolderPdfs', 'uploadPdfWithSplit',
];

describe('Tool Registry', () => {
  let ctx: TestContext;
  let tools: Array<{ name: string; inputSchema?: any; description?: string }>;

  before(async () => {
    ctx = await setupTestServer();
    const result = await ctx.client.listTools();
    tools = result.tools as any;
  });

  after(async () => {
    await ctx.cleanup();
  });

  it(`registers exactly ${EXPECTED_TOOL_COUNT} tools`, () => {
    assert.equal(tools.length, EXPECTED_TOOL_COUNT, `Expected ${EXPECTED_TOOL_COUNT} tools, got ${tools.length}`);
  });

  it('has no duplicate tool names', () => {
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    assert.equal(unique.size, names.length, `Duplicate names: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  it('every tool has a non-empty name and inputSchema', () => {
    for (const tool of tools) {
      assert.ok(tool.name, 'Tool name must be truthy');
      assert.ok(tool.inputSchema, `Tool "${tool.name}" is missing inputSchema`);
      assert.equal(tool.inputSchema.type, 'object', `Tool "${tool.name}" inputSchema.type must be "object"`);
    }
  });

  it('every expected tool is registered', () => {
    const names = new Set(tools.map((t) => t.name));
    for (const expected of EXPECTED_TOOLS) {
      assert.ok(names.has(expected), `Missing tool: ${expected}`);
    }
  });

  it('alias tools advertise the same parameters as the tools they alias', () => {
    // Alias definitions duplicate their primary's inputSchema by hand, so a
    // parameter added to only one of the pair leaves the alias advertising a
    // strictly smaller contract than the handler and Zod schema it shares.
    const ALIASES: Array<[string, string]> = [
      ['formatGoogleDocText', 'applyTextStyle'],
      ['formatGoogleDocParagraph', 'applyParagraphStyle'],
    ];
    for (const [alias, primary] of ALIASES) {
      const aliasTool = tools.find((t) => t.name === alias);
      const primaryTool = tools.find((t) => t.name === primary);
      assert.ok(aliasTool, `Missing alias tool: ${alias}`);
      assert.ok(primaryTool, `Missing primary tool: ${primary}`);
      assert.deepEqual(
        Object.keys(aliasTool.inputSchema.properties ?? {}).sort(),
        Object.keys(primaryTool.inputSchema.properties ?? {}).sort(),
        `"${alias}" inputSchema has drifted from "${primary}"`,
      );
      assert.deepEqual(
        [...(aliasTool.inputSchema.required ?? [])].sort(),
        [...(primaryTool.inputSchema.required ?? [])].sort(),
        `"${alias}" required fields have drifted from "${primary}"`,
      );
    }
  });

  it('every registered tool has a handler (does not return "Tool not found")', async () => {
    // Call each tool with empty args — should get a validation error, NOT "Tool not found"
    for (const tool of tools) {
      const result = await ctx.client.callTool({ name: tool.name, arguments: {} });
      const text = (result as any).content?.[0]?.text || '';
      assert.ok(
        !text.includes('Tool not found'),
        `Tool "${tool.name}" has no handler — got "Tool not found"`,
      );
    }
  });
});
