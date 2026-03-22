import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import type { Server as HttpServer } from 'node:http';
import { google } from 'googleapis';
import { createAllMocks } from '../helpers/mock-google-apis.js';

let _serverModule: any = null;

async function getServerModule() {
  if (!_serverModule) {
    _serverModule = await import('../../src/index.js');
  }
  return _serverModule;
}

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

/** Parse an SSE or JSON response and return the first JSON-RPC message. */
async function parseResponse(res: Response): Promise<any> {
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  if (contentType.includes('text/event-stream')) {
    // Extract the first `data:` line
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        return JSON.parse(line.slice(6));
      }
    }
    throw new Error('No data line found in SSE response');
  }
  return JSON.parse(text);
}

describe('HTTP transport', () => {
  let httpServer: HttpServer;
  let baseUrl: string;
  let sessions: Map<string, any>;

  before(async () => {
    const mocks = createAllMocks();
    (google as any).drive = mocks.google.drive;
    (google as any).docs = mocks.google.docs;
    (google as any).sheets = mocks.google.sheets;
    (google as any).slides = mocks.google.slides;
    (google as any).calendar = mocks.google.calendar;

    const mod = await getServerModule();
    mod._setAuthClientForTesting({
      request: async () => ({ data: 'mock-auth-request-response' }),
    });

    const result = mod.createHttpApp('127.0.0.1');
    const app = result.app;
    sessions = result.sessions;

    await new Promise<void>((resolve) => {
      httpServer = app.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    for (const [, session] of sessions) {
      await session.transport.close();
    }
    sessions.clear();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('responds to initialize POST and returns session ID', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } },
        id: 1,
      }),
    });

    assert.equal(res.status, 200);
    const sessionId = res.headers.get('mcp-session-id');
    assert.ok(sessionId, 'response should include mcp-session-id header');

    const body = await parseResponse(res);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.ok(body.result, 'response should have a result');
    assert.ok(body.result.serverInfo, 'result should contain serverInfo');
    assert.equal(body.result.serverInfo.name, 'google-drive-mcp');
  });

  it('reuses session ID for subsequent requests', async () => {
    // Initialize
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } },
        id: 1,
      }),
    });
    const sessionId = initRes.headers.get('mcp-session-id')!;
    assert.ok(sessionId);
    // Consume init response
    await initRes.text();

    // Send initialized notification
    await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    // List tools using same session
    const toolsRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: 2,
      }),
    });

    assert.equal(toolsRes.status, 200);
    const body = await parseResponse(toolsRes);
    assert.equal(body.id, 2);
    assert.ok(Array.isArray(body.result?.tools), 'should return tools array');
    assert.ok(body.result.tools.length > 0, 'should have at least one tool');
  });

  it('returns 400 for non-initialize request without session', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: 1,
      }),
    });

    assert.equal(res.status, 400);
    const body = await parseResponse(res);
    assert.ok(body.error, 'should have error');
  });

  it('returns 400 for GET without session ID', async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    assert.equal(res.status, 400);
  });

  it('DELETE closes session', async () => {
    // Initialize a session
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } },
        id: 1,
      }),
    });
    const sessionId = initRes.headers.get('mcp-session-id')!;
    assert.ok(sessionId);
    await initRes.text();

    // DELETE the session
    const delRes = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId },
    });
    assert.equal(delRes.status, 200);

    // Subsequent request with same session should fail
    const postRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: 2,
      }),
    });
    // Session is gone, and it's not an initialize request, so 400
    assert.equal(postRes.status, 400);
  });
});
