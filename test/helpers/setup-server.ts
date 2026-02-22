/**
 * Bootstraps the MCP server with mocked Google APIs for integration testing.
 *
 * Strategy:
 * 1. Import `google` from `googleapis` and monkey-patch service factory methods.
 * 2. Dynamically import the server module — it sees our patched `google` singleton.
 * 3. Call `_setAuthClientForTesting({})` to bypass authentication.
 * 4. Create an InMemoryTransport pair and connect a Client to the Server.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { google } from 'googleapis';
import { createAllMocks, type AllMocks } from './mock-google-apis.js';

export interface TestContext {
  client: Client;
  mocks: AllMocks;
  cleanup: () => Promise<void>;
}

// We cache the server module so it's only imported once across all test files.
let _serverModule: any = null;

export async function setupTestServer(): Promise<TestContext> {
  const mocks = createAllMocks();

  // Patch the googleapis singleton
  (google as any).drive = mocks.google.drive;
  (google as any).docs = mocks.google.docs;
  (google as any).sheets = mocks.google.sheets;
  (google as any).slides = mocks.google.slides;
  (google as any).calendar = mocks.google.calendar;

  // Import the server module (only once)
  if (!_serverModule) {
    _serverModule = await import('../../src/index.js');
  }

  // Inject fake auth client to bypass authenticate()
  _serverModule._setAuthClientForTesting({});

  const server = _serverModule.server;

  // Create transport pair
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Connect server to its transport
  await server.connect(serverTransport);

  // Create and connect client
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);

  const cleanup = async () => {
    await client.close();
    // Note: We don't close the server itself — it's reused across tests.
    // The serverTransport closing is enough to reset the connection.
  };

  return { client, mocks, cleanup };
}

/**
 * Helper to call a tool and return its result.
 */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  return result as any;
}
