import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import http, { type Server as HttpServer } from 'node:http';
import { google } from 'googleapis';
import { createAllMocks } from '../helpers/mock-google-apis.js';

// ---------------------------------------------------------------------------
// Request body size limit on the Streamable HTTP transport.
//
// The SDK's createMcpExpressApp mounts express.json() with no options, so a
// server built from it caps every request body at body-parser's 100 KiB
// default and answers an oversized one with an Express HTML error page. A
// bulk sheetsBatchUpdate exceeds 100 KiB routinely, and an MCP client cannot
// read HTML. createHttpApp therefore builds the app itself, with the limit
// configurable and the overflow reported as JSON-RPC.
// ---------------------------------------------------------------------------

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

/** The body-parser default that used to be the ceiling. */
const OLD_DEFAULT_LIMIT = 100 * 1024;

let _serverModule: any = null;
async function getServerModule() {
  if (!_serverModule) _serverModule = await import('../../src/index.js');
  return _serverModule;
}

async function setupMocks() {
  const mocks = createAllMocks();
  (google as any).drive = mocks.google.drive;
  (google as any).docs = mocks.google.docs;
  (google as any).sheets = mocks.google.sheets;
  (google as any).slides = mocks.google.slides;
  (google as any).calendar = mocks.google.calendar;
  const mod = await getServerModule();
  mod._setAuthClientForTesting({ request: async () => ({ data: 'mock' }) });
  return mod;
}

function startServer(app: any): Promise<{ httpServer: HttpServer; baseUrl: string }> {
  return new Promise((resolve) => {
    const httpServer = app.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      const baseUrl = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '';
      resolve({ httpServer, baseUrl });
    });
  });
}

/** A valid initialize request padded out to at least `bytes` on the wire. */
function paddedInitialize(bytes: number): string {
  const envelope = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0', pad: '' },
      _meta: { pad: '' },
    },
    id: 1,
  };
  const overhead = JSON.stringify(envelope).length;
  envelope.params._meta.pad = 'x'.repeat(Math.max(0, bytes - overhead));
  return JSON.stringify(envelope);
}

describe('Streamable HTTP request body limit', () => {
  const servers: HttpServer[] = [];
  const sessionMaps: Map<string, any>[] = [];

  async function appWith(options?: any) {
    const mod = await setupMocks();
    const result = mod.createHttpApp('127.0.0.1', options);
    sessionMaps.push(result.sessions);
    const started = await startServer(result.app);
    servers.push(started.httpServer);
    return started.baseUrl;
  }

  before(async () => {
    await setupMocks();
  });

  after(async () => {
    for (const sessions of sessionMaps) {
      for (const [, s] of sessions) {
        await s.transport.close();
        await s.server.close();
      }
      sessions.clear();
    }
    for (const httpServer of servers) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('accepts a body larger than body-parser’s 100 KiB default', async () => {
    const baseUrl = await appWith();
    const body = paddedInitialize(OLD_DEFAULT_LIMIT * 4);
    assert.ok(body.length > OLD_DEFAULT_LIMIT, 'test body must exceed the old ceiling');
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: MCP_HEADERS, body });
    await res.text();
    assert.notEqual(res.status, 413, 'a 400 KiB body must no longer be rejected outright');
    assert.equal(res.status, 200);
  });

  it('rejects a body over the configured limit as JSON-RPC, not HTML', async () => {
    const baseUrl = await appWith({ maxBodyBytes: 2048 });
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: paddedInitialize(8192),
    });
    const text = await res.text();
    assert.equal(res.status, 413);
    assert.ok(
      !text.trimStart().startsWith('<'),
      `expected JSON-RPC, got markup: ${text.slice(0, 80)}`,
    );
    const parsed = JSON.parse(text);
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.error.code, -32600);
    assert.match(parsed.error.message, /too large/i);
  });

  it('honours the configured limit rather than a hardcoded one', async () => {
    const baseUrl = await appWith({ maxBodyBytes: 512 * 1024 });
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: paddedInitialize(256 * 1024),
    });
    await res.text();
    assert.equal(res.status, 200, 'a 256 KiB body must pass under a 512 KiB limit');
  });

  it('still reports malformed JSON as JSON-RPC', async () => {
    const baseUrl = await appWith();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: '{"jsonrpc":"2.0",',
    });
    const text = await res.text();
    assert.equal(res.status, 400);
    assert.ok(!text.trimStart().startsWith('<'), `expected JSON-RPC, got markup: ${text.slice(0, 80)}`);
    assert.equal(JSON.parse(text).jsonrpc, '2.0');
  });

  it('keeps the Host validation that the SDK helper used to apply', async () => {
    // fetch() refuses to set Host — it is a forbidden header name — so this
    // one goes out over node:http, where the attacker's value actually
    // reaches the server.
    const baseUrl = await appWith();
    const port = Number(new URL(baseUrl).port);
    const body = paddedInitialize(64);
    const { status, text } = await new Promise<{ status: number; text: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: { ...MCP_HEADERS, Host: 'evil.example', 'Content-Length': Buffer.byteLength(body) },
          },
          (res) => {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (buf += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text: buf }));
          },
        );
        req.on('error', reject);
        req.end(body);
      },
    );
    assert.equal(status, 403, 'dropping createMcpExpressApp must not drop DNS-rebinding protection');
    assert.match(JSON.parse(text).error.message, /Invalid Host/);
  });
});
