import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

describe('Calendar tools', () => {
  let ctx: TestContext;

  before(async () => { ctx = await setupTestServer(); });
  after(async () => { await ctx.cleanup(); });
  beforeEach(() => {
    ctx.mocks.calendar.tracker.reset();
  });

  // --- listCalendars ---
  describe('listCalendars', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'listCalendars', {});
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('My Calendar'));
    });

    it('propagates API error', async () => {
      ctx.mocks.calendar.service.calendarList.list._setImpl(async () => { throw new Error('Cal API down'); });
      const res = await callTool(ctx.client, 'listCalendars', {});
      assert.equal(res.isError, true);
      assert.ok(res.content[0].text.includes('Cal API down'));
      ctx.mocks.calendar.service.calendarList.list._resetImpl();
    });
  });

  // --- getCalendarEvents ---
  describe('getCalendarEvents', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'getCalendarEvents', {});
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Test Event'));
    });
  });

  // --- getCalendarEvent ---
  describe('getCalendarEvent', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'getCalendarEvent', { eventId: 'event-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('Test Event'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'getCalendarEvent', {});
      assert.equal(res.isError, true);
    });
  });

  // --- createCalendarEvent ---
  describe('createCalendarEvent', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'createCalendarEvent', {
        summary: 'New Event',
        start: { dateTime: '2025-06-01T10:00:00Z' },
        end: { dateTime: '2025-06-01T11:00:00Z' },
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('created'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'createCalendarEvent', {});
      assert.equal(res.isError, true);
    });
  });

  // --- updateCalendarEvent ---
  describe('updateCalendarEvent', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'updateCalendarEvent', {
        eventId: 'event-1', summary: 'Updated Event',
      });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('updated'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'updateCalendarEvent', {});
      assert.equal(res.isError, true);
    });
  });

  // --- deleteCalendarEvent ---
  describe('deleteCalendarEvent', () => {
    it('happy path', async () => {
      const res = await callTool(ctx.client, 'deleteCalendarEvent', { eventId: 'event-1' });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text.includes('deleted'));
    });

    it('validation error', async () => {
      const res = await callTool(ctx.client, 'deleteCalendarEvent', {});
      assert.equal(res.isError, true);
    });
  });
});
