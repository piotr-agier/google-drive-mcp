import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import type { ToolDefinition, ToolResult, ToolContext } from '../types.js';
import { errorResponse } from '../types.js';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

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

const GetGoogleSlidesSpeakerNotesSchema = z.object({
  presentationId: z.string().min(1, "Presentation ID is required"),
  slideIndex: z.number().min(0, "Slide index must be non-negative")
});

const UpdateGoogleSlidesSpeakerNotesSchema = z.object({
  presentationId: z.string().min(1, "Presentation ID is required"),
  slideIndex: z.number().min(0, "Slide index must be non-negative"),
  notes: z.string()
});

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export const toolDefinitions: ToolDefinition[] = [
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
  },
  {
    name: "getGoogleSlidesSpeakerNotes",
    description: "Get speaker notes from a specific slide in Google Slides",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        slideIndex: { type: "number", description: "Slide index (0-based)" }
      },
      required: ["presentationId", "slideIndex"]
    }
  },
  {
    name: "updateGoogleSlidesSpeakerNotes",
    description: "Update speaker notes for a specific slide in Google Slides",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        slideIndex: { type: "number", description: "Slide index (0-based)" },
        notes: { type: "string", description: "Speaker notes content" }
      },
      required: ["presentationId", "slideIndex", "notes"]
    }
  },
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

    case "createGoogleSlides": {
      const validation = CreateGoogleSlidesSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const parentFolderId = await ctx.resolveFolderId(a.parentFolderId);

      // Check if presentation already exists
      const existingFileId = await ctx.checkFileExists(a.name, parentFolderId);
      if (existingFileId) {
        return errorResponse(
          `A presentation named "${a.name}" already exists in this location. ` +
          `File ID: ${existingFileId}. To modify it, you can use Google Slides directly.`
        );
      }

      const slidesService = ctx.google.slides({ version: 'v1', auth: ctx.authClient });
      const presentation = await slidesService.presentations.create({
        requestBody: { title: a.name },
      });

      await ctx.getDrive().files.update({
        fileId: presentation.data.presentationId!,
        addParents: parentFolderId,
        removeParents: 'root',
        supportsAllDrives: true
      });

      for (const slide of a.slides) {
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
          text: `Created Google Slides presentation: ${a.name}\nID: ${presentation.data.presentationId}\nLink: https://docs.google.com/presentation/d/${presentation.data.presentationId}`,
        }],
        isError: false,
      };
    }

    case "updateGoogleSlides": {
      const validation = UpdateGoogleSlidesSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const slidesService = ctx.google.slides({ version: 'v1', auth: ctx.authClient });

      // Get current presentation details
      const currentPresentation = await slidesService.presentations.get({
        presentationId: a.presentationId
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
      if (a.slides.length === 0) {
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
      const firstSlideContent = a.slides[0];
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
      for (let i = 1; i < a.slides.length; i++) {
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
        presentationId: a.presentationId,
        requestBody: { requests }
      });

      // If we have additional slides, add their content
      if (a.slides.length > 1) {
        const contentRequests: any[] = [];

        // Get updated presentation to find the new slide IDs
        const updatedPresentation = await slidesService.presentations.get({
          presentationId: a.presentationId
        });

        // Add content to the new slides (starting from the second slide in our args)
        for (let i = 1; i < a.slides.length && updatedPresentation.data.slides; i++) {
          const slide = a.slides[i];
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
            presentationId: a.presentationId,
            requestBody: { requests: contentRequests }
          });
        }
      }

      return {
        content: [{
          type: 'text',
          text: `Updated Google Slides presentation with ${a.slides.length} slide(s)\nLink: https://docs.google.com/presentation/d/${a.presentationId}`,
        }],
        isError: false,
      };
    }

    case "getGoogleSlidesContent": {
      const validation = GetGoogleSlidesContentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const slidesService = ctx.google.slides({ version: 'v1', auth: ctx.authClient });
      const presentation = await slidesService.presentations.get({
        presentationId: a.presentationId
      });

      if (!presentation.data.slides) {
        return errorResponse("No slides found in presentation");
      }

      let content = 'Presentation content with element IDs:\n\n';
      const slides = a.slideIndex !== undefined
        ? [presentation.data.slides[a.slideIndex]]
        : presentation.data.slides;

      slides.forEach((slide, index) => {
        if (!slide || !slide.objectId) return;

        content += `\nSlide ${a.slideIndex ?? index} (ID: ${slide.objectId}):\n`;
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
      const validation = FormatGoogleSlidesTextSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const slidesService = ctx.google.slides({ version: 'v1', auth: ctx.authClient });
      const textStyle: any = {};
      const fields: string[] = [];

      if (a.bold !== undefined) {
        textStyle.bold = a.bold;
        fields.push('bold');
      }

      if (a.italic !== undefined) {
        textStyle.italic = a.italic;
        fields.push('italic');
      }

      if (a.underline !== undefined) {
        textStyle.underline = a.underline;
        fields.push('underline');
      }

      if (a.strikethrough !== undefined) {
        textStyle.strikethrough = a.strikethrough;
        fields.push('strikethrough');
      }

      if (a.fontSize !== undefined) {
        textStyle.fontSize = {
          magnitude: a.fontSize,
          unit: 'PT'
        };
        fields.push('fontSize');
      }

      if (a.fontFamily !== undefined) {
        textStyle.fontFamily = a.fontFamily;
        fields.push('fontFamily');
      }

      if (a.foregroundColor) {
        textStyle.foregroundColor = {
          opaqueColor: {
            rgbColor: {
              red: a.foregroundColor.red || 0,
              green: a.foregroundColor.green || 0,
              blue: a.foregroundColor.blue || 0
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
          objectId: a.objectId,
          style: textStyle,
          fields: fields.join(',')
        }
      };

      // Add text range if specified
      if (a.startIndex !== undefined && a.endIndex !== undefined) {
        updateRequest.updateTextStyle.textRange = {
          type: 'FIXED_RANGE',
          startIndex: a.startIndex,
          endIndex: a.endIndex
        };
      } else {
        updateRequest.updateTextStyle.textRange = { type: 'ALL' };
      }

      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: { requests: [updateRequest] }
      });

      return {
        content: [{ type: "text", text: `Applied text formatting to object ${a.objectId}` }],
        isError: false
      };
    }

    case "formatGoogleSlidesParagraph": {
      const validation = FormatGoogleSlidesParagraphSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const slidesService = ctx.google.slides({ version: 'v1', auth: ctx.authClient });
      const requests: any[] = [];

      if (a.alignment) {
        requests.push({
          updateParagraphStyle: {
            objectId: a.objectId,
            style: { alignment: a.alignment },
            fields: 'alignment'
          }
        });
      }

      if (a.lineSpacing !== undefined) {
        requests.push({
          updateParagraphStyle: {
            objectId: a.objectId,
            style: { lineSpacing: a.lineSpacing },
            fields: 'lineSpacing'
          }
        });
      }

      if (a.bulletStyle) {
        if (a.bulletStyle === 'NONE') {
          requests.push({
            deleteParagraphBullets: {
              objectId: a.objectId
            }
          });
        } else if (a.bulletStyle === 'NUMBERED') {
          requests.push({
            createParagraphBullets: {
              objectId: a.objectId,
              bulletPreset: 'NUMBERED_DIGIT_ALPHA_ROMAN'
            }
          });
        } else {
          requests.push({
            createParagraphBullets: {
              objectId: a.objectId,
              bulletPreset: `BULLET_${a.bulletStyle}_CIRCLE_SQUARE`
            }
          });
        }
      }

      if (requests.length === 0) {
        return errorResponse("No formatting options specified");
      }

      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: { requests }
      });

      return {
        content: [{ type: "text", text: `Applied paragraph formatting to object ${a.objectId}` }],
        isError: false
      };
    }

    case "styleGoogleSlidesShape": {
      const validation = StyleGoogleSlidesShapeSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const slidesService = ctx.google.slides({ version: 'v1', auth: ctx.authClient });
      const shapeProperties: any = {};
      const fields: string[] = [];

      if (a.backgroundColor) {
        shapeProperties.shapeBackgroundFill = {
          solidFill: {
            color: {
              rgbColor: {
                red: a.backgroundColor.red || 0,
                green: a.backgroundColor.green || 0,
                blue: a.backgroundColor.blue || 0
              }
            },
            alpha: a.backgroundColor.alpha || 1
          }
        };
        fields.push('shapeBackgroundFill');
      }

      const outline: any = {};
      let hasOutlineChanges = false;

      if (a.outlineColor) {
        outline.outlineFill = {
          solidFill: {
            color: {
              rgbColor: {
                red: a.outlineColor.red || 0,
                green: a.outlineColor.green || 0,
                blue: a.outlineColor.blue || 0
              }
            }
          }
        };
        hasOutlineChanges = true;
      }

      if (a.outlineWeight !== undefined) {
        outline.weight = {
          magnitude: a.outlineWeight,
          unit: 'PT'
        };
        hasOutlineChanges = true;
      }

      if (a.outlineDashStyle !== undefined) {
        outline.dashStyle = a.outlineDashStyle;
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
        presentationId: a.presentationId,
        requestBody: {
          requests: [{
            updateShapeProperties: {
              objectId: a.objectId,
              shapeProperties,
              fields: fields.join(',')
            }
          }]
        }
      });

      return {
        content: [{ type: "text", text: `Applied styling to shape ${a.objectId}` }],
        isError: false
      };
    }

    case "setGoogleSlidesBackground": {
      const validation = SetGoogleSlidesBackgroundSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const slidesService = ctx.google.slides({ version: 'v1', auth: ctx.authClient });
      const requests = a.pageObjectIds.map(pageObjectId => ({
        updatePageProperties: {
          objectId: pageObjectId,
          pageProperties: {
            pageBackgroundFill: {
              solidFill: {
                color: {
                  rgbColor: {
                    red: a.backgroundColor.red || 0,
                    green: a.backgroundColor.green || 0,
                    blue: a.backgroundColor.blue || 0
                  }
                },
                alpha: a.backgroundColor.alpha || 1
              }
            }
          },
          fields: 'pageBackgroundFill'
        }
      }));

      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: { requests }
      });

      return {
        content: [{ type: "text", text: `Set background color for ${a.pageObjectIds.length} slide(s)` }],
        isError: false
      };
    }

    case "createGoogleSlidesTextBox": {
      const validation = CreateGoogleSlidesTextBoxSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const slidesService = ctx.google.slides({ version: 'v1', auth: ctx.authClient });
      const elementId = `textBox_${uuidv4().substring(0, 8)}`;

      const requests: any[] = [
        {
          createShape: {
            objectId: elementId,
            shapeType: 'TEXT_BOX',
            elementProperties: {
              pageObjectId: a.pageObjectId,
              size: {
                width: { magnitude: a.width, unit: 'EMU' },
                height: { magnitude: a.height, unit: 'EMU' }
              },
              transform: {
                scaleX: 1,
                scaleY: 1,
                translateX: a.x,
                translateY: a.y,
                unit: 'EMU'
              }
            }
          }
        },
        {
          insertText: {
            objectId: elementId,
            text: a.text,
            insertionIndex: 0
          }
        }
      ];

      // Apply optional formatting
      if (a.fontSize || a.bold || a.italic) {
        const textStyle: any = {};
        const fields: string[] = [];

        if (a.fontSize) {
          textStyle.fontSize = {
            magnitude: a.fontSize,
            unit: 'PT'
          };
          fields.push('fontSize');
        }

        if (a.bold !== undefined) {
          textStyle.bold = a.bold;
          fields.push('bold');
        }

        if (a.italic !== undefined) {
          textStyle.italic = a.italic;
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
        presentationId: a.presentationId,
        requestBody: { requests }
      });

      return {
        content: [{ type: "text", text: `Created text box with ID: ${elementId}` }],
        isError: false
      };
    }

    case "createGoogleSlidesShape": {
      const validation = CreateGoogleSlidesShapeSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const slidesService = ctx.google.slides({ version: 'v1', auth: ctx.authClient });
      const elementId = `shape_${uuidv4().substring(0, 8)}`;

      const createRequest: any = {
        createShape: {
          objectId: elementId,
          shapeType: a.shapeType,
          elementProperties: {
            pageObjectId: a.pageObjectId,
            size: {
              width: { magnitude: a.width, unit: 'EMU' },
              height: { magnitude: a.height, unit: 'EMU' }
            },
            transform: {
              scaleX: 1,
              scaleY: 1,
              translateX: a.x,
              translateY: a.y,
              unit: 'EMU'
            }
          }
        }
      };

      const requests = [createRequest];

      // Apply background color if specified
      if (a.backgroundColor) {
        requests.push({
          updateShapeProperties: {
            objectId: elementId,
            shapeProperties: {
              shapeBackgroundFill: {
                solidFill: {
                  color: {
                    rgbColor: {
                      red: a.backgroundColor.red || 0,
                      green: a.backgroundColor.green || 0,
                      blue: a.backgroundColor.blue || 0
                    }
                  },
                  alpha: a.backgroundColor.alpha || 1
                }
              }
            },
            fields: 'shapeBackgroundFill'
          }
        });
      }

      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: { requests }
      });

      return {
        content: [{ type: "text", text: `Created ${a.shapeType} shape with ID: ${elementId}` }],
        isError: false
      };
    }

    case "getGoogleSlidesSpeakerNotes": {
      const validation = GetGoogleSlidesSpeakerNotesSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const slidesService = ctx.google.slides({ version: 'v1', auth: ctx.authClient });

      // Get the presentation to access the slide
      const presentation = await slidesService.presentations.get({
        presentationId: a.presentationId
      });

      if (!presentation.data.slides || a.slideIndex >= presentation.data.slides.length) {
        return errorResponse(`Slide index ${a.slideIndex} not found in presentation (has ${presentation.data.slides?.length ?? 0} slides)`);
      }

      const slide = presentation.data.slides[a.slideIndex];

      // Get the notes page object ID from the slide properties
      const notesObjectId = slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;

      if (!notesObjectId) {
        return {
          content: [{ type: "text", text: "No speaker notes found for this slide" }],
          isError: false
        };
      }

      // Get the notes page to read the speaker notes text
      const notesPageObjectId = slide.slideProperties?.notesPage?.objectId;
      if (!notesPageObjectId) {
        return {
          content: [{ type: "text", text: "No speaker notes found for this slide" }],
          isError: false
        };
      }

      // Find the notes page for this slide
      const notesPage = presentation.data.slides?.[a.slideIndex]?.slideProperties?.notesPage;

      if (!notesPage || !notesPage.pageElements) {
        return {
          content: [{ type: "text", text: "No speaker notes found for this slide" }],
          isError: false
        };
      }

      // Find the speaker notes shape
      const speakerNotesElement = notesPage.pageElements.find(
        element => element.objectId === notesObjectId
      );

      if (!speakerNotesElement || !speakerNotesElement.shape?.text) {
        return {
          content: [{ type: "text", text: "No speaker notes found for this slide" }],
          isError: false
        };
      }

      // Extract the text from the speaker notes
      let notesText = '';
      const textElements = speakerNotesElement.shape.text.textElements || [];
      textElements.forEach((textElement) => {
        if (textElement.textRun?.content) {
          notesText += textElement.textRun.content;
        }
      });

      return {
        content: [{ type: "text", text: notesText.trim() || "No speaker notes found for this slide" }],
        isError: false
      };
    }

    case "updateGoogleSlidesSpeakerNotes": {
      const validation = UpdateGoogleSlidesSpeakerNotesSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;

      const slidesService = ctx.google.slides({ version: 'v1', auth: ctx.authClient });

      // Get the presentation to access the slide
      const presentation = await slidesService.presentations.get({
        presentationId: a.presentationId
      });

      if (!presentation.data.slides || a.slideIndex >= presentation.data.slides.length) {
        return errorResponse(`Slide index ${a.slideIndex} not found in presentation (has ${presentation.data.slides?.length ?? 0} slides)`);
      }

      const slide = presentation.data.slides[a.slideIndex];

      // Get the notes page object ID from the slide properties
      const notesObjectId = slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;

      if (!notesObjectId) {
        return errorResponse("This slide does not have a speaker notes object. Speaker notes may need to be initialized manually in Google Slides first.");
      }

      // Create the batchUpdate request to replace the speaker notes text
      const requests = [
        {
          deleteText: {
            objectId: notesObjectId,
            textRange: {
              type: 'ALL'
            }
          }
        },
        {
          insertText: {
            objectId: notesObjectId,
            text: a.notes,
            insertionIndex: 0
          }
        }
      ];

      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: { requests }
      });

      return {
        content: [{ type: "text", text: `Successfully updated speaker notes for slide ${a.slideIndex}` }],
        isError: false
      };
    }

    default:
      return null;
  }
}
