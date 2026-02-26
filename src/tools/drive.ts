import { z } from 'zod';
import type { drive_v3 } from 'googleapis';
import { existsSync, statSync, createReadStream } from 'fs';
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, extname, join } from 'path';
import { PDFDocument } from 'pdf-lib';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { errorResponse } from '../types.js';
import { escapeDriveQuery, getMimeTypeFromFilename, TEXT_MIME_TYPES } from '../utils.js';
import { downloadDriveFile } from '../download-file.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

// MIME types for binary file uploads (extension → MIME)
const BINARY_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/opus',
  mp4: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo', mov: 'video/quicktime',
  mkv: 'video/x-matroska', '3gp': 'video/3gpp',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  tar: 'application/x-tar', json: 'application/json', xml: 'application/xml',
  csv: 'text/csv', html: 'text/html', css: 'text/css', js: 'application/javascript',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

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

const ListSharedDrivesSchema = z.object({
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

const CopyFileSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  newName: z.string().optional(),
  parentFolderId: z.string().optional()
});

const UploadFileSchema = z.object({
  localPath: z.string().min(1, "Local file path is required"),
  name: z.string().optional(),
  parentFolderId: z.string().optional(),
  mimeType: z.string().optional()
});

const DownloadFileSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  localPath: z.string().min(1, "Local file path is required"),
  exportMimeType: z.string().optional(),
  overwrite: z.boolean().optional().default(false),
});

const ListPermissionsSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
});

const AddPermissionSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  emailAddress: z.string().email("Valid email is required"),
  role: z.enum(["owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"]).default("reader"),
  type: z.enum(["user", "group", "domain", "anyone"]).default("user"),
  sendNotificationEmail: z.boolean().optional().default(false),
});

const UpdatePermissionSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  permissionId: z.string().min(1, "Permission ID is required"),
  role: z.enum(["owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"]),
});

const RemovePermissionSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  permissionId: z.string().optional(),
  emailAddress: z.string().email("Valid email is required").optional(),
}).superRefine((data, ctx) => {
  if (!data.permissionId && !data.emailAddress) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Either permissionId or emailAddress is required" });
  }
});

const ShareFileSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  emailAddress: z.string().email("Valid email is required"),
  role: z.enum(["writer", "commenter", "reader"]).default("reader"),
  sendNotificationEmail: z.boolean().optional().default(true),
});

const ConvertPdfToGoogleDocSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  newName: z.string().optional(),
  parentFolderId: z.string().optional(),
});

const BulkConvertFolderPdfsSchema = z.object({
  folderId: z.string().min(1, "Folder ID is required"),
  maxResults: z.number().int().min(1).max(200).optional().default(100),
  continueOnError: z.boolean().optional().default(true),
});

const UploadPdfWithSplitSchema = z.object({
  localPath: z.string().min(1, "Local file path is required"),
  split: z.boolean().optional().default(false),
  maxPagesPerChunk: z.number().int().min(1).max(500).optional(),
  parentFolderId: z.string().optional(),
  namePrefix: z.string().optional(),
});

async function splitPdfIntoChunkFiles(localPath: string, maxPagesPerChunk: number): Promise<{ tempDir: string; files: string[] }> {
  const sourceBytes = await readFile(localPath);
  const source = await PDFDocument.load(sourceBytes);
  const pageCount = source.getPageCount();

  if (pageCount === 0) {
    throw new Error('PDF contains no pages.');
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'gdrive-mcp-split-'));
  const files: string[] = [];

  for (let start = 0, part = 1; start < pageCount; start += maxPagesPerChunk, part++) {
    const end = Math.min(start + maxPagesPerChunk, pageCount);
    const chunkDoc = await PDFDocument.create();
    const pages = await chunkDoc.copyPages(source, Array.from({ length: end - start }, (_, i) => start + i));
    for (const page of pages) chunkDoc.addPage(page);

    const chunkBytes = await chunkDoc.save();
    const chunkPath = join(tempDir, `part-${part}.pdf`);
    await writeFile(chunkPath, chunkBytes);
    files.push(chunkPath);
  }

  return { tempDir, files };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const toolDefinitions: ToolDefinition[] = [
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
        parentFolderId: { type: "string", description: "Parent folder ID" }
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
        name: { type: "string", description: "New name (.txt or .md)" }
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
        parent: { type: "string", description: "Parent folder ID or path" }
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
        folderId: { type: "string", description: "Folder ID" },
        pageSize: { type: "number", description: "Items to return (default 50, max 100)" },
        pageToken: { type: "string", description: "Token for next page" }
      }
    }
  },
  {
    name: "listSharedDrives",
    description: "List available Google Shared Drives",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "number", description: "Drives to return (default 50, max 100)" },
        pageToken: { type: "string", description: "Token for next page" }
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
        destinationFolderId: { type: "string", description: "Destination folder ID" }
      },
      required: ["itemId"]
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
    name: "uploadFile",
    description: "Upload a local file (any type: image, audio, video, PDF, etc.) to Google Drive",
    inputSchema: {
      type: "object",
      properties: {
        localPath: { type: "string", description: "Absolute path to the local file to upload" },
        name: { type: "string", description: "File name in Drive (defaults to local filename)" },
        parentFolderId: { type: "string", description: "Parent folder ID or path (e.g., '/Work/Projects'). Creates folders if needed. Defaults to root." },
        mimeType: { type: "string", description: "MIME type (auto-detected from extension if omitted)" }
      },
      required: ["localPath"]
    }
  },
  {
    name: "downloadFile",
    description: "Download a Google Drive file to a local path. For Google Workspace files (Docs, Sheets, Slides, Drawings), exports to the specified format. For regular files, downloads as-is. Streams directly to disk.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID" },
        localPath: { type: "string", description: "Absolute local path to save the file (must start with /). Can be a directory (filename auto-resolved from Drive metadata) or a full file path. Path is normalized before use." },
        exportMimeType: {
          type: "string",
          description: "For Google Workspace files: MIME type to export as (e.g., 'application/pdf', 'text/csv'). Auto-detected from file extension if omitted. Ignored for non-Workspace files."
        },
        overwrite: {
          type: "boolean",
          description: "Whether to overwrite if file already exists at localPath. When false (default), returns an error instead of replacing the file."
        }
      },
      required: ["fileId", "localPath"]
    }
  },
  {
    name: "listPermissions",
    description: "List sharing permissions for a file",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID" }
      },
      required: ["fileId"]
    }
  },
  {
    name: "addPermission",
    description: "Add a sharing permission to a file",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID" },
        emailAddress: { type: "string", description: "Target user/group email" },
        role: { type: "string", enum: ["owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"], description: "Permission role" },
        type: { type: "string", enum: ["user", "group", "domain", "anyone"], description: "Principal type" },
        sendNotificationEmail: { type: "boolean", description: "Send notification email" }
      },
      required: ["fileId", "emailAddress"]
    }
  },
  {
    name: "updatePermission",
    description: "Update an existing permission role",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID" },
        permissionId: { type: "string", description: "Permission ID" },
        role: { type: "string", enum: ["owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"], description: "New role" }
      },
      required: ["fileId", "permissionId", "role"]
    }
  },
  {
    name: "removePermission",
    description: "Remove a permission from a file (by permissionId or emailAddress)",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID" },
        permissionId: { type: "string", description: "Permission ID" },
        emailAddress: { type: "string", description: "User email (alternative to permissionId)" }
      },
      required: ["fileId"]
    }
  },
  {
    name: "shareFile",
    description: "Convenience wrapper to share a file with a user email",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID" },
        emailAddress: { type: "string", description: "User email" },
        role: { type: "string", enum: ["writer", "commenter", "reader"], description: "Access role" },
        sendNotificationEmail: { type: "boolean", description: "Send notification email" }
      },
      required: ["fileId", "emailAddress"]
    }
  },
  {
    name: "convertPdfToGoogleDoc",
    description: "Convert an existing PDF in Drive into an editable Google Doc",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "PDF file ID in Google Drive" },
        newName: { type: "string", description: "Optional name for converted Doc" },
        parentFolderId: { type: "string", description: "Optional destination folder ID" }
      },
      required: ["fileId"]
    }
  },
  {
    name: "bulkConvertFolderPdfs",
    description: "Convert all PDFs in a folder into Google Docs and return per-file results",
    inputSchema: {
      type: "object",
      properties: {
        folderId: { type: "string", description: "Folder ID containing PDFs" },
        maxResults: { type: "number", description: "Maximum PDFs to process (1-200, default: 100)" },
        continueOnError: { type: "boolean", description: "Continue conversion when one file fails (default: true)" }
      },
      required: ["folderId"]
    }
  },
  {
    name: "uploadPdfWithSplit",
    description: "Upload PDF and optionally split into chunked parts (metadata split plan for now)",
    inputSchema: {
      type: "object",
      properties: {
        localPath: { type: "string", description: "Absolute path to local PDF" },
        split: { type: "boolean", description: "Enable split mode" },
        maxPagesPerChunk: { type: "number", description: "Target max pages per chunk (advisory metadata)" },
        parentFolderId: { type: "string", description: "Optional destination folder ID" },
        namePrefix: { type: "string", description: "Optional output name prefix" }
      },
      required: ["localPath"]
    }
  },
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (toolName) {

    case "search": {
      const validation = SearchSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const { query: userQuery, pageSize, pageToken } = validation.data;

      const escapedQuery = escapeDriveQuery(userQuery);
      const formattedQuery = `fullText contains '${escapedQuery}' and trashed = false`;

      const res = await ctx.getDrive().files.list({
        q: formattedQuery,
        pageSize: Math.min(pageSize || 50, 100),
        pageToken: pageToken,
        fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size)",
        corpora: "allDrives",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true
      });

      const fileList = res.data.files?.map((f: drive_v3.Schema$File) => `${f.name} (ID: ${f.id}, ${f.mimeType})`).join("\n") || '';
      ctx.log('Search results', { query: userQuery, resultCount: res.data.files?.length });

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
      const validation = CreateTextFileSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;

      ctx.validateTextFileExtension(data.name);
      const parentFolderId = await ctx.resolveFolderId(data.parentFolderId);

      // Check if file already exists
      const existingFileId = await ctx.checkFileExists(data.name, parentFolderId);
      if (existingFileId) {
        return errorResponse(
          `A file named "${data.name}" already exists in this location. ` +
          `To update it, use updateTextFile with fileId: ${existingFileId}`
        );
      }

      const fileMetadata = {
        name: data.name,
        mimeType: getMimeTypeFromFilename(data.name),
        parents: [parentFolderId]
      };

      const file = await ctx.getDrive().files.create({
        requestBody: fileMetadata,
        media: {
          mimeType: fileMetadata.mimeType,
          body: data.content,
        },
        supportsAllDrives: true
      });

      ctx.log('File created successfully', { fileId: file.data?.id });
      return {
        content: [{
          type: "text",
          text: `Created file: ${file.data?.name || data.name}\nID: ${file.data?.id || 'unknown'}`
        }],
        isError: false
      };
    }

    case "updateTextFile": {
      const validation = UpdateTextFileSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;

      // Check file MIME type
      const existingFile = await ctx.getDrive().files.get({
        fileId: data.fileId,
        fields: 'mimeType, name, parents',
        supportsAllDrives: true
      });

      const currentMimeType = existingFile.data.mimeType || 'text/plain';
      if (!Object.values(TEXT_MIME_TYPES).includes(currentMimeType)) {
        return errorResponse("File is not a text or markdown file.");
      }

      const updateMetadata: { name?: string; mimeType?: string } = {};
      if (data.name) {
        ctx.validateTextFileExtension(data.name);
        updateMetadata.name = data.name;
        updateMetadata.mimeType = getMimeTypeFromFilename(data.name);
      }

      const updatedFile = await ctx.getDrive().files.update({
        fileId: data.fileId,
        requestBody: updateMetadata,
        media: {
          mimeType: updateMetadata.mimeType || currentMimeType,
          body: data.content
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
      const validation = CreateFolderSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;

      const parentFolderId = await ctx.resolveFolderId(data.parent);

      // Check if folder already exists
      const existingFolderId = await ctx.checkFileExists(data.name, parentFolderId);
      if (existingFolderId) {
        return errorResponse(
          `A folder named "${data.name}" already exists in this location. ` +
          `Folder ID: ${existingFolderId}`
        );
      }
      const folderMetadata = {
        name: data.name,
        mimeType: FOLDER_MIME_TYPE,
        parents: [parentFolderId]
      };

      const folder = await ctx.getDrive().files.create({
        requestBody: folderMetadata,
        fields: 'id, name, webViewLink',
        supportsAllDrives: true
      });

      ctx.log('Folder created successfully', { folderId: folder.data.id, name: folder.data.name });

      return {
        content: [{
          type: "text",
          text: `Created folder: ${folder.data.name}\nID: ${folder.data.id}`
        }],
        isError: false
      };
    }

    case "listFolder": {
      const validation = ListFolderSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;

      // Default to root if no folder specified
      const targetFolderId = data.folderId || 'root';

      const res = await ctx.getDrive().files.list({
        q: `'${targetFolderId}' in parents and trashed = false`,
        pageSize: Math.min(data.pageSize || 50, 100),
        pageToken: data.pageToken,
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

    case "listSharedDrives": {
      const validation = ListSharedDrivesSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;

      const res = await ctx.getDrive().drives.list({
        pageSize: Math.min(data.pageSize || 50, 100),
        pageToken: data.pageToken,
        fields: 'nextPageToken, drives(id, name, createdTime, hidden)'
      });

      const drives = res.data.drives || [];
      if (drives.length === 0) {
        return { content: [{ type: 'text', text: 'No shared drives found.' }], isError: false };
      }

      const formatted = drives
        .map((d: drive_v3.Schema$Drive) => `${d.name} (ID: ${d.id}${d.hidden ? ', hidden' : ''})`)
        .join('\n');

      let response = `Found ${drives.length} shared drives:\n${formatted}`;
      if (res.data.nextPageToken) {
        response += `\n\nMore results available. Use pageToken: ${res.data.nextPageToken}`;
      }

      return {
        content: [{ type: 'text', text: response }],
        isError: false,
      };
    }

    case "deleteItem": {
      const validation = DeleteItemSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;

      const item = await ctx.getDrive().files.get({ fileId: data.itemId, fields: 'name', supportsAllDrives: true });

      // Move to trash instead of permanent deletion
      await ctx.getDrive().files.update({
        fileId: data.itemId,
        requestBody: {
          trashed: true
        },
        supportsAllDrives: true
      });

      ctx.log('Item moved to trash successfully', { itemId: data.itemId, name: item.data.name });
      return {
        content: [{ type: "text", text: `Successfully moved to trash: ${item.data.name}` }],
        isError: false
      };
    }

    case "renameItem": {
      const validation = RenameItemSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;

      // If it's a text file, check extension
      const item = await ctx.getDrive().files.get({ fileId: data.itemId, fields: 'name, mimeType', supportsAllDrives: true });
      if (Object.values(TEXT_MIME_TYPES).includes(item.data.mimeType || '')) {
        ctx.validateTextFileExtension(data.newName);
      }

      const updatedItem = await ctx.getDrive().files.update({
        fileId: data.itemId,
        requestBody: { name: data.newName },
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
      const validation = MoveItemSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;

      const destinationFolderId = data.destinationFolderId ?
        await ctx.resolveFolderId(data.destinationFolderId) :
        'root';

      // Check we aren't moving a folder into itself or its descendant
      if (data.destinationFolderId === data.itemId) {
        return errorResponse("Cannot move a folder into itself.");
      }

      const item = await ctx.getDrive().files.get({ fileId: data.itemId, fields: 'name, parents', supportsAllDrives: true });

      // Perform move
      await ctx.getDrive().files.update({
        fileId: data.itemId,
        addParents: destinationFolderId,
        removeParents: item.data.parents?.join(',') || '',
        fields: 'id, name, parents',
        supportsAllDrives: true
      });

      // Get the destination folder name for a nice response
      const destinationFolder = await ctx.getDrive().files.get({
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

    case "copyFile": {
      const validation = CopyFileSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;

      // Get original file info
      const originalFile = await ctx.getDrive().files.get({
        fileId: data.fileId,
        fields: 'name,parents',
        supportsAllDrives: true
      });

      const copyMetadata: any = {
        name: data.newName || `Copy of ${originalFile.data.name}`
      };

      if (data.parentFolderId) {
        copyMetadata.parents = [data.parentFolderId];
      } else if (originalFile.data.parents) {
        copyMetadata.parents = originalFile.data.parents;
      }

      const response = await ctx.getDrive().files.copy({
        fileId: data.fileId,
        requestBody: copyMetadata,
        fields: 'id,name,webViewLink,parents',
        supportsAllDrives: true
      });

      return {
        content: [{ type: "text", text: `Successfully copied file as "${response.data.name}"\nNew file ID: ${response.data.id}\nLink: ${response.data.webViewLink}` }],
        isError: false
      };
    }

    case "uploadFile": {
      const validation = UploadFileSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;

      // Validate local file exists
      if (!existsSync(data.localPath)) {
        return errorResponse(`File not found: ${data.localPath}`);
      }

      const stats = statSync(data.localPath);
      const fileName = data.name || data.localPath.split(/[\\/]/).pop() || 'upload';
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      const detectedMime = data.mimeType || BINARY_MIME_TYPES[ext] || 'application/octet-stream';
      const parentId = await ctx.resolveFolderId(data.parentFolderId);

      ctx.log('Uploading file', { localPath: data.localPath, name: fileName, mimeType: detectedMime, size: stats.size });

      const file = await ctx.getDrive().files.create({
        requestBody: {
          name: fileName,
          parents: [parentId]
        },
        media: {
          mimeType: detectedMime,
          body: createReadStream(data.localPath)
        },
        fields: 'id, name, size, mimeType, webViewLink',
        supportsAllDrives: true
      });

      ctx.log('File uploaded successfully', { fileId: file.data?.id });
      return {
        content: [{
          type: "text",
          text: [
            `Uploaded: ${file.data?.name || fileName}`,
            `ID: ${file.data?.id || 'unknown'}`,
            `Size: ${file.data?.size || stats.size} bytes`,
            `Type: ${file.data?.mimeType || detectedMime}`,
            file.data?.webViewLink ? `Link: ${file.data.webViewLink}` : ''
          ].filter(Boolean).join('\n')
        }],
        isError: false
      };
    }

    case "downloadFile": {
      const validation = DownloadFileSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      const downloadResult = await downloadDriveFile(ctx.getDrive(), data, ctx.log);

      return {
        content: [{
          type: 'text',
          text: [
            `Downloaded: ${downloadResult.driveName}`,
            `Saved to: ${downloadResult.resolvedPath}`,
            `Size: ${downloadResult.size} bytes`,
            downloadResult.isWorkspaceFile
              ? `Export format: ${downloadResult.exportMime}`
              : `Type: ${downloadResult.driveMimeType}`,
          ].join('\n'),
        }],
        isError: false,
      };
    }

    case "listPermissions": {
      const validation = ListPermissionsSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;

      const response = await ctx.getDrive().permissions.list({
        fileId: data.fileId,
        fields: 'permissions(id,type,role,emailAddress,domain,displayName,permissionDetails(inherited,inheritedFrom,permissionType))',
        supportsAllDrives: true,
      });

      const permissions = response.data.permissions || [];
      if (permissions.length === 0) {
        return { content: [{ type: 'text', text: 'No permissions found.' }], isError: false };
      }

      const lines = permissions.map((p) => {
        const who = p.emailAddress || p.domain || p.displayName || p.type || 'unknown';
        const inherited = p.permissionDetails?.some((d) => d.inherited === true) ?? false;
        const inheritedFrom = p.permissionDetails?.find((d) => d.inheritedFrom)?.inheritedFrom;
        const inheritedMarker = inherited
          ? ` [inherited${inheritedFrom ? ` from ${inheritedFrom}` : ''}]`
          : ' [direct]';
        return `- ${p.id}: ${who} (${p.type}) => ${p.role}${inheritedMarker}`;
      });

      return { content: [{ type: 'text', text: `Permissions for file ${data.fileId}:\n${lines.join('\n')}` }], isError: false };
    }

    case "addPermission": {
      const validation = AddPermissionSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;

      const response = await ctx.getDrive().permissions.create({
        fileId: data.fileId,
        requestBody: {
          type: data.type,
          role: data.role,
          emailAddress: data.emailAddress,
        },
        sendNotificationEmail: data.sendNotificationEmail,
        fields: 'id,type,role,emailAddress',
        supportsAllDrives: true,
      });

      return { content: [{ type: 'text', text: `Permission added: ${response.data.id} (${response.data.role}) for ${response.data.emailAddress || data.emailAddress}` }], isError: false };
    }

    case "updatePermission": {
      const validation = UpdatePermissionSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;

      const response = await ctx.getDrive().permissions.update({
        fileId: data.fileId,
        permissionId: data.permissionId,
        requestBody: { role: data.role },
        fields: 'id,type,role,emailAddress',
        supportsAllDrives: true,
      });

      return { content: [{ type: 'text', text: `Permission updated: ${response.data.id} => ${response.data.role}` }], isError: false };
    }

    case "removePermission": {
      const validation = RemovePermissionSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;

      let permissionId: string | undefined = data.permissionId;
      if (!permissionId && data.emailAddress) {
        const listed = await ctx.getDrive().permissions.list({
          fileId: data.fileId,
          fields: 'permissions(id,type,emailAddress)',
          supportsAllDrives: true,
        });
        const found = (listed.data.permissions || []).find(
          (p) => p.type === 'user' && (p.emailAddress || '').toLowerCase() === data.emailAddress!.toLowerCase(),
        );
        if (!found?.id) {
          return errorResponse(`No permission found for ${data.emailAddress}`);
        }
        permissionId = found.id;
      }

      if (!permissionId) {
        return errorResponse("Could not resolve a permission ID to remove");
      }

      await ctx.getDrive().permissions.delete({
        fileId: data.fileId,
        permissionId,
        supportsAllDrives: true,
      });

      return { content: [{ type: 'text', text: `Permission removed: ${permissionId}` }], isError: false };
    }

    case "shareFile": {
      const validation = ShareFileSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;

      // Idempotent behavior: update existing permission for the same principal instead of creating duplicates.
      const existing = await ctx.getDrive().permissions.list({
        fileId: data.fileId,
        fields: 'permissions(id,type,emailAddress,role)',
        supportsAllDrives: true,
      });

      const existingPerm = (existing.data.permissions || []).find(
        (p) => p.type === 'user' && (p.emailAddress || '').toLowerCase() === data.emailAddress.toLowerCase(),
      );

      if (existingPerm?.id) {
        if (existingPerm.role === data.role) {
          return {
            content: [{ type: 'text', text: `No changes needed: ${data.emailAddress} already has role ${data.role}. Permission ID: ${existingPerm.id}` }],
            isError: false,
          };
        }

        const updated = await ctx.getDrive().permissions.update({
          fileId: data.fileId,
          permissionId: existingPerm.id,
          requestBody: { role: data.role },
          fields: 'id,type,role,emailAddress',
          supportsAllDrives: true,
        });

        return {
          content: [{ type: 'text', text: `Updated existing permission for ${updated.data.emailAddress || data.emailAddress} to ${updated.data.role}. Permission ID: ${updated.data.id}` }],
          isError: false,
        };
      }

      const response = await ctx.getDrive().permissions.create({
        fileId: data.fileId,
        requestBody: {
          type: 'user',
          role: data.role,
          emailAddress: data.emailAddress,
        },
        sendNotificationEmail: data.sendNotificationEmail,
        fields: 'id,type,role,emailAddress',
        supportsAllDrives: true,
      });

      return {
        content: [{ type: 'text', text: `Shared file with ${response.data.emailAddress || data.emailAddress} as ${response.data.role}. Permission ID: ${response.data.id}` }],
        isError: false,
      };
    }

    case "convertPdfToGoogleDoc": {
      const validation = ConvertPdfToGoogleDocSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;

      const source = await ctx.getDrive().files.get({
        fileId: data.fileId,
        fields: 'id,name,mimeType,parents',
        supportsAllDrives: true,
      });

      if (source.data.mimeType !== 'application/pdf') {
        return errorResponse(`File ${data.fileId} is not a PDF (mimeType=${source.data.mimeType || 'unknown'})`);
      }

      const parentId = data.parentFolderId || source.data.parents?.[0];
      const converted = await ctx.getDrive().files.copy({
        fileId: data.fileId,
        requestBody: {
          name: data.newName || `${source.data.name || 'Converted PDF'} (Doc)`,
          mimeType: 'application/vnd.google-apps.document',
          ...(parentId ? { parents: [parentId] } : {}),
        },
        fields: 'id,name,webViewLink,mimeType',
        supportsAllDrives: true,
      });

      return { content: [{ type: 'text', text: `Converted PDF to Google Doc: ${converted.data.name}\nID: ${converted.data.id}\nLink: ${converted.data.webViewLink}` }], isError: false };
    }

    case "bulkConvertFolderPdfs": {
      const validation = BulkConvertFolderPdfsSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;

      const list = await ctx.getDrive().files.list({
        q: `'${escapeDriveQuery(data.folderId)}' in parents and mimeType='application/pdf' and trashed=false`,
        pageSize: data.maxResults,
        fields: 'files(id,name,mimeType)',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });

      const files = list.data.files || [];
      const results: Array<{ id?: string; name?: string; docId?: string; ok: boolean; error?: string }> = [];

      // Sequential processing is intentional — parallel copies trigger Google API rate limits.
      for (const f of files) {
        try {
          const converted = await ctx.getDrive().files.copy({
            fileId: f.id!,
            requestBody: {
              name: `${f.name || 'Converted PDF'} (Doc)`,
              mimeType: 'application/vnd.google-apps.document',
              parents: [data.folderId],
            },
            fields: 'id,name',
            supportsAllDrives: true,
          });
          results.push({ id: f.id || undefined, name: f.name || undefined, docId: converted.data.id || undefined, ok: true });
        } catch (err: any) {
          const message = err?.message || 'Unknown conversion error';
          results.push({ id: f.id || undefined, name: f.name || undefined, ok: false, error: message });
          if (!data.continueOnError) break;
        }
      }

      const ok = results.filter(r => r.ok).length;
      const fail = results.length - ok;
      return {
        content: [{ type: 'text', text: `Bulk PDF conversion finished. Processed=${results.length}, Success=${ok}, Failed=${fail}\n\n${results.map(r => r.ok ? `✅ ${r.name} -> ${r.docId}` : `❌ ${r.name}: ${r.error}`).join('\n')}` }],
        isError: false,
      };
    }

    case "uploadPdfWithSplit": {
      const validation = UploadPdfWithSplitSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;

      if (!existsSync(data.localPath)) return errorResponse(`File not found: ${data.localPath}`);
      const parentId = await ctx.resolveFolderId(data.parentFolderId);

      if (!data.split) {
        const fileName = data.namePrefix || data.localPath.split(/[\\/]/).pop() || 'upload.pdf';
        const uploaded = await ctx.getDrive().files.create({
          requestBody: { name: fileName, parents: [parentId] },
          media: { mimeType: 'application/pdf', body: createReadStream(data.localPath) },
          fields: 'id,name,webViewLink',
          supportsAllDrives: true,
        });

        return {
          content: [{ type: 'text', text: `Uploaded PDF without split: ${uploaded.data.name}\nID: ${uploaded.data.id}` }],
          isError: false,
        };
      }

      const maxPagesPerChunk = data.maxPagesPerChunk ?? 25;
      const baseName = data.namePrefix || basename(data.localPath, extname(data.localPath));

      let tempDir: string | undefined;
      try {
        const splitResult = await splitPdfIntoChunkFiles(data.localPath, maxPagesPerChunk);
        tempDir = splitResult.tempDir;

        const uploadedParts: Array<{ id?: string | null; name?: string | null }> = [];
        for (let i = 0; i < splitResult.files.length; i++) {
          const partPath = splitResult.files[i];
          const partName = `${baseName}-part-${i + 1}.pdf`;

          const uploaded = await ctx.getDrive().files.create({
            requestBody: { name: partName, parents: [parentId] },
            media: { mimeType: 'application/pdf', body: createReadStream(partPath) },
            fields: 'id,name,webViewLink',
            supportsAllDrives: true,
          });

          uploadedParts.push({ id: uploaded.data.id, name: uploaded.data.name });
        }

        const lines = uploadedParts.map((p, idx) => `- part ${idx + 1}: ${p.name} (ID: ${p.id})`);
        return {
          content: [{
            type: 'text',
            text: `Uploaded split PDF into ${uploadedParts.length} part(s) using maxPagesPerChunk=${maxPagesPerChunk}\n${lines.join('\n')}`,
          }],
          isError: false,
        };
      } finally {
        if (tempDir) {
          await rm(tempDir, { recursive: true, force: true });
        }
      }
    }

    default:
      return null;
  }
}
