import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import http, { type Server as HttpServer } from 'node:http';
import { google } from 'googleapis';
import { createAllMocks } from '../helpers/mock-google-apis.js';
import type { TeamConfig } from '../../src/auth/team/config.js';
import type { GoogleIdp } from '../../src/auth/team/googleIdp.js';
import type { TeamRuntime } from '../../src/auth/team/runtime.js';

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
    // Transport-level rejection, so the SDK's -32000 rather than -32600:
    // that is what clients already get from the transport for 403/406/409.
    assert.equal(parsed.error.code, -32000);
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

// ---------------------------------------------------------------------------
// Where the large limit may apply
// ---------------------------------------------------------------------------

describe('the raised limit is scoped to authenticated /mcp', () => {
  const servers: HttpServer[] = [];
  const sessionMaps: Map<string, any>[] = [];
  let mod: any;
  let teamBaseUrl: string;
  let runtime: TeamRuntime;

  before(async () => {
    mod = await setupMocks();
    const { InMemoryTeamStore } = await import('../../src/auth/team/memoryStore.js');
    const { createTeamRuntime } = await import('../../src/auth/team/runtime.js');
    const idp: GoogleIdp = {
      buildConsentUrl: () => 'https://fake-google.example/consent',
      exchangeCode: async () => {
        throw new Error('not used: these tests never complete a sign-in');
      },
      revokeGrant: async () => {},
    };
    const config: TeamConfig = {
      issuerUrl: new URL('http://127.0.0.1:3100'),
      googleRedirectUri: 'http://127.0.0.1:3100/oauth/google/callback',
      allowedDomains: [],
      allowedRedirectUris: [],
      tokenTtlMs: 3600_000,
      store: 'memory',
      storePath: '/unused',
      allowedHosts: ['127.0.0.1', 'localhost', '[::1]'],
      googleScopes: ['https://www.googleapis.com/auth/drive'],
      advertisedScopes: ['https://www.googleapis.com/auth/drive'],
    };
    runtime = await createTeamRuntime(config, { store: new InMemoryTeamStore(), idp });
    mod._setTeamRuntimeForTesting(runtime);
    const created = mod.createHttpApp('127.0.0.1', { teamAuth: runtime });
    sessionMaps.push(created.sessions);
    const started = await startServer(created.app);
    servers.push(started.httpServer);
    teamBaseUrl = started.baseUrl;
  });

  after(async () => {
    runtime.stop();
    mod._setTeamRuntimeForTesting(null);
    for (const sessions of sessionMaps) {
      for (const [, s] of sessions) { await s.transport.close(); await s.server.close(); }
      sessions.clear();
    }
    for (const httpServer of servers) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  // The parser runs before the bearer guard, so a limit raised for every route
  // lets an unauthenticated caller make the server read and parse megabytes.
  // Only a malformed body shows it: a valid one returns 401 either way, after
  // being read.
  it('answers a large unauthenticated malformed body without parsing it at the raised limit', async () => {
    const res = await fetch(`${teamBaseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: '{"jsonrpc":"2.0",' + 'x'.repeat(3 * 1024 * 1024),
    });
    await res.text();
    assert.equal(res.status, 401, 'must not reach the JSON parser before the guard');
  });

  // The point of the scoping: the routes an unauthenticated caller can reach
  // keep body-parser's default. Without this, raising the non-/mcp parser to
  // the /mcp limit passes every other test in this file.
  it("keeps body-parser's 100 KiB default on /register", async () => {
    const res = await fetch(`${teamBaseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'x'.repeat(200 * 1024) }),
    });
    await res.text();
    assert.equal(res.status, 413, 'an unauthenticated route must not accept 200 KiB');
  });

  // JSON-RPC body errors are mapped inside the /mcp route's own parser. A
  // handler mounted at the root also answered the OAuth routes, which speak
  // OAuth rather than JSON-RPC and are parsed by the SDK's own parsers — so it
  // stated a limit and a remedy belonging to a different route.
  it('does not answer an OAuth route with a JSON-RPC envelope', async () => {
    const res = await fetch(`${teamBaseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"redirect_uris":',
    });
    const text = await res.text();
    assert.doesNotMatch(
      text,
      /"jsonrpc"\s*:\s*"2\.0"/,
      `/register is not a JSON-RPC endpoint, got: ${text.slice(0, 120)}`,
    );
  });

  it('does not name the /mcp limit on an oversized OAuth request', async () => {
    // The SDK's token handler parses with its own urlencoded limit, so our
    // number and our environment variable would both be wrong here.
    const res = await fetch(`${teamBaseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=authorization_code&code=${'x'.repeat(200 * 1024)}`,
    });
    const text = await res.text();
    assert.doesNotMatch(text, /GOOGLE_DRIVE_MCP_MAX_BODY_BYTES/);
    assert.doesNotMatch(text, /"jsonrpc"\s*:\s*"2\.0"/);
  });
});

// ---------------------------------------------------------------------------
// DNS-rebinding warning for an all-interfaces bind
// ---------------------------------------------------------------------------

describe('binding to all interfaces still warns', () => {
  // The SDK's helper warns here; replacing it dropped the branch, so a server
  // bound to every interface started with neither DNS-rebinding protection nor
  // any notice of its absence. t.mock.method restores console.warn when the
  // test ends, so no try/finally is needed.
  for (const host of ['0.0.0.0', '::']) {
    it(`warns for ${host} when no Host allowlist is configured`, async (t) => {
      const mod = await setupMocks();
      const warn = t.mock.method(console, 'warn', () => {});
      mod.createHttpApp(host);
      const lines = warn.mock.calls.map((c) => c.arguments.join(' '));
      assert.ok(
        lines.some((line) => /without DNS rebinding protection/.test(line)),
        `expected a rebinding warning for ${host}, got: ${JSON.stringify(lines)}`,
      );
    });
  }

  it('does not warn for a loopback bind, which is protected', async (t) => {
    const mod = await setupMocks();
    const warn = t.mock.method(console, 'warn', () => {});
    mod.createHttpApp('127.0.0.1');
    const lines = warn.mock.calls.map((c) => c.arguments.join(' '));
    assert.ok(!lines.some((line) => /without DNS rebinding protection/.test(line)));
  });
});

// ---------------------------------------------------------------------------
// The skip must match what the route matches
// ---------------------------------------------------------------------------

describe('every path the /mcp route accepts gets the raised limit', () => {
  const servers: HttpServer[] = [];
  const sessionMaps: Map<string, any>[] = [];
  let baseUrl: string;

  before(async () => {
    const mod = await setupMocks();
    const created = mod.createHttpApp('127.0.0.1');
    sessionMaps.push(created.sessions);
    const started = await startServer(created.app);
    servers.push(started.httpServer);
    baseUrl = started.baseUrl;
  });

  after(async () => {
    for (const sessions of sessionMaps) {
      for (const [, s] of sessions) { await s.transport.close(); await s.server.close(); }
      sessions.clear();
    }
    for (const httpServer of servers) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  // Express routing is case-insensitive and accepts one trailing slash, so all
  // of these reach app.post('/mcp'). A client configured with a trailing slash
  // would otherwise be held to 100 KiB on every large batchUpdate — and told to
  // raise a setting that would not help.
  for (const path of ['/mcp', '/mcp/', '/MCP', '/Mcp/']) {
    it(`accepts a 400 KiB body on ${path}`, async () => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: paddedInitialize(400 * 1024),
      });
      await res.text();
      assert.equal(res.status, 200, `${path} reaches the /mcp route, so it gets the /mcp limit`);
    });
  }
});
