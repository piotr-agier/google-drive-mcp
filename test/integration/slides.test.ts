import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

describe('Slides tools', () => {
  let ctx: TestContext;

  before(async () => { ctx = await setupTestServer(); });
  after(async () => { await ctx.cleanup(); });
  beforeEach(() => {
    ctx.mocks.drive.tracker.reset();
    ctx.mocks.slides.tracker.reset();
    ctx.mocks.docs.tracker.reset();
    // Reset to default impls
    ctx.mocks.slides.service.presentations.get._resetImpl();
    ctx.mocks.slides.service.presentations.batchUpdate._resetImpl();
    ctx.mocks.slides.service.presentations.pages.get._resetImpl();
    ctx.mocks.docs.service.documents.get._resetImpl();
  });

  // --- createGoogleSlides ---
  describe('createGoogleSlides', () => {
    it('happy path', async () => {
      ctx.mocks.drive.service.files.list._setImpl(async () => ({ data: { files: [] } }));
      ctx.mocks.slides.service.presentations.create._setImpl(async () => ({
        data: { presentationId: 'pres-new' },
      }));
      const res = await callTool(ctx.client, 'createGoogleSlides', {
        name: 'My Presentation',
        slides: [{ title: 'Slide 1', content: 'Content 1' }],
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('My Presentation'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'createGoogleSlides', {});
      assert.equal(res.isError, true);
    });
  });

  // --- updateGoogleSlides ---
  describe('updateGoogleSlides', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'updateGoogleSlides', {
        presentationId: 'pres-1',
        slides: [{ title: 'Updated Title', content: 'Updated Content' }],
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('Updated'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'updateGoogleSlides', {});
      assert.equal(res.isError, true);
    });
  });

  // --- getGoogleDocContent ---
  describe('getGoogleDocContent', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'getGoogleDocContent', { documentId: 'doc-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('Document content'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'getGoogleDocContent', {});
      assert.equal(res.isError, true);
    });
  });

  // --- getGoogleSlidesContent ---
  describe('getGoogleSlidesContent', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'getGoogleSlidesContent', { presentationId: 'pres-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('Presentation content'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'getGoogleSlidesContent', {});
      assert.equal(res.isError, true);
    });
  });

  // --- formatGoogleSlidesText ---
  describe('formatGoogleSlidesText', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'formatGoogleSlidesText', {
        presentationId: 'pres-1', objectId: 'title-1', bold: true,
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('formatting'));
    });

    it('error when no formatting specified', async () => {
      const res = await callTool(ctx.client, 'formatGoogleSlidesText', {
        presentationId: 'pres-1', objectId: 'title-1',
      });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text!.includes('No formatting'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'formatGoogleSlidesText', {});
      assert.equal(res.isError, true);
    });
  });

  // --- formatGoogleSlidesParagraph ---
  describe('formatGoogleSlidesParagraph', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'formatGoogleSlidesParagraph', {
        presentationId: 'pres-1', objectId: 'title-1', alignment: 'CENTER',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('paragraph formatting'));
    });

    it('error when no formatting specified', async () => {
      const res = await callTool(ctx.client, 'formatGoogleSlidesParagraph', {
        presentationId: 'pres-1', objectId: 'title-1',
      });
      assert.equal(res.isError, true);
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'formatGoogleSlidesParagraph', {});
      assert.equal(res.isError, true);
    });
  });

  // --- styleGoogleSlidesShape ---
  describe('styleGoogleSlidesShape', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'styleGoogleSlidesShape', {
        presentationId: 'pres-1', objectId: 'shape-1',
        backgroundColor: { red: 1, green: 0, blue: 0 },
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('styling'));
    });

    it('error when no styling specified', async () => {
      const res = await callTool(ctx.client, 'styleGoogleSlidesShape', {
        presentationId: 'pres-1', objectId: 'shape-1',
      });
      assert.equal(res.isError, true);
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'styleGoogleSlidesShape', {});
      assert.equal(res.isError, true);
    });
  });

  // --- setGoogleSlidesBackground ---
  describe('setGoogleSlidesBackground', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'setGoogleSlidesBackground', {
        presentationId: 'pres-1',
        pageObjectIds: ['slide-1'],
        backgroundColor: { red: 0, green: 0, blue: 1 },
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('background'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'setGoogleSlidesBackground', {});
      assert.equal(res.isError, true);
    });
  });

  // --- createGoogleSlidesTextBox ---
  describe('createGoogleSlidesTextBox', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'createGoogleSlidesTextBox', {
        presentationId: 'pres-1', pageObjectId: 'slide-1',
        text: 'Hello', x: 100, y: 100, width: 300, height: 50,
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('text box'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'createGoogleSlidesTextBox', {});
      assert.equal(res.isError, true);
    });
  });

  // --- createGoogleSlidesShape ---
  describe('createGoogleSlidesShape', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'createGoogleSlidesShape', {
        presentationId: 'pres-1', pageObjectId: 'slide-1',
        shapeType: 'RECTANGLE', x: 100, y: 100, width: 200, height: 200,
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('RECTANGLE'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'createGoogleSlidesShape', {});
      assert.equal(res.isError, true);
    });
  });

  // --- slide lifecycle helpers ---
  describe('slide lifecycle helpers', () => {
    it('deleteGoogleSlide happy path', async () => {
      const res = await callTool(ctx.client, 'deleteGoogleSlide', {
        presentationId: 'pres-1', slideObjectId: 'slide-1',
      });
      assert.equal(res.isError, false);
    });

    it('deleteGoogleSlide validation error', async () => {
      const res = await callTool(ctx.client, 'deleteGoogleSlide', {});
      assert.equal(res.isError, true);
    });

    it('duplicateSlide happy path', async () => {
      const res = await callTool(ctx.client, 'duplicateSlide', {
        presentationId: 'pres-1', slideObjectId: 'slide-1',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('Duplicated'));
    });

    it('reorderSlides happy path', async () => {
      const res = await callTool(ctx.client, 'reorderSlides', {
        presentationId: 'pres-1', slideObjectIds: ['slide-1'], insertionIndex: 0,
      });
      assert.equal(res.isError, false);
    });

    it('replaceAllTextInSlides happy path', async () => {
      const res = await callTool(ctx.client, 'replaceAllTextInSlides', {
        presentationId: 'pres-1', containsText: 'Old', replaceText: 'New',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('Replaced'));
    });
  });

  // --- replaceAllTextInSlides expectedCount ---
  describe('replaceAllTextInSlides expectedCount', () => {
    const paras = (texts: string[]) => ({
      textElements: texts.flatMap((content) => [{ paragraphMarker: {} }, { textRun: { content } }]),
    });
    const shape = (objectId: string, texts: string[]) => ({ objectId, shape: { text: paras(texts) } });

    // One token per place a Slides replaceAllText could reach. The expected
    // counts below were observed against the live API: a scratch deck built
    // the same way, one replaceAllText per token, reading occurrencesChanged.
    // It reaches slide shapes, table cells, grouped shapes, speaker notes,
    // layouts and masters; a match may run across two paragraphs of one shape
    // but never across two shapes. The notes master cannot be written through
    // the API at all, and the API reference answers its id in pageObjectIds
    // with a 400, so it is not part of the surface.
    const deck = {
      presentationId: 'pres-1',
      revisionId: 'rev-1',
      slides: [{
        objectId: 'slide-1',
        pageElements: [
          shape('slide-box', ['ZQXSLIDE\n']),
          { objectId: 'slide-table', table: { tableRows: [{ tableCells: [{ text: paras(['ZQXTABLE\n']) }] }] } },
          { objectId: 'grp', elementGroup: { children: [shape('grp-a', ['ZQXGROUP\n']), shape('grp-b', ['y\n'])] } },
          shape('split-1', ['ZQXSPL\n']),
          shape('split-2', ['IT\n']),
          shape('two-paras', ['ZQXPA\n', 'RA\n']),
          shape('nbsp', ['Q3 Revenue\n']),
        ],
        slideProperties: { notesPage: { pageElements: [shape('notes-body', ['ZQXNOTES\n'])] } },
      }],
      layouts: [{ objectId: 'layout-1', pageElements: [shape('layout-box', ['ZQXLAYOUT\n'])] }],
      masters: [{ objectId: 'master-1', pageElements: [shape('master-box', ['ZQXMASTER\n'])] }],
      notesMaster: { objectId: 'notes-master', pageElements: [shape('nm-box', ['ZQXNOTESMASTER\n'])] },
    };

    // The mock honours a `fields` mask for the parts this guard depends on,
    // because the API does: a projection that leaves out revisionId silently
    // unlocks the write, and one that leaves out speaker notes, layouts or
    // masters silently under-counts. A mock that returned everything whatever
    // was asked for would pass either mistake.
    function project(fields: unknown) {
      if (typeof fields !== 'string' || fields.trim() === '') return deck;
      const has = (name: string) => new RegExp(`(^|[(,\\s])${name}([(),\\s]|$)`).test(fields);
      return {
        presentationId: deck.presentationId,
        ...(has('revisionId') ? { revisionId: deck.revisionId } : {}),
        ...(has('slides') ? {
          slides: deck.slides.map((s) => ({
            objectId: s.objectId,
            pageElements: s.pageElements,
            ...(has('notesPage') ? { slideProperties: s.slideProperties } : {}),
          })),
        } : {}),
        ...(has('layouts') ? { layouts: deck.layouts } : {}),
        ...(has('masters') ? { masters: deck.masters } : {}),
        ...(has('notesMaster') ? { notesMaster: deck.notesMaster } : {}),
      };
    }

    beforeEach(() => {
      ctx.mocks.slides.service.presentations.get._setImpl(async (params: any) => ({ data: project(params?.fields) }));
      ctx.mocks.slides.service.presentations.batchUpdate._setImpl(async () => ({
        data: { replies: [{ replaceAllText: { occurrencesChanged: 1 } }] },
      }));
    });

    const cases: Array<{ where: string; containsText: string; found: number; hint?: string }> = [
      { where: 'a slide shape', containsText: 'ZQXSLIDE', found: 1 },
      { where: 'a table cell', containsText: 'ZQXTABLE', found: 1 },
      { where: 'a grouped shape', containsText: 'ZQXGROUP', found: 1 },
      { where: 'speaker notes', containsText: 'ZQXNOTES', found: 1 },
      { where: 'a layout', containsText: 'ZQXLAYOUT', found: 1 },
      { where: 'a master', containsText: 'ZQXMASTER', found: 1 },
      { where: 'two paragraphs of one shape', containsText: 'ZQXPA\nRA', found: 1 },
      { where: 'two separate shapes', containsText: 'ZQXSPL\nIT', found: 0 },
      { where: 'the notes master', containsText: 'ZQXNOTESMASTER', found: 0 },
      { where: 'every shape, cell and page at once', containsText: 'ZQX', found: 8 },
      { where: 'a non-breaking-space lookalike', containsText: 'Q3 Revenue', found: 0, hint: 'Likely cause' },
    ];
    for (const c of cases) {
      it(`counts ${c.where} as ${c.found}, and a mismatch writes nothing`, async () => {
        const res = await callTool(ctx.client, 'replaceAllTextInSlides', {
          presentationId: 'pres-1', containsText: c.containsText, replaceText: 'R', matchCase: true, expectedCount: 99,
        });
        assert.equal(res.isError, true);
        assert.ok(res.content[0].text!.includes(`found ${c.found} occurrence(s)`), res.content[0].text);
        if (c.hint) assert.ok(res.content[0].text!.includes(c.hint), res.content[0].text);
        assert.equal(ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate').length, 0);
      });
    }

    it('writes once when the count matches, locked to the revision it counted', async () => {
      const res = await callTool(ctx.client, 'replaceAllTextInSlides', {
        presentationId: 'pres-1', containsText: 'ZQXLAYOUT', replaceText: 'R', expectedCount: 1,
      });
      assert.equal(res.isError, false, res.content[0].text);
      assert.ok(res.content[0].text!.includes('Replaced 1 occurrence(s)'), res.content[0].text);
      const calls = ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args[0].requestBody.writeControl, { requiredRevisionId: 'rev-1' });
    });

    it('reports the count the API changed when it differs from the one counted', async () => {
      ctx.mocks.slides.service.presentations.batchUpdate._setImpl(async () => ({
        data: { replies: [{ replaceAllText: { occurrencesChanged: 2 } }] },
      }));
      const res = await callTool(ctx.client, 'replaceAllTextInSlides', {
        presentationId: 'pres-1', containsText: 'ZQXSLIDE', replaceText: 'R', expectedCount: 1,
      });
      assert.ok(res.content[0].text!.includes('Replaced 2 occurrence(s)'), res.content[0].text);
      assert.ok(res.content[0].text!.includes('WARNING'), res.content[0].text);
    });

    // A 400 on the locked write is the lock failing, whatever Google's wording,
    // so the mapping is gated on whether a lock was sent (as #219 does for Docs).
    const writeFailures: Array<{ name: string; expectedCount?: number; status: number; mapped: boolean }> = [
      { name: 'a 400 on the locked write says the presentation changed', expectedCount: 1, status: 400, mapped: true },
      { name: 'a non-400 on the locked write passes through unmapped', expectedCount: 1, status: 500, mapped: false },
      { name: 'a 400 without expectedCount (no lock) passes through unmapped', status: 400, mapped: false },
    ];
    for (const f of writeFailures) {
      it(f.name, async () => {
        ctx.mocks.slides.service.presentations.batchUpdate._setImpl(async () => {
          throw Object.assign(new Error('Google says no (zq-api-text)'), { status: f.status });
        });
        const res = await callTool(ctx.client, 'replaceAllTextInSlides', {
          presentationId: 'pres-1', containsText: 'ZQXSLIDE', replaceText: 'R',
          ...(f.expectedCount !== undefined ? { expectedCount: f.expectedCount } : {}),
        });
        assert.equal(res.isError, true);
        const text = res.content[0].text!;
        assert.equal(text.includes('changed between the count and the write'), f.mapped, text);
        assert.ok(text.includes('zq-api-text'), text);
      });
    }
  });

  // --- exportSlideThumbnail ---
  describe('exportSlideThumbnail', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'exportSlideThumbnail', {
        presentationId: 'pres-1', slideObjectId: 'slide-1', mimeType: 'PNG', size: 'LARGE',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('thumbnail URL'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'exportSlideThumbnail', {});
      assert.equal(res.isError, true);
    });
  });

  // --- getGoogleSlidesSpeakerNotes ---
  describe('getGoogleSlidesSpeakerNotes', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'getGoogleSlidesSpeakerNotes', {
        presentationId: 'pres-1', slideIndex: 0,
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('Speaker notes text'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'getGoogleSlidesSpeakerNotes', {});
      assert.equal(res.isError, true);
    });
  });

  // --- updateGoogleSlidesSpeakerNotes ---
  describe('updateGoogleSlidesSpeakerNotes', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'updateGoogleSlidesSpeakerNotes', {
        presentationId: 'pres-1', slideIndex: 0, notes: 'New notes',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('updated speaker notes'));
    });

    it('update slides with existing notes', async () => {
      const res = await callTool(ctx.client, 'updateGoogleSlidesSpeakerNotes', {
        presentationId: 'pres-1', slideIndex: 0, notes: 'Updated notes',
      });
      assert.equal(res.isError, false);

      const calls = ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate');
      const requests = calls[calls.length - 1].args[0].requestBody.requests;
      assert.equal(requests.length, 2);
      assert.ok(requests[0].deleteText);
      assert.ok(requests[1].insertText);
    });

    it('update slides with no existing notes', async () => {
      ctx.mocks.slides.service.presentations.get._setImpl(async () => ({
        data: {
          presentationId: 'pres-1',
          slides: [{
            objectId: 'slide-1',
            slideProperties: {
              notesPage: {
                notesProperties: { speakerNotesObjectId: 'notes-1' },
                pageElements: [
                  { objectId: 'notes-1', shape: { text: { textElements: [] } } },
                ],
              },
            },
          }],
        },
      }));

      const res = await callTool(ctx.client, 'updateGoogleSlidesSpeakerNotes', {
        presentationId: 'pres-1', slideIndex: 0, notes: 'First notes',
      });
      assert.equal(res.isError, false);

      const calls = ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate');
      const requests = calls[calls.length - 1].args[0].requestBody.requests;
      assert.equal(requests.length, 1);
      assert.ok(requests[0].insertText);
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'updateGoogleSlidesSpeakerNotes', {});
      assert.equal(res.isError, true);
    });
  });

  // --- setSlideVisibility ---
  describe('setSlideVisibility', () => {
    it('hides multiple slides in one atomic batch', async () => {
      const res = await callTool(ctx.client, 'setSlideVisibility', {
        presentationId: 'pres-1', slideObjectIds: ['s1', 's2'], skipped: true,
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('Hid 2 slide(s)'));

      const calls = ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate');
      const requests = calls[calls.length - 1].args[0].requestBody.requests;
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0].updateSlideProperties, {
        objectId: 's1', slideProperties: { isSkipped: true }, fields: 'isSkipped',
      });
    });

    it('unhides with skipped: false', async () => {
      const res = await callTool(ctx.client, 'setSlideVisibility', {
        presentationId: 'pres-1', slideObjectIds: ['s1'], skipped: false,
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('Unhid 1 slide(s)'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'setSlideVisibility', { presentationId: 'pres-1', slideObjectIds: [] });
      assert.equal(res.isError, true);
    });
  });

  // --- replaceSlideImage ---
  describe('replaceSlideImage', () => {
    it('replaces by URL with the default fit method', async () => {
      const res = await callTool(ctx.client, 'replaceSlideImage', {
        presentationId: 'pres-1', imageObjectId: 'img-1', imageUrl: 'https://example.com/new.png',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('layering, position, size, and crop preserved'));

      const calls = ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate');
      const requests = calls[calls.length - 1].args[0].requestBody.requests;
      assert.deepEqual(requests[0].replaceImage, {
        imageObjectId: 'img-1', url: 'https://example.com/new.png', imageReplaceMethod: 'CENTER_INSIDE',
      });
    });

    it('refuses both or neither image source', async () => {
      const neither = await callTool(ctx.client, 'replaceSlideImage', { presentationId: 'p', imageObjectId: 'i' });
      assert.equal(neither.isError, true);
      const both = await callTool(ctx.client, 'replaceSlideImage', {
        presentationId: 'p', imageObjectId: 'i', imageUrl: 'https://x.com/a.png', localImagePath: '/tmp/a.png',
      });
      assert.equal(both.isError, true);
    });
  });

  // --- setElementZOrder ---
  describe('setElementZOrder', () => {
    it('forwards the operation and element ids', async () => {
      const res = await callTool(ctx.client, 'setElementZOrder', {
        presentationId: 'pres-1', pageElementObjectIds: ['el-1', 'el-2'], operation: 'SEND_TO_BACK',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes('SEND_TO_BACK'));

      const calls = ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate');
      const requests = calls[calls.length - 1].args[0].requestBody.requests;
      assert.deepEqual(requests[0].updatePageElementsZOrder, {
        pageElementObjectIds: ['el-1', 'el-2'], operation: 'SEND_TO_BACK',
      });
    });

    it('validation error on unknown operation', async () => {
      const res = await callTool(ctx.client, 'setElementZOrder', {
        presentationId: 'pres-1', pageElementObjectIds: ['el-1'], operation: 'FLIP',
      });
      assert.equal(res.isError, true);
    });
  });

  // --- setElementText ---
  describe('setElementText', () => {
    it('deletes existing text then inserts, in one atomic batch', async () => {
      ctx.mocks.slides.service.presentations.get._setImpl(async () => ({
        data: {
          slides: [{
            pageElements: [
              { objectId: 'shape-1', shape: { text: { textElements: [{ textRun: { content: 'old copy\n' } }] } } },
            ],
          }],
        },
      }));
      const res = await callTool(ctx.client, 'setElementText', {
        presentationId: 'pres-1', objectId: 'shape-1', text: 'new copy',
      });
      assert.equal(res.isError, false);

      const calls = ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate');
      const requests = calls[calls.length - 1].args[0].requestBody.requests;
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0].deleteText, { objectId: 'shape-1', textRange: { type: 'ALL' } });
      assert.deepEqual(requests[1].insertText, { objectId: 'shape-1', insertionIndex: 0, text: 'new copy' });
    });

    it('skips deleteText on an empty shape and finds elements inside groups', async () => {
      ctx.mocks.slides.service.presentations.get._setImpl(async () => ({
        data: {
          slides: [{
            pageElements: [
              { objectId: 'group-1', elementGroup: { children: [{ objectId: 'shape-2', shape: {} }] } },
            ],
          }],
        },
      }));
      const res = await callTool(ctx.client, 'setElementText', {
        presentationId: 'pres-1', objectId: 'shape-2', text: 'fresh',
      });
      assert.equal(res.isError, false);

      const calls = ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate');
      const requests = calls[calls.length - 1].args[0].requestBody.requests;
      assert.equal(requests.length, 1);
      assert.ok(requests[0].insertText);
    });

    it('treats an autoText-only shape as having text, so the new copy replaces it', async () => {
      // A slide-number placeholder holds an autoText element and no textRun.
      // Reading that as empty skips deleteText and inserts the new copy in
      // front of the auto-text instead of replacing it.
      ctx.mocks.slides.service.presentations.get._setImpl(async () => ({
        data: {
          slides: [{
            pageElements: [
              { objectId: 'num-1', shape: { text: { textElements: [{ autoText: { type: 'SLIDE_NUMBER' } }] } } },
            ],
          }],
        },
      }));
      const res = await callTool(ctx.client, 'setElementText', {
        presentationId: 'pres-1', objectId: 'num-1', text: 'Page 4',
      });
      assert.equal(res.isError, false);

      const calls = ctx.mocks.slides.tracker.getCalls('presentations.batchUpdate');
      const requests = calls[calls.length - 1].args[0].requestBody.requests;
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0].deleteText, { objectId: 'num-1', textRange: { type: 'ALL' } });
    });

    it('errors when the element does not exist', async () => {
      ctx.mocks.slides.service.presentations.get._setImpl(async () => ({
        data: { slides: [{ pageElements: [] }] },
      }));
      const res = await callTool(ctx.client, 'setElementText', {
        presentationId: 'pres-1', objectId: 'ghost', text: 'x',
      });
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text!.includes('not found'));
    });
  });
});
