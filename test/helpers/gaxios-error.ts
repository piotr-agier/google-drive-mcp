import http from 'node:http';
import { readFileSync } from 'node:fs';

import { OAuth2Client } from 'google-auth-library';

/** A body from test/fixtures/api-errors/. */
export function apiErrorFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/api-errors/${name}`, import.meta.url), 'utf8');
}

/**
 * The error googleapis would throw for this response: the body is served from
 * a local server and read through an OAuth2Client, the same request path the
 * Google service clients use. No network, no credentials.
 */
export async function gaxiosErrorFor(status: number, body: string): Promise<unknown> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const client = new OAuth2Client();
  client.setCredentials({ access_token: 'test-token-not-a-secret' });
  try {
    await client.request({ url: `http://127.0.0.1:${port}/probe` });
  } catch (err) {
    return err;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error(`expected HTTP ${status} to throw`);
}
