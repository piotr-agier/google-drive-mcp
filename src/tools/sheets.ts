import { z } from 'zod';
import type { ToolDefinition, ToolResult, ToolContext } from '../types.js';
import { errorResponse } from '../types.js';
import { parseA1Range, convertA1ToGridRange, escapeDriveQuery } from '../utils.js';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const CreateGoogleSheetSchema = z.object({
  name: z.string().min(1, "Sheet name is required"),
  data: z.array(z.array(z.string())),
  parentFolderId: z.string().optional(),
  valueInputOption: z.enum(["RAW", "USER_ENTERED"]).optional()
});

const UpdateGoogleSheetSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  range: z.string().min(1, "Range is required"),
  data: z.array(z.array(z.string())),
  valueInputOption: z.enum(["RAW", "USER_ENTERED"]).optional()
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

const ListSheetsSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required")
});

const RenameSheetSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  sheetId: z.number().int(),
  newTitle: z.string().min(1, "New title is required")
});

const DeleteSheetSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  sheetId: z.number().int()
});

const AddDataValidationSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  range: z.string().min(1, "Range is required"),
  conditionType: z.enum(["ONE_OF_LIST", "NUMBER_GREATER", "NUMBER_LESS", "TEXT_CONTAINS"]),
  values: z.array(z.string()).optional(),
  strict: z.boolean().optional().default(true),
  showCustomUi: z.boolean().optional().default(true)
});

const ProtectRangeSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  range: z.string().min(1, "Range is required"),
  description: z.string().optional(),
  warningOnly: z.boolean().optional().default(false)
});

const AddNamedRangeSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  name: z.string().min(1, "Name is required"),
  range: z.string().min(1, "Range is required")
});

const ListGoogleSheetsSchema = z.object({
  maxResults: z.number().int().min(1).max(100).optional().default(20),
  query: z.string().optional(),
  orderBy: z.enum(["name", "modifiedTime", "createdTime"]).optional().default("modifiedTime")
});

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "createGoogleSheet",
    description: "Create a new Google Sheet. By default uses RAW mode which stores values as-is. Set valueInputOption to 'USER_ENTERED' only when you need formulas to be evaluated.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Sheet name" },
        data: {
          type: "array",
          description: "Data as array of arrays",
          items: { type: "array", items: { type: "string" } }
        },
        parentFolderId: { type: "string", description: "Parent folder ID (defaults to root)" },
        valueInputOption: {
          type: "string",
          enum: ["RAW", "USER_ENTERED"],
          description: "RAW (default): Values stored exactly as provided - formulas stored as text strings. Safe for untrusted data. USER_ENTERED: Values parsed like spreadsheet UI - formulas (=SUM, =IF, etc.) are evaluated. SECURITY WARNING: USER_ENTERED can execute formulas, only use with trusted data, never with user-provided input that could contain malicious formulas like =IMPORTDATA() or =IMPORTRANGE()."
        }
      },
      required: ["name", "data"]
    }
  },
  {
    name: "updateGoogleSheet",
    description: "Update an existing Google Sheet. By default uses RAW mode which stores values as-is. Set valueInputOption to 'USER_ENTERED' only when you need formulas to be evaluated.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Sheet ID" },
        range: { type: "string", description: "Range to update (e.g., 'Sheet1!A1:C10')" },
        data: {
          type: "array",
          description: "2D array of values to write",
          items: { type: "array", items: { type: "string" } }
        },
        valueInputOption: {
          type: "string",
          enum: ["RAW", "USER_ENTERED"],
          description: "RAW (default): Values stored exactly as provided - formulas stored as text strings. Safe for untrusted data. USER_ENTERED: Values parsed like spreadsheet UI - formulas (=SUM, =IF, etc.) are evaluated. SECURITY WARNING: USER_ENTERED can execute formulas, only use with trusted data, never with user-provided input that could contain malicious formulas like =IMPORTDATA() or =IMPORTRANGE()."
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
            red: { type: "number" },
            green: { type: "number" },
            blue: { type: "number" }
          }
        },
        horizontalAlignment: {
          type: "string",
          description: "Horizontal alignment",
          enum: ["LEFT", "CENTER", "RIGHT"]
        },
        verticalAlignment: {
          type: "string",
          description: "Vertical alignment",
          enum: ["TOP", "MIDDLE", "BOTTOM"]
        },
        wrapStrategy: {
          type: "string",
          description: "Text wrapping",
          enum: ["OVERFLOW_CELL", "CLIP", "WRAP"]
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
        bold: { type: "boolean", description: "Make text bold" },
        italic: { type: "boolean", description: "Make text italic" },
        strikethrough: { type: "boolean", description: "Strikethrough text" },
        underline: { type: "boolean", description: "Underline text" },
        fontSize: { type: "number", description: "Font size in points" },
        fontFamily: { type: "string", description: "Font family name" },
        foregroundColor: {
          type: "object",
          description: "Text color (RGB values 0-1)",
          properties: {
            red: { type: "number" },
            green: { type: "number" },
            blue: { type: "number" }
          }
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
          enum: ["NUMBER", "CURRENCY", "PERCENT", "DATE", "TIME", "DATE_TIME", "SCIENTIFIC"]
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
        width: { type: "number", description: "Border width (1-3)" },
        color: {
          type: "object",
          description: "Border color (RGB values 0-1)",
          properties: {
            red: { type: "number" },
            green: { type: "number" },
            blue: { type: "number" }
          }
        },
        top: { type: "boolean", description: "Apply to top border" },
        bottom: { type: "boolean", description: "Apply to bottom border" },
        left: { type: "boolean", description: "Apply to left border" },
        right: { type: "boolean", description: "Apply to right border" },
        innerHorizontal: { type: "boolean", description: "Apply to inner horizontal borders" },
        innerVertical: { type: "boolean", description: "Apply to inner vertical borders" }
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
                red: { type: "number" },
                green: { type: "number" },
                blue: { type: "number" }
              }
            },
            textFormat: {
              type: "object",
              properties: {
                bold: { type: "boolean" },
                foregroundColor: {
                  type: "object",
                  properties: {
                    red: { type: "number" },
                    green: { type: "number" },
                    blue: { type: "number" }
                  }
                }
              }
            }
          }
        }
      },
      required: ["spreadsheetId", "range", "condition", "format"]
    }
  },
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
    name: "listSheets",
    description: "List tabs/sheets in a Google Spreadsheet",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" }
      },
      required: ["spreadsheetId"]
    }
  },
  {
    name: "renameSheet",
    description: "Rename a sheet/tab by sheetId",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        sheetId: { type: "number", description: "Sheet ID" },
        newTitle: { type: "string", description: "New title" }
      },
      required: ["spreadsheetId", "sheetId", "newTitle"]
    }
  },
  {
    name: "deleteSheet",
    description: "Delete a sheet/tab by sheetId",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        sheetId: { type: "number", description: "Sheet ID" }
      },
      required: ["spreadsheetId", "sheetId"]
    }
  },
  {
    name: "addDataValidation",
    description: "Add data validation rules to a sheet range",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        range: { type: "string", description: "A1 range" },
        conditionType: { type: "string", enum: ["ONE_OF_LIST", "NUMBER_GREATER", "NUMBER_LESS", "TEXT_CONTAINS"], description: "Validation condition type" },
        values: { type: "array", items: { type: "string" }, description: "Condition values (required for ONE_OF_LIST)" },
        strict: { type: "boolean", description: "Reject invalid values" },
        showCustomUi: { type: "boolean", description: "Show dropdown/custom UI" }
      },
      required: ["spreadsheetId", "range", "conditionType"]
    }
  },
  {
    name: "protectRange",
    description: "Protect a range in a spreadsheet",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        range: { type: "string", description: "A1 range" },
        description: { type: "string", description: "Protection description" },
        warningOnly: { type: "boolean", description: "Warn instead of enforce" }
      },
      required: ["spreadsheetId", "range"]
    }
  },
  {
    name: "addNamedRange",
    description: "Create a named range",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        name: { type: "string", description: "Named range name" },
        range: { type: "string", description: "A1 range" }
      },
      required: ["spreadsheetId", "name", "range"]
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
  }
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult | null> {
  switch (toolName) {
    case "createGoogleSheet": {
      const validation = CreateGoogleSheetSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const parentFolderId = await ctx.resolveFolderId(a.parentFolderId);

      // Check if spreadsheet already exists
      const existingFileId = await ctx.checkFileExists(a.name, parentFolderId);
      if (existingFileId) {
        return errorResponse(
          `A spreadsheet named "${a.name}" already exists in this location. ` +
          `To update it, use updateGoogleSheet with spreadsheetId: ${existingFileId}`
        );
      }
      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });

      // Create spreadsheet with initial sheet
      const spreadsheet = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: a.name },
          sheets: [{
            properties: {
              sheetId: 0,
              title: 'Sheet1',
              gridProperties: {
                rowCount: Math.max(a.data.length, 1000),
                columnCount: Math.max(a.data[0]?.length || 0, 26)
              }
            }
          }]
        }
      });

      await ctx.getDrive().files.update({
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
        valueInputOption: a.valueInputOption || 'RAW',
        requestBody: { values: a.data }
      });

      return {
        content: [{ type: "text", text: `Created Google Sheet: ${a.name}\nID: ${spreadsheet.data.spreadsheetId}` }],
        isError: false
      };
    }

    case "updateGoogleSheet": {
      const validation = UpdateGoogleSheetSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      await sheets.spreadsheets.values.update({
        spreadsheetId: a.spreadsheetId,
        range: a.range,
        valueInputOption: a.valueInputOption || 'RAW',
        requestBody: { values: a.data }
      });

      return {
        content: [{ type: "text", text: `Updated Google Sheet range: ${a.range}` }],
        isError: false
      };
    }

    case "getGoogleSheetContent": {
      const validation = GetGoogleSheetContentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: a.spreadsheetId,
        range: a.range
      });

      const values = response.data.values || [];
      let content = `Content for range ${a.range}:\n\n`;

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
      const validation = FormatGoogleSheetCellsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });

      // Parse the range to get sheet ID and grid range
      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: 'sheets(properties(sheetId,title))'
      });

      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);

      const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);

      if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }

      // Parse A1 notation to grid range
      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

      const requests: any[] = [{
        repeatCell: {
          range: gridRange,
          cell: {
            userEnteredFormat: {
              ...(a.backgroundColor && {
                backgroundColor: {
                  red: a.backgroundColor.red || 0,
                  green: a.backgroundColor.green || 0,
                  blue: a.backgroundColor.blue || 0
                }
              }),
              ...(a.horizontalAlignment && { horizontalAlignment: a.horizontalAlignment }),
              ...(a.verticalAlignment && { verticalAlignment: a.verticalAlignment }),
              ...(a.wrapStrategy && { wrapStrategy: a.wrapStrategy })
            }
          },
          fields: [
            a.backgroundColor && 'userEnteredFormat.backgroundColor',
            a.horizontalAlignment && 'userEnteredFormat.horizontalAlignment',
            a.verticalAlignment && 'userEnteredFormat.verticalAlignment',
            a.wrapStrategy && 'userEnteredFormat.wrapStrategy'
          ].filter(Boolean).join(',')
        }
      }];

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: { requests }
      });

      return {
        content: [{ type: "text", text: `Formatted cells in range ${a.range}` }],
        isError: false
      };
    }

    case "formatGoogleSheetText": {
      const validation = FormatGoogleSheetTextSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });

      // Get sheet information
      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: 'sheets(properties(sheetId,title))'
      });

      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);
      const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
      if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }

      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

      const textFormat: any = {};
      const fields: string[] = [];

      if (a.bold !== undefined) {
        textFormat.bold = a.bold;
        fields.push('bold');
      }
      if (a.italic !== undefined) {
        textFormat.italic = a.italic;
        fields.push('italic');
      }
      if (a.strikethrough !== undefined) {
        textFormat.strikethrough = a.strikethrough;
        fields.push('strikethrough');
      }
      if (a.underline !== undefined) {
        textFormat.underline = a.underline;
        fields.push('underline');
      }
      if (a.fontSize !== undefined) {
        textFormat.fontSize = a.fontSize;
        fields.push('fontSize');
      }
      if (a.fontFamily !== undefined) {
        textFormat.fontFamily = a.fontFamily;
        fields.push('fontFamily');
      }
      if (a.foregroundColor) {
        textFormat.foregroundColor = {
          red: a.foregroundColor.red || 0,
          green: a.foregroundColor.green || 0,
          blue: a.foregroundColor.blue || 0
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
        spreadsheetId: a.spreadsheetId,
        requestBody: { requests }
      });

      return {
        content: [{ type: "text", text: `Applied text formatting to range ${a.range}` }],
        isError: false
      };
    }

    case "formatGoogleSheetNumbers": {
      const validation = FormatGoogleSheetNumbersSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });

      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: 'sheets(properties(sheetId,title))'
      });

      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);
      const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
      if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }

      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

      const numberFormat: any = {
        pattern: a.pattern
      };
      if (a.type) {
        numberFormat.type = a.type;
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
        spreadsheetId: a.spreadsheetId,
        requestBody: { requests }
      });

      return {
        content: [{ type: "text", text: `Applied number formatting to range ${a.range}` }],
        isError: false
      };
    }

    case "setGoogleSheetBorders": {
      const validation = SetGoogleSheetBordersSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });

      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: 'sheets(properties(sheetId,title))'
      });

      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);
      const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
      if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }

      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

      const border = {
        style: a.style,
        width: a.width || 1,
        color: a.color ? {
          red: a.color.red || 0,
          green: a.color.green || 0,
          blue: a.color.blue || 0
        } : undefined
      };

      const updateBordersRequest: any = {
        updateBorders: {
          range: gridRange
        }
      };

      if (a.top !== false) updateBordersRequest.updateBorders.top = border;
      if (a.bottom !== false) updateBordersRequest.updateBorders.bottom = border;
      if (a.left !== false) updateBordersRequest.updateBorders.left = border;
      if (a.right !== false) updateBordersRequest.updateBorders.right = border;
      if (a.innerHorizontal) updateBordersRequest.updateBorders.innerHorizontal = border;
      if (a.innerVertical) updateBordersRequest.updateBorders.innerVertical = border;

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: { requests: [updateBordersRequest] }
      });

      return {
        content: [{ type: "text", text: `Set borders for range ${a.range}` }],
        isError: false
      };
    }

    case "mergeGoogleSheetCells": {
      const validation = MergeGoogleSheetCellsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });

      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: 'sheets(properties(sheetId,title))'
      });

      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);
      const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
      if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }

      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

      const requests = [{
        mergeCells: {
          range: gridRange,
          mergeType: a.mergeType
        }
      }];

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: { requests }
      });

      return {
        content: [{ type: "text", text: `Merged cells in range ${a.range} with type ${a.mergeType}` }],
        isError: false
      };
    }

    case "addGoogleSheetConditionalFormat": {
      const validation = AddGoogleSheetConditionalFormatSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });

      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: 'sheets(properties(sheetId,title))'
      });

      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);
      const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
      if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }

      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

      // Build condition based on type
      const booleanCondition: any = {};
      switch (a.condition.type) {
        case 'NUMBER_GREATER':
          booleanCondition.type = 'NUMBER_GREATER';
          booleanCondition.values = [{ userEnteredValue: a.condition.value }];
          break;
        case 'NUMBER_LESS':
          booleanCondition.type = 'NUMBER_LESS';
          booleanCondition.values = [{ userEnteredValue: a.condition.value }];
          break;
        case 'TEXT_CONTAINS':
          booleanCondition.type = 'TEXT_CONTAINS';
          booleanCondition.values = [{ userEnteredValue: a.condition.value }];
          break;
        case 'TEXT_STARTS_WITH':
          booleanCondition.type = 'TEXT_STARTS_WITH';
          booleanCondition.values = [{ userEnteredValue: a.condition.value }];
          break;
        case 'TEXT_ENDS_WITH':
          booleanCondition.type = 'TEXT_ENDS_WITH';
          booleanCondition.values = [{ userEnteredValue: a.condition.value }];
          break;
        case 'CUSTOM_FORMULA':
          booleanCondition.type = 'CUSTOM_FORMULA';
          booleanCondition.values = [{ userEnteredValue: a.condition.value }];
          break;
      }

      const format: any = {};
      if (a.format.backgroundColor) {
        format.backgroundColor = {
          red: a.format.backgroundColor.red || 0,
          green: a.format.backgroundColor.green || 0,
          blue: a.format.backgroundColor.blue || 0
        };
      }
      if (a.format.textFormat) {
        format.textFormat = {};
        if (a.format.textFormat.bold !== undefined) {
          format.textFormat.bold = a.format.textFormat.bold;
        }
        if (a.format.textFormat.foregroundColor) {
          format.textFormat.foregroundColor = {
            red: a.format.textFormat.foregroundColor.red || 0,
            green: a.format.textFormat.foregroundColor.green || 0,
            blue: a.format.textFormat.foregroundColor.blue || 0
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
        spreadsheetId: a.spreadsheetId,
        requestBody: { requests }
      });

      return {
        content: [{ type: "text", text: `Added conditional formatting to range ${a.range}` }],
        isError: false
      };
    }

    case "getSpreadsheetInfo": {
      const validation = GetSpreadsheetInfoSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      const response = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
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
      const validation = AppendSpreadsheetRowsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId: a.spreadsheetId,
        range: a.range,
        valueInputOption: a.valueInputOption || 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: a.values }
      });

      const updatedCells = response.data.updates?.updatedCells || 0;
      const updatedRows = response.data.updates?.updatedRows || 0;
      const updatedRange = response.data.updates?.updatedRange || a.range;

      return {
        content: [{ type: "text", text: `Successfully appended ${updatedRows} row(s) (${updatedCells} cells) to spreadsheet. Updated range: ${updatedRange}` }],
        isError: false
      };
    }

    case "addSpreadsheetSheet": {
      const validation = AddSpreadsheetSheetSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title: a.sheetTitle
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

    case "listSheets": {
      const validation = ListSheetsSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      const response = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        fields: 'sheets.properties(sheetId,title,index,hidden)'
      });

      const tabs = response.data.sheets || [];
      if (tabs.length === 0) {
        return { content: [{ type: 'text', text: 'No sheets found.' }], isError: false };
      }

      const lines = tabs.map((s) => `- ${s.properties?.title} (id: ${s.properties?.sheetId}, index: ${s.properties?.index}${s.properties?.hidden ? ', hidden' : ''})`);
      return { content: [{ type: 'text', text: `Sheets in spreadsheet ${a.spreadsheetId}:\n${lines.join('\n')}` }], isError: false };
    }

    case "renameSheet": {
      const validation = RenameSheetSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: {
          requests: [{
            updateSheetProperties: {
              properties: { sheetId: a.sheetId, title: a.newTitle },
              fields: 'title'
            }
          }]
        }
      });

      return { content: [{ type: 'text', text: `Renamed sheet ${a.sheetId} to "${a.newTitle}".` }], isError: false };
    }

    case "deleteSheet": {
      const validation = DeleteSheetSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: {
          requests: [{
            deleteSheet: { sheetId: a.sheetId }
          }]
        }
      });

      return { content: [{ type: 'text', text: `Deleted sheet ${a.sheetId}.` }], isError: false };
    }

    case "addDataValidation": {
      const validation = AddDataValidationSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });

      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: 'sheets(properties(sheetId,title))'
      });
      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);
      const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
      if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }
      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

      const conditionValues = (a.values || []).map(v => ({ userEnteredValue: v }));
      if (a.conditionType === 'ONE_OF_LIST' && conditionValues.length === 0) {
        return errorResponse('values are required when conditionType is ONE_OF_LIST');
      }

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: {
          requests: [{
            setDataValidation: {
              range: gridRange,
              rule: {
                condition: {
                  type: a.conditionType,
                  values: conditionValues,
                },
                strict: a.strict,
                showCustomUi: a.showCustomUi,
              },
            },
          }],
        },
      });

      return { content: [{ type: 'text', text: `Added data validation (${a.conditionType}) to ${a.range}.` }], isError: false };
    }

    case "protectRange": {
      const validation = ProtectRangeSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: 'sheets(properties(sheetId,title))'
      });
      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);
      const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
      if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }
      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: {
          requests: [{
            addProtectedRange: {
              protectedRange: {
                range: gridRange,
                description: a.description,
                warningOnly: a.warningOnly,
              },
            },
          }],
        },
      });

      const protectedRangeId = response.data.replies?.[0]?.addProtectedRange?.protectedRange?.protectedRangeId;
      return { content: [{ type: 'text', text: `Protected range ${a.range}${protectedRangeId ? ` (id: ${protectedRangeId})` : ''}.` }], isError: false };
    }

    case "addNamedRange": {
      const validation = AddNamedRangeSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: 'sheets(properties(sheetId,title))'
      });
      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);
      const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
      if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }
      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId!);

      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: {
          requests: [{
            addNamedRange: {
              namedRange: {
                name: a.name,
                range: gridRange,
              },
            },
          }],
        },
      });

      const namedRangeId = response.data.replies?.[0]?.addNamedRange?.namedRange?.namedRangeId;
      return { content: [{ type: 'text', text: `Added named range "${a.name}" for ${a.range}${namedRangeId ? ` (id: ${namedRangeId})` : ''}.` }], isError: false };
    }

    case "listGoogleSheets": {
      const validation = ListGoogleSheetsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      let queryString = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
      if (a.query) {
        const escapedQuery = escapeDriveQuery(a.query);
        queryString += ` and (name contains '${escapedQuery}' or fullText contains '${escapedQuery}')`;
      }

      const response = await ctx.getDrive().files.list({
        q: queryString,
        pageSize: a.maxResults || 20,
        orderBy: a.orderBy === 'name' ? 'name' : a.orderBy,
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

    default:
      return null;
  }
}
