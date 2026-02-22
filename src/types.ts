import type { drive_v3, calendar_v3 } from 'googleapis';
import type { google as GoogleApisType } from 'googleapis';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  authClient: any;
  google: typeof GoogleApisType;
  getDrive: () => drive_v3.Drive;
  getCalendar: () => calendar_v3.Calendar;
  log: (message: string, data?: any) => void;
  resolvePath: (pathStr: string) => Promise<string>;
  resolveFolderId: (input: string | undefined) => Promise<string>;
  checkFileExists: (name: string, parentFolderId?: string) => Promise<string | null>;
  validateTextFileExtension: (name: string) => void;
}

export function errorResponse(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}
