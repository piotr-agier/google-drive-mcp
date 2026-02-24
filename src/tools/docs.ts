import { z } from 'zod';
import { createReadStream, existsSync } from 'fs';
import { basename, extname } from 'path';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { errorResponse } from '../types.js';
import { escapeDriveQuery } from '../utils.js';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

// Pure helper – no context needed
function hexToRgbColor(hex: string): { red: number; green: number; blue: number } | null {
  if (!hex) return null;
  let hexClean = hex.startsWith('#') ? hex.slice(1) : hex;

  if (hexClean.length === 3) {
    hexClean = hexClean[0] + hexClean[0] + hexClean[1] + hexClean[1] + hexClean[2] + hexClean[2];
  }
  if (hexClean.length !== 6) return null;
  const bigint = parseInt(hexClean, 16);
  if (isNaN(bigint)) return null;

  const r = ((bigint >> 16) & 255) / 255;
  const g = ((bigint >> 8) & 255) / 255;
  const b = (bigint & 255) / 255;

  return { red: r, green: g, blue: b };
}

// Inverse of hexToRgbColor – converts Google Docs API color object to hex string
function rgbColorToHex(color: any): string | null {
  if (!color?.color?.rgbColor) return null;
  const rgb = color.color.rgbColor;
  const r = Math.round((rgb.red || 0) * 255);
  const g = Math.round((rgb.green || 0) * 255);
  const b = Math.round((rgb.blue || 0) * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// Execute batch update for Google Docs
async function executeBatchUpdate(ctx: ToolContext, documentId: string, requests: any[]): Promise<any> {
  if (!requests || requests.length === 0) {
    return {};
  }

  const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });

  try {
    const response = await docs.documents.batchUpdate({
      documentId: documentId,
      requestBody: { requests },
    });
    return response.data;
  } catch (error: any) {
    ctx.log('Google Docs batchUpdate error:', error.message);
    if (error.code === 404) throw new Error(`Document not found (ID: ${documentId})`);
    if (error.code === 403) throw new Error(`Permission denied for document (ID: ${documentId})`);
    throw new Error(`Google Docs API Error: ${error.message}`);
  }
}

// Find text in a document and return the range indices
async function findTextRange(ctx: ToolContext, documentId: string, textToFind: string, instance: number = 1): Promise<{ startIndex: number; endIndex: number } | null> {
  const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });

  try {
    const res = await docs.documents.get({
      documentId,
      fields: 'body(content(paragraph(elements(startIndex,endIndex,textRun(content))),table,startIndex,endIndex))',
    });

    if (!res.data.body?.content) {
      return null;
    }

    // Collect all text segments with their positions
    let fullText = '';
    const segments: { text: string; start: number; end: number }[] = [];

    const collectTextFromContent = (content: any[]) => {
      content.forEach(element => {
        if (element.paragraph?.elements) {
          element.paragraph.elements.forEach((pe: any) => {
            if (pe.textRun?.content && pe.startIndex !== undefined && pe.endIndex !== undefined) {
              const text = pe.textRun.content;
              fullText += text;
              segments.push({ text, start: pe.startIndex, end: pe.endIndex });
            }
          });
        }

        // Handle tables recursively
        if (element.table?.tableRows) {
          element.table.tableRows.forEach((row: any) => {
            if (row.tableCells) {
              row.tableCells.forEach((cell: any) => {
                if (cell.content) {
                  collectTextFromContent(cell.content);
                }
              });
            }
          });
        }
      });
    };

    collectTextFromContent(res.data.body.content);
    segments.sort((a, b) => a.start - b.start);

    // Find the specified instance
    let foundCount = 0;
    let searchStartIndex = 0;

    while (foundCount < instance) {
      const currentIndex = fullText.indexOf(textToFind, searchStartIndex);
      if (currentIndex === -1) break;

      foundCount++;

      if (foundCount === instance) {
        const targetStartInFullText = currentIndex;
        const targetEndInFullText = currentIndex + textToFind.length;
        let currentPosInFullText = 0;
        let startIndex = -1;
        let endIndex = -1;

        for (const seg of segments) {
          const segStartInFullText = currentPosInFullText;
          const segEndInFullText = segStartInFullText + seg.text.length;

          if (startIndex === -1 && targetStartInFullText >= segStartInFullText && targetStartInFullText < segEndInFullText) {
            startIndex = seg.start + (targetStartInFullText - segStartInFullText);
          }

          if (targetEndInFullText > segStartInFullText && targetEndInFullText <= segEndInFullText) {
            endIndex = seg.start + (targetEndInFullText - segStartInFullText);
            break;
          }

          currentPosInFullText = segEndInFullText;
        }

        if (startIndex !== -1 && endIndex !== -1) {
          return { startIndex, endIndex };
        }
      }

      searchStartIndex = currentIndex + 1;
    }

    return null;
  } catch (error: any) {
    ctx.log('Error finding text in document:', error.message);
    if (error.code === 404) throw new Error(`Document not found (ID: ${documentId})`);
    throw new Error(`Failed to search document: ${error.message}`);
  }
}

// Get paragraph range containing a specific index
async function getParagraphRange(ctx: ToolContext, documentId: string, indexWithin: number): Promise<{ startIndex: number; endIndex: number } | null> {
  const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });

  try {
    const res = await docs.documents.get({
      documentId,
      fields: 'body(content(startIndex,endIndex,paragraph,table))',
    });

    if (!res.data.body?.content) {
      return null;
    }

    const findParagraphInContent = (content: any[]): { startIndex: number; endIndex: number } | null => {
      for (const element of content) {
        if (element.startIndex !== undefined && element.endIndex !== undefined) {
          if (indexWithin >= element.startIndex && indexWithin < element.endIndex) {
            if (element.paragraph) {
              return { startIndex: element.startIndex, endIndex: element.endIndex };
            }

            // Check table cells recursively
            if (element.table?.tableRows) {
              for (const row of element.table.tableRows) {
                if (row.tableCells) {
                  for (const cell of row.tableCells) {
                    if (cell.content) {
                      const result = findParagraphInContent(cell.content);
                      if (result) return result;
                    }
                  }
                }
              }
            }
          }
        }
      }
      return null;
    };

    return findParagraphInContent(res.data.body.content);
  } catch (error: any) {
    ctx.log('Error getting paragraph range:', error.message);
    throw new Error(`Failed to find paragraph: ${error.message}`);
  }
}

// Pure helper – build text style update request
function buildUpdateTextStyleRequest(
  startIndex: number,
  endIndex: number,
  style: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    fontSize?: number;
    fontFamily?: string;
    foregroundColor?: string;
    backgroundColor?: string;
    linkUrl?: string;
  }
): { request: any; fields: string[] } | null {
  const textStyle: any = {};
  const fieldsToUpdate: string[] = [];

  if (style.bold !== undefined) { textStyle.bold = style.bold; fieldsToUpdate.push('bold'); }
  if (style.italic !== undefined) { textStyle.italic = style.italic; fieldsToUpdate.push('italic'); }
  if (style.underline !== undefined) { textStyle.underline = style.underline; fieldsToUpdate.push('underline'); }
  if (style.strikethrough !== undefined) { textStyle.strikethrough = style.strikethrough; fieldsToUpdate.push('strikethrough'); }
  if (style.fontSize !== undefined) { textStyle.fontSize = { magnitude: style.fontSize, unit: 'PT' }; fieldsToUpdate.push('fontSize'); }
  if (style.fontFamily !== undefined) { textStyle.weightedFontFamily = { fontFamily: style.fontFamily }; fieldsToUpdate.push('weightedFontFamily'); }

  if (style.foregroundColor !== undefined) {
    const rgbColor = hexToRgbColor(style.foregroundColor);
    if (!rgbColor) throw new Error(`Invalid foreground hex color: ${style.foregroundColor}`);
    textStyle.foregroundColor = { color: { rgbColor } };
    fieldsToUpdate.push('foregroundColor');
  }

  if (style.backgroundColor !== undefined) {
    const rgbColor = hexToRgbColor(style.backgroundColor);
    if (!rgbColor) throw new Error(`Invalid background hex color: ${style.backgroundColor}`);
    textStyle.backgroundColor = { color: { rgbColor } };
    fieldsToUpdate.push('backgroundColor');
  }

  if (style.linkUrl !== undefined) {
    textStyle.link = { url: style.linkUrl };
    fieldsToUpdate.push('link');
  }

  if (fieldsToUpdate.length === 0) return null;

  return {
    request: {
      updateTextStyle: {
        range: { startIndex, endIndex },
        textStyle,
        fields: fieldsToUpdate.join(','),
      }
    },
    fields: fieldsToUpdate
  };
}

// Pure helper – build paragraph style update request
function buildUpdateParagraphStyleRequest(
  startIndex: number,
  endIndex: number,
  style: {
    alignment?: 'START' | 'END' | 'CENTER' | 'JUSTIFIED';
    indentStart?: number;
    indentEnd?: number;
    spaceAbove?: number;
    spaceBelow?: number;
    namedStyleType?: string;
    keepWithNext?: boolean;
  }
): { request: any; fields: string[] } | null {
  const paragraphStyle: any = {};
  const fieldsToUpdate: string[] = [];

  if (style.alignment !== undefined) { paragraphStyle.alignment = style.alignment; fieldsToUpdate.push('alignment'); }
  if (style.indentStart !== undefined) { paragraphStyle.indentStart = { magnitude: style.indentStart, unit: 'PT' }; fieldsToUpdate.push('indentStart'); }
  if (style.indentEnd !== undefined) { paragraphStyle.indentEnd = { magnitude: style.indentEnd, unit: 'PT' }; fieldsToUpdate.push('indentEnd'); }
  if (style.spaceAbove !== undefined) { paragraphStyle.spaceAbove = { magnitude: style.spaceAbove, unit: 'PT' }; fieldsToUpdate.push('spaceAbove'); }
  if (style.spaceBelow !== undefined) { paragraphStyle.spaceBelow = { magnitude: style.spaceBelow, unit: 'PT' }; fieldsToUpdate.push('spaceBelow'); }
  if (style.namedStyleType !== undefined) { paragraphStyle.namedStyleType = style.namedStyleType; fieldsToUpdate.push('namedStyleType'); }
  if (style.keepWithNext !== undefined) { paragraphStyle.keepWithNext = style.keepWithNext; fieldsToUpdate.push('keepWithNext'); }

  if (fieldsToUpdate.length === 0) return null;

  return {
    request: {
      updateParagraphStyle: {
        range: { startIndex, endIndex },
        paragraphStyle,
        fields: fieldsToUpdate.join(','),
      }
    },
    fields: fieldsToUpdate
  };
}

// Insert an inline image from a URL
async function insertInlineImageHelper(
  ctx: ToolContext,
  documentId: string,
  imageUrl: string,
  index: number,
  width?: number,
  height?: number
): Promise<any> {
  // Validate URL format
  try {
    new URL(imageUrl);
  } catch (_e) {
    throw new Error(`Invalid image URL format: ${imageUrl}`);
  }

  const request: any = {
    insertInlineImage: {
      location: { index },
      uri: imageUrl
    }
  };

  if (width && height) {
    request.insertInlineImage.objectSize = {
      height: { magnitude: height, unit: 'PT' },
      width: { magnitude: width, unit: 'PT' }
    };
  }

  return executeBatchUpdate(ctx, documentId, [request]);
}

// Upload a local image to Drive and return its URL
async function uploadImageToDriveHelper(
  ctx: ToolContext,
  localFilePath: string,
  parentFolderId?: string,
  makePublic: boolean = false
): Promise<string> {
  // Verify file exists
  if (!existsSync(localFilePath)) {
    throw new Error(`Image file not found: ${localFilePath}`);
  }

  // Get file name and mime type
  const fileName = basename(localFilePath);
  const mimeTypeMap: { [key: string]: string } = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
  };

  const ext = extname(localFilePath).toLowerCase();
  const mimeType = mimeTypeMap[ext] || 'application/octet-stream';

  // Upload file to Drive
  const fileMetadata: any = {
    name: fileName,
    mimeType: mimeType
  };

  if (parentFolderId) {
    fileMetadata.parents = [parentFolderId];
  }

  const media = {
    mimeType: mimeType,
    body: createReadStream(localFilePath)
  };

  const drive = ctx.getDrive();

  const uploadResponse = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id,webViewLink,webContentLink',
    supportsAllDrives: true
  });

  const fileId = uploadResponse.data.id;
  if (!fileId) {
    throw new Error('Failed to upload image to Drive - no file ID returned');
  }

  if (makePublic) {
    // Make the file publicly readable so the Docs API can fetch it
    await drive.permissions.create({
      fileId: fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });
  }

  // Get the webContentLink
  const fileInfo = await drive.files.get({
    fileId: fileId,
    fields: 'webContentLink',
    supportsAllDrives: true
  });

  const webContentLink = fileInfo.data.webContentLink;
  if (!webContentLink) {
    throw new Error('Failed to get web content link for uploaded image');
  }

  return webContentLink;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const CreateGoogleDocSchema = z.object({
  name: z.string().min(1, "Document name is required"),
  content: z.string(),
  parentFolderId: z.string().optional()
});

const UpdateGoogleDocSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  content: z.string()
});

const GetGoogleDocContentSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  includeFormatting: z.boolean().optional(),
});

const InsertTextSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  text: z.string().min(1, "Text to insert is required"),
  index: z.number().int().min(1, "Index must be at least 1 (1-based)")
});

const DeleteRangeSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  startIndex: z.number().int().min(1, "Start index must be at least 1"),
  endIndex: z.number().int().min(1, "End index must be at least 1")
}).refine(data => data.endIndex > data.startIndex, {
  message: "End index must be greater than start index",
  path: ["endIndex"]
});

const ReadGoogleDocSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  format: z.enum(['text', 'json', 'markdown']).optional().default('text'),
  maxLength: z.number().int().min(1).optional(),
  tabId: z.string().optional()
});

const ListDocumentTabsSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  includeContent: z.boolean().optional().default(false)
});

const ApplyTextStyleSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  startIndex: z.number().int().min(1).optional(),
  endIndex: z.number().int().min(1).optional(),
  textToFind: z.string().min(1).optional(),
  matchInstance: z.number().int().min(1).optional().default(1),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  fontSize: z.number().min(1).optional(),
  fontFamily: z.string().optional(),
  foregroundColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  linkUrl: z.string().url().optional()
});

const ApplyParagraphStyleSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  startIndex: z.number().int().min(1).optional(),
  endIndex: z.number().int().min(1).optional(),
  textToFind: z.string().min(1).optional(),
  matchInstance: z.number().int().min(1).optional().default(1),
  indexWithinParagraph: z.number().int().min(1).optional(),
  alignment: z.enum(['START', 'END', 'CENTER', 'JUSTIFIED']).optional(),
  indentStart: z.number().min(0).optional(),
  indentEnd: z.number().min(0).optional(),
  spaceAbove: z.number().min(0).optional(),
  spaceBelow: z.number().min(0).optional(),
  namedStyleType: z.enum(['NORMAL_TEXT', 'TITLE', 'SUBTITLE', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6']).optional(),
  keepWithNext: z.boolean().optional()
});

const ListCommentsSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  includeDeleted: z.boolean().optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});

const GetCommentSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  commentId: z.string().min(1, "Comment ID is required")
});

const AddCommentSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  startIndex: z.number().int().min(1, "Start index must be at least 1"),
  endIndex: z.number().int().min(1, "End index must be at least 1"),
  commentText: z.string().min(1, "Comment text is required")
});

const ReplyToCommentSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  commentId: z.string().min(1, "Comment ID is required"),
  replyText: z.string().min(1, "Reply text is required")
});

const DeleteCommentSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  commentId: z.string().min(1, "Comment ID is required")
});

const InsertTableSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  rows: z.number().int().min(1, "Must have at least 1 row"),
  columns: z.number().int().min(1, "Must have at least 1 column"),
  index: z.number().int().min(1, "Index must be at least 1 (1-based)")
});

const EditTableCellSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  tableStartIndex: z.number().int().min(1, "Table start index is required"),
  rowIndex: z.number().int().min(0, "Row index must be at least 0 (0-based)"),
  columnIndex: z.number().int().min(0, "Column index must be at least 0 (0-based)"),
  textContent: z.string().optional().describe("New text content for the cell"),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  fontSize: z.number().optional(),
  alignment: z.enum(["START", "CENTER", "END", "JUSTIFIED"]).optional()
});

const InsertImageFromUrlSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  imageUrl: z.string().url("Must be a valid URL"),
  index: z.number().int().min(1, "Index must be at least 1 (1-based)"),
  width: z.number().optional().describe("Width in points"),
  height: z.number().optional().describe("Height in points")
});

const InsertLocalImageSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  localImagePath: z.string().min(1, "Local image path is required"),
  index: z.number().int().min(1, "Index must be at least 1 (1-based)"),
  width: z.number().optional().describe("Width in points"),
  height: z.number().optional().describe("Height in points"),
  uploadToSameFolder: z.boolean().optional().default(true).describe("Upload to same folder as document"),
  makePublic: z.boolean().optional().default(false).describe("Make uploaded image publicly accessible. Required if the document is not shared with the service account.")
});

const ListGoogleDocsSchema = z.object({
  maxResults: z.number().int().min(1).max(100).optional().default(20).describe("Maximum number of documents to return (1-100)."),
  query: z.string().optional().describe("Search query to filter documents by name or content."),
  orderBy: z.enum(["name", "modifiedTime", "createdTime"]).optional().default("modifiedTime").describe("Sort order for results.")
});

const GetDocumentInfoSchema = z.object({
  documentId: z.string().min(1, "Document ID is required")
});

const FindAndReplaceInDocSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  findText: z.string().min(1, "findText is required"),
  replaceText: z.string(),
  matchCase: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
});

const AddDocumentTabSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  title: z.string().min(1, "Tab title is required"),
});

const RenameDocumentTabSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  tabId: z.string().min(1, "Tab ID is required"),
  title: z.string().min(1, "Tab title is required"),
});

const InsertSmartChipSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  index: z.number().int().min(1, "Index must be at least 1"),
  chipType: z.enum(["person", "date", "file"]),
  personEmail: z.string().email().optional(),
  date: z.string().optional(),
  fileId: z.string().optional(),
});

const ReadSmartChipsSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
});

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "createGoogleDoc",
    description: "Create a new Google Doc",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Doc name" },
        content: { type: "string", description: "Doc content" },
        parentFolderId: { type: "string", description: "Parent folder ID" }
      },
      required: ["name", "content"]
    }
  },
  {
    name: "updateGoogleDoc",
    description: "Update an existing Google Doc",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Doc ID" },
        content: { type: "string", description: "New content" }
      },
      required: ["documentId", "content"]
    }
  },
  {
    name: "insertText",
    description: "Insert text at a specific index in a Google Doc (surgical edit, doesn't replace entire doc)",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        text: { type: "string", description: "Text to insert" },
        index: { type: "number", description: "Position to insert at (1-based)" }
      },
      required: ["documentId", "text", "index"]
    }
  },
  {
    name: "deleteRange",
    description: "Delete content between start and end indices in a Google Doc",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        startIndex: { type: "number", description: "Start index (1-based, inclusive)" },
        endIndex: { type: "number", description: "End index (exclusive)" }
      },
      required: ["documentId", "startIndex", "endIndex"]
    }
  },
  {
    name: "readGoogleDoc",
    description: "Read content of a Google Doc with format options. Supports multi-tab documents.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        format: { type: "string", enum: ["text", "json", "markdown"], description: "Output format (default: text)" },
        maxLength: { type: "number", description: "Maximum characters to return" },
        tabId: { type: "string", description: "Read a specific tab by ID (from listDocumentTabs). If omitted, all tabs are returned." }
      },
      required: ["documentId"]
    }
  },
  {
    name: "listDocumentTabs",
    description: "List all tabs in a Google Doc with their IDs and hierarchy",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        includeContent: { type: "boolean", description: "Include content summary (character count) for each tab" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "applyTextStyle",
    description: "Apply text formatting (bold, italic, color, etc.) to a range or found text. Use EITHER startIndex+endIndex OR textToFind for targeting.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        startIndex: { type: "number", description: "Start index (1-based) - use with endIndex" },
        endIndex: { type: "number", description: "End index (exclusive) - use with startIndex" },
        textToFind: { type: "string", description: "Text to find and format (alternative to indices)" },
        matchInstance: { type: "number", description: "Which instance of textToFind (default: 1)" },
        bold: { type: "boolean", description: "Make text bold" },
        italic: { type: "boolean", description: "Make text italic" },
        underline: { type: "boolean", description: "Underline text" },
        strikethrough: { type: "boolean", description: "Strikethrough text" },
        fontSize: { type: "number", description: "Font size in points" },
        fontFamily: { type: "string", description: "Font family name" },
        foregroundColor: { type: "string", description: "Hex color (e.g., #FF0000)" },
        backgroundColor: { type: "string", description: "Hex background color" },
        linkUrl: { type: "string", description: "URL for hyperlink" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "applyParagraphStyle",
    description: "Apply paragraph formatting. Use EITHER startIndex+endIndex OR textToFind OR indexWithinParagraph for targeting.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        startIndex: { type: "number", description: "Start index (1-based) - use with endIndex" },
        endIndex: { type: "number", description: "End index (exclusive) - use with startIndex" },
        textToFind: { type: "string", description: "Text within the target paragraph" },
        matchInstance: { type: "number", description: "Which instance of textToFind (default: 1)" },
        indexWithinParagraph: { type: "number", description: "Any index within the target paragraph" },
        alignment: { type: "string", enum: ["START", "END", "CENTER", "JUSTIFIED"], description: "Text alignment" },
        indentStart: { type: "number", description: "Left indent in points" },
        indentEnd: { type: "number", description: "Right indent in points" },
        spaceAbove: { type: "number", description: "Space above in points" },
        spaceBelow: { type: "number", description: "Space below in points" },
        namedStyleType: { type: "string", enum: ["NORMAL_TEXT", "TITLE", "SUBTITLE", "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"], description: "Named paragraph style" },
        keepWithNext: { type: "boolean", description: "Keep with next paragraph" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "formatGoogleDocText",
    description: "Apply text formatting (bold, italic, font, color, links) to a range or found text in a Google Doc. Alias for applyTextStyle.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        startIndex: { type: "number", description: "Start index (1-based) - use with endIndex" },
        endIndex: { type: "number", description: "End index (exclusive) - use with startIndex" },
        textToFind: { type: "string", description: "Text to find and format (alternative to indices)" },
        matchInstance: { type: "number", description: "Which instance of textToFind (default: 1)" },
        bold: { type: "boolean", description: "Make text bold" },
        italic: { type: "boolean", description: "Make text italic" },
        underline: { type: "boolean", description: "Underline text" },
        strikethrough: { type: "boolean", description: "Strikethrough text" },
        fontSize: { type: "number", description: "Font size in points" },
        fontFamily: { type: "string", description: "Font family name" },
        foregroundColor: { type: "string", description: "Hex color (e.g., #FF0000)" },
        backgroundColor: { type: "string", description: "Hex background color" },
        linkUrl: { type: "string", description: "URL for hyperlink" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "formatGoogleDocParagraph",
    description: "Apply paragraph formatting (alignment, indentation, spacing, heading style) in a Google Doc. Alias for applyParagraphStyle.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        startIndex: { type: "number", description: "Start index (1-based) - use with endIndex" },
        endIndex: { type: "number", description: "End index (exclusive) - use with startIndex" },
        textToFind: { type: "string", description: "Text within the target paragraph" },
        matchInstance: { type: "number", description: "Which instance of textToFind (default: 1)" },
        indexWithinParagraph: { type: "number", description: "Any index within the target paragraph" },
        alignment: { type: "string", enum: ["START", "END", "CENTER", "JUSTIFIED"], description: "Text alignment" },
        indentStart: { type: "number", description: "Left indent in points" },
        indentEnd: { type: "number", description: "Right indent in points" },
        spaceAbove: { type: "number", description: "Space above in points" },
        spaceBelow: { type: "number", description: "Space below in points" },
        namedStyleType: { type: "string", enum: ["NORMAL_TEXT", "TITLE", "SUBTITLE", "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"], description: "Named paragraph style" },
        keepWithNext: { type: "boolean", description: "Keep with next paragraph" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "findAndReplaceInDoc",
    description: "Find and replace text across a Google Document. Dry-run mode counts matches from paragraph text only (may differ from actual replacements which cover tables, headers, footers, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        findText: { type: "string", description: "Text to find" },
        replaceText: { type: "string", description: "Replacement text" },
        matchCase: { type: "boolean", description: "Case-sensitive match (default: false)" },
        dryRun: { type: "boolean", description: "Only count approximate matches from paragraph text, do not modify document (default: false)" }
      },
      required: ["documentId", "findText", "replaceText"]
    }
  },
  {
    name: "listComments",
    description: "List all comments in a Google Document",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        includeDeleted: { type: "boolean", description: "Whether to include deleted comments (default: false)" },
        pageSize: { type: "number", description: "Max comments to return (1-100, default: 100)" },
        pageToken: { type: "string", description: "Token for next page of results" },
      },
      required: ["documentId"]
    }
  },
  {
    name: "getComment",
    description: "Get a specific comment with its full thread of replies",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        commentId: { type: "string", description: "The comment ID" }
      },
      required: ["documentId", "commentId"]
    }
  },
  {
    name: "addComment",
    description: "Add a comment anchored to a specific text range. Note: Due to Google API limitations, programmatic comments appear in 'All Comments' but may not be visibly anchored in the document UI.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        startIndex: { type: "number", description: "Start index (1-based)" },
        endIndex: { type: "number", description: "End index (exclusive)" },
        commentText: { type: "string", description: "The comment content" }
      },
      required: ["documentId", "startIndex", "endIndex", "commentText"]
    }
  },
  {
    name: "replyToComment",
    description: "Add a reply to an existing comment",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        commentId: { type: "string", description: "The comment ID to reply to" },
        replyText: { type: "string", description: "The reply content" }
      },
      required: ["documentId", "commentId", "replyText"]
    }
  },
  {
    name: "deleteComment",
    description: "Delete a comment from the document",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        commentId: { type: "string", description: "The comment ID to delete" }
      },
      required: ["documentId", "commentId"]
    }
  },
  {
    name: "getGoogleDocContent",
    description: "Get content of a Google Doc with text indices for formatting",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document ID" },
        includeFormatting: { type: "boolean", description: "Include font, style, and color info for each text span (default: false)" },
      },
      required: ["documentId"]
    }
  },
  {
    name: "insertTable",
    description: "Insert a new table with the specified dimensions at a given index",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        rows: { type: "number", description: "Number of rows for the new table" },
        columns: { type: "number", description: "Number of columns for the new table" },
        index: { type: "number", description: "The index (1-based) where the table should be inserted" }
      },
      required: ["documentId", "rows", "columns", "index"]
    }
  },
  {
    name: "editTableCell",
    description: "Edit the content and/or style of a specific table cell. Requires knowing the table start index.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        tableStartIndex: { type: "number", description: "The starting index of the TABLE element" },
        rowIndex: { type: "number", description: "Row index (0-based)" },
        columnIndex: { type: "number", description: "Column index (0-based)" },
        textContent: { type: "string", description: "New text content for the cell (replaces existing)" },
        bold: { type: "boolean", description: "Make text bold" },
        italic: { type: "boolean", description: "Make text italic" },
        fontSize: { type: "number", description: "Font size in points" },
        alignment: { type: "string", enum: ["START", "CENTER", "END", "JUSTIFIED"], description: "Text alignment" }
      },
      required: ["documentId", "tableStartIndex", "rowIndex", "columnIndex"]
    }
  },
  {
    name: "insertImageFromUrl",
    description: "Insert an inline image into a Google Document from a publicly accessible URL",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        imageUrl: { type: "string", description: "Publicly accessible URL to the image" },
        index: { type: "number", description: "The index (1-based) where the image should be inserted" },
        width: { type: "number", description: "Width of the image in points" },
        height: { type: "number", description: "Height of the image in points" }
      },
      required: ["documentId", "imageUrl", "index"]
    }
  },
  {
    name: "insertLocalImage",
    description: "Upload a local image file to Google Drive and insert it into a Google Document",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        localImagePath: { type: "string", description: "Absolute path to the local image file" },
        index: { type: "number", description: "The index (1-based) where the image should be inserted" },
        width: { type: "number", description: "Width of the image in points" },
        height: { type: "number", description: "Height of the image in points" },
        uploadToSameFolder: { type: "boolean", description: "Upload to same folder as document (default: true)" },
        makePublic: { type: "boolean", description: "Make uploaded image publicly accessible (anyone with the link can view). Set to true if the Docs API cannot access the image through the authenticated user's permissions. Default: false" }
      },
      required: ["documentId", "localImagePath", "index"]
    }
  },
  {
    name: "listGoogleDocs",
    description: "Lists Google Documents from your Google Drive with optional filtering.",
    inputSchema: {
      type: "object",
      properties: {
        maxResults: { type: "integer", description: "Maximum number of documents to return (1-100)." },
        query: { type: "string", description: "Search query to filter documents by name or content." },
        orderBy: { type: "string", enum: ["name", "modifiedTime", "createdTime"], description: "Sort order for results." }
      },
      required: []
    }
  },
  {
    name: "getDocumentInfo",
    description: "Gets detailed information about a specific Google Document.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The ID of the Google Document (from the URL)." }
      },
      required: ["documentId"]
    }
  },
  {
    name: "addDocumentTab",
    description: "Add a new tab in a Google Doc",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document ID" },
        title: { type: "string", description: "Tab title" }
      },
      required: ["documentId", "title"]
    }
  },
  {
    name: "renameDocumentTab",
    description: "Rename an existing Google Doc tab",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document ID" },
        tabId: { type: "string", description: "Tab ID" },
        title: { type: "string", description: "New tab title" }
      },
      required: ["documentId", "tabId", "title"]
    }
  },
  {
    name: "insertSmartChip",
    description: "Insert a smart chip (person/date/file) at a document index",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document ID" },
        index: { type: "number", description: "Insertion index (1-based)" },
        chipType: { type: "string", enum: ["person", "date", "file"], description: "Smart chip type" },
        personEmail: { type: "string", description: "Email for person chip" },
        date: { type: "string", description: "Date string for date chip" },
        fileId: { type: "string", description: "Drive file ID for file chip" }
      },
      required: ["documentId", "index", "chipType"]
    }
  },
  {
    name: "readSmartChips",
    description: "Read smart chip-like elements from a document",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document ID" }
      },
      required: ["documentId"]
    }
  },
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleTool(toolName: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  switch (toolName) {

    // =========================================================================
    // CREATE / UPDATE GOOGLE DOC
    // =========================================================================

    case "createGoogleDoc": {
      const validation = CreateGoogleDocSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const parentFolderId = await ctx.resolveFolderId(a.parentFolderId);

      // Check if document already exists
      const existingFileId = await ctx.checkFileExists(a.name, parentFolderId);
      if (existingFileId) {
        return errorResponse(
          `A document named "${a.name}" already exists in this location. ` +
          `To update it, use updateGoogleDoc with documentId: ${existingFileId}`
        );
      }

      // Create empty doc
      let docResponse;
      try {
        docResponse = await ctx.getDrive().files.create({
          requestBody: {
            name: a.name,
            mimeType: 'application/vnd.google-apps.document',
            parents: [parentFolderId]
          },
          fields: 'id, name, webViewLink',
          supportsAllDrives: true
        });
      } catch (createError: any) {
        ctx.log('Drive files.create error details:', {
          message: createError.message,
          code: createError.code,
          errors: createError.errors,
          status: createError.status
        });
        throw createError;
      }
      const doc = docResponse.data;

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      await docs.documents.batchUpdate({
        documentId: doc.id!,
        requestBody: {
          requests: [
            {
              insertText: { location: { index: 1 }, text: a.content }
            },
            // Ensure the text is formatted as normal text, not as a header
            {
              updateParagraphStyle: {
                range: {
                  startIndex: 1,
                  endIndex: a.content.length + 1
                },
                paragraphStyle: {
                  namedStyleType: 'NORMAL_TEXT'
                },
                fields: 'namedStyleType'
              }
            }
          ]
        }
      });

      return {
        content: [{ type: "text", text: `Created Google Doc: ${doc.name}\nID: ${doc.id}\nLink: ${doc.webViewLink}` }],
        isError: false
      };
    }

    case "updateGoogleDoc": {
      const validation = UpdateGoogleDocSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      const document = await docs.documents.get({ documentId: a.documentId });

      // Delete all content
      const endIndex = document.data.body?.content?.[document.data.body.content.length - 1]?.endIndex || 1;
      const deleteEndIndex = Math.max(1, endIndex - 1);

      if (deleteEndIndex > 1) {
        await docs.documents.batchUpdate({
          documentId: a.documentId,
          requestBody: {
            requests: [{
              deleteContentRange: {
                range: { startIndex: 1, endIndex: deleteEndIndex }
              }
            }]
          }
        });
      }

      // Insert new content
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [
            {
              insertText: { location: { index: 1 }, text: a.content }
            },
            {
              updateParagraphStyle: {
                range: {
                  startIndex: 1,
                  endIndex: a.content.length + 1
                },
                paragraphStyle: {
                  namedStyleType: 'NORMAL_TEXT'
                },
                fields: 'namedStyleType'
              }
            }
          ]
        }
      });

      return {
        content: [{ type: "text", text: `Updated Google Doc: ${document.data.title}` }],
        isError: false
      };
    }

    // =========================================================================
    // DOC CONTENT
    // =========================================================================

    case "getGoogleDocContent": {
      const validation = GetGoogleDocContentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const withFormatting = a.includeFormatting === true;

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      const document = await docs.documents.get({
        documentId: a.documentId,
        includeTabsContent: true,
      });

      interface Segment {
        text: string;
        startIndex: number;
        endIndex: number;
        fontFamily?: string;
        fontSize?: number;
        bold?: boolean;
        italic?: boolean;
        underline?: boolean;
        strikethrough?: boolean;
        foregroundColor?: string;
        backgroundColor?: string;
      }

      // Helper to extract segments from body content
      function extractSegments(bodyContent: any[]): Segment[] {
        const segments: Segment[] = [];
        for (const element of bodyContent) {
          if (element.paragraph?.elements) {
            for (const textElement of element.paragraph.elements) {
              if (textElement.textRun?.content && textElement.startIndex != null && textElement.endIndex != null) {
                const seg: Segment = {
                  text: textElement.textRun.content,
                  startIndex: textElement.startIndex,
                  endIndex: textElement.endIndex,
                };
                if (withFormatting) {
                  const ts = textElement.textRun.textStyle;
                  if (ts) {
                    if (ts.weightedFontFamily?.fontFamily) seg.fontFamily = ts.weightedFontFamily.fontFamily;
                    if (ts.fontSize?.magnitude != null) seg.fontSize = ts.fontSize.magnitude;
                    if (ts.bold) seg.bold = true;
                    if (ts.italic) seg.italic = true;
                    if (ts.underline) seg.underline = true;
                    if (ts.strikethrough) seg.strikethrough = true;
                    const fg = rgbColorToHex(ts.foregroundColor);
                    const bg = rgbColorToHex(ts.backgroundColor);
                    if (fg) seg.foregroundColor = fg;
                    if (bg) seg.backgroundColor = bg;
                  }
                }
                segments.push(seg);
              }
            }
          }
        }
        return segments;
      }

      // Helper to format segments into indexed text
      function formatSegments(segments: Segment[]): string {
        let result = '';
        for (const segment of segments) {
          const hasMeta = withFormatting && hasFormattingInfo(segment);
          const meta = hasMeta ? buildMetaLine(segment) : null;
          const lines = segment.text.split('\n');
          let offset = segment.startIndex;
          for (const line of lines) {
            if (line.trim()) {
              if (meta) {
                result += `[${offset}-${offset + line.length}] ${meta}\n  ${line}\n`;
              } else {
                result += `[${offset}-${offset + line.length}] ${line}\n`;
              }
            }
            offset += line.length + 1;
          }
        }
        return result;
      }

      function hasFormattingInfo(seg: Segment): boolean {
        return !!(seg.fontFamily || seg.fontSize || seg.bold || seg.italic || seg.underline || seg.strikethrough || seg.foregroundColor || seg.backgroundColor);
      }

      function buildMetaLine(seg: Segment): string {
        const parts: string[] = [];
        if (seg.fontFamily) parts.push(`font="${seg.fontFamily}"`);
        if (seg.fontSize) parts.push(`size=${seg.fontSize}pt`);
        const styles: string[] = [];
        if (seg.bold) styles.push('bold');
        if (seg.italic) styles.push('italic');
        if (seg.underline) styles.push('underline');
        if (seg.strikethrough) styles.push('strikethrough');
        if (styles.length > 0) parts.push(`style=${styles.join(',')}`);
        if (seg.foregroundColor) parts.push(`color=${seg.foregroundColor}`);
        if (seg.backgroundColor) parts.push(`bg=${seg.backgroundColor}`);
        return parts.join(', ');
      }

      // Accumulate font usage across all segments
      interface FontInfo { sizes: Set<number>; styles: Set<string>; charCount: number }
      const fontUsage: Map<string, FontInfo> = new Map();
      function trackFonts(segments: Segment[]) {
        if (!withFormatting) return;
        for (const seg of segments) {
          if (seg.fontFamily) {
            let info = fontUsage.get(seg.fontFamily);
            if (!info) {
              info = { sizes: new Set(), styles: new Set(), charCount: 0 };
              fontUsage.set(seg.fontFamily, info);
            }
            if (seg.fontSize) info.sizes.add(seg.fontSize);
            if (seg.bold) info.styles.add('bold');
            if (seg.italic) info.styles.add('italic');
            if (seg.underline) info.styles.add('underline');
            if (seg.strikethrough) info.styles.add('strikethrough');
            info.charCount += seg.endIndex - seg.startIndex;
          }
        }
      }

      const tabs = (document.data as any).tabs as any[] | undefined;
      let formattedContent = 'Document content with indices:\n\n';
      let totalLength = 0;

      if (tabs && tabs.length > 1) {
        // Multi-tab document
        for (const tab of tabs) {
          const title = tab.tabProperties?.title || 'Untitled';
          const bodyContent = tab.documentTab?.body?.content;
          formattedContent += `=== Tab: ${title} ===\n`;
          if (bodyContent) {
            const segments = extractSegments(bodyContent);
            trackFonts(segments);
            formattedContent += formatSegments(segments);
            if (segments.length > 0) {
              totalLength += segments[segments.length - 1].endIndex;
            }
          }
          formattedContent += '\n';
        }
      } else if (tabs && tabs.length === 1) {
        // Single-tab document via tabs API
        const bodyContent = tabs[0].documentTab?.body?.content;
        if (bodyContent) {
          const segments = extractSegments(bodyContent);
          trackFonts(segments);
          formattedContent += formatSegments(segments);
          totalLength = segments.length > 0 ? segments[segments.length - 1].endIndex : 0;
        }
      } else {
        // Fallback to legacy body content
        const bodyContent = document.data.body?.content;
        if (bodyContent) {
          const segments = extractSegments(bodyContent);
          trackFonts(segments);
          formattedContent += formatSegments(segments);
          totalLength = segments.length > 0 ? segments[segments.length - 1].endIndex : 0;
        }
      }

      if (withFormatting && fontUsage.size > 0) {
        formattedContent += '\n--- Fonts summary ---\n';
        const sorted = [...fontUsage.entries()].sort((a, b) => b[1].charCount - a[1].charCount);
        for (const [font, info] of sorted) {
          const sizesStr = info.sizes.size > 0 ? [...info.sizes].sort((a, b) => a - b).join(', ') + ' pt' : 'default size';
          const stylesStr = info.styles.size > 0 ? [...info.styles].sort().join(', ') : 'normal';
          formattedContent += `${font}: sizes [${sizesStr}], styles [${stylesStr}], ~${info.charCount} chars\n`;
        }
      }

      return {
        content: [{
          type: "text",
          text: formattedContent + `\nTotal length: ${totalLength} characters`
        }],
        isError: false
      };
    }

    // =========================================================================
    // DOC EDITING TOOLS
    // =========================================================================

    case "insertText": {
      const validation = InsertTextSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [{
            insertText: {
              location: { index: a.index },
              text: a.text
            }
          }]
        }
      });

      return {
        content: [{ type: "text", text: `Successfully inserted ${a.text.length} characters at index ${a.index}` }],
        isError: false
      };
    }

    case "deleteRange": {
      const validation = DeleteRangeSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      if (a.endIndex <= a.startIndex) {
        return errorResponse("endIndex must be greater than startIndex");
      }

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [{
            deleteContentRange: {
              range: {
                startIndex: a.startIndex,
                endIndex: a.endIndex
              }
            }
          }]
        }
      });

      return {
        content: [{ type: "text", text: `Successfully deleted content from index ${a.startIndex} to ${a.endIndex}` }],
        isError: false
      };
    }

    case "readGoogleDoc": {
      const validation = ReadGoogleDocSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      const docResponse = await docs.documents.get({
        documentId: a.documentId,
        includeTabsContent: true,
      });

      const doc = docResponse.data;
      const format = a.format || 'text';

      if (format === 'json') {
        let result = JSON.stringify(doc, null, 2);
        if (a.maxLength && result.length > a.maxLength) {
          result = result.substring(0, a.maxLength) + '\n... (truncated)';
        }
        return {
          content: [{ type: "text", text: result }],
          isError: false
        };
      }

      // Helper to extract plain text from body content
      function extractText(bodyContent: any[]): string {
        let result = '';
        for (const element of bodyContent) {
          if (element.paragraph?.elements) {
            for (const elem of element.paragraph.elements) {
              if (elem.textRun?.content) {
                result += elem.textRun.content;
              }
            }
          } else if (element.table) {
            for (const row of element.table.tableRows || []) {
              for (const cell of row.tableCells || []) {
                for (const cellContent of cell.content || []) {
                  if (cellContent.paragraph?.elements) {
                    for (const elem of cellContent.paragraph.elements) {
                      if (elem.textRun?.content) {
                        result += elem.textRun.content;
                      }
                    }
                  }
                }
                result += '\t';
              }
              result += '\n';
            }
          }
        }
        return result;
      }

      let text = '';
      const tabs = (doc as any).tabs as any[] | undefined;

      if (tabs && tabs.length > 0) {
        if (a.tabId) {
          // Find the specific tab
          const tab = tabs.find((t: any) => t.tabProperties?.tabId === a.tabId);
          if (!tab) {
            return errorResponse(`Tab with ID "${a.tabId}" not found. Use listDocumentTabs to see available tabs.`);
          }
          const bodyContent = tab.documentTab?.body?.content;
          if (bodyContent) {
            text = extractText(bodyContent);
          }
        } else if (tabs.length > 1) {
          // Multi-tab: include all tabs with headers
          for (const tab of tabs) {
            const title = tab.tabProperties?.title || 'Untitled';
            text += `=== Tab: ${title} ===\n`;
            const bodyContent = tab.documentTab?.body?.content;
            if (bodyContent) {
              text += extractText(bodyContent);
            }
            text += '\n';
          }
        } else {
          // Single tab via tabs API
          const bodyContent = tabs[0].documentTab?.body?.content;
          if (bodyContent) {
            text = extractText(bodyContent);
          }
        }
      } else {
        // Fallback to legacy body content
        const body = doc.body;
        if (body?.content) {
          text = extractText(body.content);
        }
      }

      if (format === 'markdown') {
        text = `# ${doc.title}\n\n${text}`;
      }

      if (a.maxLength && text.length > a.maxLength) {
        text = text.substring(0, a.maxLength) + '\n... (truncated)';
      }

      return {
        content: [{ type: "text", text }],
        isError: false
      };
    }

    case "listDocumentTabs": {
      const validation = ListDocumentTabsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      // Use includeTabsContent to get the new tabs structure
      const docResponse = await docs.documents.get({
        documentId: a.documentId,
        includeTabsContent: true
      });

      const doc = docResponse.data;

      // Check if document has tabs (newer API feature)
      const tabs = (doc as any).tabs;
      if (!tabs || tabs.length === 0) {
        // Single-tab document or legacy format - check for body content
        let contentInfo = '';
        if (a.includeContent) {
          let charCount = 0;
          const body = doc.body;
          if (body?.content) {
            for (const element of body.content) {
              if (element.paragraph?.elements) {
                for (const elem of element.paragraph.elements) {
                  if (elem.textRun?.content) {
                    charCount += elem.textRun.content.length;
                  }
                }
              }
            }
          }
          contentInfo = ` (${charCount} characters)`;
        }
        return {
          content: [{ type: "text", text: `Document "${doc.title}" has a single tab (standard format).${contentInfo}` }],
          isError: false
        };
      }

      // Process tabs
      const processTab = (tab: any, depth: number = 0): string => {
        const indent = '  '.repeat(depth);
        let result = `${indent}- Tab: "${tab.tabProperties?.title || 'Untitled'}" (ID: ${tab.tabProperties?.tabId})`;

        if (a.includeContent && tab.documentTab?.body?.content) {
          let charCount = 0;
          for (const element of tab.documentTab.body.content) {
            if (element.paragraph?.elements) {
              for (const elem of element.paragraph.elements) {
                if (elem.textRun?.content) {
                  charCount += elem.textRun.content.length;
                }
              }
            }
          }
          result += ` (${charCount} characters)`;
        }

        if (tab.childTabs) {
          for (const childTab of tab.childTabs) {
            result += '\n' + processTab(childTab, depth + 1);
          }
        }

        return result;
      };

      let tabList = `Document "${doc.title}" tabs:\n`;
      for (const tab of tabs) {
        tabList += processTab(tab) + '\n';
      }

      return {
        content: [{ type: "text", text: tabList }],
        isError: false
      };
    }

    // =========================================================================
    // TEXT & PARAGRAPH STYLE
    // =========================================================================

    case "applyTextStyle":
    case "formatGoogleDocText": {
      const validation = ApplyTextStyleSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      let startIndex: number;
      let endIndex: number;

      // Determine target range (flat parameters)
      if (a.startIndex !== undefined && a.endIndex !== undefined) {
        startIndex = a.startIndex;
        endIndex = a.endIndex;
      } else if (a.textToFind !== undefined) {
        const range = await findTextRange(
          ctx,
          a.documentId,
          a.textToFind,
          a.matchInstance || 1
        );
        if (!range) {
          return errorResponse(`Text "${a.textToFind}" not found in document`);
        }
        startIndex = range.startIndex;
        endIndex = range.endIndex;
      } else {
        return errorResponse("Must provide either startIndex+endIndex or textToFind");
      }

      // Build style object from flat parameters
      const style = {
        bold: a.bold,
        italic: a.italic,
        underline: a.underline,
        strikethrough: a.strikethrough,
        fontSize: a.fontSize,
        fontFamily: a.fontFamily,
        foregroundColor: a.foregroundColor,
        backgroundColor: a.backgroundColor,
        linkUrl: a.linkUrl
      };

      // Build the update request
      const styleResult = buildUpdateTextStyleRequest(startIndex, endIndex, style);
      if (!styleResult) {
        return errorResponse("No valid style options provided");
      }

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [styleResult.request]
        }
      });

      return {
        content: [{ type: "text", text: `Successfully applied text style to range ${startIndex}-${endIndex}` }],
        isError: false
      };
    }

    case "applyParagraphStyle":
    case "formatGoogleDocParagraph": {
      const validation = ApplyParagraphStyleSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      let startIndex: number;
      let endIndex: number;

      // Determine target range (flat parameters)
      if (a.startIndex !== undefined && a.endIndex !== undefined) {
        startIndex = a.startIndex;
        endIndex = a.endIndex;
      } else if (a.textToFind !== undefined) {
        const range = await findTextRange(
          ctx,
          a.documentId,
          a.textToFind,
          a.matchInstance || 1
        );
        if (!range) {
          return errorResponse(`Text "${a.textToFind}" not found in document`);
        }
        // For paragraph style, get the full paragraph range
        const paraRange = await getParagraphRange(ctx, a.documentId, range.startIndex);
        if (!paraRange) {
          return errorResponse("Could not determine paragraph boundaries");
        }
        startIndex = paraRange.startIndex;
        endIndex = paraRange.endIndex;
      } else if (a.indexWithinParagraph !== undefined) {
        const paraRange = await getParagraphRange(ctx, a.documentId, a.indexWithinParagraph);
        if (!paraRange) {
          return errorResponse("Could not determine paragraph boundaries");
        }
        startIndex = paraRange.startIndex;
        endIndex = paraRange.endIndex;
      } else {
        return errorResponse("Must provide either startIndex+endIndex, textToFind, or indexWithinParagraph");
      }

      // Build style object from flat parameters
      const style = {
        alignment: a.alignment,
        indentStart: a.indentStart,
        indentEnd: a.indentEnd,
        spaceAbove: a.spaceAbove,
        spaceBelow: a.spaceBelow,
        namedStyleType: a.namedStyleType,
        keepWithNext: a.keepWithNext
      };

      // Build the update request
      const styleResult = buildUpdateParagraphStyleRequest(startIndex, endIndex, style);
      if (!styleResult) {
        return errorResponse("No valid style options provided");
      }

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [styleResult.request]
        }
      });

      return {
        content: [{ type: "text", text: `Successfully applied paragraph style to range ${startIndex}-${endIndex}` }],
        isError: false
      };
    }

    case "findAndReplaceInDoc": {
      const validation = FindAndReplaceInDocSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });

      if (a.dryRun) {
        const doc = await docs.documents.get({ documentId: a.documentId });
        let text = '';
        const content = doc.data.body?.content || [];
        for (const el of content) {
          if (el.paragraph?.elements) {
            for (const elem of el.paragraph.elements) {
              if (elem.textRun?.content) text += elem.textRun.content;
            }
          }
        }
        const escaped = a.findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const flags = a.matchCase ? 'g' : 'gi';
        const matches = text.match(new RegExp(escaped, flags));
        const count = matches ? matches.length : 0;
        return {
          content: [{ type: 'text', text: `Dry run (paragraph text only, approximate): found ${count} occurrence(s) of "${a.findText}". Note: actual replacement covers the full document including tables, headers, and footers.` }],
          isError: false,
        };
      }

      const response = await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [
            {
              replaceAllText: {
                containsText: {
                  text: a.findText,
                  matchCase: a.matchCase,
                },
                replaceText: a.replaceText,
              },
            },
          ],
        },
      });

      const occurrences = response.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
      return {
        content: [{ type: 'text', text: `Replaced ${occurrences} occurrence(s) of "${a.findText}".` }],
        isError: false,
      };
    }

    // =========================================================================
    // COMMENT TOOLS (use Drive API v3)
    // =========================================================================

    case "listComments": {
      const validation = ListCommentsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      // Use Drive API v3 for comments
      const response = await ctx.getDrive().comments.list({
        fileId: a.documentId,
        fields: 'comments(id,content,quotedFileContent,author,createdTime,resolved,replies),nextPageToken',
        pageSize: a.pageSize || 100,
        pageToken: a.pageToken,
        includeDeleted: a.includeDeleted || false,
      });

      const comments = response.data.comments || [];
      const nextPageToken = response.data.nextPageToken;

      if (comments.length === 0) {
        return {
          content: [{ type: "text", text: "No comments found in this document." }],
          isError: false
        };
      }

      // Format comments for display
      const formattedComments = comments.map((comment: any, index: number) => {
        const replies = comment.replies?.length || 0;
        const status = comment.resolved ? ' [RESOLVED]' : '';
        const author = comment.author?.displayName || 'Unknown';
        const date = comment.createdTime ? new Date(comment.createdTime).toLocaleDateString() : 'Unknown date';
        const quotedText = comment.quotedFileContent?.value || 'No quoted text';
        const anchor = quotedText !== 'No quoted text' ? ` (anchored to: "${quotedText.substring(0, 100)}${quotedText.length > 100 ? '...' : ''}")` : '';

        let result = `${index + 1}. ${author} (${date})${status}${anchor}\n   ${comment.content}`;

        if (replies > 0) {
          result += `\n   └─ ${replies} ${replies === 1 ? 'reply' : 'replies'}`;
        }

        result += `\n   Comment ID: ${comment.id}`;
        return result;
      }).join('\n\n');

      let text = `Found ${comments.length} comment${comments.length === 1 ? '' : 's'}:\n\n${formattedComments}`;
      if (nextPageToken) {
        text += `\n\nMore comments available. Use pageToken: "${nextPageToken}" to fetch the next page.`;
      }

      return {
        content: [{ type: "text", text }],
        isError: false
      };
    }

    case "getComment": {
      const validation = GetCommentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const response = await ctx.getDrive().comments.get({
        fileId: a.documentId,
        commentId: a.commentId,
        fields: 'id,content,quotedFileContent,author,createdTime,resolved,replies(id,content,author,createdTime)'
      });

      const comment = response.data;
      const author = comment.author?.displayName || 'Unknown';
      const date = comment.createdTime ? new Date(comment.createdTime).toLocaleDateString() : 'Unknown date';
      const status = comment.resolved ? ' [RESOLVED]' : '';
      const quotedText = comment.quotedFileContent?.value || 'No quoted text';
      const anchor = quotedText !== 'No quoted text' ? `\nAnchored to: "${quotedText}"` : '';

      let result = `${author} (${date})${status}${anchor}\n${comment.content}`;

      if (comment.replies && comment.replies.length > 0) {
        result += '\n\nReplies:';
        comment.replies.forEach((reply: any, index: number) => {
          const replyAuthor = reply.author?.displayName || 'Unknown';
          const replyDate = reply.createdTime ? new Date(reply.createdTime).toLocaleDateString() : 'Unknown date';
          result += `\n${index + 1}. ${replyAuthor} (${replyDate})\n   ${reply.content}`;
        });
      }

      return {
        content: [{ type: "text", text: result }],
        isError: false
      };
    }

    case "addComment": {
      const validation = AddCommentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      if (a.endIndex <= a.startIndex) {
        return errorResponse("endIndex must be greater than startIndex");
      }

      // Get the document to extract quoted text
      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      const doc = await docs.documents.get({ documentId: a.documentId });

      // Extract quoted text from the range
      let quotedText = '';
      const content = doc.data.body?.content || [];
      for (const element of content) {
        if (element.paragraph?.elements) {
          for (const textElement of element.paragraph.elements) {
            if (textElement.textRun) {
              const elementStart = textElement.startIndex || 0;
              const elementEnd = textElement.endIndex || 0;

              if (elementEnd > a.startIndex && elementStart < a.endIndex) {
                const text = textElement.textRun.content || '';
                const startOffset = Math.max(0, a.startIndex - elementStart);
                const endOffset = Math.min(text.length, a.endIndex - elementStart);
                quotedText += text.substring(startOffset, endOffset);
              }
            }
          }
        }
      }

      const response = await ctx.getDrive().comments.create({
        fileId: a.documentId,
        fields: 'id,content,quotedFileContent,author,createdTime',
        requestBody: {
          content: a.commentText,
          quotedFileContent: {
            value: quotedText,
            mimeType: 'text/html'
          },
          // Reverse-engineered anchor format for positioning comments.
          // Not part of the public Drive API -- may break if Google changes internals.
          // See: https://stackoverflow.com/questions/51789168
          anchor: JSON.stringify({
            r: a.documentId,
            a: [{
              txt: {
                o: a.startIndex - 1,  // Drive API uses 0-based indexing
                l: a.endIndex - a.startIndex,
                ml: a.endIndex - a.startIndex
              }
            }]
          })
        }
      });

      return {
        content: [{ type: "text", text: `Comment added successfully. Comment ID: ${response.data.id}` }],
        isError: false
      };
    }

    case "replyToComment": {
      const validation = ReplyToCommentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const response = await ctx.getDrive().replies.create({
        fileId: a.documentId,
        commentId: a.commentId,
        fields: 'id,content,author,createdTime',
        requestBody: {
          content: a.replyText
        }
      });

      return {
        content: [{ type: "text", text: `Reply added successfully. Reply ID: ${response.data.id}` }],
        isError: false
      };
    }

    case "deleteComment": {
      const validation = DeleteCommentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      await ctx.getDrive().comments.delete({
        fileId: a.documentId,
        commentId: a.commentId
      });

      return {
        content: [{ type: "text", text: `Comment ${a.commentId} has been deleted.` }],
        isError: false
      };
    }

    // =========================================================================
    // TABLE & MEDIA TOOLS
    // =========================================================================

    case "insertTable": {
      const validation = InsertTableSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const request_body = {
        insertTable: {
          location: { index: a.index },
          rows: a.rows,
          columns: a.columns
        }
      };

      await executeBatchUpdate(ctx, a.documentId, [request_body]);

      return {
        content: [{ type: "text", text: `Successfully inserted ${a.rows}x${a.columns} table at index ${a.index}` }],
        isError: false
      };
    }

    case "editTableCell": {
      const validation = EditTableCellSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      // Get the document to find the table structure
      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });

      const docRes = await docs.documents.get({
        documentId: a.documentId,
        fields: 'body(content)'
      });

      // Find the table at the specified start index
      let table: any = null;
      const findTable = (content: any[]) => {
        for (const elem of content) {
          if (elem.table && elem.startIndex === a.tableStartIndex) {
            table = elem.table;
            return;
          }
        }
      };

      if (docRes.data.body?.content) {
        findTable(docRes.data.body.content);
      }

      if (!table) {
        return errorResponse(`No table found at index ${a.tableStartIndex}`);
      }

      // Get the cell
      const row = table.tableRows?.[a.rowIndex];
      if (!row) {
        return errorResponse(`Row ${a.rowIndex} not found in table`);
      }

      const cell = row.tableCells?.[a.columnIndex];
      if (!cell) {
        return errorResponse(`Column ${a.columnIndex} not found in row ${a.rowIndex}`);
      }

      // Get cell content range
      const cellStartIndex = cell.startIndex;
      const cellEndIndex = cell.endIndex;

      const requests: any[] = [];

      // If textContent is provided, delete existing content and insert new
      if (a.textContent !== undefined) {
        // Delete existing content (keeping the paragraph structure)
        const cellContentStart = cellStartIndex + 1; // Skip the cell start marker
        const cellContentEnd = cellEndIndex - 1; // Before cell end marker

        if (cellContentEnd > cellContentStart) {
          requests.push({
            deleteContentRange: {
              range: { startIndex: cellContentStart, endIndex: cellContentEnd }
            }
          });
        }

        // Insert new text
        if (a.textContent.length > 0) {
          requests.push({
            insertText: {
              location: { index: cellContentStart },
              text: a.textContent
            }
          });
        }
      }

      // Apply text styling if any style options provided
      if (a.bold !== undefined || a.italic !== undefined || a.fontSize !== undefined) {
        const textStyle: any = {};
        const fields: string[] = [];

        if (a.bold !== undefined) { textStyle.bold = a.bold; fields.push('bold'); }
        if (a.italic !== undefined) { textStyle.italic = a.italic; fields.push('italic'); }
        if (a.fontSize !== undefined) { textStyle.fontSize = { magnitude: a.fontSize, unit: 'PT' }; fields.push('fontSize'); }

        if (fields.length > 0) {
          // Apply to the cell content range
          const styleStart = cellStartIndex + 1;
          const styleEnd = a.textContent !== undefined
            ? styleStart + a.textContent.length
            : cellEndIndex - 1;

          requests.push({
            updateTextStyle: {
              range: { startIndex: styleStart, endIndex: styleEnd },
              textStyle,
              fields: fields.join(',')
            }
          });
        }
      }

      // Apply paragraph alignment if provided
      if (a.alignment !== undefined) {
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: cellStartIndex + 1, endIndex: cellEndIndex - 1 },
            paragraphStyle: { alignment: a.alignment },
            fields: 'alignment'
          }
        });
      }

      if (requests.length === 0) {
        return errorResponse("No changes specified for the table cell");
      }

      await executeBatchUpdate(ctx, a.documentId, requests);

      return {
        content: [{ type: "text", text: `Successfully edited cell at row ${a.rowIndex}, column ${a.columnIndex}` }],
        isError: false
      };
    }

    case "insertImageFromUrl": {
      const validation = InsertImageFromUrlSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      await insertInlineImageHelper(ctx, a.documentId, a.imageUrl, a.index, a.width, a.height);

      return {
        content: [{ type: "text", text: `Successfully inserted image from URL at index ${a.index}` }],
        isError: false
      };
    }

    case "insertLocalImage": {
      const validation = InsertLocalImageSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      // Get the document's parent folder if uploadToSameFolder is true
      let parentFolderId: string | undefined;
      if (a.uploadToSameFolder !== false) {
        const fileInfo = await ctx.getDrive().files.get({
          fileId: a.documentId,
          fields: 'parents',
          supportsAllDrives: true
        });
        parentFolderId = fileInfo.data.parents?.[0];
      }

      // Upload the image to Drive
      const imageUrl = await uploadImageToDriveHelper(ctx, a.localImagePath, parentFolderId, a.makePublic);

      // Insert the image into the document
      await insertInlineImageHelper(ctx, a.documentId, imageUrl, a.index, a.width, a.height);

      return {
        content: [{ type: "text", text: `Successfully uploaded and inserted local image at index ${a.index}\nImage URL: ${imageUrl}` }],
        isError: false
      };
    }

    // =========================================================================
    // GOOGLE DOCS DISCOVERY & MANAGEMENT TOOLS
    // =========================================================================

    case "listGoogleDocs": {
      const validation = ListGoogleDocsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      // Build the query string for Google Drive API
      let queryString = "mimeType='application/vnd.google-apps.document' and trashed=false";
      if (a.query) {
        const escapedQuery = escapeDriveQuery(a.query);
        queryString += ` and (name contains '${escapedQuery}' or fullText contains '${escapedQuery}')`;
      }

      const response = await ctx.getDrive().files.list({
        q: queryString,
        pageSize: a.maxResults,
        orderBy: a.orderBy === 'name' ? 'name' : a.orderBy,
        fields: 'files(id,name,modifiedTime,createdTime,size,webViewLink,owners(displayName,emailAddress))',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      const files = response.data.files || [];

      if (files.length === 0) {
        return { content: [{ type: "text", text: "No Google Docs found matching your criteria." }], isError: false };
      }

      let result = `Found ${files.length} Google Document(s):\n\n`;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const modifiedDate = file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString() : 'Unknown';
        const owner = file.owners?.[0]?.displayName || 'Unknown';
        result += `${i + 1}. **${file.name}**\n`;
        result += `   ID: ${file.id}\n`;
        result += `   Modified: ${modifiedDate}\n`;
        result += `   Owner: ${owner}\n`;
        result += `   Link: ${file.webViewLink}\n\n`;
      }

      return { content: [{ type: "text", text: result }], isError: false };
    }

    case "getDocumentInfo": {
      const validation = GetDocumentInfoSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const response = await ctx.getDrive().files.get({
        fileId: a.documentId,
        fields: 'id,name,description,mimeType,size,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),shared,parents,version',
      });

      const file = response.data;

      if (!file) {
        return errorResponse(`Document with ID ${a.documentId} not found.`);
      }

      const createdDate = file.createdTime ? new Date(file.createdTime).toLocaleString() : 'Unknown';
      const modifiedDate = file.modifiedTime ? new Date(file.modifiedTime).toLocaleString() : 'Unknown';
      const owner = file.owners?.[0];
      const lastModifier = (file as any).lastModifyingUser;

      let result = `**Document Information:**\n\n`;
      result += `**Name:** ${file.name}\n`;
      result += `**ID:** ${file.id}\n`;
      result += `**Type:** Google Document\n`;
      result += `**Created:** ${createdDate}\n`;
      result += `**Last Modified:** ${modifiedDate}\n`;

      if (owner) {
        result += `**Owner:** ${owner.displayName} (${owner.emailAddress})\n`;
      }

      if (lastModifier) {
        result += `**Last Modified By:** ${lastModifier.displayName} (${lastModifier.emailAddress})\n`;
      }

      if (file.description) {
        result += `**Description:** ${file.description}\n`;
      }

      result += `**Shared:** ${file.shared ? 'Yes' : 'No'}\n`;
      result += `**Version:** ${file.version || 'Unknown'}\n`;
      result += `**View Link:** ${file.webViewLink}\n`;

      return { content: [{ type: "text", text: result }], isError: false };
    }

    case "addDocumentTab": {
      const validation = AddDocumentTabSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: { requests: [{ createTab: { tabProperties: { title: a.title } } } as any] as any }
      });

      return { content: [{ type: 'text', text: `Requested creation of tab "${a.title}" in document ${a.documentId}.` }], isError: false };
    }

    case "renameDocumentTab": {
      const validation = RenameDocumentTabSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: { requests: [{ updateTabProperties: { tabId: a.tabId, tabProperties: { title: a.title }, fields: 'title' } } as any] as any }
      });

      return { content: [{ type: 'text', text: `Renamed tab ${a.tabId} to "${a.title}".` }], isError: false };
    }

    case "insertSmartChip": {
      const validation = InsertSmartChipSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      const smartChip: any = a.chipType === 'person'
        ? { personProperties: { email: a.personEmail } }
        : a.chipType === 'date'
          ? { dateProperties: { dateString: a.date } }
          : { richLinkProperties: { uri: `https://drive.google.com/file/d/${a.fileId}/view` } };

      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: { requests: [{ insertInlineObject: { location: { index: a.index }, inlineObject: { embeddedObject: smartChip } } } as any] as any }
      });

      return { content: [{ type: 'text', text: `Inserted ${a.chipType} smart chip at index ${a.index}.` }], isError: false };
    }

    case "readSmartChips": {
      const validation = ReadSmartChipsSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      const doc = await docs.documents.get({ documentId: a.documentId });
      const body = (doc.data as any).body?.content || [];
      const hits: string[] = [];
      for (const block of body) {
        for (const el of block?.paragraph?.elements || []) {
          if (el?.richLink) hits.push(`richLink: ${el.richLink.richLinkProperties?.uri || 'unknown'}`);
          if (el?.person) hits.push(`person: ${el.person.personProperties?.email || 'unknown'}`);
        }
      }
      return { content: [{ type: 'text', text: hits.length ? hits.join('\n') : 'No smart chips detected.' }], isError: false };
    }

    default:
      return null;
  }
}
