import assert from "node:assert/strict";
import test from "node:test";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

import {
  API_BASE_URL_ENV,
  REWRITTEN_HOSTS,
  parseApiBaseUrls,
  rewriteApiUrl,
  applyApiBaseUrl,
} from "../src/utils/apiBaseUrl.js";
import { createExternalOAuth2Client } from "../src/auth/externalAuth.js";

const PROXY = "http://127.0.0.1:10255/tenant-a/docs";
const MAP = [
  `www.googleapis.com=${PROXY}/www/`,
  `docs.googleapis.com=${PROXY}/docs`,
  `sheets.googleapis.com=${PROXY}/sheets/`,
].join(",");

function withEnv(value: string | undefined, fn: () => void | Promise<void>) {
  return async () => {
    const saved = process.env[API_BASE_URL_ENV];
    if (value === undefined) delete process.env[API_BASE_URL_ENV];
    else process.env[API_BASE_URL_ENV] = value;
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env[API_BASE_URL_ENV];
      else process.env[API_BASE_URL_ENV] = saved;
    }
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A client whose every request lands in `calls` instead of on the network. */
function recordingClient(calls: string[]): OAuth2Client {
  const fetchImplementation = async (url: string | URL | Request) => {
    calls.push(String(url instanceof Request ? url.url : url));
    return jsonResponse({});
  };
  const client = new OAuth2Client({
    transporterOptions: { fetchImplementation } as any,
  });
  client.setCredentials({
    access_token: "stub",
    expiry_date: Date.now() + 3_600_000,
  });
  return client;
}

test(
  "parseApiBaseUrls: unset or blank is no override",
  withEnv(undefined, () => {
    assert.deepEqual(parseApiBaseUrls(), new Map());
    process.env[API_BASE_URL_ENV] = "  ";
    assert.deepEqual(parseApiBaseUrls(), new Map());
  }),
);

test(
  "parseApiBaseUrls: one base per host, trailing slash dropped",
  withEnv(MAP, () => {
    assert.deepEqual(
      parseApiBaseUrls(),
      new Map([
        ["www.googleapis.com", `${PROXY}/www`],
        ["docs.googleapis.com", `${PROXY}/docs`],
        ["sheets.googleapis.com", `${PROXY}/sheets`],
      ]),
    );
  }),
);

test(
  "parseApiBaseUrls: rejects a host the server does not call",
  withEnv(`oauth2.googleapis.com=${PROXY}`, () => {
    assert.throws(
      () => parseApiBaseUrls(),
      new RegExp(`${API_BASE_URL_ENV}.*oauth2\\.googleapis\\.com`),
    );
  }),
);

test(
  "parseApiBaseUrls: rejects a base that is not an absolute http(s) URL",
  withEnv("docs.googleapis.com=proxy/docs", () => {
    assert.throws(() => parseApiBaseUrls(), new RegExp(API_BASE_URL_ENV));
  }),
);

test(
  "parseApiBaseUrls: rejects an entry with no =",
  withEnv("docs.googleapis.com", () => {
    assert.throws(() => parseApiBaseUrls(), new RegExp(API_BASE_URL_ENV));
  }),
);

test(
  "parseApiBaseUrls: rejects a host named twice",
  withEnv(
    `docs.googleapis.com=${PROXY}/a,docs.googleapis.com=${PROXY}/b`,
    () => {
      assert.throws(() => parseApiBaseUrls(), /twice/);
    },
  ),
);

test("REWRITTEN_HOSTS: Drive, Docs and Sheets", () => {
  assert.deepEqual([...REWRITTEN_HOSTS].sort(), [
    "docs.googleapis.com",
    "sheets.googleapis.com",
    "www.googleapis.com",
  ]);
});

test(
  "rewriteApiUrl: keeps the path prefix and the query string",
  withEnv(MAP, () => {
    assert.equal(
      rewriteApiUrl(
        "https://docs.googleapis.com/v1/documents/abc?includeTabsContent=true",
      ).href,
      `${PROXY}/docs/v1/documents/abc?includeTabsContent=true`,
    );
    assert.equal(
      rewriteApiUrl(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      ).href,
      `${PROXY}/www/upload/drive/v3/files?uploadType=multipart`,
    );
  }),
);

test(
  "rewriteApiUrl: leaves a host with no entry alone (token refresh stays on oauth2.googleapis.com)",
  withEnv(`docs.googleapis.com=${PROXY}/docs`, () => {
    assert.equal(
      rewriteApiUrl("https://oauth2.googleapis.com/token").href,
      "https://oauth2.googleapis.com/token",
    );
    assert.equal(
      rewriteApiUrl("https://sheets.googleapis.com/v4/spreadsheets/x").href,
      "https://sheets.googleapis.com/v4/spreadsheets/x",
    );
  }),
);

test(
  "applyApiBaseUrl: adds no interceptor when unset",
  withEnv(undefined, () => {
    const client = new OAuth2Client();
    const before = client.transporter.interceptors.request.size;
    applyApiBaseUrl(client);
    assert.equal(client.transporter.interceptors.request.size, before);
  }),
);

test(
  "applyApiBaseUrl: every call to the three hosts goes to its base",
  withEnv(MAP, async () => {
    const calls: string[] = [];
    const auth = applyApiBaseUrl(recordingClient(calls));
    await google.drive({ version: "v3", auth }).files.get({ fileId: "f1" });
    await google
      .docs({ version: "v1", auth })
      .documents.get({ documentId: "d1" });
    await google
      .sheets({ version: "v4", auth })
      .spreadsheets.values.get({ spreadsheetId: "s1", range: "A1:B2" });
    assert.deepEqual(calls, [
      `${PROXY}/www/drive/v3/files/f1`,
      `${PROXY}/docs/v1/documents/d1`,
      `${PROXY}/sheets/v4/spreadsheets/s1/values/A1%3AB2`,
    ]);
    for (const call of calls) {
      for (const host of REWRITTEN_HOSTS)
        assert.ok(!call.includes(host), `${call} still names ${host}`);
    }
  }),
);

test(
  "createExternalOAuth2Client honours the override",
  withEnv(MAP, async () => {
    const saved = process.env.GOOGLE_DRIVE_MCP_ACCESS_TOKEN;
    process.env.GOOGLE_DRIVE_MCP_ACCESS_TOKEN = "stub";
    try {
      const client = createExternalOAuth2Client();
      assert.ok(client.transporter.interceptors.request.size > 0);
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_DRIVE_MCP_ACCESS_TOKEN;
      else process.env.GOOGLE_DRIVE_MCP_ACCESS_TOKEN = saved;
    }
  }),
);
