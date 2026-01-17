#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import type { drive_v3 } from "googleapis";
import { v4 as uuidv4 } from 'uuid';
import { authenticate, runAuthCommand, AuthServer, initializeOAuth2Client } from './auth.js';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';

// Drive service - will be created with auth when needed
let drive: any = null;

// Calendar service - will be created with auth when needed
let calendar: any = null;

// Helper to ensure drive service has current auth
function ensureDriveService() {
  if (!authClient) {
    throw new Error('Authentication required');
  }
  
  // Log detailed auth client info
  log('About to create drive service', {
    authClientType: authClient?.constructor?.name,
    hasCredentials: !!authClient.credentials,
    credentialsKeys: authClient.credentials ? Object.keys(authClient.credentials) : [],
    accessTokenLength: authClient.credentials?.access_token?.length,
    accessTokenPrefix: authClient.credentials?.access_token?.substring(0, 20),
    expiryDate: authClient.credentials?.expiry_date,
    isExpired: authClient.credentials?.expiry_date ? Date.now() > authClient.credentials.expiry_date : 'no expiry'
  });
  
  // Create drive service with auth parameter directly
  drive = google.drive({ version: 'v3', auth: authClient });
  
  log('Drive service created/updated', {
    hasAuth: !!authClient,
    hasCredentials: !!authClient.credentials,
    hasAccessToken: !!authClient.credentials?.access_token
  });
  
  // Test the auth by making a simple API call
  drive.about.get({ fields: 'user' })
    .then((response: any) => {
      log('Auth test successful, user:', response.data.user?.emailAddress);
    })
    .catch((error: any) => {
      log('Auth test failed:', error.message || error);
      if (error.response) {
        log('Auth test error details:', {
          status: error.response.status,
          statusText: error.response.statusText,
          headers: error.response.headers,
          data: error.response.data
        });
      }
    });
}

// Helper to ensure calendar service has current auth
function ensureCalendarService() {
  if (!authClient) {
    throw new Error('Authentication required');
  }
  calendar = google.calendar({ version: 'v3', auth: authClient });
  log('Calendar service created/updated');
}

// -----------------------------------------------------------------------------
// CONSTANTS & CONFIG
// -----------------------------------------------------------------------------
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const TEXT_MIME_TYPES = {
  txt: 'text/plain',
  md: 'text/markdown'
};
// Global auth client - will be initialized on first use
let authClient: any = null;
let authenticationPromise: Promise<any> | null = null;

// Get package version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const VERSION = packageJson.version;

// -----------------------------------------------------------------------------
// LOGGING UTILITY
// -----------------------------------------------------------------------------
function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = data
    ? `[${timestamp}] ${message}: ${JSON.stringify(data)}`
    : `[${timestamp}] ${message}`;
  console.error(logMessage);
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------
function getExtensionFromFilename(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || '';
}

function getMimeTypeFromFilename(filename: string): string {
  const ext = getExtensionFromFilename(filename);
  return TEXT_MIME_TYPES[ext as keyof typeof TEXT_MIME_TYPES] || 'text/plain';
}



/**
 * Resolve a slash-delimited path (e.g. "/some/folder") within Google Drive
 * into a folder ID. Creates folders if they don't exist.
 */
async function resolvePath(pathStr: string): Promise<string> {
  if (!pathStr || pathStr === '/') return 'root';

  // Note: This function is called after ensureAuthenticated, so drive should exist
  const parts = pathStr.replace(/^\/+|\/+$/g, '').split('/');
  let currentFolderId: string = 'root';

  for (const part of parts) {
    if (!part) continue;
    let response = await drive.files.list({
      q: `'${currentFolderId}' in parents and name = '${part}' and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`,
      fields: 'files(id)',
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    });

    // If the folder segment doesn't exist, create it
    if (!response.data.files?.length) {
      const folderMetadata = {
        name: part,
        mimeType: FOLDER_MIME_TYPE,
        parents: [currentFolderId]
      };
      const folder = await drive.files.create({
        requestBody: folderMetadata,
        fields: 'id',
        supportsAllDrives: true
      });

      if (!folder.data.id) {
        throw new Error(`Failed to create intermediate folder: ${part}`);
      }

      currentFolderId = folder.data.id;
    } else {
      // Folder exists, proceed deeper
      currentFolderId = response.data.files[0].id!;
    }
  }

  return currentFolderId;
}


/**
 * Resolve a folder ID or path.
 * If it's a path (starts with '/'), resolve it.
 * If no folder is provided, return 'root'.
 */
async function resolveFolderId(input: string | undefined): Promise<string> {
  if (!input) return 'root';

  if (input.startsWith('/')) {
    // Input is a path
    return resolvePath(input);
  } else {
    // Input is a folder ID, return as-is
    return input;
  }
}

/**
 * For text-based files, ensure they have a valid extension.
 */
function validateTextFileExtension(name: string) {
  const ext = getExtensionFromFilename(name);
  if (!['txt', 'md'].includes(ext)) {
    throw new Error("File name must end with .txt or .md for text files.");
  }
}

/**
 * Convert A1 notation to GridRange for Google Sheets API
 */
function convertA1ToGridRange(a1Notation: string, sheetId: number): any {
  // Regular expression to match A1 notation like "A1", "B2:D5", "A:A", "1:1"
  const rangeRegex = /^([A-Z]*)([0-9]*)(:([A-Z]*)([0-9]*))?$/;
  const match = a1Notation.match(rangeRegex);
  
  if (!match) {
    throw new Error(`Invalid A1 notation: ${a1Notation}`);
  }
  
  const [, startCol, startRow, , endCol, endRow] = match;
  
  const gridRange: any = { sheetId };
  
  // Convert column letters to numbers (A=0, B=1, etc.)
  const colToNum = (col: string): number => {
    let num = 0;
    for (let i = 0; i < col.length; i++) {
      num = num * 26 + (col.charCodeAt(i) - 'A'.charCodeAt(0) + 1);
    }
    return num - 1;
  };
  
  // Set start indices
  if (startCol) gridRange.startColumnIndex = colToNum(startCol);
  if (startRow) gridRange.startRowIndex = parseInt(startRow) - 1;
  
  // Set end indices (exclusive)
  if (endCol) {
    gridRange.endColumnIndex = colToNum(endCol) + 1;
  } else if (startCol && !endCol) {
    gridRange.endColumnIndex = gridRange.startColumnIndex + 1;
  }
  
  if (endRow) {
    gridRange.endRowIndex = parseInt(endRow);
  } else if (startRow && !endRow) {
    gridRange.endRowIndex = gridRange.startRowIndex + 1;
  }
  
  return gridRange;
}

/**
 * Check if a file with the given name already exists in the specified folder.
 * Returns the file ID if it exists, null otherwise.
 */
async function checkFileExists(name: string, parentFolderId: string = 'root'): Promise<string | null> {
  try {
    const escapedName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const query = `name = '${escapedName}' and '${parentFolderId}' in parents and trashed = false`;
    
    const res = await drive.files.list({
      q: query,
      fields: 'files(id, name, mimeType)',
      pageSize: 1,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    });
    
    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0].id || null;
    }
    return null;
  } catch (error) {
    log('Error checking file existence:', error);
    return null;
  }
}

// -----------------------------------------------------------------------------
// GOOGLE DOCS HELPER FUNCTIONS
// -----------------------------------------------------------------------------

// Helper function for hex color validation and conversion
const hexColorRegex = /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
function validateHexColor(color: string): boolean {
  return hexColorRegex.test(color);
}

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

// Execute batch update for Google Docs
async function executeBatchUpdate(documentId: string, requests: any[]): Promise<any> {
  if (!requests || requests.length === 0) {
    return {};
  }

  await ensureAuthenticated();
  const docs = google.docs({ version: 'v1', auth: authClient });

  try {
    const response = await docs.documents.batchUpdate({
      documentId: documentId,
      requestBody: { requests },
    });
    return response.data;
  } catch (error: any) {
    log('Google Docs batchUpdate error:', error.message);
    if (error.code === 404) throw new Error(`Document not found (ID: ${documentId})`);
    if (error.code === 403) throw new Error(`Permission denied for document (ID: ${documentId})`);
    throw new Error(`Google Docs API Error: ${error.message}`);
  }
}

// Find text in a document and return the range indices
async function findTextRange(documentId: string, textToFind: string, instance: number = 1): Promise<{ startIndex: number; endIndex: number } | null> {
  await ensureAuthenticated();
  const docs = google.docs({ version: 'v1', auth: authClient });

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
    log('Error finding text in document:', error.message);
    if (error.code === 404) throw new Error(`Document not found (ID: ${documentId})`);
    throw new Error(`Failed to search document: ${error.message}`);
  }
}

// Get paragraph range containing a specific index
async function getParagraphRange(documentId: string, indexWithin: number): Promise<{ startIndex: number; endIndex: number } | null> {
  await ensureAuthenticated();
  const docs = google.docs({ version: 'v1', auth: authClient });

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
    log('Error getting paragraph range:', error.message);
    throw new Error(`Failed to find paragraph: ${error.message}`);
  }
}

// Build text style update request
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

// Build paragraph style update request
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

// -----------------------------------------------------------------------------
// TABLE & MEDIA HELPER FUNCTIONS
// -----------------------------------------------------------------------------

// Insert an inline image from a URL
async function insertInlineImageHelper(
  documentId: string,
  imageUrl: string,
  index: number,
  width?: number,
  height?: number
): Promise<any> {
  // Validate URL format
  try {
    new URL(imageUrl);
  } catch (e) {
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

  return executeBatchUpdate(documentId, [request]);
}

// Upload a local image to Drive and return its URL
async function uploadImageToDriveHelper(
  localFilePath: string,
  parentFolderId?: string
): Promise<string> {
  const fs = await import('fs');
  const path = await import('path');

  // Verify file exists
  if (!fs.existsSync(localFilePath)) {
    throw new Error(`Image file not found: ${localFilePath}`);
  }

  // Get file name and mime type
  const fileName = path.basename(localFilePath);
  const mimeTypeMap: { [key: string]: string } = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
  };

  const ext = path.extname(localFilePath).toLowerCase();
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
    body: fs.createReadStream(localFilePath)
  };

  const uploadResponse = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id,webViewLink,webContentLink'
  });

  const fileId = uploadResponse.data.id;
  if (!fileId) {
    throw new Error('Failed to upload image to Drive - no file ID returned');
  }

  // Make the file publicly readable
  await drive.permissions.create({
    fileId: fileId,
    requestBody: {
      role: 'reader',
      type: 'anyone'
    }
  });

  // Get the webContentLink
  const fileInfo = await drive.files.get({
    fileId: fileId,
    fields: 'webContentLink'
  });

  const webContentLink = fileInfo.data.webContentLink;
  if (!webContentLink) {
    throw new Error('Failed to get public URL for uploaded image');
  }

  return webContentLink;
}

// -----------------------------------------------------------------------------
// CALENDAR HELPER FUNCTIONS
// -----------------------------------------------------------------------------

interface CalendarEventInfo {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
  meetingLink?: string;
  attendees?: { email: string; displayName?: string; responseStatus?: string }[];
  organizer?: { email?: string; displayName?: string };
  recurrence?: string[];
  created?: string;
  updated?: string;
}

function formatCalendarEvent(event: any): CalendarEventInfo {
  const result: CalendarEventInfo = {
    id: event.id || '',
    summary: event.summary,
    description: event.description,
    location: event.location,
    status: event.status,
    htmlLink: event.htmlLink,
    created: event.created,
    updated: event.updated,
  };

  if (event.start) {
    result.start = {
      dateTime: event.start.dateTime,
      date: event.start.date,
      timeZone: event.start.timeZone,
    };
  }

  if (event.end) {
    result.end = {
      dateTime: event.end.dateTime,
      date: event.end.date,
      timeZone: event.end.timeZone,
    };
  }

  if (event.hangoutLink) {
    result.hangoutLink = event.hangoutLink;
  }

  if (event.conferenceData?.entryPoints) {
    const videoEntry = event.conferenceData.entryPoints.find((ep: any) => ep.entryPointType === 'video');
    if (videoEntry?.uri) {
      result.meetingLink = videoEntry.uri;
    }
  }

  if (event.attendees) {
    result.attendees = event.attendees.map((a: any) => ({
      email: a.email || '',
      displayName: a.displayName,
      responseStatus: a.responseStatus,
    }));
  }

  if (event.organizer) {
    result.organizer = {
      email: event.organizer.email,
      displayName: event.organizer.displayName,
    };
  }

  if (event.recurrence) {
    result.recurrence = event.recurrence;
  }

  return result;
}

function formatEventForDisplay(event: CalendarEventInfo): string {
  const lines: string[] = [];
  lines.push(`**${event.summary || '(No title)'}**`);

  if (event.start) {
    const startStr = event.start.dateTime || event.start.date || '';
    const endStr = event.end?.dateTime || event.end?.date || '';
    if (event.start.date) {
      // All-day event
      lines.push(`Date: ${startStr}${endStr && endStr !== startStr ? ` - ${endStr}` : ''}`);
    } else {
      lines.push(`Time: ${startStr} - ${endStr}`);
    }
  }

  if (event.location) lines.push(`Location: ${event.location}`);
  if (event.description) lines.push(`Description: ${event.description}`);
  if (event.hangoutLink || event.meetingLink) {
    lines.push(`Meeting: ${event.meetingLink || event.hangoutLink}`);
  }
  if (event.attendees && event.attendees.length > 0) {
    lines.push(`Attendees: ${event.attendees.map(a => a.email).join(', ')}`);
  }
  if (event.htmlLink) lines.push(`Link: ${event.htmlLink}`);
  lines.push(`Event ID: ${event.id}`);

  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// INPUT VALIDATION SCHEMAS
// -----------------------------------------------------------------------------
const SearchSchema = z.object({
  query: z.string().min(1, "Search query is required"),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional()
});

const CreateTextFileSchema = z.object({
  name: z.string().min(1, "File name is required"),
  content: z.string(),
  parentFolderId: z.string().optional()
});

const UpdateTextFileSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  content: z.string(),
  name: z.string().optional()
});

const CreateFolderSchema = z.object({
  name: z.string().min(1, "Folder name is required"),
  parent: z.string().optional()
});

const ListFolderSchema = z.object({
  folderId: z.string().optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional()
});

const DeleteItemSchema = z.object({
  itemId: z.string().min(1, "Item ID is required")
});

const RenameItemSchema = z.object({
  itemId: z.string().min(1, "Item ID is required"),
  newName: z.string().min(1, "New name is required")
});

const MoveItemSchema = z.object({
  itemId: z.string().min(1, "Item ID is required"),
  destinationFolderId: z.string().optional()
});

const CreateGoogleDocSchema = z.object({
  name: z.string().min(1, "Document name is required"),
  content: z.string(),
  parentFolderId: z.string().optional()
});

const UpdateGoogleDocSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  content: z.string()
});

const CreateGoogleSheetSchema = z.object({
  name: z.string().min(1, "Sheet name is required"),
  data: z.array(z.array(z.string())),
  parentFolderId: z.string().optional()
});

const UpdateGoogleSheetSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  range: z.string().min(1, "Range is required"),
  data: z.array(z.array(z.string()))
});

const GetGoogleSheetContentSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  range: z.string().min(1, "Range is required")
});

const FormatGoogleSheetCellsSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  range: z.string().min(1, "Range is required"),
  backgroundColor: z.object({
    red: z.number().min(0).max(1).optional(),
    green: z.number().min(0).max(1).optional(),
    blue: z.number().min(0).max(1).optional()
  }).optional(),
  horizontalAlignment: z.enum(["LEFT", "CENTER", "RIGHT"]).optional(),
  verticalAlignment: z.enum(["TOP", "MIDDLE", "BOTTOM"]).optional(),
  wrapStrategy: z.enum(["OVERFLOW_CELL", "CLIP", "WRAP"]).optional()
});

const FormatGoogleSheetTextSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  range: z.string().min(1, "Range is required"),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  underline: z.boolean().optional(),
  fontSize: z.number().min(1).optional(),
  fontFamily: z.string().optional(),
  foregroundColor: z.object({
    red: z.number().min(0).max(1).optional(),
    green: z.number().min(0).max(1).optional(),
    blue: z.number().min(0).max(1).optional()
  }).optional()
});

const FormatGoogleSheetNumbersSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  range: z.string().min(1, "Range is required"),
  pattern: z.string().min(1, "Pattern is required"),
  type: z.enum(["NUMBER", "CURRENCY", "PERCENT", "DATE", "TIME", "DATE_TIME", "SCIENTIFIC"]).optional()
});

const SetGoogleSheetBordersSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  range: z.string().min(1, "Range is required"),
  style: z.enum(["SOLID", "DASHED", "DOTTED", "DOUBLE"]),
  width: z.number().min(1).max(3).optional(),
  color: z.object({
    red: z.number().min(0).max(1).optional(),
    green: z.number().min(0).max(1).optional(),
    blue: z.number().min(0).max(1).optional()
  }).optional(),
  top: z.boolean().optional(),
  bottom: z.boolean().optional(),
  left: z.boolean().optional(),
  right: z.boolean().optional(),
  innerHorizontal: z.boolean().optional(),
  innerVertical: z.boolean().optional()
});

const MergeGoogleSheetCellsSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  range: z.string().min(1, "Range is required"),
  mergeType: z.enum(["MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS"])
});

const AddGoogleSheetConditionalFormatSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  range: z.string().min(1, "Range is required"),
  condition: z.object({
    type: z.enum(["NUMBER_GREATER", "NUMBER_LESS", "TEXT_CONTAINS", "TEXT_STARTS_WITH", "TEXT_ENDS_WITH", "CUSTOM_FORMULA"]),
    value: z.string()
  }),
  format: z.object({
    backgroundColor: z.object({
      red: z.number().min(0).max(1).optional(),
      green: z.number().min(0).max(1).optional(),
      blue: z.number().min(0).max(1).optional()
    }).optional(),
    textFormat: z.object({
      bold: z.boolean().optional(),
      foregroundColor: z.object({
        red: z.number().min(0).max(1).optional(),
        green: z.number().min(0).max(1).optional(),
        blue: z.number().min(0).max(1).optional()
      }).optional()
    }).optional()
  })
});

// Phase 2: Additional Sheets tools
const GetSpreadsheetInfoSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required")
});

const AppendSpreadsheetRowsSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  range: z.string().min(1, "Range is required"),
  values: z.array(z.array(z.any())),
  valueInputOption: z.enum(["RAW", "USER_ENTERED"]).optional().default("USER_ENTERED")
});

const AddSpreadsheetSheetSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  sheetTitle: z.string().min(1, "Sheet title is required")
});

const ListGoogleSheetsSchema = z.object({
  maxResults: z.number().int().min(1).max(100).optional().default(20),
  query: z.string().optional(),
  orderBy: z.enum(["name", "modifiedTime", "createdTime"]).optional().default("modifiedTime")
});

const CopyFileSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  newName: z.string().optional(),
  parentFolderId: z.string().optional()
});

const CreateGoogleSlidesSchema = z.object({
  name: z.string().min(1, "Presentation name is required"),
  slides: z.array(z.object({
    title: z.string(),
    content: z.string()
  })).min(1, "At least one slide is required"),
  parentFolderId: z.string().optional()
});

const UpdateGoogleSlidesSchema = z.object({
  presentationId: z.string().min(1, "Presentation ID is required"),
  slides: z.array(z.object({
    title: z.string(),
    content: z.string()
  })).min(1, "At least one slide is required")
});

const FormatGoogleDocTextSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  startIndex: z.number().min(1, "Start index must be at least 1"),
  endIndex: z.number().min(1, "End index must be at least 1"),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  fontSize: z.number().optional(),
  foregroundColor: z.object({
    red: z.number().min(0).max(1).optional(),
    green: z.number().min(0).max(1).optional(),
    blue: z.number().min(0).max(1).optional()
  }).optional()
});

const FormatGoogleDocParagraphSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  startIndex: z.number().min(1, "Start index must be at least 1"),
  endIndex: z.number().min(1, "End index must be at least 1"),
  namedStyleType: z.enum(['NORMAL_TEXT', 'TITLE', 'SUBTITLE', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6']).optional(),
  alignment: z.enum(['START', 'CENTER', 'END', 'JUSTIFIED']).optional(),
  lineSpacing: z.number().optional(),
  spaceAbove: z.number().optional(),
  spaceBelow: z.number().optional()
});

const GetGoogleDocContentSchema = z.object({
  documentId: z.string().min(1, "Document ID is required")
});

// Google Slides Formatting Schemas
const GetGoogleSlidesContentSchema = z.object({
  presentationId: z.string().min(1, "Presentation ID is required"),
  slideIndex: z.number().min(0).optional()
});

const FormatGoogleSlidesTextSchema = z.object({
  presentationId: z.string().min(1, "Presentation ID is required"),
  objectId: z.string().min(1, "Object ID is required"),
  startIndex: z.number().min(0).optional(),
  endIndex: z.number().min(0).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  fontSize: z.number().optional(),
  fontFamily: z.string().optional(),
  foregroundColor: z.object({
    red: z.number().min(0).max(1).optional(),
    green: z.number().min(0).max(1).optional(),
    blue: z.number().min(0).max(1).optional()
  }).optional()
});

const FormatGoogleSlidesParagraphSchema = z.object({
  presentationId: z.string().min(1, "Presentation ID is required"),
  objectId: z.string().min(1, "Object ID is required"),
  alignment: z.enum(['START', 'CENTER', 'END', 'JUSTIFIED']).optional(),
  lineSpacing: z.number().optional(),
  bulletStyle: z.enum(['NONE', 'DISC', 'ARROW', 'SQUARE', 'DIAMOND', 'STAR', 'NUMBERED']).optional()
});

const StyleGoogleSlidesShapeSchema = z.object({
  presentationId: z.string().min(1, "Presentation ID is required"),
  objectId: z.string().min(1, "Shape object ID is required"),
  backgroundColor: z.object({
    red: z.number().min(0).max(1).optional(),
    green: z.number().min(0).max(1).optional(),
    blue: z.number().min(0).max(1).optional(),
    alpha: z.number().min(0).max(1).optional()
  }).optional(),
  outlineColor: z.object({
    red: z.number().min(0).max(1).optional(),
    green: z.number().min(0).max(1).optional(),
    blue: z.number().min(0).max(1).optional()
  }).optional(),
  outlineWeight: z.number().optional(),
  outlineDashStyle: z.enum(['SOLID', 'DOT', 'DASH', 'DASH_DOT', 'LONG_DASH', 'LONG_DASH_DOT']).optional()
});

const SetGoogleSlidesBackgroundSchema = z.object({
  presentationId: z.string().min(1, "Presentation ID is required"),
  pageObjectIds: z.array(z.string()).min(1, "At least one page object ID is required"),
  backgroundColor: z.object({
    red: z.number().min(0).max(1).optional(),
    green: z.number().min(0).max(1).optional(),
    blue: z.number().min(0).max(1).optional(),
    alpha: z.number().min(0).max(1).optional()
  })
});

const CreateGoogleSlidesTextBoxSchema = z.object({
  presentationId: z.string().min(1, "Presentation ID is required"),
  pageObjectId: z.string().min(1, "Page object ID is required"),
  text: z.string().min(1, "Text content is required"),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  fontSize: z.number().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional()
});

const CreateGoogleSlidesShapeSchema = z.object({
  presentationId: z.string().min(1, "Presentation ID is required"),
  pageObjectId: z.string().min(1, "Page object ID is required"),
  shapeType: z.enum(['RECTANGLE', 'ELLIPSE', 'DIAMOND', 'TRIANGLE', 'STAR', 'ROUND_RECTANGLE', 'ARROW']),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  backgroundColor: z.object({
    red: z.number().min(0).max(1).optional(),
    green: z.number().min(0).max(1).optional(),
    blue: z.number().min(0).max(1).optional(),
    alpha: z.number().min(0).max(1).optional()
  }).optional()
});

// --- New Doc Editing Schemas ---
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
  maxLength: z.number().int().min(1).optional()
});

const ListDocumentTabsSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  includeContent: z.boolean().optional().default(false)
});

// Enhanced text/paragraph style schemas with text-find targeting
const ApplyTextStyleSchema = z.object({
  documentId: z.string().min(1, "Document ID is required"),
  // Flat targeting - use EITHER indices OR text-find (not nested union)
  startIndex: z.number().int().min(1).optional(),
  endIndex: z.number().int().min(1).optional(),
  textToFind: z.string().min(1).optional(),
  matchInstance: z.number().int().min(1).optional().default(1),
  // Style options
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
  // Flat targeting - use EITHER indices OR text-find OR indexWithinParagraph
  startIndex: z.number().int().min(1).optional(),
  endIndex: z.number().int().min(1).optional(),
  textToFind: z.string().min(1).optional(),
  matchInstance: z.number().int().min(1).optional().default(1),
  indexWithinParagraph: z.number().int().min(1).optional(),
  // Style options
  alignment: z.enum(['START', 'END', 'CENTER', 'JUSTIFIED']).optional(),
  indentStart: z.number().min(0).optional(),
  indentEnd: z.number().min(0).optional(),
  spaceAbove: z.number().min(0).optional(),
  spaceBelow: z.number().min(0).optional(),
  namedStyleType: z.enum(['NORMAL_TEXT', 'TITLE', 'SUBTITLE', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6']).optional(),
  keepWithNext: z.boolean().optional()
});

// Comment tool schemas
const ListCommentsSchema = z.object({
  documentId: z.string().min(1, "Document ID is required")
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

// --- Calendar Schemas ---
const ListCalendarsSchema = z.object({
  showHidden: z.boolean().optional().default(false).describe("Include hidden calendars")
});

const GetCalendarEventsSchema = z.object({
  calendarId: z.string().optional().default("primary").describe("Calendar ID (default: primary)"),
  timeMin: z.string().optional().describe("Start of time range (RFC3339, e.g., '2024-01-01T00:00:00Z')"),
  timeMax: z.string().optional().describe("End of time range (RFC3339)"),
  query: z.string().optional().describe("Free text search in events"),
  maxResults: z.number().int().min(1).max(250).optional().default(50).describe("Maximum events to return (1-250)"),
  singleEvents: z.boolean().optional().default(true).describe("Expand recurring events into instances"),
  orderBy: z.enum(["startTime", "updated"]).optional().default("startTime").describe("Sort order")
});

const GetCalendarEventSchema = z.object({
  eventId: z.string().min(1, "Event ID is required"),
  calendarId: z.string().optional().default("primary").describe("Calendar ID (default: primary)")
});

const CreateCalendarEventSchema = z.object({
  summary: z.string().min(1, "Event title is required"),
  calendarId: z.string().optional().default("primary").describe("Calendar ID (default: primary)"),
  description: z.string().optional().describe("Event description"),
  location: z.string().optional().describe("Event location"),
  start: z.object({
    dateTime: z.string().optional().describe("RFC3339 timestamp for timed events"),
    date: z.string().optional().describe("Date for all-day events (YYYY-MM-DD)"),
    timeZone: z.string().optional().describe("Time zone (e.g., 'America/Los_Angeles')")
  }).describe("Start time"),
  end: z.object({
    dateTime: z.string().optional().describe("RFC3339 timestamp for timed events"),
    date: z.string().optional().describe("Date for all-day events (YYYY-MM-DD)"),
    timeZone: z.string().optional().describe("Time zone (e.g., 'America/Los_Angeles')")
  }).describe("End time"),
  attendees: z.array(z.string()).optional().describe("Email addresses of attendees"),
  sendUpdates: z.enum(["all", "externalOnly", "none"]).optional().default("all").describe("Send notifications to attendees"),
  conferenceType: z.enum(["hangoutsMeet"]).optional().describe("Add Google Meet link"),
  recurrence: z.array(z.string()).optional().describe("RRULE strings for recurring events"),
  visibility: z.enum(["default", "public", "private", "confidential"]).optional().describe("Event visibility")
});

const UpdateCalendarEventSchema = z.object({
  eventId: z.string().min(1, "Event ID is required"),
  calendarId: z.string().optional().default("primary").describe("Calendar ID (default: primary)"),
  summary: z.string().optional().describe("New event title"),
  description: z.string().optional().describe("New event description"),
  location: z.string().optional().describe("New event location"),
  start: z.object({
    dateTime: z.string().optional(),
    date: z.string().optional(),
    timeZone: z.string().optional()
  }).optional().describe("New start time"),
  end: z.object({
    dateTime: z.string().optional(),
    date: z.string().optional(),
    timeZone: z.string().optional()
  }).optional().describe("New end time"),
  attendees: z.array(z.string()).optional().describe("Updated attendee emails (replaces existing)"),
  sendUpdates: z.enum(["all", "externalOnly", "none"]).optional().default("all").describe("Send notifications about the update")
});

const DeleteCalendarEventSchema = z.object({
  eventId: z.string().min(1, "Event ID is required"),
  calendarId: z.string().optional().default("primary").describe("Calendar ID (default: primary)"),
  sendUpdates: z.enum(["all", "externalOnly", "none"]).optional().default("all").describe("Send cancellation notifications to attendees")
});

// --- Table & Media Schemas ---
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
  uploadToSameFolder: z.boolean().optional().default(true).describe("Upload to same folder as document")
});

// Google Docs Discovery & Management Schemas
const ListGoogleDocsSchema = z.object({
  maxResults: z.number().int().min(1).max(100).optional().default(20).describe("Maximum number of documents to return (1-100)."),
  query: z.string().optional().describe("Search query to filter documents by name or content."),
  orderBy: z.enum(["name", "modifiedTime", "createdTime"]).optional().default("modifiedTime").describe("Sort order for results.")
});

const GetDocumentInfoSchema = z.object({
  documentId: z.string().min(1, "Document ID is required")
});

// -----------------------------------------------------------------------------
// SERVER SETUP
// -----------------------------------------------------------------------------
const server = new Server(
  {
    name: "google-drive-mcp",
    version: VERSION,
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

// -----------------------------------------------------------------------------
// AUTHENTICATION HELPER
// -----------------------------------------------------------------------------
async function ensureAuthenticated() {
  if (!authClient) {
    // If authentication is already in progress, wait for it
    if (authenticationPromise) {
      log('Authentication already in progress, waiting...');
      authClient = await authenticationPromise;
      return;
    }
    
    log('Initializing authentication');
    // Store the promise to prevent concurrent authentication attempts
    authenticationPromise = authenticate();
    
    try {
      authClient = await authenticationPromise;
      log('Authentication complete', {
        authClientType: authClient?.constructor?.name,
        hasCredentials: !!authClient?.credentials,
        hasAccessToken: !!authClient?.credentials?.access_token
      });
      // Ensure drive and calendar services are created with auth
      ensureDriveService();
      ensureCalendarService();
    } finally {
      // Clear the promise after completion (success or failure)
      authenticationPromise = null;
    }
  }

  // If we already have authClient, ensure services are up to date
  ensureDriveService();
  ensureCalendarService();
}

// -----------------------------------------------------------------------------
// MCP REQUEST HANDLERS
// -----------------------------------------------------------------------------

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  await ensureAuthenticated();
  log('Handling ListResources request', { params: request.params });
  const pageSize = 10;
  const params: {
    pageSize: number,
    fields: string,
    pageToken?: string,
    q: string,
    includeItemsFromAllDrives: boolean,
    supportsAllDrives: boolean
  } = {
    pageSize,
    fields: "nextPageToken, files(id, name, mimeType)",
    q: `trashed = false`,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true
  };

  if (request.params?.cursor) {
    params.pageToken = request.params.cursor;
  }

  const res = await drive.files.list(params);
  log('Listed files', { count: res.data.files?.length });
  const files = res.data.files || [];

  return {
    resources: files.map((file: drive_v3.Schema$File) => ({
      uri: `gdrive:///${file.id}`,
      mimeType: file.mimeType || 'application/octet-stream',
      name: file.name || 'Untitled',
    })),
    nextCursor: res.data.nextPageToken,
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  await ensureAuthenticated();
  log('Handling ReadResource request', { uri: request.params.uri });
  const fileId = request.params.uri.replace("gdrive:///", "");

  const file = await drive.files.get({
    fileId,
    fields: "mimeType",
    supportsAllDrives: true
  });
  const mimeType = file.data.mimeType;

  if (!mimeType) {
    throw new Error("File has no MIME type.");
  }

  if (mimeType.startsWith("application/vnd.google-apps")) {
    // Export logic for Google Docs/Sheets/Slides
    let exportMimeType;
    switch (mimeType) {
      case "application/vnd.google-apps.document": exportMimeType = "text/markdown"; break;
      case "application/vnd.google-apps.spreadsheet": exportMimeType = "text/csv"; break;
      case "application/vnd.google-apps.presentation": exportMimeType = "text/plain"; break;
      case "application/vnd.google-apps.drawing": exportMimeType = "image/png"; break;
      default: exportMimeType = "text/plain"; break;
    }

    const res = await drive.files.export(
      { fileId, mimeType: exportMimeType, supportsAllDrives: true },
      { responseType: "text" },
    );

    log('Successfully read resource', { fileId, mimeType });
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: exportMimeType,
          text: res.data,
        },
      ],
    };
  } else {
    // Regular file download
    const res = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    const contentMime = mimeType || "application/octet-stream";

    if (contentMime.startsWith("text/") || contentMime === "application/json") {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: contentMime,
            text: Buffer.from(res.data as ArrayBuffer).toString("utf-8"),
          },
        ],
      };
    } else {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: contentMime,
            blob: Buffer.from(res.data as ArrayBuffer).toString("base64"),
          },
        ],
      };
    }
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search",
        description: "Search for files in Google Drive",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            pageSize: { type: "number", description: "Results per page (default 50, max 100)" },
            pageToken: { type: "string", description: "Token for next page of results" }
          },
          required: ["query"],
        },
      },
      {
        name: "createTextFile",
        description: "Create a new text or markdown file",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "File name (.txt or .md)" },
            content: { type: "string", description: "File content" },
            parentFolderId: { type: "string", description: "Optional parent folder ID", optional: true }
          },
          required: ["name", "content"]
        }
      },
      {
        name: "updateTextFile",
        description: "Update an existing text or markdown file",
        inputSchema: {
          type: "object",
          properties: {
            fileId: { type: "string", description: "ID of the file to update" },
            content: { type: "string", description: "New file content" },
            name: { type: "string", description: "Optional new name (.txt or .md)", optional: true }
          },
          required: ["fileId", "content"]
        }
      },
      {
        name: "createFolder",
        description: "Create a new folder in Google Drive",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Folder name" },
            parent: { type: "string", description: "Optional parent folder ID or path", optional: true }
          },
          required: ["name"]
        }
      },
      {
        name: "listFolder",
        description: "List contents of a folder (defaults to root)",
        inputSchema: {
          type: "object",
          properties: {
            folderId: { type: "string", description: "Folder ID", optional: true },
            pageSize: { type: "number", description: "Items to return (default 50, max 100)", optional: true },
            pageToken: { type: "string", description: "Token for next page", optional: true }
          }
        }
      },
      {
        name: "deleteItem",
        description: "Move a file or folder to trash (can be restored from Google Drive trash)",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "ID of the item to delete" }
          },
          required: ["itemId"]
        }
      },
      {
        name: "renameItem",
        description: "Rename a file or folder",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "ID of the item to rename" },
            newName: { type: "string", description: "New name" }
          },
          required: ["itemId", "newName"]
        }
      },
      {
        name: "moveItem",
        description: "Move a file or folder",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "ID of the item to move" },
            destinationFolderId: { type: "string", description: "Destination folder ID", optional: true }
          },
          required: ["itemId"]
        }
      },
      {
        name: "createGoogleDoc",
        description: "Create a new Google Doc",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Doc name" },
            content: { type: "string", description: "Doc content" },
            parentFolderId: { type: "string", description: "Parent folder ID", optional: true }
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
      // --- New Doc Editing Tools ---
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
        description: "Read content of a Google Doc with format options",
        inputSchema: {
          type: "object",
          properties: {
            documentId: { type: "string", description: "The document ID" },
            format: { type: "string", enum: ["text", "json", "markdown"], description: "Output format (default: text)" },
            maxLength: { type: "number", description: "Maximum characters to return" }
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
      // =========================================================================
      // COMMENT TOOLS (use Drive API v3)
      // =========================================================================
      {
        name: "listComments",
        description: "List all comments in a Google Document",
        inputSchema: {
          type: "object",
          properties: {
            documentId: { type: "string", description: "The document ID" }
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
      // =========================================================================
      // CALENDAR TOOLS
      // =========================================================================
      {
        name: "listCalendars",
        description: "List all accessible Google Calendars for the authenticated user",
        inputSchema: {
          type: "object",
          properties: {
            showHidden: { type: "boolean", description: "Include hidden calendars (default: false)" }
          }
        }
      },
      {
        name: "getCalendarEvents",
        description: "Get events from a Google Calendar with optional filtering",
        inputSchema: {
          type: "object",
          properties: {
            calendarId: { type: "string", description: "Calendar ID (default: primary)" },
            timeMin: { type: "string", description: "Start of time range (RFC3339, e.g., '2024-01-01T00:00:00Z')" },
            timeMax: { type: "string", description: "End of time range (RFC3339)" },
            query: { type: "string", description: "Free text search in events" },
            maxResults: { type: "number", description: "Maximum events to return (1-250, default: 50)" },
            singleEvents: { type: "boolean", description: "Expand recurring events into instances (default: true)" },
            orderBy: { type: "string", enum: ["startTime", "updated"], description: "Sort order (default: startTime)" }
          }
        }
      },
      {
        name: "getCalendarEvent",
        description: "Get a single calendar event by ID",
        inputSchema: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "The event ID to retrieve" },
            calendarId: { type: "string", description: "Calendar ID (default: primary)" }
          },
          required: ["eventId"]
        }
      },
      {
        name: "createCalendarEvent",
        description: "Create a new calendar event. Supports timed events, all-day events, and Google Meet integration.",
        inputSchema: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Event title" },
            calendarId: { type: "string", description: "Calendar ID (default: primary)" },
            description: { type: "string", description: "Event description" },
            location: { type: "string", description: "Event location" },
            start: {
              type: "object",
              description: "Start time (use dateTime for timed events, date for all-day)",
              properties: {
                dateTime: { type: "string", description: "RFC3339 timestamp (e.g., '2024-01-15T09:00:00-08:00')" },
                date: { type: "string", description: "Date for all-day events (YYYY-MM-DD)" },
                timeZone: { type: "string", description: "Time zone (e.g., 'America/Los_Angeles')" }
              }
            },
            end: {
              type: "object",
              description: "End time",
              properties: {
                dateTime: { type: "string" },
                date: { type: "string" },
                timeZone: { type: "string" }
              }
            },
            attendees: { type: "array", items: { type: "string" }, description: "Email addresses of attendees" },
            sendUpdates: { type: "string", enum: ["all", "externalOnly", "none"], description: "Send notifications (default: none)" },
            conferenceType: { type: "string", enum: ["hangoutsMeet"], description: "Add Google Meet link" },
            recurrence: { type: "array", items: { type: "string" }, description: "RRULE strings for recurring events" },
            visibility: { type: "string", enum: ["default", "public", "private", "confidential"], description: "Event visibility" }
          },
          required: ["summary", "start", "end"]
        }
      },
      {
        name: "updateCalendarEvent",
        description: "Update an existing calendar event",
        inputSchema: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "The event ID to update" },
            calendarId: { type: "string", description: "Calendar ID (default: primary)" },
            summary: { type: "string", description: "New event title" },
            description: { type: "string", description: "New event description" },
            location: { type: "string", description: "New event location" },
            start: {
              type: "object",
              properties: {
                dateTime: { type: "string" },
                date: { type: "string" },
                timeZone: { type: "string" }
              }
            },
            end: {
              type: "object",
              properties: {
                dateTime: { type: "string" },
                date: { type: "string" },
                timeZone: { type: "string" }
              }
            },
            attendees: { type: "array", items: { type: "string" }, description: "Updated attendee emails (replaces existing)" },
            sendUpdates: { type: "string", enum: ["all", "externalOnly", "none"], description: "Send notifications (default: none)" }
          },
          required: ["eventId"]
        }
      },
      {
        name: "deleteCalendarEvent",
        description: "Delete a calendar event",
        inputSchema: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "The event ID to delete" },
            calendarId: { type: "string", description: "Calendar ID (default: primary)" },
            sendUpdates: { type: "string", enum: ["all", "externalOnly", "none"], description: "Send cancellation notifications (default: none)" }
          },
          required: ["eventId"]
        }
      },
      // =========================================================================
      // TABLE & MEDIA TOOLS
      // =========================================================================
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
            uploadToSameFolder: { type: "boolean", description: "Upload to same folder as document (default: true)" }
          },
          required: ["documentId", "localImagePath", "index"]
        }
      },
      // Google Docs Discovery & Management Tools
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
        name: "createGoogleSheet",
        description: "Create a new Google Sheet",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Sheet name" },
            data: {
              type: "array",
              description: "Data as array of arrays",
              items: { type: "array", items: { type: "string" } }
            },
            parentFolderId: { type: "string", description: "Parent folder ID (defaults to root)", optional: true }
          },
          required: ["name", "data"]
        }
      },
      {
        name: "updateGoogleSheet",
        description: "Update an existing Google Sheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", description: "Sheet ID" },
            range: { type: "string", description: "Range to update" },
            data: {
              type: "array",
              items: { type: "array", items: { type: "string" } }
            }
          },
          required: ["spreadsheetId", "range", "data"]
        }
      },
      {
        name: "getGoogleSheetContent",
        description: "Get content of a Google Sheet with cell information",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", description: "Spreadsheet ID" },
            range: { type: "string", description: "Range to get (e.g., 'Sheet1!A1:C10')" }
          },
          required: ["spreadsheetId", "range"]
        }
      },
      {
        name: "formatGoogleSheetCells",
        description: "Format cells in a Google Sheet (background, borders, alignment)",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", description: "Spreadsheet ID" },
            range: { type: "string", description: "Range to format (e.g., 'A1:C10')" },
            backgroundColor: {
              type: "object",
              description: "Background color (RGB values 0-1)",
              properties: {
                red: { type: "number", optional: true },
                green: { type: "number", optional: true },
                blue: { type: "number", optional: true }
              },
              optional: true
            },
            horizontalAlignment: {
              type: "string",
              description: "Horizontal alignment",
              enum: ["LEFT", "CENTER", "RIGHT"],
              optional: true
            },
            verticalAlignment: {
              type: "string",
              description: "Vertical alignment",
              enum: ["TOP", "MIDDLE", "BOTTOM"],
              optional: true
            },
            wrapStrategy: {
              type: "string",
              description: "Text wrapping",
              enum: ["OVERFLOW_CELL", "CLIP", "WRAP"],
              optional: true
            }
          },
          required: ["spreadsheetId", "range"]
        }
      },
      {
        name: "formatGoogleSheetText",
        description: "Apply text formatting to cells in a Google Sheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", description: "Spreadsheet ID" },
            range: { type: "string", description: "Range to format (e.g., 'A1:C10')" },
            bold: { type: "boolean", description: "Make text bold", optional: true },
            italic: { type: "boolean", description: "Make text italic", optional: true },
            strikethrough: { type: "boolean", description: "Strikethrough text", optional: true },
            underline: { type: "boolean", description: "Underline text", optional: true },
            fontSize: { type: "number", description: "Font size in points", optional: true },
            fontFamily: { type: "string", description: "Font family name", optional: true },
            foregroundColor: {
              type: "object",
              description: "Text color (RGB values 0-1)",
              properties: {
                red: { type: "number", optional: true },
                green: { type: "number", optional: true },
                blue: { type: "number", optional: true }
              },
              optional: true
            }
          },
          required: ["spreadsheetId", "range"]
        }
      },
      {
        name: "formatGoogleSheetNumbers",
        description: "Apply number formatting to cells in a Google Sheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", description: "Spreadsheet ID" },
            range: { type: "string", description: "Range to format (e.g., 'A1:C10')" },
            pattern: {
              type: "string",
              description: "Number format pattern (e.g., '#,##0.00', 'yyyy-mm-dd', '$#,##0.00', '0.00%')"
            },
            type: {
              type: "string",
              description: "Format type",
              enum: ["NUMBER", "CURRENCY", "PERCENT", "DATE", "TIME", "DATE_TIME", "SCIENTIFIC"],
              optional: true
            }
          },
          required: ["spreadsheetId", "range", "pattern"]
        }
      },
      {
        name: "setGoogleSheetBorders",
        description: "Set borders for cells in a Google Sheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", description: "Spreadsheet ID" },
            range: { type: "string", description: "Range to format (e.g., 'A1:C10')" },
            style: {
              type: "string",
              description: "Border style",
              enum: ["SOLID", "DASHED", "DOTTED", "DOUBLE"]
            },
            width: { type: "number", description: "Border width (1-3)", optional: true },
            color: {
              type: "object",
              description: "Border color (RGB values 0-1)",
              properties: {
                red: { type: "number", optional: true },
                green: { type: "number", optional: true },
                blue: { type: "number", optional: true }
              },
              optional: true
            },
            top: { type: "boolean", description: "Apply to top border", optional: true },
            bottom: { type: "boolean", description: "Apply to bottom border", optional: true },
            left: { type: "boolean", description: "Apply to left border", optional: true },
            right: { type: "boolean", description: "Apply to right border", optional: true },
            innerHorizontal: { type: "boolean", description: "Apply to inner horizontal borders", optional: true },
            innerVertical: { type: "boolean", description: "Apply to inner vertical borders", optional: true }
          },
          required: ["spreadsheetId", "range", "style"]
        }
      },
      {
        name: "mergeGoogleSheetCells",
        description: "Merge cells in a Google Sheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", description: "Spreadsheet ID" },
            range: { type: "string", description: "Range to merge (e.g., 'A1:C3')" },
            mergeType: {
              type: "string",
              description: "Merge type",
              enum: ["MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS"]
            }
          },
          required: ["spreadsheetId", "range", "mergeType"]
        }
      },
      {
        name: "addGoogleSheetConditionalFormat",
        description: "Add conditional formatting to a Google Sheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", description: "Spreadsheet ID" },
            range: { type: "string", description: "Range to apply formatting (e.g., 'A1:C10')" },
            condition: {
              type: "object",
              description: "Condition configuration",
              properties: {
                type: {
                  type: "string",
                  description: "Condition type",
                  enum: ["NUMBER_GREATER", "NUMBER_LESS", "TEXT_CONTAINS", "TEXT_STARTS_WITH", "TEXT_ENDS_WITH", "CUSTOM_FORMULA"]
                },
                value: { type: "string", description: "Value to compare or formula" }
              }
            },
            format: {
              type: "object",
              description: "Format to apply when condition is true",
              properties: {
                backgroundColor: {
                  type: "object",
                  properties: {
                    red: { type: "number", optional: true },
                    green: { type: "number", optional: true },
                    blue: { type: "number", optional: true }
                  },
                  optional: true
                },
                textFormat: {
                  type: "object",
                  properties: {
                    bold: { type: "boolean", optional: true },
                    foregroundColor: {
                      type: "object",
                      properties: {
                        red: { type: "number", optional: true },
                        green: { type: "number", optional: true },
                        blue: { type: "number", optional: true }
                      },
                      optional: true
                    }
                  },
                  optional: true
                }
              }
            }
          },
          required: ["spreadsheetId", "range", "condition", "format"]
        }
      },
      // Phase 2: Additional Sheets tools
      {
        name: "getSpreadsheetInfo",
        description: "Gets detailed information about a Google Spreadsheet including all sheets/tabs",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", description: "The ID of the Google Spreadsheet (from the URL)" }
          },
          required: ["spreadsheetId"]
        }
      },
      {
        name: "appendSpreadsheetRows",
        description: "Appends rows of data to the end of a sheet in a Google Spreadsheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", description: "The ID of the Google Spreadsheet (from the URL)" },
            range: { type: "string", description: "A1 notation range indicating where to append (e.g., 'A1' or 'Sheet1!A1'). Data will be appended starting from this range." },
            values: { type: "array", description: "2D array of values to append. Each inner array represents a row.", items: { type: "array" } },
            valueInputOption: { type: "string", description: "How input data should be interpreted (RAW or USER_ENTERED)", enum: ["RAW", "USER_ENTERED"], default: "USER_ENTERED" }
          },
          required: ["spreadsheetId", "range", "values"]
        }
      },
      {
        name: "addSpreadsheetSheet",
        description: "Adds a new sheet/tab to an existing Google Spreadsheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", description: "The ID of the Google Spreadsheet (from the URL)" },
            sheetTitle: { type: "string", description: "Title for the new sheet/tab" }
          },
          required: ["spreadsheetId", "sheetTitle"]
        }
      },
      {
        name: "listGoogleSheets",
        description: "Lists Google Spreadsheets from your Google Drive with optional filtering",
        inputSchema: {
          type: "object",
          properties: {
            maxResults: { type: "number", description: "Maximum number of spreadsheets to return (1-100)", default: 20 },
            query: { type: "string", description: "Search query to filter spreadsheets by name or content" },
            orderBy: { type: "string", description: "Sort order for results", enum: ["name", "modifiedTime", "createdTime"], default: "modifiedTime" }
          },
          required: []
        }
      },
      {
        name: "copyFile",
        description: "Creates a copy of a Google Drive file or document",
        inputSchema: {
          type: "object",
          properties: {
            fileId: { type: "string", description: "ID of the file to copy" },
            newName: { type: "string", description: "Name for the copied file. If not provided, will use 'Copy of [original name]'" },
            parentFolderId: { type: "string", description: "ID of folder where copy should be placed. If not provided, places in same location as original." }
          },
          required: ["fileId"]
        }
      },
      {
        name: "createGoogleSlides",
        description: "Create a new Google Slides presentation",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Presentation name" },
            slides: {
              type: "array",
              description: "Array of slide objects",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  content: { type: "string" }
                }
              }
            },
            parentFolderId: { type: "string", description: "Parent folder ID (defaults to root)", optional: true }
          },
          required: ["name", "slides"]
        }
      },
      {
        name: "updateGoogleSlides",
        description: "Update an existing Google Slides presentation",
        inputSchema: {
          type: "object",
          properties: {
            presentationId: { type: "string", description: "Presentation ID" },
            slides: {
              type: "array",
              description: "Array of slide objects to replace existing slides",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  content: { type: "string" }
                }
              }
            }
          },
          required: ["presentationId", "slides"]
        }
      },
      {
        name: "formatGoogleDocText",
        description: "Apply text formatting to a range in a Google Doc",
        inputSchema: {
          type: "object",
          properties: {
            documentId: { type: "string", description: "Document ID" },
            startIndex: { type: "number", description: "Start index (1-based)" },
            endIndex: { type: "number", description: "End index (1-based)" },
            bold: { type: "boolean", description: "Make text bold", optional: true },
            italic: { type: "boolean", description: "Make text italic", optional: true },
            underline: { type: "boolean", description: "Underline text", optional: true },
            strikethrough: { type: "boolean", description: "Strikethrough text", optional: true },
            fontSize: { type: "number", description: "Font size in points", optional: true },
            foregroundColor: {
              type: "object",
              description: "Text color (RGB values 0-1)",
              properties: {
                red: { type: "number", optional: true },
                green: { type: "number", optional: true },
                blue: { type: "number", optional: true }
              },
              optional: true
            }
          },
          required: ["documentId", "startIndex", "endIndex"]
        }
      },
      {
        name: "formatGoogleDocParagraph",
        description: "Apply paragraph formatting to a range in a Google Doc",
        inputSchema: {
          type: "object",
          properties: {
            documentId: { type: "string", description: "Document ID" },
            startIndex: { type: "number", description: "Start index (1-based)" },
            endIndex: { type: "number", description: "End index (1-based)" },
            namedStyleType: {
              type: "string",
              description: "Paragraph style",
              enum: ["NORMAL_TEXT", "TITLE", "SUBTITLE", "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"],
              optional: true
            },
            alignment: {
              type: "string",
              description: "Text alignment",
              enum: ["START", "CENTER", "END", "JUSTIFIED"],
              optional: true
            },
            lineSpacing: { type: "number", description: "Line spacing multiplier", optional: true },
            spaceAbove: { type: "number", description: "Space above paragraph in points", optional: true },
            spaceBelow: { type: "number", description: "Space below paragraph in points", optional: true }
          },
          required: ["documentId", "startIndex", "endIndex"]
        }
      },
      {
        name: "getGoogleDocContent",
        description: "Get content of a Google Doc with text indices for formatting",
        inputSchema: {
          type: "object",
          properties: {
            documentId: { type: "string", description: "Document ID" }
          },
          required: ["documentId"]
        }
      },
      {
        name: "getGoogleSlidesContent",
        description: "Get content of Google Slides with element IDs for formatting",
        inputSchema: {
          type: "object",
          properties: {
            presentationId: { type: "string", description: "Presentation ID" },
            slideIndex: { type: "number", description: "Specific slide index (optional)", optional: true }
          },
          required: ["presentationId"]
        }
      },
      {
        name: "formatGoogleSlidesText",
        description: "Apply text formatting to elements in Google Slides",
        inputSchema: {
          type: "object",
          properties: {
            presentationId: { type: "string", description: "Presentation ID" },
            objectId: { type: "string", description: "Object ID of the text element" },
            startIndex: { type: "number", description: "Start index (0-based)", optional: true },
            endIndex: { type: "number", description: "End index (0-based)", optional: true },
            bold: { type: "boolean", description: "Make text bold", optional: true },
            italic: { type: "boolean", description: "Make text italic", optional: true },
            underline: { type: "boolean", description: "Underline text", optional: true },
            strikethrough: { type: "boolean", description: "Strikethrough text", optional: true },
            fontSize: { type: "number", description: "Font size in points", optional: true },
            fontFamily: { type: "string", description: "Font family name", optional: true },
            foregroundColor: {
              type: "object",
              description: "Text color (RGB values 0-1)",
              properties: {
                red: { type: "number", optional: true },
                green: { type: "number", optional: true },
                blue: { type: "number", optional: true }
              },
              optional: true
            }
          },
          required: ["presentationId", "objectId"]
        }
      },
      {
        name: "formatGoogleSlidesParagraph",
        description: "Apply paragraph formatting to text in Google Slides",
        inputSchema: {
          type: "object",
          properties: {
            presentationId: { type: "string", description: "Presentation ID" },
            objectId: { type: "string", description: "Object ID of the text element" },
            alignment: {
              type: "string",
              description: "Text alignment",
              enum: ["START", "CENTER", "END", "JUSTIFIED"],
              optional: true
            },
            lineSpacing: { type: "number", description: "Line spacing multiplier", optional: true },
            bulletStyle: {
              type: "string",
              description: "Bullet style",
              enum: ["NONE", "DISC", "ARROW", "SQUARE", "DIAMOND", "STAR", "NUMBERED"],
              optional: true
            }
          },
          required: ["presentationId", "objectId"]
        }
      },
      {
        name: "styleGoogleSlidesShape",
        description: "Style shapes in Google Slides",
        inputSchema: {
          type: "object",
          properties: {
            presentationId: { type: "string", description: "Presentation ID" },
            objectId: { type: "string", description: "Shape object ID" },
            backgroundColor: {
              type: "object",
              description: "Background color (RGBA values 0-1)",
              properties: {
                red: { type: "number", optional: true },
                green: { type: "number", optional: true },
                blue: { type: "number", optional: true },
                alpha: { type: "number", optional: true }
              },
              optional: true
            },
            outlineColor: {
              type: "object",
              description: "Outline color (RGB values 0-1)",
              properties: {
                red: { type: "number", optional: true },
                green: { type: "number", optional: true },
                blue: { type: "number", optional: true }
              },
              optional: true
            },
            outlineWeight: { type: "number", description: "Outline thickness in points", optional: true },
            outlineDashStyle: {
              type: "string",
              description: "Outline dash style",
              enum: ["SOLID", "DOT", "DASH", "DASH_DOT", "LONG_DASH", "LONG_DASH_DOT"],
              optional: true
            }
          },
          required: ["presentationId", "objectId"]
        }
      },
      {
        name: "setGoogleSlidesBackground",
        description: "Set background color for slides",
        inputSchema: {
          type: "object",
          properties: {
            presentationId: { type: "string", description: "Presentation ID" },
            pageObjectIds: {
              type: "array",
              description: "Array of slide IDs to update",
              items: { type: "string" }
            },
            backgroundColor: {
              type: "object",
              description: "Background color (RGBA values 0-1)",
              properties: {
                red: { type: "number", optional: true },
                green: { type: "number", optional: true },
                blue: { type: "number", optional: true },
                alpha: { type: "number", optional: true }
              }
            }
          },
          required: ["presentationId", "pageObjectIds", "backgroundColor"]
        }
      },
      {
        name: "createGoogleSlidesTextBox",
        description: "Create a text box in Google Slides",
        inputSchema: {
          type: "object",
          properties: {
            presentationId: { type: "string", description: "Presentation ID" },
            pageObjectId: { type: "string", description: "Slide ID" },
            text: { type: "string", description: "Text content" },
            x: { type: "number", description: "X position in EMU (1/360000 cm)" },
            y: { type: "number", description: "Y position in EMU" },
            width: { type: "number", description: "Width in EMU" },
            height: { type: "number", description: "Height in EMU" },
            fontSize: { type: "number", description: "Font size in points", optional: true },
            bold: { type: "boolean", description: "Make text bold", optional: true },
            italic: { type: "boolean", description: "Make text italic", optional: true }
          },
          required: ["presentationId", "pageObjectId", "text", "x", "y", "width", "height"]
        }
      },
      {
        name: "createGoogleSlidesShape",
        description: "Create a shape in Google Slides",
        inputSchema: {
          type: "object",
          properties: {
            presentationId: { type: "string", description: "Presentation ID" },
            pageObjectId: { type: "string", description: "Slide ID" },
            shapeType: {
              type: "string",
              description: "Shape type",
              enum: ["RECTANGLE", "ELLIPSE", "DIAMOND", "TRIANGLE", "STAR", "ROUND_RECTANGLE", "ARROW"]
            },
            x: { type: "number", description: "X position in EMU" },
            y: { type: "number", description: "Y position in EMU" },
            width: { type: "number", description: "Width in EMU" },
            height: { type: "number", description: "Height in EMU" },
            backgroundColor: {
              type: "object",
              description: "Fill color (RGBA values 0-1)",
              properties: {
                red: { type: "number", optional: true },
                green: { type: "number", optional: true },
                blue: { type: "number", optional: true },
                alpha: { type: "number", optional: true }
              },
              optional: true
            }
          },
          required: ["presentationId", "pageObjectId", "shapeType", "x", "y", "width", "height"]
        }
      }
    ]
  };
});

// -----------------------------------------------------------------------------
// TOOL CALL REQUEST HANDLER
// -----------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.error(`[DEBUG] CallTool handler called for tool: ${request.params.name}`);
  await ensureAuthenticated();
  console.error(`[DEBUG] After ensureAuthenticated - authClient exists: ${!!authClient}, drive exists: ${!!drive}`);
  log('Handling tool request', { tool: request.params.name });

  // Helper for error responses
  function errorResponse(message: string) {
    log('Error', { message });
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }

  try {
    switch (request.params.name) {
      case "search": {
        const validation = SearchSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const { query: userQuery, pageSize, pageToken } = validation.data;

        const escapedQuery = userQuery.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const formattedQuery = `fullText contains '${escapedQuery}' and trashed = false`;

        const res = await drive.files.list({
          q: formattedQuery,
          pageSize: Math.min(pageSize || 50, 100),
          pageToken: pageToken,
          fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size)",
          includeItemsFromAllDrives: true,
          supportsAllDrives: true
        });

        const fileList = res.data.files?.map((f: drive_v3.Schema$File) => `${f.name} (${f.mimeType})`).join("\n") || '';
        log('Search results', { query: userQuery, resultCount: res.data.files?.length });

        let response = `Found ${res.data.files?.length ?? 0} files:\n${fileList}`;
        if (res.data.nextPageToken) {
          response += `\n\nMore results available. Use pageToken: ${res.data.nextPageToken}`;
        }

        return {
          content: [{ type: "text", text: response }],
          isError: false,
        };
      }

      case "createTextFile": {
        const validation = CreateTextFileSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        validateTextFileExtension(args.name);
        const parentFolderId = await resolveFolderId(args.parentFolderId);

        // Check if file already exists
        const existingFileId = await checkFileExists(args.name, parentFolderId);
        if (existingFileId) {
          return errorResponse(
            `A file named "${args.name}" already exists in this location. ` +
            `To update it, use updateTextFile with fileId: ${existingFileId}`
          );
        }

        const fileMetadata = {
          name: args.name,
          mimeType: getMimeTypeFromFilename(args.name),
          parents: [parentFolderId]
        };

        log('About to create file', {
          driveExists: !!drive,
          authClientExists: !!authClient,
          hasAccessToken: !!authClient?.credentials?.access_token,
          tokenLength: authClient?.credentials?.access_token?.length
        });

        const file = await drive.files.create({
          requestBody: fileMetadata,
          media: {
            mimeType: fileMetadata.mimeType,
            body: args.content,
          },
          supportsAllDrives: true
        });

        log('File created successfully', { fileId: file.data?.id });
        return {
          content: [{
            type: "text",
            text: `Created file: ${file.data?.name || args.name}\nID: ${file.data?.id || 'unknown'}`
          }],
          isError: false
        };
      }

      case "updateTextFile": {
        const validation = UpdateTextFileSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        // Check file MIME type
        const existingFile = await drive.files.get({
          fileId: args.fileId,
          fields: 'mimeType, name, parents',
          supportsAllDrives: true
        });

        const currentMimeType = existingFile.data.mimeType || 'text/plain';
        if (!Object.values(TEXT_MIME_TYPES).includes(currentMimeType)) {
          return errorResponse("File is not a text or markdown file.");
        }

        const updateMetadata: { name?: string; mimeType?: string } = {};
        if (args.name) {
          validateTextFileExtension(args.name);
          updateMetadata.name = args.name;
          updateMetadata.mimeType = getMimeTypeFromFilename(args.name);
        }

        const updatedFile = await drive.files.update({
          fileId: args.fileId,
          requestBody: updateMetadata,
          media: {
            mimeType: updateMetadata.mimeType || currentMimeType,
            body: args.content
          },
          fields: 'id, name, modifiedTime, webViewLink',
          supportsAllDrives: true
        });

        return {
          content: [{
            type: "text",
            text: `Updated file: ${updatedFile.data.name}\nModified: ${updatedFile.data.modifiedTime}`
          }],
          isError: false
        };
      }

      case "createFolder": {
        const validation = CreateFolderSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const parentFolderId = await resolveFolderId(args.parent);

        // Check if folder already exists
        const existingFolderId = await checkFileExists(args.name, parentFolderId);
        if (existingFolderId) {
          return errorResponse(
            `A folder named "${args.name}" already exists in this location. ` +
            `Folder ID: ${existingFolderId}`
          );
        }
        const folderMetadata = {
          name: args.name,
          mimeType: FOLDER_MIME_TYPE,
          parents: [parentFolderId]
        };

        const folder = await drive.files.create({
          requestBody: folderMetadata,
          fields: 'id, name, webViewLink',
          supportsAllDrives: true
        });

        log('Folder created successfully', { folderId: folder.data.id, name: folder.data.name });

        return {
          content: [{
            type: "text",
            text: `Created folder: ${folder.data.name}\nID: ${folder.data.id}`
          }],
          isError: false
        };
      }

      case "listFolder": {
        const validation = ListFolderSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        // Default to root if no folder specified
        const targetFolderId = args.folderId || 'root';

        const res = await drive.files.list({
          q: `'${targetFolderId}' in parents and trashed = false`,
          pageSize: Math.min(args.pageSize || 50, 100),
          pageToken: args.pageToken,
          fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size)",
          orderBy: "name",
          includeItemsFromAllDrives: true,
          supportsAllDrives: true
        });

        const files = res.data.files || [];
        const formattedFiles = files.map((file: drive_v3.Schema$File) => {
          const isFolder = file.mimeType === FOLDER_MIME_TYPE;
          return `${isFolder ? '📁' : '📄'} ${file.name} (ID: ${file.id})`;
        }).join('\n');

        let response = `Contents of folder:\n\n${formattedFiles}`;
        if (res.data.nextPageToken) {
          response += `\n\nMore items available. Use pageToken: ${res.data.nextPageToken}`;
        }

        return {
          content: [{ type: "text", text: response }],
          isError: false
        };
      }

      case "deleteItem": {
        const validation = DeleteItemSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const item = await drive.files.get({ fileId: args.itemId, fields: 'name', supportsAllDrives: true });
        
        // Move to trash instead of permanent deletion
        await drive.files.update({
          fileId: args.itemId,
          requestBody: {
            trashed: true
          },
          supportsAllDrives: true
        });

        log('Item moved to trash successfully', { itemId: args.itemId, name: item.data.name });
        return {
          content: [{ type: "text", text: `Successfully moved to trash: ${item.data.name}` }],
          isError: false
        };
      }

      case "renameItem": {
        const validation = RenameItemSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        // If it's a text file, check extension
        const item = await drive.files.get({ fileId: args.itemId, fields: 'name, mimeType', supportsAllDrives: true });
        if (Object.values(TEXT_MIME_TYPES).includes(item.data.mimeType || '')) {
          validateTextFileExtension(args.newName);
        }

        const updatedItem = await drive.files.update({
          fileId: args.itemId,
          requestBody: { name: args.newName },
          fields: 'id, name, modifiedTime',
          supportsAllDrives: true
        });

        return {
          content: [{
            type: "text",
            text: `Successfully renamed "${item.data.name}" to "${updatedItem.data.name}"`
          }],
          isError: false
        };
      }

      case "moveItem": {
        const validation = MoveItemSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const destinationFolderId = args.destinationFolderId ?
          await resolveFolderId(args.destinationFolderId) :
          'root';

        // Check we aren't moving a folder into itself or its descendant
        if (args.destinationFolderId === args.itemId) {
          return errorResponse("Cannot move a folder into itself.");
        }

        const item = await drive.files.get({ fileId: args.itemId, fields: 'name, parents', supportsAllDrives: true });

        // Perform move
        await drive.files.update({
          fileId: args.itemId,
          addParents: destinationFolderId,
          removeParents: item.data.parents?.join(',') || '',
          fields: 'id, name, parents',
          supportsAllDrives: true
        });

        // Get the destination folder name for a nice response
        const destinationFolder = await drive.files.get({
          fileId: destinationFolderId,
          fields: 'name',
          supportsAllDrives: true
        });

        return {
          content: [{
            type: "text",
            text: `Successfully moved "${item.data.name}" to "${destinationFolder.data.name}"`
          }],
          isError: false
        };
      }

      case "createGoogleDoc": {
        const validation = CreateGoogleDocSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const parentFolderId = await resolveFolderId(args.parentFolderId);

        // Check if document already exists
        const existingFileId = await checkFileExists(args.name, parentFolderId);
        if (existingFileId) {
          return errorResponse(
            `A document named "${args.name}" already exists in this location. ` +
            `To update it, use updateGoogleDoc with documentId: ${existingFileId}`
          );
        }

        log('Creating Google Doc', { 
          authClientExists: !!authClient, 
          parentFolderId,
          authClientType: authClient?.constructor?.name,
          accessToken: authClient?.credentials?.access_token ? 'present' : 'missing',
          tokenLength: authClient?.credentials?.access_token?.length
        });

        // Debug: Try to get current user to verify auth
        try {
          const aboutResponse = await drive.about.get({ fields: 'user' });
          log('Auth verification - current user:', aboutResponse.data.user?.emailAddress);
        } catch (authError) {
          log('Auth verification failed:', authError instanceof Error ? authError.message : String(authError));
        }

        // Create empty doc
        let docResponse;
        try {
          docResponse = await drive.files.create({
            requestBody: {
              name: args.name,
              mimeType: 'application/vnd.google-apps.document',
              parents: [parentFolderId]
            },
            fields: 'id, name, webViewLink',
            supportsAllDrives: true
          });
        } catch (createError: any) {
          log('Drive files.create error details:', {
            message: createError.message,
            code: createError.code,
            errors: createError.errors,
            status: createError.status
          });
          throw createError;
        }
        const doc = docResponse.data;

        const docs = google.docs({ version: 'v1', auth: authClient });
        await docs.documents.batchUpdate({
          documentId: doc.id!,
          requestBody: {
            requests: [
              {
                insertText: { location: { index: 1 }, text: args.content }
              },
              // Ensure the text is formatted as normal text, not as a header
              {
                updateParagraphStyle: {
                  range: {
                    startIndex: 1,
                    endIndex: args.content.length + 1
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
        const validation = UpdateGoogleDocSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const docs = google.docs({ version: 'v1', auth: authClient });
        const document = await docs.documents.get({ documentId: args.documentId });

        // Delete all content
        // End index of last piece of content (body's last element, fallback to 1 if none)
        const endIndex = document.data.body?.content?.[document.data.body.content.length - 1]?.endIndex || 1;
        
        // Google Docs API doesn't allow deleting the final newline character
        // We need to leave at least one character in the document
        const deleteEndIndex = Math.max(1, endIndex - 1);

        if (deleteEndIndex > 1) {
          await docs.documents.batchUpdate({
            documentId: args.documentId,
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
          documentId: args.documentId,
          requestBody: {
            requests: [
              {
                insertText: { location: { index: 1 }, text: args.content }
              },
              // Ensure the text is formatted as normal text, not as a header
              {
                updateParagraphStyle: {
                  range: {
                    startIndex: 1,
                    endIndex: args.content.length + 1
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

      case "createGoogleSheet": {
        const validation = CreateGoogleSheetSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const parentFolderId = await resolveFolderId(args.parentFolderId);

        // Check if spreadsheet already exists
        const existingFileId = await checkFileExists(args.name, parentFolderId);
        if (existingFileId) {
          return errorResponse(
            `A spreadsheet named "${args.name}" already exists in this location. ` +
            `To update it, use updateGoogleSheet with spreadsheetId: ${existingFileId}`
          );
        }
        const sheets = google.sheets({ version: 'v4', auth: authClient });
        
        // Create spreadsheet with initial sheet
        const spreadsheet = await sheets.spreadsheets.create({
          requestBody: { 
            properties: { title: args.name },
            sheets: [{
              properties: {
                sheetId: 0,
                title: 'Sheet1',
                gridProperties: {
                  rowCount: Math.max(args.data.length, 1000),
                  columnCount: Math.max(args.data[0]?.length || 0, 26)
                }
              }
            }]
          }
        });

        await drive.files.update({
          fileId: spreadsheet.data.spreadsheetId || '',
          addParents: parentFolderId,
          removeParents: 'root',
          fields: 'id, name, webViewLink',
          supportsAllDrives: true
        });

        // Now update with data
        await sheets.spreadsheets.values.update({
          spreadsheetId: spreadsheet.data.spreadsheetId!,
          range: 'Sheet1!A1',
          valueInputOption: 'RAW',
          requestBody: { values: args.data }
        });

        return {
          content: [{ type: "text", text: `Created Google Sheet: ${args.name}\nID: ${spreadsheet.data.spreadsheetId}` }],
          isError: false
        };
      }

      case "updateGoogleSheet": {
        const validation = UpdateGoogleSheetSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const sheets = google.sheets({ version: 'v4', auth: authClient });
        await sheets.spreadsheets.values.update({
          spreadsheetId: args.spreadsheetId,
          range: args.range,
          valueInputOption: 'RAW',
          requestBody: { values: args.data }
        });

        return {
          content: [{ type: "text", text: `Updated Google Sheet range: ${args.range}` }],
          isError: false
        };
      }

      case "getGoogleSheetContent": {
        const validation = GetGoogleSheetContentSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const sheets = google.sheets({ version: 'v4', auth: authClient });
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: args.spreadsheetId,
          range: args.range
        });

        const values = response.data.values || [];
        let content = `Content for range ${args.range}:\n\n`;
        
        if (values.length === 0) {
          content += "(empty range)";
        } else {
          values.forEach((row, rowIndex) => {
            content += `Row ${rowIndex + 1}: ${row.join(', ')}\n`;
          });
        }

        return {
          content: [{ type: "text", text: content }],
          isError: false
        };
      }

      case "formatGoogleSheetCells": {
        const validation = FormatGoogleSheetCellsSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const sheets = google.sheets({ version: 'v4', auth: authClient });
        
        // Parse the range to get sheet ID and grid range
        const rangeData = await sheets.spreadsheets.get({
          spreadsheetId: args.spreadsheetId,
          ranges: [args.range],
          fields: 'sheets(properties(sheetId,title))'
        });

        console.error(`[DEBUG] formatGoogleSheetCells - range: ${args.range}`);
        console.error(`[DEBUG] rangeData.data:`, JSON.stringify(rangeData.data, null, 2));
        
        const sheetName = args.range.includes('!') ? args.range.split('!')[0] : 'Sheet1';
        console.error(`[DEBUG] Calculated sheetName: "${sheetName}"`);
        
        const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
        console.error(`[DEBUG] Found sheet:`, sheet ? JSON.stringify(sheet, null, 2) : 'null');
        
        if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
          console.error(`[DEBUG] Available sheets:`, rangeData.data.sheets?.map(s => s.properties?.title).join(', '));
          return errorResponse(`Sheet "${sheetName}" not found`);
        }

        // Parse A1 notation to grid range
        const a1Range = args.range.includes('!') ? args.range.split('!')[1] : args.range;
        const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

        const requests: any[] = [{
          repeatCell: {
            range: gridRange,
            cell: {
              userEnteredFormat: {
                ...(args.backgroundColor && {
                  backgroundColor: {
                    red: args.backgroundColor.red || 0,
                    green: args.backgroundColor.green || 0,
                    blue: args.backgroundColor.blue || 0
                  }
                }),
                ...(args.horizontalAlignment && { horizontalAlignment: args.horizontalAlignment }),
                ...(args.verticalAlignment && { verticalAlignment: args.verticalAlignment }),
                ...(args.wrapStrategy && { wrapStrategy: args.wrapStrategy })
              }
            },
            fields: [
              args.backgroundColor && 'userEnteredFormat.backgroundColor',
              args.horizontalAlignment && 'userEnteredFormat.horizontalAlignment',
              args.verticalAlignment && 'userEnteredFormat.verticalAlignment',
              args.wrapStrategy && 'userEnteredFormat.wrapStrategy'
            ].filter(Boolean).join(',')
          }
        }];

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: args.spreadsheetId,
          requestBody: { requests }
        });

        return {
          content: [{ type: "text", text: `Formatted cells in range ${args.range}` }],
          isError: false
        };
      }

      case "formatGoogleSheetText": {
        const validation = FormatGoogleSheetTextSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const sheets = google.sheets({ version: 'v4', auth: authClient });
        
        // Get sheet information
        const rangeData = await sheets.spreadsheets.get({
          spreadsheetId: args.spreadsheetId,
          ranges: [args.range],
          fields: 'sheets(properties(sheetId,title))'
        });

        const sheetName = args.range.includes('!') ? args.range.split('!')[0] : 'Sheet1';
        const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
        if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
          return errorResponse(`Sheet "${sheetName}" not found`);
        }

        const a1Range = args.range.includes('!') ? args.range.split('!')[1] : args.range;
        const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

        const textFormat: any = {};
        const fields: string[] = [];

        if (args.bold !== undefined) {
          textFormat.bold = args.bold;
          fields.push('bold');
        }
        if (args.italic !== undefined) {
          textFormat.italic = args.italic;
          fields.push('italic');
        }
        if (args.strikethrough !== undefined) {
          textFormat.strikethrough = args.strikethrough;
          fields.push('strikethrough');
        }
        if (args.underline !== undefined) {
          textFormat.underline = args.underline;
          fields.push('underline');
        }
        if (args.fontSize !== undefined) {
          textFormat.fontSize = args.fontSize;
          fields.push('fontSize');
        }
        if (args.fontFamily !== undefined) {
          textFormat.fontFamily = args.fontFamily;
          fields.push('fontFamily');
        }
        if (args.foregroundColor) {
          textFormat.foregroundColor = {
            red: args.foregroundColor.red || 0,
            green: args.foregroundColor.green || 0,
            blue: args.foregroundColor.blue || 0
          };
          fields.push('foregroundColor');
        }

        const requests = [{
          repeatCell: {
            range: gridRange,
            cell: {
              userEnteredFormat: { textFormat }
            },
            fields: 'userEnteredFormat.textFormat(' + fields.join(',') + ')'
          }
        }];

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: args.spreadsheetId,
          requestBody: { requests }
        });

        return {
          content: [{ type: "text", text: `Applied text formatting to range ${args.range}` }],
          isError: false
        };
      }

      case "formatGoogleSheetNumbers": {
        const validation = FormatGoogleSheetNumbersSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const sheets = google.sheets({ version: 'v4', auth: authClient });
        
        const rangeData = await sheets.spreadsheets.get({
          spreadsheetId: args.spreadsheetId,
          ranges: [args.range],
          fields: 'sheets(properties(sheetId,title))'
        });

        const sheetName = args.range.includes('!') ? args.range.split('!')[0] : 'Sheet1';
        const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
        if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
          return errorResponse(`Sheet "${sheetName}" not found`);
        }

        const a1Range = args.range.includes('!') ? args.range.split('!')[1] : args.range;
        const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

        const numberFormat: any = {
          pattern: args.pattern
        };
        if (args.type) {
          numberFormat.type = args.type;
        }

        const requests = [{
          repeatCell: {
            range: gridRange,
            cell: {
              userEnteredFormat: { numberFormat }
            },
            fields: 'userEnteredFormat.numberFormat'
          }
        }];

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: args.spreadsheetId,
          requestBody: { requests }
        });

        return {
          content: [{ type: "text", text: `Applied number formatting to range ${args.range}` }],
          isError: false
        };
      }

      case "setGoogleSheetBorders": {
        const validation = SetGoogleSheetBordersSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const sheets = google.sheets({ version: 'v4', auth: authClient });
        
        const rangeData = await sheets.spreadsheets.get({
          spreadsheetId: args.spreadsheetId,
          ranges: [args.range],
          fields: 'sheets(properties(sheetId,title))'
        });

        const sheetName = args.range.includes('!') ? args.range.split('!')[0] : 'Sheet1';
        const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
        if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
          return errorResponse(`Sheet "${sheetName}" not found`);
        }

        const a1Range = args.range.includes('!') ? args.range.split('!')[1] : args.range;
        const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

        const border = {
          style: args.style,
          width: args.width || 1,
          color: args.color ? {
            red: args.color.red || 0,
            green: args.color.green || 0,
            blue: args.color.blue || 0
          } : undefined
        };

        const updateBordersRequest: any = {
          updateBorders: {
            range: gridRange
          }
        };

        if (args.top !== false) updateBordersRequest.updateBorders.top = border;
        if (args.bottom !== false) updateBordersRequest.updateBorders.bottom = border;
        if (args.left !== false) updateBordersRequest.updateBorders.left = border;
        if (args.right !== false) updateBordersRequest.updateBorders.right = border;
        if (args.innerHorizontal) updateBordersRequest.updateBorders.innerHorizontal = border;
        if (args.innerVertical) updateBordersRequest.updateBorders.innerVertical = border;

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: args.spreadsheetId,
          requestBody: { requests: [updateBordersRequest] }
        });

        return {
          content: [{ type: "text", text: `Set borders for range ${args.range}` }],
          isError: false
        };
      }

      case "mergeGoogleSheetCells": {
        const validation = MergeGoogleSheetCellsSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const sheets = google.sheets({ version: 'v4', auth: authClient });
        
        const rangeData = await sheets.spreadsheets.get({
          spreadsheetId: args.spreadsheetId,
          ranges: [args.range],
          fields: 'sheets(properties(sheetId,title))'
        });

        const sheetName = args.range.includes('!') ? args.range.split('!')[0] : 'Sheet1';
        const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
        if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
          return errorResponse(`Sheet "${sheetName}" not found`);
        }

        const a1Range = args.range.includes('!') ? args.range.split('!')[1] : args.range;
        const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

        const requests = [{
          mergeCells: {
            range: gridRange,
            mergeType: args.mergeType
          }
        }];

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: args.spreadsheetId,
          requestBody: { requests }
        });

        return {
          content: [{ type: "text", text: `Merged cells in range ${args.range} with type ${args.mergeType}` }],
          isError: false
        };
      }

      case "addGoogleSheetConditionalFormat": {
        const validation = AddGoogleSheetConditionalFormatSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const sheets = google.sheets({ version: 'v4', auth: authClient });
        
        const rangeData = await sheets.spreadsheets.get({
          spreadsheetId: args.spreadsheetId,
          ranges: [args.range],
          fields: 'sheets(properties(sheetId,title))'
        });

        const sheetName = args.range.includes('!') ? args.range.split('!')[0] : 'Sheet1';
        const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
        if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
          return errorResponse(`Sheet "${sheetName}" not found`);
        }

        const a1Range = args.range.includes('!') ? args.range.split('!')[1] : args.range;
        const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

        // Build condition based on type
        const booleanCondition: any = {};
        switch (args.condition.type) {
          case 'NUMBER_GREATER':
            booleanCondition.type = 'NUMBER_GREATER';
            booleanCondition.values = [{ userEnteredValue: args.condition.value }];
            break;
          case 'NUMBER_LESS':
            booleanCondition.type = 'NUMBER_LESS';
            booleanCondition.values = [{ userEnteredValue: args.condition.value }];
            break;
          case 'TEXT_CONTAINS':
            booleanCondition.type = 'TEXT_CONTAINS';
            booleanCondition.values = [{ userEnteredValue: args.condition.value }];
            break;
          case 'TEXT_STARTS_WITH':
            booleanCondition.type = 'TEXT_STARTS_WITH';
            booleanCondition.values = [{ userEnteredValue: args.condition.value }];
            break;
          case 'TEXT_ENDS_WITH':
            booleanCondition.type = 'TEXT_ENDS_WITH';
            booleanCondition.values = [{ userEnteredValue: args.condition.value }];
            break;
          case 'CUSTOM_FORMULA':
            booleanCondition.type = 'CUSTOM_FORMULA';
            booleanCondition.values = [{ userEnteredValue: args.condition.value }];
            break;
        }

        const format: any = {};
        if (args.format.backgroundColor) {
          format.backgroundColor = {
            red: args.format.backgroundColor.red || 0,
            green: args.format.backgroundColor.green || 0,
            blue: args.format.backgroundColor.blue || 0
          };
        }
        if (args.format.textFormat) {
          format.textFormat = {};
          if (args.format.textFormat.bold !== undefined) {
            format.textFormat.bold = args.format.textFormat.bold;
          }
          if (args.format.textFormat.foregroundColor) {
            format.textFormat.foregroundColor = {
              red: args.format.textFormat.foregroundColor.red || 0,
              green: args.format.textFormat.foregroundColor.green || 0,
              blue: args.format.textFormat.foregroundColor.blue || 0
            };
          }
        }

        const requests = [{
          addConditionalFormatRule: {
            rule: {
              ranges: [gridRange],
              booleanRule: {
                condition: booleanCondition,
                format: format
              }
            },
            index: 0
          }
        }];

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: args.spreadsheetId,
          requestBody: { requests }
        });

        return {
          content: [{ type: "text", text: `Added conditional formatting to range ${args.range}` }],
          isError: false
        };
      }

      // Phase 2: Additional Sheets tools
      case "getSpreadsheetInfo": {
        const validation = GetSpreadsheetInfoSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const sheets = google.sheets({ version: 'v4', auth: authClient });
        const response = await sheets.spreadsheets.get({
          spreadsheetId: args.spreadsheetId,
          fields: 'spreadsheetId,properties.title,sheets.properties'
        });

        const metadata = response.data;
        let result = `**Spreadsheet Information:**\n\n`;
        result += `**Title:** ${metadata.properties?.title || 'Untitled'}\n`;
        result += `**ID:** ${metadata.spreadsheetId}\n`;
        result += `**URL:** https://docs.google.com/spreadsheets/d/${metadata.spreadsheetId}\n\n`;

        const sheetList = metadata.sheets || [];
        result += `**Sheets (${sheetList.length}):**\n`;
        for (let i = 0; i < sheetList.length; i++) {
          const props = sheetList[i].properties;
          result += `${i + 1}. **${props?.title || 'Untitled'}**\n`;
          result += `   - Sheet ID: ${props?.sheetId}\n`;
          result += `   - Grid: ${props?.gridProperties?.rowCount || 0} rows × ${props?.gridProperties?.columnCount || 0} columns\n`;
          if (props?.hidden) {
            result += `   - Status: Hidden\n`;
          }
          result += `\n`;
        }

        return {
          content: [{ type: "text", text: result }],
          isError: false
        };
      }

      case "appendSpreadsheetRows": {
        const validation = AppendSpreadsheetRowsSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const sheets = google.sheets({ version: 'v4', auth: authClient });
        const response = await sheets.spreadsheets.values.append({
          spreadsheetId: args.spreadsheetId,
          range: args.range,
          valueInputOption: args.valueInputOption || 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: args.values }
        });

        const updatedCells = response.data.updates?.updatedCells || 0;
        const updatedRows = response.data.updates?.updatedRows || 0;
        const updatedRange = response.data.updates?.updatedRange || args.range;

        return {
          content: [{ type: "text", text: `Successfully appended ${updatedRows} row(s) (${updatedCells} cells) to spreadsheet. Updated range: ${updatedRange}` }],
          isError: false
        };
      }

      case "addSpreadsheetSheet": {
        const validation = AddSpreadsheetSheetSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const sheets = google.sheets({ version: 'v4', auth: authClient });
        const response = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: args.spreadsheetId,
          requestBody: {
            requests: [{
              addSheet: {
                properties: {
                  title: args.sheetTitle
                }
              }
            }]
          }
        });

        const addedSheet = response.data.replies?.[0]?.addSheet?.properties;
        if (!addedSheet) {
          return errorResponse('Failed to add sheet - no sheet properties returned.');
        }

        return {
          content: [{ type: "text", text: `Successfully added sheet "${addedSheet.title}" (Sheet ID: ${addedSheet.sheetId}) to spreadsheet.` }],
          isError: false
        };
      }

      case "listGoogleSheets": {
        const validation = ListGoogleSheetsSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        let queryString = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
        if (args.query) {
          queryString += ` and (name contains '${args.query}' or fullText contains '${args.query}')`;
        }

        const response = await drive.files.list({
          q: queryString,
          pageSize: args.maxResults || 20,
          orderBy: args.orderBy === 'name' ? 'name' : args.orderBy,
          fields: 'files(id,name,modifiedTime,createdTime,webViewLink,owners(displayName,emailAddress))',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        });

        const files = response.data.files || [];
        if (files.length === 0) {
          return {
            content: [{ type: "text", text: "No Google Spreadsheets found matching your criteria." }],
            isError: false
          };
        }

        let result = `Found ${files.length} Google Spreadsheet(s):\n\n`;
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

        return {
          content: [{ type: "text", text: result }],
          isError: false
        };
      }

      case "copyFile": {
        const validation = CopyFileSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        // Get original file info
        const originalFile = await drive.files.get({
          fileId: args.fileId,
          fields: 'name,parents',
          supportsAllDrives: true
        });

        const copyMetadata: any = {
          name: args.newName || `Copy of ${originalFile.data.name}`
        };

        if (args.parentFolderId) {
          copyMetadata.parents = [args.parentFolderId];
        } else if (originalFile.data.parents) {
          copyMetadata.parents = originalFile.data.parents;
        }

        const response = await drive.files.copy({
          fileId: args.fileId,
          requestBody: copyMetadata,
          fields: 'id,name,webViewLink,parents',
          supportsAllDrives: true
        });

        return {
          content: [{ type: "text", text: `Successfully copied file as "${response.data.name}"\nNew file ID: ${response.data.id}\nLink: ${response.data.webViewLink}` }],
          isError: false
        };
      }

      case "createGoogleSlides": {
        const validation = CreateGoogleSlidesSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const parentFolderId = await resolveFolderId(args.parentFolderId);

        // Check if presentation already exists
        const existingFileId = await checkFileExists(args.name, parentFolderId);
        if (existingFileId) {
          return errorResponse(
            `A presentation named "${args.name}" already exists in this location. ` +
            `File ID: ${existingFileId}. To modify it, you can use Google Slides directly.`
          );
        }

        const slidesService = google.slides({ version: 'v1', auth: authClient });
        const presentation = await slidesService.presentations.create({
          requestBody: { title: args.name },
        });

        await drive.files.update({
          fileId: presentation.data.presentationId!,
          addParents: parentFolderId,
          removeParents: 'root',
          supportsAllDrives: true
        });

        for (const slide of args.slides) {
          const slideObjectId = `slide_${uuidv4().substring(0, 8)}`;
          await slidesService.presentations.batchUpdate({
            presentationId: presentation.data.presentationId!,
            requestBody: {
              requests: [{
                createSlide: {
                  objectId: slideObjectId,
                  slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
                }
              }]
            },
          });

          const slidePage = await slidesService.presentations.pages.get({
            presentationId: presentation.data.presentationId!,
            pageObjectId: slideObjectId,
          });

          let titlePlaceholderId = '';
          let bodyPlaceholderId = '';
          slidePage.data.pageElements?.forEach((el) => {
            if (el.shape?.placeholder?.type === 'TITLE') {
              titlePlaceholderId = el.objectId!;
            } else if (el.shape?.placeholder?.type === 'BODY') {
              bodyPlaceholderId = el.objectId!;
            }
          });

          await slidesService.presentations.batchUpdate({
            presentationId: presentation.data.presentationId!,
            requestBody: {
              requests: [
                { insertText: { objectId: titlePlaceholderId, text: slide.title, insertionIndex: 0 } },
                { insertText: { objectId: bodyPlaceholderId, text: slide.content, insertionIndex: 0 } }
              ]
            },
          });
        }

        return {
          content: [{
            type: 'text',
            text: `Created Google Slides presentation: ${args.name}\nID: ${presentation.data.presentationId}\nLink: https://docs.google.com/presentation/d/${presentation.data.presentationId}`,
          }],
          isError: false,
        };
      }

      case "updateGoogleSlides": {
        const validation = UpdateGoogleSlidesSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const slidesService = google.slides({ version: 'v1', auth: authClient });
        
        // Get current presentation details
        const currentPresentation = await slidesService.presentations.get({
          presentationId: args.presentationId
        });
        
        if (!currentPresentation.data.slides) {
          return errorResponse("No slides found in presentation");
        }

        // Collect all slide IDs except the first one (we'll keep it for now)
        const slideIdsToDelete = currentPresentation.data.slides
          .slice(1)
          .map(slide => slide.objectId)
          .filter((id): id is string => id !== undefined);

        // Prepare requests to update presentation
        const requests: any[] = [];

        // Delete all slides except the first one
        if (slideIdsToDelete.length > 0) {
          slideIdsToDelete.forEach(slideId => {
            requests.push({
              deleteObject: { objectId: slideId }
            });
          });
        }

        // Now we need to update the first slide or create new slides
        if (args.slides.length === 0) {
          return errorResponse("At least one slide must be provided");
        }

        // Clear content of the first slide
        const firstSlide = currentPresentation.data.slides[0];
        if (firstSlide && firstSlide.pageElements) {
          // Find text elements to clear
          firstSlide.pageElements.forEach(element => {
            if (element.objectId && element.shape?.text) {
              requests.push({
                deleteText: {
                  objectId: element.objectId,
                  textRange: { type: 'ALL' }
                }
              });
            }
          });
        }

        // Update the first slide with new content
        const firstSlideContent = args.slides[0];
        if (firstSlide && firstSlide.pageElements) {
          // Find title and body placeholders
          let titlePlaceholderId: string | undefined;
          let bodyPlaceholderId: string | undefined;

          firstSlide.pageElements.forEach(element => {
            if (element.shape?.placeholder?.type === 'TITLE' || element.shape?.placeholder?.type === 'CENTERED_TITLE') {
              titlePlaceholderId = element.objectId || undefined;
            } else if (element.shape?.placeholder?.type === 'BODY' || element.shape?.placeholder?.type === 'SUBTITLE') {
              bodyPlaceholderId = element.objectId || undefined;
            }
          });

          if (titlePlaceholderId) {
            requests.push({
              insertText: {
                objectId: titlePlaceholderId,
                text: firstSlideContent.title,
                insertionIndex: 0
              }
            });
          }

          if (bodyPlaceholderId) {
            requests.push({
              insertText: {
                objectId: bodyPlaceholderId,
                text: firstSlideContent.content,
                insertionIndex: 0
              }
            });
          }
        }

        // Add any additional slides from the request
        for (let i = 1; i < args.slides.length; i++) {
          const slide = args.slides[i];
          const slideId = `slide_${Date.now()}_${i}`;
          
          requests.push({
            createSlide: {
              objectId: slideId,
              slideLayoutReference: {
                predefinedLayout: 'TITLE_AND_BODY'
              }
            }
          });

          // We'll need to add content to these slides in a separate batch update
          // because we need to wait for the slides to be created first
        }

        // Execute the batch update
        await slidesService.presentations.batchUpdate({
          presentationId: args.presentationId,
          requestBody: { requests }
        });

        // If we have additional slides, add their content
        if (args.slides.length > 1) {
          const contentRequests: any[] = [];
          
          // Get updated presentation to find the new slide IDs
          const updatedPresentation = await slidesService.presentations.get({
            presentationId: args.presentationId
          });

          // Add content to the new slides (starting from the second slide in our args)
          for (let i = 1; i < args.slides.length && updatedPresentation.data.slides; i++) {
            const slide = args.slides[i];
            const presentationSlide = updatedPresentation.data.slides[i];
            
            if (presentationSlide && presentationSlide.pageElements) {
              presentationSlide.pageElements.forEach(element => {
                if (element.objectId) {
                  if (element.shape?.placeholder?.type === 'TITLE' || element.shape?.placeholder?.type === 'CENTERED_TITLE') {
                    contentRequests.push({
                      insertText: {
                        objectId: element.objectId,
                        text: slide.title,
                        insertionIndex: 0
                      }
                    });
                  } else if (element.shape?.placeholder?.type === 'BODY' || element.shape?.placeholder?.type === 'SUBTITLE') {
                    contentRequests.push({
                      insertText: {
                        objectId: element.objectId,
                        text: slide.content,
                        insertionIndex: 0
                      }
                    });
                  }
                }
              });
            }
          }

          if (contentRequests.length > 0) {
            await slidesService.presentations.batchUpdate({
              presentationId: args.presentationId,
              requestBody: { requests: contentRequests }
            });
          }
        }

        return {
          content: [{
            type: 'text',
            text: `Updated Google Slides presentation with ${args.slides.length} slide(s)\nLink: https://docs.google.com/presentation/d/${args.presentationId}`,
          }],
          isError: false,
        };
      }

      case "formatGoogleDocText": {
        const validation = FormatGoogleDocTextSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const docs = google.docs({ version: 'v1', auth: authClient });
        
        // Build text style object
        const textStyle: any = {};
        const fields: string[] = [];
        
        if (args.bold !== undefined) {
          textStyle.bold = args.bold;
          fields.push('bold');
        }
        
        if (args.italic !== undefined) {
          textStyle.italic = args.italic;
          fields.push('italic');
        }
        
        if (args.underline !== undefined) {
          textStyle.underline = args.underline;
          fields.push('underline');
        }
        
        if (args.strikethrough !== undefined) {
          textStyle.strikethrough = args.strikethrough;
          fields.push('strikethrough');
        }
        
        if (args.fontSize !== undefined) {
          textStyle.fontSize = {
            magnitude: args.fontSize,
            unit: 'PT'
          };
          fields.push('fontSize');
        }
        
        if (args.foregroundColor) {
          textStyle.foregroundColor = {
            color: {
              rgbColor: {
                red: args.foregroundColor.red || 0,
                green: args.foregroundColor.green || 0,
                blue: args.foregroundColor.blue || 0
              }
            }
          };
          fields.push('foregroundColor');
        }
        
        if (fields.length === 0) {
          return errorResponse("No formatting options specified");
        }
        
        await docs.documents.batchUpdate({
          documentId: args.documentId,
          requestBody: {
            requests: [{
              updateTextStyle: {
                range: {
                  startIndex: args.startIndex,
                  endIndex: args.endIndex
                },
                textStyle,
                fields: fields.join(',')
              }
            }]
          }
        });
        
        return {
          content: [{ type: "text", text: `Applied text formatting to range ${args.startIndex}-${args.endIndex}` }],
          isError: false
        };
      }

      case "formatGoogleDocParagraph": {
        const validation = FormatGoogleDocParagraphSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const docs = google.docs({ version: 'v1', auth: authClient });
        
        // Build paragraph style object
        const paragraphStyle: any = {};
        const fields: string[] = [];
        
        if (args.namedStyleType !== undefined) {
          paragraphStyle.namedStyleType = args.namedStyleType;
          fields.push('namedStyleType');
        }
        
        if (args.alignment !== undefined) {
          paragraphStyle.alignment = args.alignment;
          fields.push('alignment');
        }
        
        if (args.lineSpacing !== undefined) {
          paragraphStyle.lineSpacing = args.lineSpacing;
          fields.push('lineSpacing');
        }
        
        if (args.spaceAbove !== undefined) {
          paragraphStyle.spaceAbove = {
            magnitude: args.spaceAbove,
            unit: 'PT'
          };
          fields.push('spaceAbove');
        }
        
        if (args.spaceBelow !== undefined) {
          paragraphStyle.spaceBelow = {
            magnitude: args.spaceBelow,
            unit: 'PT'
          };
          fields.push('spaceBelow');
        }
        
        if (fields.length === 0) {
          return errorResponse("No formatting options specified");
        }
        
        await docs.documents.batchUpdate({
          documentId: args.documentId,
          requestBody: {
            requests: [{
              updateParagraphStyle: {
                range: {
                  startIndex: args.startIndex,
                  endIndex: args.endIndex
                },
                paragraphStyle,
                fields: fields.join(',')
              }
            }]
          }
        });
        
        return {
          content: [{ type: "text", text: `Applied paragraph formatting to range ${args.startIndex}-${args.endIndex}` }],
          isError: false
        };
      }

      case "getGoogleDocContent": {
        const validation = GetGoogleDocContentSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const docs = google.docs({ version: 'v1', auth: authClient });
        const document = await docs.documents.get({ documentId: args.documentId });
        
        let content = '';
        let currentIndex = 1;
        const segments: Array<{text: string, startIndex: number, endIndex: number}> = [];
        
        // Extract text content with indices
        if (document.data.body?.content) {
          for (const element of document.data.body.content) {
            if (element.paragraph?.elements) {
              for (const textElement of element.paragraph.elements) {
                if (textElement.textRun?.content) {
                  const text = textElement.textRun.content;
                  segments.push({
                    text,
                    startIndex: currentIndex,
                    endIndex: currentIndex + text.length
                  });
                  content += text;
                  currentIndex += text.length;
                }
              }
            }
          }
        }
        
        // Format the response to show text with indices
        let formattedContent = 'Document content with indices:\n\n';
        let lineStart = 1;
        const lines = content.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineEnd = lineStart + line.length;
          if (line.trim()) {
            formattedContent += `[${lineStart}-${lineEnd}] ${line}\n`;
          }
          lineStart = lineEnd + 1; // +1 for the newline character
        }
        
        return {
          content: [{
            type: "text",
            text: formattedContent + `\nTotal length: ${content.length} characters`
          }],
          isError: false
        };
      }

      case "getGoogleSlidesContent": {
        const validation = GetGoogleSlidesContentSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const slidesService = google.slides({ version: 'v1', auth: authClient });
        const presentation = await slidesService.presentations.get({
          presentationId: args.presentationId
        });

        if (!presentation.data.slides) {
          return errorResponse("No slides found in presentation");
        }

        let content = 'Presentation content with element IDs:\n\n';
        const slides = args.slideIndex !== undefined 
          ? [presentation.data.slides[args.slideIndex]]
          : presentation.data.slides;

        slides.forEach((slide, index) => {
          if (!slide || !slide.objectId) return;
          
          content += `\nSlide ${args.slideIndex ?? index} (ID: ${slide.objectId}):\n`;
          content += '----------------------------\n';

          if (slide.pageElements) {
            slide.pageElements.forEach((element) => {
              if (!element.objectId) return;

              if (element.shape?.text) {
                content += `  Text Box (ID: ${element.objectId}):\n`;
                const textElements = element.shape.text.textElements || [];
                let text = '';
                textElements.forEach((textElement) => {
                  if (textElement.textRun?.content) {
                    text += textElement.textRun.content;
                  }
                });
                content += `    "${text.trim()}"\n`;
              } else if (element.shape) {
                content += `  Shape (ID: ${element.objectId}): ${element.shape.shapeType || 'Unknown'}\n`;
              } else if (element.image) {
                content += `  Image (ID: ${element.objectId})\n`;
              } else if (element.video) {
                content += `  Video (ID: ${element.objectId})\n`;
              } else if (element.table) {
                content += `  Table (ID: ${element.objectId})\n`;
              }
            });
          }
        });

        return {
          content: [{ type: "text", text: content }],
          isError: false
        };
      }

      case "formatGoogleSlidesText": {
        const validation = FormatGoogleSlidesTextSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const slidesService = google.slides({ version: 'v1', auth: authClient });
        const textStyle: any = {};
        const fields: string[] = [];

        if (args.bold !== undefined) {
          textStyle.bold = args.bold;
          fields.push('bold');
        }

        if (args.italic !== undefined) {
          textStyle.italic = args.italic;
          fields.push('italic');
        }

        if (args.underline !== undefined) {
          textStyle.underline = args.underline;
          fields.push('underline');
        }

        if (args.strikethrough !== undefined) {
          textStyle.strikethrough = args.strikethrough;
          fields.push('strikethrough');
        }

        if (args.fontSize !== undefined) {
          textStyle.fontSize = {
            magnitude: args.fontSize,
            unit: 'PT'
          };
          fields.push('fontSize');
        }

        if (args.fontFamily !== undefined) {
          textStyle.fontFamily = args.fontFamily;
          fields.push('fontFamily');
        }

        if (args.foregroundColor) {
          textStyle.foregroundColor = {
            opaqueColor: {
              rgbColor: {
                red: args.foregroundColor.red || 0,
                green: args.foregroundColor.green || 0,
                blue: args.foregroundColor.blue || 0
              }
            }
          };
          fields.push('foregroundColor');
        }

        if (fields.length === 0) {
          return errorResponse("No formatting options specified");
        }

        const updateRequest: any = {
          updateTextStyle: {
            objectId: args.objectId,
            style: textStyle,
            fields: fields.join(',')
          }
        };

        // Add text range if specified
        if (args.startIndex !== undefined && args.endIndex !== undefined) {
          updateRequest.updateTextStyle.textRange = {
            type: 'FIXED_RANGE',
            startIndex: args.startIndex,
            endIndex: args.endIndex
          };
        } else {
          updateRequest.updateTextStyle.textRange = { type: 'ALL' };
        }

        await slidesService.presentations.batchUpdate({
          presentationId: args.presentationId,
          requestBody: { requests: [updateRequest] }
        });

        return {
          content: [{ type: "text", text: `Applied text formatting to object ${args.objectId}` }],
          isError: false
        };
      }

      case "formatGoogleSlidesParagraph": {
        const validation = FormatGoogleSlidesParagraphSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const slidesService = google.slides({ version: 'v1', auth: authClient });
        const requests: any[] = [];

        if (args.alignment) {
          requests.push({
            updateParagraphStyle: {
              objectId: args.objectId,
              style: { alignment: args.alignment },
              fields: 'alignment'
            }
          });
        }

        if (args.lineSpacing !== undefined) {
          requests.push({
            updateParagraphStyle: {
              objectId: args.objectId,
              style: { lineSpacing: args.lineSpacing },
              fields: 'lineSpacing'
            }
          });
        }

        if (args.bulletStyle) {
          if (args.bulletStyle === 'NONE') {
            requests.push({
              deleteParagraphBullets: {
                objectId: args.objectId
              }
            });
          } else if (args.bulletStyle === 'NUMBERED') {
            requests.push({
              createParagraphBullets: {
                objectId: args.objectId,
                bulletPreset: 'NUMBERED_DIGIT_ALPHA_ROMAN'
              }
            });
          } else {
            requests.push({
              createParagraphBullets: {
                objectId: args.objectId,
                bulletPreset: `BULLET_${args.bulletStyle}_CIRCLE_SQUARE`
              }
            });
          }
        }

        if (requests.length === 0) {
          return errorResponse("No formatting options specified");
        }

        await slidesService.presentations.batchUpdate({
          presentationId: args.presentationId,
          requestBody: { requests }
        });

        return {
          content: [{ type: "text", text: `Applied paragraph formatting to object ${args.objectId}` }],
          isError: false
        };
      }

      case "styleGoogleSlidesShape": {
        const validation = StyleGoogleSlidesShapeSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const slidesService = google.slides({ version: 'v1', auth: authClient });
        const shapeProperties: any = {};
        const fields: string[] = [];

        if (args.backgroundColor) {
          shapeProperties.shapeBackgroundFill = {
            solidFill: {
              color: {
                rgbColor: {
                  red: args.backgroundColor.red || 0,
                  green: args.backgroundColor.green || 0,
                  blue: args.backgroundColor.blue || 0
                }
              },
              alpha: args.backgroundColor.alpha || 1
            }
          };
          fields.push('shapeBackgroundFill');
        }

        const outline: any = {};
        let hasOutlineChanges = false;

        if (args.outlineColor) {
          outline.outlineFill = {
            solidFill: {
              color: {
                rgbColor: {
                  red: args.outlineColor.red || 0,
                  green: args.outlineColor.green || 0,
                  blue: args.outlineColor.blue || 0
                }
              }
            }
          };
          hasOutlineChanges = true;
        }

        if (args.outlineWeight !== undefined) {
          outline.weight = {
            magnitude: args.outlineWeight,
            unit: 'PT'
          };
          hasOutlineChanges = true;
        }

        if (args.outlineDashStyle !== undefined) {
          outline.dashStyle = args.outlineDashStyle;
          hasOutlineChanges = true;
        }

        if (hasOutlineChanges) {
          shapeProperties.outline = outline;
          fields.push('outline');
        }

        if (fields.length === 0) {
          return errorResponse("No styling options specified");
        }

        await slidesService.presentations.batchUpdate({
          presentationId: args.presentationId,
          requestBody: {
            requests: [{
              updateShapeProperties: {
                objectId: args.objectId,
                shapeProperties,
                fields: fields.join(',')
              }
            }]
          }
        });

        return {
          content: [{ type: "text", text: `Applied styling to shape ${args.objectId}` }],
          isError: false
        };
      }

      case "setGoogleSlidesBackground": {
        const validation = SetGoogleSlidesBackgroundSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const slidesService = google.slides({ version: 'v1', auth: authClient });
        const requests = args.pageObjectIds.map(pageObjectId => ({
          updatePageProperties: {
            objectId: pageObjectId,
            pageProperties: {
              pageBackgroundFill: {
                solidFill: {
                  color: {
                    rgbColor: {
                      red: args.backgroundColor.red || 0,
                      green: args.backgroundColor.green || 0,
                      blue: args.backgroundColor.blue || 0
                    }
                  },
                  alpha: args.backgroundColor.alpha || 1
                }
              }
            },
            fields: 'pageBackgroundFill'
          }
        }));

        await slidesService.presentations.batchUpdate({
          presentationId: args.presentationId,
          requestBody: { requests }
        });

        return {
          content: [{ type: "text", text: `Set background color for ${args.pageObjectIds.length} slide(s)` }],
          isError: false
        };
      }

      case "createGoogleSlidesTextBox": {
        const validation = CreateGoogleSlidesTextBoxSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const slidesService = google.slides({ version: 'v1', auth: authClient });
        const elementId = `textBox_${uuidv4().substring(0, 8)}`;

        const requests: any[] = [
          {
            createShape: {
              objectId: elementId,
              shapeType: 'TEXT_BOX',
              elementProperties: {
                pageObjectId: args.pageObjectId,
                size: {
                  width: { magnitude: args.width, unit: 'EMU' },
                  height: { magnitude: args.height, unit: 'EMU' }
                },
                transform: {
                  scaleX: 1,
                  scaleY: 1,
                  translateX: args.x,
                  translateY: args.y,
                  unit: 'EMU'
                }
              }
            }
          },
          {
            insertText: {
              objectId: elementId,
              text: args.text,
              insertionIndex: 0
            }
          }
        ];

        // Apply optional formatting
        if (args.fontSize || args.bold || args.italic) {
          const textStyle: any = {};
          const fields: string[] = [];

          if (args.fontSize) {
            textStyle.fontSize = {
              magnitude: args.fontSize,
              unit: 'PT'
            };
            fields.push('fontSize');
          }

          if (args.bold !== undefined) {
            textStyle.bold = args.bold;
            fields.push('bold');
          }

          if (args.italic !== undefined) {
            textStyle.italic = args.italic;
            fields.push('italic');
          }

          if (fields.length > 0) {
            requests.push({
              updateTextStyle: {
                objectId: elementId,
                style: textStyle,
                fields: fields.join(','),
                textRange: { type: 'ALL' }
              }
            });
          }
        }

        await slidesService.presentations.batchUpdate({
          presentationId: args.presentationId,
          requestBody: { requests }
        });

        return {
          content: [{ type: "text", text: `Created text box with ID: ${elementId}` }],
          isError: false
        };
      }

      case "createGoogleSlidesShape": {
        const validation = CreateGoogleSlidesShapeSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const slidesService = google.slides({ version: 'v1', auth: authClient });
        const elementId = `shape_${uuidv4().substring(0, 8)}`;

        const createRequest: any = {
          createShape: {
            objectId: elementId,
            shapeType: args.shapeType,
            elementProperties: {
              pageObjectId: args.pageObjectId,
              size: {
                width: { magnitude: args.width, unit: 'EMU' },
                height: { magnitude: args.height, unit: 'EMU' }
              },
              transform: {
                scaleX: 1,
                scaleY: 1,
                translateX: args.x,
                translateY: args.y,
                unit: 'EMU'
              }
            }
          }
        };

        const requests = [createRequest];

        // Apply background color if specified
        if (args.backgroundColor) {
          requests.push({
            updateShapeProperties: {
              objectId: elementId,
              shapeProperties: {
                shapeBackgroundFill: {
                  solidFill: {
                    color: {
                      rgbColor: {
                        red: args.backgroundColor.red || 0,
                        green: args.backgroundColor.green || 0,
                        blue: args.backgroundColor.blue || 0
                      }
                    },
                    alpha: args.backgroundColor.alpha || 1
                  }
                }
              },
              fields: 'shapeBackgroundFill'
            }
          });
        }

        await slidesService.presentations.batchUpdate({
          presentationId: args.presentationId,
          requestBody: { requests }
        });

        return {
          content: [{ type: "text", text: `Created ${args.shapeType} shape with ID: ${elementId}` }],
          isError: false
        };
      }

      // =========================================================================
      // NEW GOOGLE DOCS EDITING TOOLS (ported from google-workspace-work)
      // =========================================================================

      case "insertText": {
        const validation = InsertTextSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const docs = google.docs({ version: 'v1', auth: authClient });
        await docs.documents.batchUpdate({
          documentId: args.documentId,
          requestBody: {
            requests: [{
              insertText: {
                location: { index: args.index },
                text: args.text
              }
            }]
          }
        });

        return {
          content: [{ type: "text", text: `Successfully inserted ${args.text.length} characters at index ${args.index}` }],
          isError: false
        };
      }

      case "deleteRange": {
        const validation = DeleteRangeSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        if (args.endIndex <= args.startIndex) {
          return errorResponse("endIndex must be greater than startIndex");
        }

        const docs = google.docs({ version: 'v1', auth: authClient });
        await docs.documents.batchUpdate({
          documentId: args.documentId,
          requestBody: {
            requests: [{
              deleteContentRange: {
                range: {
                  startIndex: args.startIndex,
                  endIndex: args.endIndex
                }
              }
            }]
          }
        });

        return {
          content: [{ type: "text", text: `Successfully deleted content from index ${args.startIndex} to ${args.endIndex}` }],
          isError: false
        };
      }

      case "readGoogleDoc": {
        const validation = ReadGoogleDocSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const docs = google.docs({ version: 'v1', auth: authClient });
        const docResponse = await docs.documents.get({
          documentId: args.documentId
        });

        const doc = docResponse.data;
        const format = args.format || 'text';

        if (format === 'json') {
          let result = JSON.stringify(doc, null, 2);
          if (args.maxLength && result.length > args.maxLength) {
            result = result.substring(0, args.maxLength) + '\n... (truncated)';
          }
          return {
            content: [{ type: "text", text: result }],
            isError: false
          };
        }

        // Extract plain text from document
        let text = '';
        const body = doc.body;
        if (body?.content) {
          for (const element of body.content) {
            if (element.paragraph?.elements) {
              for (const elem of element.paragraph.elements) {
                if (elem.textRun?.content) {
                  text += elem.textRun.content;
                }
              }
            } else if (element.table) {
              // Handle tables
              for (const row of element.table.tableRows || []) {
                for (const cell of row.tableCells || []) {
                  for (const cellContent of cell.content || []) {
                    if (cellContent.paragraph?.elements) {
                      for (const elem of cellContent.paragraph.elements) {
                        if (elem.textRun?.content) {
                          text += elem.textRun.content;
                        }
                      }
                    }
                  }
                  text += '\t';
                }
                text += '\n';
              }
            }
          }
        }

        if (format === 'markdown') {
          // Basic markdown conversion - could be enhanced
          text = `# ${doc.title}\n\n${text}`;
        }

        if (args.maxLength && text.length > args.maxLength) {
          text = text.substring(0, args.maxLength) + '\n... (truncated)';
        }

        return {
          content: [{ type: "text", text }],
          isError: false
        };
      }

      case "listDocumentTabs": {
        const validation = ListDocumentTabsSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const docs = google.docs({ version: 'v1', auth: authClient });
        // Use includeTabsContent to get the new tabs structure
        const docResponse = await docs.documents.get({
          documentId: args.documentId,
          includeTabsContent: true
        });

        const doc = docResponse.data;

        // Check if document has tabs (newer API feature)
        const tabs = (doc as any).tabs;
        if (!tabs || tabs.length === 0) {
          // Single-tab document or legacy format - check for body content
          let contentInfo = '';
          if (args.includeContent) {
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

          if (args.includeContent && tab.documentTab?.body?.content) {
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

      case "applyTextStyle": {
        const validation = ApplyTextStyleSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        let startIndex: number;
        let endIndex: number;

        // Determine target range (flat parameters)
        if (args.startIndex !== undefined && args.endIndex !== undefined) {
          startIndex = args.startIndex;
          endIndex = args.endIndex;
        } else if (args.textToFind !== undefined) {
          const range = await findTextRange(
            args.documentId,
            args.textToFind,
            args.matchInstance || 1
          );
          if (!range) {
            return errorResponse(`Text "${args.textToFind}" not found in document`);
          }
          startIndex = range.startIndex;
          endIndex = range.endIndex;
        } else {
          return errorResponse("Must provide either startIndex+endIndex or textToFind");
        }

        // Build style object from flat parameters
        const style = {
          bold: args.bold,
          italic: args.italic,
          underline: args.underline,
          strikethrough: args.strikethrough,
          fontSize: args.fontSize,
          fontFamily: args.fontFamily,
          foregroundColor: args.foregroundColor,
          backgroundColor: args.backgroundColor,
          linkUrl: args.linkUrl
        };

        // Build the update request
        const styleResult = buildUpdateTextStyleRequest(startIndex, endIndex, style);
        if (!styleResult) {
          return errorResponse("No valid style options provided");
        }

        const docs = google.docs({ version: 'v1', auth: authClient });
        await docs.documents.batchUpdate({
          documentId: args.documentId,
          requestBody: {
            requests: [styleResult.request]
          }
        });

        return {
          content: [{ type: "text", text: `Successfully applied text style to range ${startIndex}-${endIndex}` }],
          isError: false
        };
      }

      case "applyParagraphStyle": {
        const validation = ApplyParagraphStyleSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        let startIndex: number;
        let endIndex: number;

        // Determine target range (flat parameters)
        if (args.startIndex !== undefined && args.endIndex !== undefined) {
          startIndex = args.startIndex;
          endIndex = args.endIndex;
        } else if (args.textToFind !== undefined) {
          const range = await findTextRange(
            args.documentId,
            args.textToFind,
            args.matchInstance || 1
          );
          if (!range) {
            return errorResponse(`Text "${args.textToFind}" not found in document`);
          }
          // For paragraph style, get the full paragraph range
          const paraRange = await getParagraphRange(args.documentId, range.startIndex);
          if (!paraRange) {
            return errorResponse("Could not determine paragraph boundaries");
          }
          startIndex = paraRange.startIndex;
          endIndex = paraRange.endIndex;
        } else if (args.indexWithinParagraph !== undefined) {
          const paraRange = await getParagraphRange(args.documentId, args.indexWithinParagraph);
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
          alignment: args.alignment,
          indentStart: args.indentStart,
          indentEnd: args.indentEnd,
          spaceAbove: args.spaceAbove,
          spaceBelow: args.spaceBelow,
          namedStyleType: args.namedStyleType,
          keepWithNext: args.keepWithNext
        };

        // Build the update request
        const styleResult = buildUpdateParagraphStyleRequest(startIndex, endIndex, style);
        if (!styleResult) {
          return errorResponse("No valid style options provided");
        }

        const docs = google.docs({ version: 'v1', auth: authClient });
        await docs.documents.batchUpdate({
          documentId: args.documentId,
          requestBody: {
            requests: [styleResult.request]
          }
        });

        return {
          content: [{ type: "text", text: `Successfully applied paragraph style to range ${startIndex}-${endIndex}` }],
          isError: false
        };
      }

      // =========================================================================
      // COMMENT TOOLS (use Drive API v3)
      // =========================================================================

      case "listComments": {
        const validation = ListCommentsSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        // Use Drive API v3 for comments
        const response = await drive.comments.list({
          fileId: args.documentId,
          fields: 'comments(id,content,quotedFileContent,author,createdTime,resolved,replies)',
          pageSize: 100
        });

        const comments = response.data.comments || [];

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

        return {
          content: [{ type: "text", text: `Found ${comments.length} comment${comments.length === 1 ? '' : 's'}:\n\n${formattedComments}` }],
          isError: false
        };
      }

      case "getComment": {
        const validation = GetCommentSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const response = await drive.comments.get({
          fileId: args.documentId,
          commentId: args.commentId,
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
        const validation = AddCommentSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        if (args.endIndex <= args.startIndex) {
          return errorResponse("endIndex must be greater than startIndex");
        }

        // Get the document to extract quoted text
        const docs = google.docs({ version: 'v1', auth: authClient });
        const doc = await docs.documents.get({ documentId: args.documentId });

        // Extract quoted text from the range
        let quotedText = '';
        const content = doc.data.body?.content || [];
        for (const element of content) {
          if (element.paragraph?.elements) {
            for (const textElement of element.paragraph.elements) {
              if (textElement.textRun) {
                const elementStart = textElement.startIndex || 0;
                const elementEnd = textElement.endIndex || 0;

                if (elementEnd > args.startIndex && elementStart < args.endIndex) {
                  const text = textElement.textRun.content || '';
                  const startOffset = Math.max(0, args.startIndex - elementStart);
                  const endOffset = Math.min(text.length, args.endIndex - elementStart);
                  quotedText += text.substring(startOffset, endOffset);
                }
              }
            }
          }
        }

        const response = await drive.comments.create({
          fileId: args.documentId,
          fields: 'id,content,quotedFileContent,author,createdTime',
          requestBody: {
            content: args.commentText,
            quotedFileContent: {
              value: quotedText,
              mimeType: 'text/html'
            },
            anchor: JSON.stringify({
              r: args.documentId,
              a: [{
                txt: {
                  o: args.startIndex - 1,  // Drive API uses 0-based indexing
                  l: args.endIndex - args.startIndex,
                  ml: args.endIndex - args.startIndex
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
        const validation = ReplyToCommentSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const response = await drive.replies.create({
          fileId: args.documentId,
          commentId: args.commentId,
          fields: 'id,content,author,createdTime',
          requestBody: {
            content: args.replyText
          }
        });

        return {
          content: [{ type: "text", text: `Reply added successfully. Reply ID: ${response.data.id}` }],
          isError: false
        };
      }

      case "deleteComment": {
        const validation = DeleteCommentSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        await drive.comments.delete({
          fileId: args.documentId,
          commentId: args.commentId
        });

        return {
          content: [{ type: "text", text: `Comment ${args.commentId} has been deleted.` }],
          isError: false
        };
      }

      // =========================================================================
      // CALENDAR HANDLERS
      // =========================================================================
      case "listCalendars": {
        const validation = ListCalendarsSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const response = await calendar.calendarList.list({
          showHidden: args.showHidden,
          maxResults: 250
        });

        const calendars = response.data.items || [];
        if (calendars.length === 0) {
          return { content: [{ type: "text", text: "No calendars found." }], isError: false };
        }

        const lines = calendars.map((cal: any) => {
          const primary = cal.primary ? ' (PRIMARY)' : '';
          const role = cal.accessRole ? ` [${cal.accessRole}]` : '';
          return `- ${cal.summary}${primary}${role}\n  ID: ${cal.id}`;
        });

        return {
          content: [{ type: "text", text: `Found ${calendars.length} calendar(s):\n\n${lines.join('\n\n')}` }],
          isError: false
        };
      }

      case "getCalendarEvents": {
        const validation = GetCalendarEventsSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const params: any = {
          calendarId: args.calendarId || 'primary',
          maxResults: args.maxResults || 50,
          singleEvents: args.singleEvents !== false,
          orderBy: args.orderBy || 'startTime'
        };

        if (args.timeMin) params.timeMin = args.timeMin;
        if (args.timeMax) params.timeMax = args.timeMax;
        if (args.query) params.q = args.query;

        const response = await calendar.events.list(params);

        const events = response.data.items || [];
        if (events.length === 0) {
          return { content: [{ type: "text", text: "No events found." }], isError: false };
        }

        const formattedEvents = events.map((e: any) => formatEventForDisplay(formatCalendarEvent(e)));

        return {
          content: [{ type: "text", text: `Found ${events.length} event(s):\n\n${formattedEvents.join('\n\n---\n\n')}` }],
          isError: false
        };
      }

      case "getCalendarEvent": {
        const validation = GetCalendarEventSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const response = await calendar.events.get({
          calendarId: args.calendarId || 'primary',
          eventId: args.eventId
        });

        const formatted = formatEventForDisplay(formatCalendarEvent(response.data));
        return {
          content: [{ type: "text", text: formatted }],
          isError: false
        };
      }

      case "createCalendarEvent": {
        const validation = CreateCalendarEventSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const eventResource: any = {
          summary: args.summary,
          description: args.description,
          location: args.location,
          start: args.start,
          end: args.end,
          visibility: args.visibility
        };

        if (args.attendees && args.attendees.length > 0) {
          eventResource.attendees = args.attendees.map((email: string) => ({ email }));
        }

        if (args.recurrence) {
          eventResource.recurrence = args.recurrence;
        }

        let conferenceDataVersion = 0;
        if (args.conferenceType === 'hangoutsMeet') {
          eventResource.conferenceData = {
            createRequest: {
              requestId: `meet-${Date.now()}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' }
            }
          };
          conferenceDataVersion = 1;
        }

        const params: any = {
          calendarId: args.calendarId || 'primary',
          requestBody: eventResource,
          sendUpdates: args.sendUpdates || 'none'
        };

        if (conferenceDataVersion > 0) {
          params.conferenceDataVersion = conferenceDataVersion;
        }

        const response = await calendar.events.insert(params);
        const created = formatCalendarEvent(response.data);

        return {
          content: [{ type: "text", text: `Event created successfully!\n\n${formatEventForDisplay(created)}` }],
          isError: false
        };
      }

      case "updateCalendarEvent": {
        const validation = UpdateCalendarEventSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        // First get the existing event
        const existingResponse = await calendar.events.get({
          calendarId: args.calendarId || 'primary',
          eventId: args.eventId
        });

        const eventResource: any = { ...existingResponse.data };

        if (args.summary !== undefined) eventResource.summary = args.summary;
        if (args.description !== undefined) eventResource.description = args.description;
        if (args.location !== undefined) eventResource.location = args.location;
        if (args.start) eventResource.start = args.start;
        if (args.end) eventResource.end = args.end;

        if (args.attendees !== undefined) {
          eventResource.attendees = args.attendees.map((email: string) => ({ email }));
        }

        const response = await calendar.events.update({
          calendarId: args.calendarId || 'primary',
          eventId: args.eventId,
          requestBody: eventResource,
          sendUpdates: args.sendUpdates || 'none'
        });

        const updated = formatCalendarEvent(response.data);

        return {
          content: [{ type: "text", text: `Event updated successfully!\n\n${formatEventForDisplay(updated)}` }],
          isError: false
        };
      }

      case "deleteCalendarEvent": {
        const validation = DeleteCalendarEventSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        await calendar.events.delete({
          calendarId: args.calendarId || 'primary',
          eventId: args.eventId,
          sendUpdates: args.sendUpdates || 'none'
        });

        return {
          content: [{ type: "text", text: `Event ${args.eventId} has been deleted.` }],
          isError: false
        };
      }

      // =========================================================================
      // TABLE & MEDIA HANDLERS
      // =========================================================================
      case "insertTable": {
        const validation = InsertTableSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const request_body = {
          insertTable: {
            location: { index: args.index },
            rows: args.rows,
            columns: args.columns
          }
        };

        await executeBatchUpdate(args.documentId, [request_body]);

        return {
          content: [{ type: "text", text: `Successfully inserted ${args.rows}x${args.columns} table at index ${args.index}` }],
          isError: false
        };
      }

      case "editTableCell": {
        const validation = EditTableCellSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        // Get the document to find the table structure
        await ensureAuthenticated();
        const docs = google.docs({ version: 'v1', auth: authClient });

        const docRes = await docs.documents.get({
          documentId: args.documentId,
          fields: 'body(content)'
        });

        // Find the table at the specified start index
        let table: any = null;
        const findTable = (content: any[]) => {
          for (const elem of content) {
            if (elem.table && elem.startIndex === args.tableStartIndex) {
              table = elem.table;
              return;
            }
          }
        };

        if (docRes.data.body?.content) {
          findTable(docRes.data.body.content);
        }

        if (!table) {
          return errorResponse(`No table found at index ${args.tableStartIndex}`);
        }

        // Get the cell
        const row = table.tableRows?.[args.rowIndex];
        if (!row) {
          return errorResponse(`Row ${args.rowIndex} not found in table`);
        }

        const cell = row.tableCells?.[args.columnIndex];
        if (!cell) {
          return errorResponse(`Column ${args.columnIndex} not found in row ${args.rowIndex}`);
        }

        // Get cell content range
        const cellStartIndex = cell.startIndex;
        const cellEndIndex = cell.endIndex;

        const requests: any[] = [];

        // If textContent is provided, delete existing content and insert new
        if (args.textContent !== undefined) {
          // Delete existing content (keeping the paragraph structure)
          // The cell always has at least one paragraph ending with newline
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
          if (args.textContent.length > 0) {
            requests.push({
              insertText: {
                location: { index: cellContentStart },
                text: args.textContent
              }
            });
          }
        }

        // Apply text styling if any style options provided
        if (args.bold !== undefined || args.italic !== undefined || args.fontSize !== undefined) {
          const textStyle: any = {};
          const fields: string[] = [];

          if (args.bold !== undefined) { textStyle.bold = args.bold; fields.push('bold'); }
          if (args.italic !== undefined) { textStyle.italic = args.italic; fields.push('italic'); }
          if (args.fontSize !== undefined) { textStyle.fontSize = { magnitude: args.fontSize, unit: 'PT' }; fields.push('fontSize'); }

          if (fields.length > 0) {
            // Apply to the cell content range
            const styleStart = cellStartIndex + 1;
            const styleEnd = args.textContent !== undefined
              ? styleStart + args.textContent.length
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
        if (args.alignment !== undefined) {
          requests.push({
            updateParagraphStyle: {
              range: { startIndex: cellStartIndex + 1, endIndex: cellEndIndex - 1 },
              paragraphStyle: { alignment: args.alignment },
              fields: 'alignment'
            }
          });
        }

        if (requests.length === 0) {
          return errorResponse("No changes specified for the table cell");
        }

        await executeBatchUpdate(args.documentId, requests);

        return {
          content: [{ type: "text", text: `Successfully edited cell at row ${args.rowIndex}, column ${args.columnIndex}` }],
          isError: false
        };
      }

      case "insertImageFromUrl": {
        const validation = InsertImageFromUrlSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        await insertInlineImageHelper(args.documentId, args.imageUrl, args.index, args.width, args.height);

        return {
          content: [{ type: "text", text: `Successfully inserted image from URL at index ${args.index}` }],
          isError: false
        };
      }

      case "insertLocalImage": {
        const validation = InsertLocalImageSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        // Get the document's parent folder if uploadToSameFolder is true
        let parentFolderId: string | undefined;
        if (args.uploadToSameFolder !== false) {
          const fileInfo = await drive.files.get({
            fileId: args.documentId,
            fields: 'parents'
          });
          parentFolderId = fileInfo.data.parents?.[0];
        }

        // Upload the image to Drive
        const imageUrl = await uploadImageToDriveHelper(args.localImagePath, parentFolderId);

        // Insert the image into the document
        await insertInlineImageHelper(args.documentId, imageUrl, args.index, args.width, args.height);

        return {
          content: [{ type: "text", text: `Successfully uploaded and inserted local image at index ${args.index}\nImage URL: ${imageUrl}` }],
          isError: false
        };
      }

      // =========================================================================
      // GOOGLE DOCS DISCOVERY & MANAGEMENT TOOLS
      // =========================================================================

      case "listGoogleDocs": {
        const validation = ListGoogleDocsSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        // Build the query string for Google Drive API
        let queryString = "mimeType='application/vnd.google-apps.document' and trashed=false";
        if (args.query) {
          queryString += ` and (name contains '${args.query}' or fullText contains '${args.query}')`;
        }

        const response = await drive.files.list({
          q: queryString,
          pageSize: args.maxResults,
          orderBy: args.orderBy === 'name' ? 'name' : args.orderBy,
          fields: 'files(id,name,modifiedTime,createdTime,size,webViewLink,owners(displayName,emailAddress))',
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
        const validation = GetDocumentInfoSchema.safeParse(request.params.arguments);
        if (!validation.success) {
          return errorResponse(validation.error.errors[0].message);
        }
        const args = validation.data;

        const response = await drive.files.get({
          fileId: args.documentId,
          fields: 'id,name,description,mimeType,size,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),shared,parents,version',
        });

        const file = response.data;

        if (!file) {
          return errorResponse(`Document with ID ${args.documentId} not found.`);
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

      default:
        return errorResponse("Tool not found");
    }
  } catch (error) {
    log('Error in tool request handler', { error: (error as Error).message });
    return errorResponse((error as Error).message);
  }
});

// -----------------------------------------------------------------------------
// CLI FUNCTIONS
// -----------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
Google Drive MCP Server v${VERSION}

Usage:
  npx @yourusername/google-drive-mcp [command]

Commands:
  auth     Run the authentication flow
  start    Start the MCP server (default)
  version  Show version information
  help     Show this help message

Examples:
  npx @yourusername/google-drive-mcp auth
  npx @yourusername/google-drive-mcp start
  npx @yourusername/google-drive-mcp version
  npx @yourusername/google-drive-mcp

Environment Variables:
  GOOGLE_DRIVE_OAUTH_CREDENTIALS   Path to OAuth credentials file
  GOOGLE_DRIVE_MCP_TOKEN_PATH      Path to store authentication tokens
`);
}

function showVersion(): void {
  console.log(`Google Drive MCP Server v${VERSION}`);
}

async function runAuthServer(): Promise<void> {
  try {
    // Initialize OAuth client
    const oauth2Client = await initializeOAuth2Client();

    // Create and start the auth server
    const authServerInstance = new AuthServer(oauth2Client);

    // Start with browser opening (true by default)
    const success = await authServerInstance.start(true);

    if (!success && !authServerInstance.authCompletedSuccessfully) {
      // Failed to start and tokens weren't already valid
      console.error(
        "Authentication failed. Could not start server or validate existing tokens. Check port availability (3000-3004) and try again."
      );
      process.exit(1);
    } else if (authServerInstance.authCompletedSuccessfully) {
      // Auth was successful (either existing tokens were valid or flow completed just now)
      console.log("Authentication successful.");
      process.exit(0); // Exit cleanly if auth is already done
    }

    // If we reach here, the server started and is waiting for the browser callback
    console.log(
      "Authentication server started. Please complete the authentication in your browser..."
    );

    // Wait for completion
    const intervalId = setInterval(async () => {
      if (authServerInstance.authCompletedSuccessfully) {
        clearInterval(intervalId);
        await authServerInstance.stop();
        console.log("Authentication completed successfully!");
        process.exit(0);
      }
    }, 1000);
  } catch (error) {
    console.error("Authentication failed:", error);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// MAIN EXECUTION
// -----------------------------------------------------------------------------

function parseCliArgs(): { command: string | undefined } {
  const args = process.argv.slice(2);
  let command: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    // Handle special version/help flags as commands
    if (arg === '--version' || arg === '-v' || arg === '--help' || arg === '-h') {
      command = arg;
      continue;
    }
    
    // Check for command (first non-option argument)
    if (!command && !arg.startsWith('--')) {
      command = arg;
      continue;
    }
  }

  return { command };
}

async function main() {
  const { command } = parseCliArgs();

  switch (command) {
    case "auth":
      await runAuthServer();
      break;
    case "start":
    case undefined:
      try {
        // Start the MCP server
        console.error("Starting Google Drive MCP server...");
        const transport = new StdioServerTransport();
        await server.connect(transport);
        log('Server started successfully');
        
        // Set up graceful shutdown
        process.on("SIGINT", async () => {
          await server.close();
          process.exit(0);
        });
        process.on("SIGTERM", async () => {
          await server.close();
          process.exit(0);
        });
      } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
      }
      break;
    case "version":
    case "--version":
    case "-v":
      showVersion();
      break;
    case "help":
    case "--help":
    case "-h":
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

// Export server and main for testing or potential programmatic use
export { main, server };

// Run the CLI
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});