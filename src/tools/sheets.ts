import { z } from 'zod';
import type { sheets_v4 } from 'googleapis';
import type { ToolDefinition, ToolResult, ToolContext } from '../types.js';
import { errorResponse } from '../types.js';
import { parseA1Range, convertA1ToGridRange, escapeDriveQuery, ALL_DRIVES_LIST_PARAMS, DRIVE_ORDER_BY_VALUES, type GridRange } from '../utils.js';
import {
  CELL_FIELDS, DEFAULT_CELL_FIELDS, SHEET_METADATA, buildFieldMask, collectSheetMetadata,
  extractRanges, matchRangesToGridData, type SheetLike,
} from './sheetCells.js';
import { withRetry } from '../utils/retry.js';

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

// One call, many ranges. Field names follow the API's own ValueRange shape
// ({range, values}) rather than updateGoogleSheet's `data`, so the nesting does
// not read as `data[].data` and matches what the batch endpoint documents.
const BatchUpdateGoogleSheetValuesSchema = z.object({
  // required_error as well as min(): on a missing key Zod reports a bare
  // "Required", which tells a caller nothing about which field it means.
  spreadsheetId: z.string({ required_error: "Spreadsheet ID is required" })
    .min(1, "Spreadsheet ID is required"),
  updates: z.array(z.object({
    range: z.string({ required_error: "Range is required" }).min(1, "Range is required"),
    values: z.array(z.array(z.string()), { required_error: "Values are required" })
  }), { required_error: "At least one update is required" })
    .min(1, "At least one update is required"),
  valueInputOption: z.enum(["RAW", "USER_ENTERED"]).optional()
});

const GetGoogleSheetContentSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  range: z.string().min(1, "Range is required"),
  valueRenderOption: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).optional().default("FORMATTED_VALUE")
});

const GetGoogleSheetCellsSchema = z.object({
  spreadsheetId: z.string({ required_error: "Spreadsheet ID is required" }).min(1, "Spreadsheet ID is required"),
  ranges: z.array(z.string().min(1), { required_error: "At least one range is required" })
    .min(1, "At least one range is required"),
  fields: z.array(z.enum(CELL_FIELDS)).optional()
    .default([...DEFAULT_CELL_FIELDS]),
  sheetMetadata: z.array(z.enum(SHEET_METADATA)).optional().default([]),
  includeEmpty: z.boolean().optional().default(false),
  maxCells: z.number().int().min(1).max(100000).optional().default(2000),
  maxBytes: z.number().int().min(1024).max(4 * 1024 * 1024).optional().default(131072)
});

// The dimension tools (hide/show and the outline groups) address whole
// rows/columns, so they take a DimensionRange (sheetId + index span) rather
// than the A1 `range` the cell-oriented tools use. Indices are 0-based and the
// interval is half-open.
const dimensionRangeFields = {
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  sheetId: z.number().int(),
  dimension: z.enum(["COLUMNS", "ROWS"]),
  startIndex: z.number().int().min(0),
  endIndex: z.number().int().min(0)
};

const startBeforeEnd = {
  check: (a: { startIndex: number; endIndex: number }) => a.startIndex < a.endIndex,
  message: "startIndex must be less than endIndex"
};

/** Shared by hideSheetDimension, showSheetDimension, addDimensionGroup and deleteDimensionGroup. */
const DimensionRangeSchema = z.object(dimensionRangeFields)
  .refine(startBeforeEnd.check, { message: startBeforeEnd.message });

const UpdateDimensionGroupSchema = z.object({
  ...dimensionRangeFields,
  depth: z.number().int().min(1, "depth must be at least 1").optional().default(1),
  collapsed: z.boolean()
}).refine(startBeforeEnd.check, { message: startBeforeEnd.message });

const ListDimensionGroupsSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  sheetId: z.number().int().optional()
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

const AddSheetSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  title: z.string().min(1, "Sheet title is required")
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
  conditionType: z.enum(["ONE_OF_LIST", "ONE_OF_RANGE", "NUMBER_GREATER", "NUMBER_LESS", "TEXT_CONTAINS"]),
  values: z.array(z.string()).min(1, "At least one value is required"),
  strict: z.boolean().optional().default(true),
  showCustomUi: z.boolean().optional().default(true)
}).refine(
  a => a.conditionType !== "ONE_OF_RANGE" || a.values.length === 1,
  { message: "ONE_OF_RANGE takes exactly one value: the source range (e.g. 'Reference!A2:A50')" }
);

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
  orderBy: z.enum(DRIVE_ORDER_BY_VALUES).optional().default("modifiedTime desc")
});

const SetColumnWidthSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  sheetId: z.number().int(),
  startColumn: z.number().int().min(0),
  endColumn: z.number().int().min(0),
  pixelSize: z.number().int().min(0, "pixelSize must be >= 0")
}).refine(a => a.startColumn < a.endColumn, { message: "startColumn must be less than endColumn" });

const SetRowHeightSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  sheetId: z.number().int(),
  startRow: z.number().int().min(0),
  endRow: z.number().int().min(0),
  pixelSize: z.number().int().min(0, "pixelSize must be >= 0")
}).refine(a => a.startRow < a.endRow, { message: "startRow must be less than endRow" });

const AutoResizeColumnsSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  sheetId: z.number().int(),
  startColumn: z.number().int().min(0),
  endColumn: z.number().int().min(0)
}).refine(a => a.startColumn < a.endColumn, { message: "startColumn must be less than endColumn" });

const AutoResizeRowsSchema = z.object({
  spreadsheetId: z.string().min(1, "Spreadsheet ID is required"),
  sheetId: z.number().int(),
  startRow: z.number().int().min(0),
  endRow: z.number().int().min(0)
}).refine(a => a.startRow < a.endRow, { message: "startRow must be less than endRow" });

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
    name: "batchUpdateGoogleSheetValues",
    description: "Write many ranges in ONE call via spreadsheets.values.batchUpdate. Ranges may sit on different sheets of the same spreadsheet. Prefer this over repeated updateGoogleSheet calls whenever more than one range changes: N separate writes cost N round trips and N units of the per-minute write quota, while one batch costs one of each.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Sheet ID" },
        updates: {
          type: "array",
          description: "Ranges to write, each a {range, values} pair. The API does not document precedence for overlapping ranges, so do not overlap them.",
          items: {
            type: "object",
            properties: {
              range: { type: "string", description: "Range to update (e.g., 'Sheet1!A1:C10')" },
              values: {
                type: "array",
                description: "2D array of values to write into this range",
                items: { type: "array", items: { type: "string" } }
              }
            },
            required: ["range", "values"]
          }
        },
        valueInputOption: {
          type: "string",
          enum: ["RAW", "USER_ENTERED"],
          description: "Applies to every range in the batch. RAW (default): values stored exactly as provided - formulas stored as text strings. Safe for untrusted data. USER_ENTERED: values parsed like the spreadsheet UI - formulas (=SUM, =IF, etc.) are evaluated. SECURITY WARNING: USER_ENTERED can execute formulas, only use with trusted data, never with user-provided input that could contain malicious formulas like =IMPORTDATA() or =IMPORTRANGE()."
        }
      },
      required: ["spreadsheetId", "updates"]
    }
  },
  {
    name: "getGoogleSheetContent",
    description: "Get content of a Google Sheet with cell information. Each row is returned as 'Row N: ' followed by that row's cells separated by tab characters. Returns displayed values by default; set valueRenderOption to 'FORMULA' to read the underlying formulas (e.g. '=SUM(A1:A10)') instead of their results, or 'UNFORMATTED_VALUE' for raw numbers without display formatting. Under UNFORMATTED_VALUE a date or time cell comes back as a spreadsheet serial number (e.g. 45678), not a date string.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        range: { type: "string", description: "Range to get (e.g., 'Sheet1!A1:C10')" },
        valueRenderOption: {
          type: "string",
          description: "How values are returned: FORMATTED_VALUE (as displayed, default), UNFORMATTED_VALUE (raw values; dates and times come back as serial numbers, not date strings), FORMULA (the formula behind each cell)",
          enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"],
          default: "FORMATTED_VALUE"
        }
      },
      required: ["spreadsheetId", "range"]
    }
  },
  {
    name: "getGoogleSheetCells",
    description: "Read Google Sheets cells as structured data instead of joined text: each cell comes back with its own absolute A1 address, and with the formula the user entered AND the value it evaluates to, in one call. Reads several ranges at once and returns them separately. Use getGoogleSheetContent for a quick human-readable dump of one range. Use this tool whenever the result will be written back, compared to a formula, or spans several ranges.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        ranges: {
          type: "array",
          description: "A1 ranges to read, e.g. [\"'Entity Assumptions'!B52:E52\", \"'Mgmt Fees Calc'!C6:EB13\"]. Returned separately, in this order, each with its own coordinates.",
          items: { type: "string" }
        },
        fields: {
          type: "array",
          description: "CellData fields to return. Default ['userEnteredValue','effectiveValue','formattedValue'] gives the formula (userEnteredValue.formulaValue) together with its computed result (effectiveValue, or effectiveValue.errorValue for #REF!/#DIV/0!).",
          items: { type: "string", enum: [...CELL_FIELDS] }
        },
        sheetMetadata: {
          type: "array",
          description: "Per-sheet extras returned once per sheet under `sheets`. `merges`, `frozen` and `dimensionGroups` cover the whole sheet (merges are reported at full extent even when they leave the range). `hiddenRows`, `hiddenColumns` and `dimensionSizes` cover only the rows and columns inside the requested ranges.",
          items: { type: "string", enum: [...SHEET_METADATA] }
        },
        includeEmpty: { type: "boolean", description: "Return cells that have none of the requested fields as {a1, empty: true}. Default false - addresses are explicit, so gaps are unambiguous." },
        maxCells: { type: "number", description: "Cell budget for the whole response (default 2000). On overflow the read stops at a row boundary and returns truncated:true plus nextRanges." },
        maxBytes: { type: "number", description: "Byte budget for the serialized cells (default 131072), measured on this tool's output. With the default fields, formula-heavy ranges hit this before maxCells, at roughly 1000 cells." }
      },
      required: ["spreadsheetId", "ranges"]
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
        values: {
          type: "array",
          description: "2D array of values to append. Each inner array represents a row.",
          items: {
            type: "array",
            items: {
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "null" }
              ]
            }
          }
        },
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
    name: "addSheet",
    description: "Alias for addSpreadsheetSheet (adds a new sheet/tab)",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        title: { type: "string", description: "Title for the new sheet/tab" }
      },
      required: ["spreadsheetId", "title"]
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
        conditionType: { type: "string", enum: ["ONE_OF_LIST", "ONE_OF_RANGE", "NUMBER_GREATER", "NUMBER_LESS", "TEXT_CONTAINS"], description: "Validation condition type. ONE_OF_RANGE creates a dropdown sourced from a cell range in the same spreadsheet, so the list can be maintained in one place (or imported from a master sheet via IMPORTRANGE)." },
        values: { type: "array", items: { type: "string" }, description: "Condition values (e.g. list items, threshold). For ONE_OF_RANGE: exactly one value, the source range in A1 notation (e.g. 'Reference!A2:A50'); a leading '=' is added automatically if omitted." },
        strict: { type: "boolean", description: "Reject invalid values" },
        showCustomUi: { type: "boolean", description: "Show dropdown/custom UI" }
      },
      required: ["spreadsheetId", "range", "conditionType", "values"]
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
    name: "addDimensionGroup",
    description: "Group a range of rows or columns in a sheet (creates a collapsible outline group). Indices are 0-based and the interval is half-open [startIndex, endIndex) \u2014 to group rows 5 through 12 as shown in the UI, pass startIndex: 4, endIndex: 12. Nest groups by adding a second group inside the range of the first.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        sheetId: { type: "number", description: "Sheet ID (from getSpreadsheetInfo / listSheets). The default first sheet is usually 0." },
        dimension: { type: "string", description: "Group rows or columns", enum: ["ROWS", "COLUMNS"] },
        startIndex: { type: "number", description: "0-based start index (inclusive)" },
        endIndex: { type: "number", description: "0-based end index (exclusive); must be greater than startIndex" }
      },
      required: ["spreadsheetId", "sheetId", "dimension", "startIndex", "endIndex"]
    }
  },
  {
    name: "deleteDimensionGroup",
    description: "Remove a row or column group from a sheet. The rows/columns themselves are kept; only the grouping is removed. Indices are 0-based and the interval is half-open [startIndex, endIndex). Use listDimensionGroups to read back an existing group\u0027s range and pass it in full: the API decrements the group depth of every dimension in the range rather than matching a whole group, so a range that only partially overlaps a group shrinks that group instead of removing it. With a depth-1 group over columns B:E and a depth-2 group over C:D, deleting D:E leaves depth-1 over B:D and depth-2 over C:C.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        sheetId: { type: "number", description: "Sheet ID (from getSpreadsheetInfo / listSheets). The default first sheet is usually 0." },
        dimension: { type: "string", description: "Group rows or columns", enum: ["ROWS", "COLUMNS"] },
        startIndex: { type: "number", description: "0-based start index (inclusive)" },
        endIndex: { type: "number", description: "0-based end index (exclusive); must be greater than startIndex" }
      },
      required: ["spreadsheetId", "sheetId", "dimension", "startIndex", "endIndex"]
    }
  },
  {
    name: "updateDimensionGroup",
    description: "Collapse or expand an existing row or column group. Indices are 0-based and the interval is half-open [startIndex, endIndex). Use listDimensionGroups first to find the group's range and depth.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        sheetId: { type: "number", description: "Sheet ID (from getSpreadsheetInfo / listSheets). The default first sheet is usually 0." },
        dimension: { type: "string", description: "Group rows or columns", enum: ["ROWS", "COLUMNS"] },
        startIndex: { type: "number", description: "0-based start index (inclusive)" },
        endIndex: { type: "number", description: "0-based end index (exclusive); must be greater than startIndex" },
        depth: { type: "number", description: "Nesting depth of the group, 1 for an outermost group (default 1)", default: 1 },
        collapsed: { type: "boolean", description: "true to collapse the group, false to expand it" }
      },
      required: ["spreadsheetId", "sheetId", "dimension", "startIndex", "endIndex", "collapsed"]
    }
  },
  {
    name: "listDimensionGroups",
    description: "List the row and column groups of a spreadsheet, with each group's range, nesting depth and collapsed state. Ranges are reported as 0-based half-open intervals, exactly as addDimensionGroup, deleteDimensionGroup and updateDimensionGroup take them.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        sheetId: { type: "number", description: "Limit to one sheet by ID; omit to list every sheet" }
      },
      required: ["spreadsheetId"]
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
        orderBy: { type: "string", description: "Sort order for results. Keys without 'desc' sort ascending, so 'modifiedTime' is oldest-first.", enum: [...DRIVE_ORDER_BY_VALUES], default: "modifiedTime desc" }
      },
      required: []
    }
  },
  {
    name: "setColumnWidth",
    description: "Set the width (in pixels) of one or more columns in a sheet. Indices are 0-based and the interval is half-open [startColumn, endColumn) — to resize a single column at position 5, pass startColumn: 5, endColumn: 6.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        sheetId: { type: "number", description: "Sheet ID (from getSpreadsheetInfo / listSheets). The default first sheet is usually 0." },
        startColumn: { type: "number", description: "0-based start column index (inclusive)" },
        endColumn: { type: "number", description: "0-based end column index (exclusive); must be greater than startColumn" },
        pixelSize: { type: "number", description: "Column width in pixels (must be >= 0)" }
      },
      required: ["spreadsheetId", "sheetId", "startColumn", "endColumn", "pixelSize"]
    }
  },
  {
    name: "setRowHeight",
    description: "Set the height (in pixels) of one or more rows in a sheet. Indices are 0-based and the interval is half-open [startRow, endRow) — to resize a single row at position 5, pass startRow: 5, endRow: 6.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        sheetId: { type: "number", description: "Sheet ID (from getSpreadsheetInfo / listSheets). The default first sheet is usually 0." },
        startRow: { type: "number", description: "0-based start row index (inclusive)" },
        endRow: { type: "number", description: "0-based end row index (exclusive); must be greater than startRow" },
        pixelSize: { type: "number", description: "Row height in pixels (must be >= 0)" }
      },
      required: ["spreadsheetId", "sheetId", "startRow", "endRow", "pixelSize"]
    }
  },
  {
    name: "autoResizeColumns",
    description: "Auto-size one or more columns to fit their content. Indices are 0-based and the interval is half-open [startColumn, endColumn) — to auto-fit a single column at position 5, pass startColumn: 5, endColumn: 6.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        sheetId: { type: "number", description: "Sheet ID (from getSpreadsheetInfo / listSheets). The default first sheet is usually 0." },
        startColumn: { type: "number", description: "0-based start column index (inclusive)" },
        endColumn: { type: "number", description: "0-based end column index (exclusive); must be greater than startColumn" }
      },
      required: ["spreadsheetId", "sheetId", "startColumn", "endColumn"]
    }
  },
  {
    name: "autoResizeRows",
    description: "Auto-size one or more rows to fit their content. Indices are 0-based and the interval is half-open [startRow, endRow) — to auto-fit a single row at position 5, pass startRow: 5, endRow: 6.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        sheetId: { type: "number", description: "Sheet ID (from getSpreadsheetInfo / listSheets). The default first sheet is usually 0." },
        startRow: { type: "number", description: "0-based start row index (inclusive)" },
        endRow: { type: "number", description: "0-based end row index (exclusive); must be greater than startRow" }
      },
      required: ["spreadsheetId", "sheetId", "startRow", "endRow"]
    }
  },
  {
    name: "hideSheetDimension",
    description: "Hide a range of columns or rows in a sheet (sets hiddenByUser=true). Indices are 0-based and the interval is half-open [startIndex, endIndex) — to hide a single column/row at position 5, pass startIndex: 5, endIndex: 6.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        sheetId: { type: "number", description: "Sheet ID (from getSpreadsheetInfo / listSheets). The default first sheet is usually 0." },
        dimension: { type: "string", description: "Which dimension to hide", enum: ["COLUMNS", "ROWS"] },
        startIndex: { type: "number", description: "0-based start index (inclusive)" },
        endIndex: { type: "number", description: "0-based end index (exclusive); must be greater than startIndex" }
      },
      required: ["spreadsheetId", "sheetId", "dimension", "startIndex", "endIndex"]
    }
  },
  {
    name: "showSheetDimension",
    description: "Show (unhide) a range of columns or rows in a sheet (sets hiddenByUser=false). Indices are 0-based and the interval is half-open [startIndex, endIndex) — to unhide a single column/row at position 5, pass startIndex: 5, endIndex: 6.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        sheetId: { type: "number", description: "Sheet ID (from getSpreadsheetInfo / listSheets). The default first sheet is usually 0." },
        dimension: { type: "string", description: "Which dimension to show", enum: ["COLUMNS", "ROWS"] },
        startIndex: { type: "number", description: "0-based start index (inclusive)" },
        endIndex: { type: "number", description: "0-based end index (exclusive); must be greater than startIndex" }
      },
      required: ["spreadsheetId", "sheetId", "dimension", "startIndex", "endIndex"]
    }
  }
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveGridRange(
  ctx: ToolContext,
  sheetsService: ReturnType<ToolContext['google']['sheets']>,
  spreadsheetId: string,
  range: string
): Promise<GridRange | string> {
  const rangeData = await withRetry(
    (signal) => sheetsService.spreadsheets.get({
      spreadsheetId,
      ranges: [range],
      fields: 'sheets(properties(sheetId,title))'
    }, { signal }),
    ctx.runtimeConfig,
    'sheets.spreadsheets.get(sheetLookup)',
    ctx.log
  );
  const { sheetName, cellRange: a1Range } = parseA1Range(range);
  const sheet = rangeData.data.sheets?.find(s => s.properties?.title === sheetName);
  if (!sheet || sheet.properties?.sheetId === undefined || sheet.properties?.sheetId === null) {
    return `Sheet "${sheetName}" not found`;
  }
  return convertA1ToGridRange(a1Range, sheet.properties.sheetId!);
}

/** Build a half-open [startIndex, endIndex) dimension range for a sheet. */
function dimensionRange(
  sheetId: number,
  dimension: 'COLUMNS' | 'ROWS',
  startIndex: number,
  endIndex: number
): sheets_v4.Schema$DimensionRange {
  return { sheetId, dimension, startIndex, endIndex };
}

/** Issue a batchUpdate carrying a single request against the given spreadsheet. */
async function batchUpdateOne(
  ctx: ToolContext,
  spreadsheetId: string,
  request: sheets_v4.Schema$Request
) {
  const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
  return withRetry(
    (signal) => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [request] },
    }, { signal }),
    { ...ctx.runtimeConfig, retryMax: 0 },
    'sheets.spreadsheets.batchUpdate',
    ctx.log
  );
}

function describeDimensionGroup(
  label: 'rows' | 'columns',
  group: sheets_v4.Schema$DimensionGroup
): string {
  const start = group.range?.startIndex ?? 0;
  const end = group.range?.endIndex ?? 0;
  const depth = group.depth ?? 1;
  return `  - ${label} [${start}, ${end}), depth ${depth}, ${group.collapsed ? 'collapsed' : 'expanded'}`;
}

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
      const spreadsheet = await withRetry(
        (signal) => sheets.spreadsheets.create({
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
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.create',
        ctx.log
      );

      await withRetry(
        (signal) => ctx.getDrive().files.update({
          fileId: spreadsheet.data.spreadsheetId || '',
          addParents: parentFolderId,
          removeParents: 'root',
          fields: 'id, name, webViewLink',
          supportsAllDrives: true
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'drive.files.update(reparent)',
        ctx.log
      );

      // Now update with data
      await withRetry(
        (signal) => sheets.spreadsheets.values.update({
          spreadsheetId: spreadsheet.data.spreadsheetId!,
          range: 'Sheet1!A1',
          valueInputOption: a.valueInputOption || 'RAW',
          requestBody: { values: a.data }
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.values.update',
        ctx.log
      );

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
      await withRetry(
        (signal) => sheets.spreadsheets.values.update({
          spreadsheetId: a.spreadsheetId,
          range: a.range,
          valueInputOption: a.valueInputOption || 'RAW',
          requestBody: { values: a.data }
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.values.update',
        ctx.log
      );

      return {
        content: [{ type: "text", text: `Updated Google Sheet range: ${a.range}` }],
        isError: false
      };
    }

    case "batchUpdateGoogleSheetValues": {
      const validation = BatchUpdateGoogleSheetValuesSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      const response = await withRetry(
        (signal) => sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: a.spreadsheetId,
          requestBody: {
            valueInputOption: a.valueInputOption || 'RAW',
            data: a.updates
          }
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.values.batchUpdate',
        ctx.log
      );

      // Report counts and the ranges touched, never the values back: echoing a
      // large batch would undo the context saving the batch exists for.
      const d = response.data;
      const ranges = (d.responses || [])
        .map(r => r.updatedRange)
        .filter((r): r is string => Boolean(r));
      const rangeList = ranges.length
        ? ` (${ranges.slice(0, 10).join(', ')}${ranges.length > 10 ? `, +${ranges.length - 10} more` : ''})`
        : '';
      // The response carries no range count of its own; one reply per requested
      // range is the API's contract, so fall back to what we asked for.
      const rangeCount = d.responses?.length || a.updates.length;
      return {
        content: [{
          type: "text",
          text: `Updated ${d.totalUpdatedCells ?? 0} cell(s) across ${rangeCount} range(s)${rangeList} in one batch.`
        }],
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
      const response = await withRetry(
        (signal) => sheets.spreadsheets.values.get({
          spreadsheetId: a.spreadsheetId,
          range: a.range,
          valueRenderOption: a.valueRenderOption
        }, { signal }),
        ctx.runtimeConfig,
        'sheets.spreadsheets.values.get',
        ctx.log
      );

      const values = response.data.values || [];
      let content = `Content for range ${a.range}:\n\n`;

      if (values.length === 0) {
        content += "(empty range)";
      } else {
        values.forEach((row, rowIndex) => {
          content += `Row ${rowIndex + 1}: ${row.join('\t')}\n`;
        });
      }

      return {
        content: [{ type: "text", text: content }],
        isError: false
      };
    }

    case "getGoogleSheetCells": {
      const validation = GetGoogleSheetCellsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      // includeGridData is deliberately not passed: a field mask already
      // selects the grid data, and the flag is ignored when one is present.
      const response = await withRetry(
        (signal) => sheets.spreadsheets.get({
          spreadsheetId: a.spreadsheetId,
          ranges: a.ranges,
          fields: buildFieldMask(a.fields, a.sheetMetadata)
        }, { signal }),
        ctx.runtimeConfig,
        'sheets.spreadsheets.get(cells)',
        ctx.log
      );

      const matched = matchRangesToGridData(a.ranges, (response.data.sheets ?? []) as SheetLike[]);
      if ('error' in matched) {
        return errorResponse(matched.error);
      }

      const extracted = extractRanges(matched.matches, a.fields, {
        maxCells: a.maxCells, maxBytes: a.maxBytes, includeEmpty: a.includeEmpty
      });
      const sheetMeta = collectSheetMetadata(matched.matches, a.sheetMetadata);

      const payload = {
        spreadsheetId: a.spreadsheetId,
        spreadsheetTitle: response.data.properties?.title ?? null,
        results: extracted.results,
        ...(Object.keys(sheetMeta).length > 0 && { sheets: sheetMeta }),
        truncated: extracted.truncated,
        ...(extracted.truncated && { nextRanges: extracted.nextRanges }),
        returned: extracted.returned
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
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
      const rangeData = await withRetry(
        (signal) => sheets.spreadsheets.get({
          spreadsheetId: a.spreadsheetId,
          ranges: [a.range],
          fields: 'sheets(properties(sheetId,title))'
        }, { signal }),
        ctx.runtimeConfig,
        'sheets.spreadsheets.get(sheetLookup)',
        ctx.log
      );

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

      await withRetry(
        (signal) => sheets.spreadsheets.batchUpdate({
          spreadsheetId: a.spreadsheetId,
          requestBody: { requests }
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.batchUpdate(repeatCell)',
        ctx.log
      );

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
      const rangeData = await withRetry(
        (signal) => sheets.spreadsheets.get({
          spreadsheetId: a.spreadsheetId,
          ranges: [a.range],
          fields: 'sheets(properties(sheetId,title))'
        }, { signal }),
        ctx.runtimeConfig,
        'sheets.spreadsheets.get(sheetLookup)',
        ctx.log
      );

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

      await withRetry(
        (signal) => sheets.spreadsheets.batchUpdate({
          spreadsheetId: a.spreadsheetId,
          requestBody: { requests }
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.batchUpdate(textFormat)',
        ctx.log
      );

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

      const rangeData = await withRetry(
        (signal) => sheets.spreadsheets.get({
          spreadsheetId: a.spreadsheetId,
          ranges: [a.range],
          fields: 'sheets(properties(sheetId,title))'
        }, { signal }),
        ctx.runtimeConfig,
        'sheets.spreadsheets.get(sheetLookup)',
        ctx.log
      );

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

      await withRetry(
        (signal) => sheets.spreadsheets.batchUpdate({
          spreadsheetId: a.spreadsheetId,
          requestBody: { requests }
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.batchUpdate(numberFormat)',
        ctx.log
      );

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

      const rangeData = await withRetry(
        (signal) => sheets.spreadsheets.get({
          spreadsheetId: a.spreadsheetId,
          ranges: [a.range],
          fields: 'sheets(properties(sheetId,title))'
        }, { signal }),
        ctx.runtimeConfig,
        'sheets.spreadsheets.get(sheetLookup)',
        ctx.log
      );

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

      await withRetry(
        (signal) => sheets.spreadsheets.batchUpdate({
          spreadsheetId: a.spreadsheetId,
          requestBody: { requests: [updateBordersRequest] }
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.batchUpdate(updateBorders)',
        ctx.log
      );

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

      const rangeData = await withRetry(
        (signal) => sheets.spreadsheets.get({
          spreadsheetId: a.spreadsheetId,
          ranges: [a.range],
          fields: 'sheets(properties(sheetId,title))'
        }, { signal }),
        ctx.runtimeConfig,
        'sheets.spreadsheets.get(sheetLookup)',
        ctx.log
      );

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

      await withRetry(
        (signal) => sheets.spreadsheets.batchUpdate({
          spreadsheetId: a.spreadsheetId,
          requestBody: { requests }
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.batchUpdate(mergeCells)',
        ctx.log
      );

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

      const rangeData = await withRetry(
        (signal) => sheets.spreadsheets.get({
          spreadsheetId: a.spreadsheetId,
          ranges: [a.range],
          fields: 'sheets(properties(sheetId,title))'
        }, { signal }),
        ctx.runtimeConfig,
        'sheets.spreadsheets.get(sheetLookup)',
        ctx.log
      );

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

      await withRetry(
        (signal) => sheets.spreadsheets.batchUpdate({
          spreadsheetId: a.spreadsheetId,
          requestBody: { requests }
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.batchUpdate(conditionalFormat)',
        ctx.log
      );

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
      const response = await withRetry(
        (signal) => sheets.spreadsheets.get({
          spreadsheetId: a.spreadsheetId,
          fields: 'spreadsheetId,properties.title,sheets.properties'
        }, { signal }),
        ctx.runtimeConfig,
        'sheets.spreadsheets.get(info)',
        ctx.log
      );

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
      const response = await withRetry(
        (signal) => sheets.spreadsheets.values.append({
          spreadsheetId: a.spreadsheetId,
          range: a.range,
          valueInputOption: a.valueInputOption || 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: a.values }
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.values.append',
        ctx.log
      );

      const updatedCells = response.data.updates?.updatedCells || 0;
      const updatedRows = response.data.updates?.updatedRows || 0;
      const updatedRange = response.data.updates?.updatedRange || a.range;

      return {
        content: [{ type: "text", text: `Successfully appended ${updatedRows} row(s) (${updatedCells} cells) to spreadsheet. Updated range: ${updatedRange}` }],
        isError: false
      };
    }

    case "addSpreadsheetSheet":
    case "addSheet": {
      const isAlias = toolName === 'addSheet';
      const validation = isAlias ? AddSheetSchema.safeParse(args) : AddSpreadsheetSheetSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }

      const spreadsheetId = validation.data.spreadsheetId;
      const sheetTitle = isAlias ? (validation.data as z.infer<typeof AddSheetSchema>).title : (validation.data as z.infer<typeof AddSpreadsheetSheetSchema>).sheetTitle;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      const response = await withRetry(
        (signal) => sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              addSheet: {
                properties: {
                  title: sheetTitle
                }
              }
            }]
          }
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.batchUpdate(addSheet)',
        ctx.log
      );

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
      const response = await withRetry(
        (signal) => sheets.spreadsheets.get({
          spreadsheetId: a.spreadsheetId,
          fields: 'sheets.properties(sheetId,title,index,hidden)'
        }, { signal }),
        ctx.runtimeConfig,
        'sheets.spreadsheets.get(listSheets)',
        ctx.log
      );

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
      await withRetry(
        (signal) => sheets.spreadsheets.batchUpdate({
          spreadsheetId: a.spreadsheetId,
          requestBody: {
            requests: [{
              updateSheetProperties: {
                properties: { sheetId: a.sheetId, title: a.newTitle },
                fields: 'title'
              }
            }]
          }
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.batchUpdate(renameSheet)',
        ctx.log
      );

      return { content: [{ type: 'text', text: `Renamed sheet ${a.sheetId} to "${a.newTitle}".` }], isError: false };
    }

    case "deleteSheet": {
      const validation = DeleteSheetSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      await withRetry(
        (signal) => sheets.spreadsheets.batchUpdate({
          spreadsheetId: a.spreadsheetId,
          requestBody: {
            requests: [{
              deleteSheet: { sheetId: a.sheetId }
            }]
          }
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.batchUpdate(deleteSheet)',
        ctx.log
      );

      return { content: [{ type: 'text', text: `Deleted sheet ${a.sheetId}.` }], isError: false };
    }

    case "addDataValidation": {
      const validation = AddDataValidationSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      const gridRange = await resolveGridRange(ctx, sheets, a.spreadsheetId, a.range);
      if (typeof gridRange === 'string') return errorResponse(gridRange);

      // ONE_OF_RANGE expects a single range formula (leading "="); accept plain
      // A1 notation and normalise so callers don't need to know the quirk.
      const conditionValues = a.conditionType === "ONE_OF_RANGE"
        ? a.values.map(v => ({ userEnteredValue: v.startsWith("=") ? v : `=${v}` }))
        : a.values.map(v => ({ userEnteredValue: v }));

      await withRetry(
        (signal) => sheets.spreadsheets.batchUpdate({
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
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.batchUpdate(setDataValidation)',
        ctx.log
      );

      return { content: [{ type: 'text', text: `Added data validation (${a.conditionType}) to ${a.range}.` }], isError: false };
    }

    case "protectRange": {
      const validation = ProtectRangeSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      const gridRange = await resolveGridRange(ctx, sheets, a.spreadsheetId, a.range);
      if (typeof gridRange === 'string') return errorResponse(gridRange);

      const response = await withRetry(
        (signal) => sheets.spreadsheets.batchUpdate({
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
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.batchUpdate(addProtectedRange)',
        ctx.log
      );

      const protectedRangeId = response.data.replies?.[0]?.addProtectedRange?.protectedRange?.protectedRangeId;
      return { content: [{ type: 'text', text: `Protected range ${a.range}${protectedRangeId ? ` (id: ${protectedRangeId})` : ''}.` }], isError: false };
    }

    case "addNamedRange": {
      const validation = AddNamedRangeSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      const gridRange = await resolveGridRange(ctx, sheets, a.spreadsheetId, a.range);
      if (typeof gridRange === 'string') return errorResponse(gridRange);

      const response = await withRetry(
        (signal) => sheets.spreadsheets.batchUpdate({
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
        }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'sheets.spreadsheets.batchUpdate(addNamedRange)',
        ctx.log
      );

      const namedRangeId = response.data.replies?.[0]?.addNamedRange?.namedRange?.namedRangeId;
      return { content: [{ type: 'text', text: `Added named range "${a.name}" for ${a.range}${namedRangeId ? ` (id: ${namedRangeId})` : ''}.` }], isError: false };
    }

    case "addDimensionGroup": {
      const validation = DimensionRangeSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      await batchUpdateOne(ctx, a.spreadsheetId, {
        addDimensionGroup: {
          range: dimensionRange(a.sheetId, a.dimension, a.startIndex, a.endIndex),
        },
      });

      const label = a.dimension === 'ROWS' ? 'rows' : 'columns';
      return { content: [{ type: 'text', text: `Grouped ${label} [${a.startIndex}, ${a.endIndex}) on sheet ${a.sheetId}.` }], isError: false };
    }

    case "deleteDimensionGroup": {
      const validation = DimensionRangeSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      await batchUpdateOne(ctx, a.spreadsheetId, {
        deleteDimensionGroup: {
          range: dimensionRange(a.sheetId, a.dimension, a.startIndex, a.endIndex),
        },
      });

      const label = a.dimension === 'ROWS' ? 'rows' : 'columns';
      return { content: [{ type: 'text', text: `Removed the group on ${label} [${a.startIndex}, ${a.endIndex}) on sheet ${a.sheetId}.` }], isError: false };
    }

    case "updateDimensionGroup": {
      const validation = UpdateDimensionGroupSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      await batchUpdateOne(ctx, a.spreadsheetId, {
        updateDimensionGroup: {
          dimensionGroup: {
            range: dimensionRange(a.sheetId, a.dimension, a.startIndex, a.endIndex),
            depth: a.depth,
            collapsed: a.collapsed,
          },
          fields: 'collapsed',
        },
      });

      const label = a.dimension === 'ROWS' ? 'rows' : 'columns';
      return { content: [{ type: 'text', text: `${a.collapsed ? 'Collapsed' : 'Expanded'} the group on ${label} [${a.startIndex}, ${a.endIndex}) at depth ${a.depth} on sheet ${a.sheetId}.` }], isError: false };
    }

    case "listDimensionGroups": {
      const validation = ListDimensionGroupsSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      const sheets = ctx.google.sheets({ version: 'v4', auth: ctx.authClient });
      const response = await withRetry(
        (signal) => sheets.spreadsheets.get({
          spreadsheetId: a.spreadsheetId,
          fields: 'sheets(properties(sheetId,title),rowGroups,columnGroups)'
        }, { signal }),
        ctx.runtimeConfig,
        'sheets.spreadsheets.get(dimensionGroups)',
        ctx.log
      );

      const allSheets = response.data.sheets || [];
      const targets = a.sheetId === undefined
        ? allSheets
        : allSheets.filter(s => s.properties?.sheetId === a.sheetId);
      if (a.sheetId !== undefined && targets.length === 0) {
        return errorResponse(`Sheet with id ${a.sheetId} not found`);
      }

      const blocks = targets.map(sheet => {
        const lines = [
          ...(sheet.rowGroups || []).map(g => describeDimensionGroup('rows', g)),
          ...(sheet.columnGroups || []).map(g => describeDimensionGroup('columns', g)),
        ];
        const body = lines.length > 0 ? lines.join('\n') : '  (no groups)';
        return `**${sheet.properties?.title || 'Untitled'}** (sheetId: ${sheet.properties?.sheetId})\n${body}`;
      });

      return { content: [{ type: 'text', text: blocks.join('\n\n') }], isError: false };
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

      const response = await withRetry(
        (signal) => ctx.getDrive().files.list({
          q: queryString,
          pageSize: a.maxResults || 20,
          orderBy: a.orderBy,
          fields: 'files(id,name,modifiedTime,createdTime,webViewLink,owners(displayName,emailAddress))',
          ...ALL_DRIVES_LIST_PARAMS
        }, { signal }),
        ctx.runtimeConfig,
        'drive.files.list',
        ctx.log
      );

      const files = response.data.files || [];
      if (files.length === 0) {
        return {
          content: [{ type: "text", text: "No Google Spreadsheets found matching your criteria." }],
          isError: false
        };
      }

      let result = `Found ${files.length} Google Spreadsheet(s) (ordered by ${a.orderBy}):\n\n`;
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

    case "setColumnWidth": {
      const validation = SetColumnWidthSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      await batchUpdateOne(ctx, a.spreadsheetId, {
        updateDimensionProperties: {
          range: dimensionRange(a.sheetId, 'COLUMNS', a.startColumn, a.endColumn),
          properties: { pixelSize: a.pixelSize },
          fields: 'pixelSize',
        },
      });

      return { content: [{ type: 'text', text: `Set column width to ${a.pixelSize}px for columns [${a.startColumn}, ${a.endColumn}) on sheet ${a.sheetId}.` }], isError: false };
    }

    case "setRowHeight": {
      const validation = SetRowHeightSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      await batchUpdateOne(ctx, a.spreadsheetId, {
        updateDimensionProperties: {
          range: dimensionRange(a.sheetId, 'ROWS', a.startRow, a.endRow),
          properties: { pixelSize: a.pixelSize },
          fields: 'pixelSize',
        },
      });

      return { content: [{ type: 'text', text: `Set row height to ${a.pixelSize}px for rows [${a.startRow}, ${a.endRow}) on sheet ${a.sheetId}.` }], isError: false };
    }

    case "autoResizeColumns": {
      const validation = AutoResizeColumnsSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      await batchUpdateOne(ctx, a.spreadsheetId, {
        autoResizeDimensions: {
          dimensions: dimensionRange(a.sheetId, 'COLUMNS', a.startColumn, a.endColumn),
        },
      });

      return { content: [{ type: 'text', text: `Auto-resized columns [${a.startColumn}, ${a.endColumn}) on sheet ${a.sheetId}.` }], isError: false };
    }

    case "autoResizeRows": {
      const validation = AutoResizeRowsSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;

      await batchUpdateOne(ctx, a.spreadsheetId, {
        autoResizeDimensions: {
          dimensions: dimensionRange(a.sheetId, 'ROWS', a.startRow, a.endRow),
        },
      });

      return { content: [{ type: 'text', text: `Auto-resized rows [${a.startRow}, ${a.endRow}) on sheet ${a.sheetId}.` }], isError: false };
    }

    case "hideSheetDimension":
    case "showSheetDimension": {
      const validation = DimensionRangeSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const hide = toolName === 'hideSheetDimension';

      await batchUpdateOne(ctx, a.spreadsheetId, {
        updateDimensionProperties: {
          range: dimensionRange(a.sheetId, a.dimension, a.startIndex, a.endIndex),
          properties: { hiddenByUser: hide },
          fields: 'hiddenByUser',
        },
      });

      const verb = hide ? 'Hid' : 'Showed';
      return { content: [{ type: 'text', text: `${verb} ${a.dimension.toLowerCase()} [${a.startIndex}, ${a.endIndex}) on sheet ${a.sheetId}.` }], isError: false };
    }

    default:
      return null;
  }
}
