/**
 * Mock factories for all Google API services used by the MCP server.
 *
 * Each factory returns a service object that matches the shape expected by the
 * handler code, plus a `_tracker` for test assertions on call args.
 */

// ---------------------------------------------------------------------------
// Call tracker
// ---------------------------------------------------------------------------
export interface TrackedCall {
  method: string;
  args: any[];
}

export class CallTracker {
  calls: TrackedCall[] = [];
  record(method: string, args: any[]) {
    this.calls.push({ method, args });
  }
  reset() {
    this.calls = [];
  }
  getCalls(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function stub(tracker: CallTracker, name: string, defaultReturn: any = {}) {
  let impl: ((...a: any[]) => any) | null = null;
  const fn = async (...args: any[]) => {
    tracker.record(name, args);
    if (impl) return impl(...args);
    return { data: typeof defaultReturn === 'function' ? defaultReturn() : defaultReturn };
  };
  fn._setImpl = (f: (...a: any[]) => any) => {
    impl = f;
  };
  fn._resetImpl = () => {
    impl = null;
  };
  return fn;
}

// ---------------------------------------------------------------------------
// Drive mock
// ---------------------------------------------------------------------------
export function createDriveMock() {
  const tracker = new CallTracker();
  const files = {
    list: stub(tracker, 'files.list', { files: [] }),
    create: stub(tracker, 'files.create', { id: 'file-1', name: 'test-file' }),
    get: stub(tracker, 'files.get', { id: 'file-1', name: 'test-file', mimeType: 'text/plain', parents: ['root'] }),
    update: stub(tracker, 'files.update', { id: 'file-1', name: 'test-file' }),
    delete: stub(tracker, 'files.delete', {}),
    copy: stub(tracker, 'files.copy', { id: 'file-copy-1', name: 'Copy of test-file', webViewLink: 'https://link' }),
    export: stub(tracker, 'files.export', {}),
  };
  const comments = {
    list: stub(tracker, 'comments.list', { comments: [] }),
    get: stub(tracker, 'comments.get', { id: 'comment-1', content: 'test comment', author: { displayName: 'User' } }),
    create: stub(tracker, 'comments.create', { id: 'comment-new', content: 'new comment' }),
    delete: stub(tracker, 'comments.delete', {}),
  };
  const replies = {
    create: stub(tracker, 'replies.create', { id: 'reply-1', content: 'reply text' }),
  };
  const permissions = {
    create: stub(tracker, 'permissions.create', {}),
  };
  return { service: { files, comments, replies, permissions }, tracker };
}

// ---------------------------------------------------------------------------
// Docs mock
// ---------------------------------------------------------------------------
export function createDocsMock() {
  const tracker = new CallTracker();
  const documents = {
    get: stub(tracker, 'documents.get', {
      documentId: 'doc-1',
      title: 'Test Doc',
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { textRun: { content: 'Hello World\n' }, startIndex: 1, endIndex: 13 },
              ],
            },
            startIndex: 0,
            endIndex: 13,
          },
        ],
      },
    }),
    batchUpdate: stub(tracker, 'documents.batchUpdate', {}),
    create: stub(tracker, 'documents.create', { documentId: 'doc-new' }),
  };
  return { service: { documents }, tracker };
}

// ---------------------------------------------------------------------------
// Sheets mock
// ---------------------------------------------------------------------------
export function createSheetsMock() {
  const tracker = new CallTracker();
  const spreadsheets = {
    create: stub(tracker, 'spreadsheets.create', { spreadsheetId: 'sheet-1' }),
    get: stub(tracker, 'spreadsheets.get', {
      spreadsheetId: 'sheet-1',
      properties: { title: 'Test Sheet' },
      sheets: [{ properties: { sheetId: 0, title: 'Sheet1', gridProperties: { rowCount: 100, columnCount: 26 } } }],
    }),
    batchUpdate: stub(tracker, 'spreadsheets.batchUpdate', { replies: [{ addSheet: { properties: { title: 'Sheet2', sheetId: 1 } } }] }),
    values: {
      get: stub(tracker, 'spreadsheets.values.get', { values: [['a', 'b'], ['1', '2']] }),
      update: stub(tracker, 'spreadsheets.values.update', {}),
      append: stub(tracker, 'spreadsheets.values.append', { updates: { updatedCells: 4, updatedRows: 2, updatedRange: 'Sheet1!A1:B2' } }),
    },
  };
  return { service: { spreadsheets }, tracker };
}

// ---------------------------------------------------------------------------
// Slides mock
// ---------------------------------------------------------------------------
export function createSlidesMock() {
  const tracker = new CallTracker();
  const presentations = {
    create: stub(tracker, 'presentations.create', { presentationId: 'pres-1' }),
    get: stub(tracker, 'presentations.get', {
      presentationId: 'pres-1',
      slides: [
        {
          objectId: 'slide-1',
          pageElements: [
            { objectId: 'title-1', shape: { placeholder: { type: 'TITLE' }, text: { textElements: [{ textRun: { content: 'Title' } }] } } },
            { objectId: 'body-1', shape: { placeholder: { type: 'BODY' }, text: { textElements: [{ textRun: { content: 'Body' } }] } } },
          ],
          slideProperties: {
            notesPage: {
              objectId: 'notes-page-1',
              notesProperties: { speakerNotesObjectId: 'notes-1' },
              pageElements: [
                { objectId: 'notes-1', shape: { text: { textElements: [{ textRun: { content: 'Speaker notes text' } }] } } },
              ],
            },
          },
        },
      ],
    }),
    batchUpdate: stub(tracker, 'presentations.batchUpdate', { replies: [] }),
    pages: {
      get: stub(tracker, 'presentations.pages.get', {
        objectId: 'slide-1',
        pageElements: [
          { objectId: 'title-1', shape: { placeholder: { type: 'TITLE' } } },
          { objectId: 'body-1', shape: { placeholder: { type: 'BODY' } } },
        ],
      }),
    },
  };
  return { service: { presentations }, tracker };
}

// ---------------------------------------------------------------------------
// Calendar mock
// ---------------------------------------------------------------------------
export function createCalendarMock() {
  const tracker = new CallTracker();
  const calendarList = {
    list: stub(tracker, 'calendarList.list', {
      items: [{ id: 'primary', summary: 'My Calendar', primary: true, accessRole: 'owner' }],
    }),
  };
  const events = {
    list: stub(tracker, 'events.list', {
      items: [
        {
          id: 'event-1',
          summary: 'Test Event',
          start: { dateTime: '2025-01-01T10:00:00Z' },
          end: { dateTime: '2025-01-01T11:00:00Z' },
          status: 'confirmed',
        },
      ],
    }),
    get: stub(tracker, 'events.get', {
      id: 'event-1',
      summary: 'Test Event',
      start: { dateTime: '2025-01-01T10:00:00Z' },
      end: { dateTime: '2025-01-01T11:00:00Z' },
      status: 'confirmed',
    }),
    insert: stub(tracker, 'events.insert', {
      id: 'event-new',
      summary: 'New Event',
      start: { dateTime: '2025-01-01T10:00:00Z' },
      end: { dateTime: '2025-01-01T11:00:00Z' },
      status: 'confirmed',
      htmlLink: 'https://calendar.google.com/event?id=event-new',
    }),
    update: stub(tracker, 'events.update', {
      id: 'event-1',
      summary: 'Updated Event',
      start: { dateTime: '2025-01-01T10:00:00Z' },
      end: { dateTime: '2025-01-01T11:00:00Z' },
      status: 'confirmed',
    }),
    delete: stub(tracker, 'events.delete', {}),
  };
  return { service: { calendarList, events }, tracker };
}

// ---------------------------------------------------------------------------
// Bundle all mocks together
// ---------------------------------------------------------------------------
export interface AllMocks {
  drive: ReturnType<typeof createDriveMock>;
  docs: ReturnType<typeof createDocsMock>;
  sheets: ReturnType<typeof createSheetsMock>;
  slides: ReturnType<typeof createSlidesMock>;
  calendar: ReturnType<typeof createCalendarMock>;
  google: Record<string, (...args: any[]) => any>;
}

export function createAllMocks(): AllMocks {
  const drive = createDriveMock();
  const docs = createDocsMock();
  const sheets = createSheetsMock();
  const slides = createSlidesMock();
  const calendar = createCalendarMock();

  const google: Record<string, (...args: any[]) => any> = {
    drive: () => drive.service,
    docs: () => docs.service,
    sheets: () => sheets.service,
    slides: () => slides.service,
    calendar: () => calendar.service,
  };

  return { drive, docs, sheets, slides, calendar, google };
}
