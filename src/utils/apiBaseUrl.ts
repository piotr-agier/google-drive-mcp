import type { OAuth2Client } from "google-auth-library";

/**
 * Environment variable that sends Google API calls to base URLs of your own
 * instead of Google's hosts, one base per host.
 *
 * Meant for deployments with an egress proxy in front of Google: the server
 * dials the proxy over plain HTTP and the proxy originates TLS. The proxy
 * routes by host, so the value maps each host to its own base:
 *
 *   www.googleapis.com=http://proxy:10255/t/www,docs.googleapis.com=http://proxy:10255/t/docs
 *
 * A base is an absolute http(s) URL and may carry a path prefix, which is
 * kept, so `https://docs.googleapis.com/v1/documents/x` goes to
 * `http://proxy:10255/t/docs/v1/documents/x`. A host with no entry is left
 * alone, and token refresh (oauth2.googleapis.com) is never rewritten.
 *
 * Implemented as a request interceptor on the OAuth2Client's transporter rather
 * than googleapis' `rootUrl` option: `rootUrl` resolves the API path against the
 * override's origin only and drops any path prefix, and the Drive, Docs and
 * Sheets clients are built in many places.
 */
export const API_BASE_URL_ENV = "GOOGLE_DRIVE_MCP_API_BASE_URL";

/** The Google API hosts this server calls: Drive (and uploads), Docs, Sheets. */
export const REWRITTEN_HOSTS: ReadonlySet<string> = new Set([
  "www.googleapis.com",
  "docs.googleapis.com",
  "sheets.googleapis.com",
]);

/**
 * The override as host -> base URL (no trailing slash); empty when unset.
 * @throws Error naming the variable on a malformed entry, a host the server
 *   does not call, a host named twice, or a base that is not an absolute
 *   http(s) URL
 */
export function parseApiBaseUrls(): Map<string, string> {
  const raw = process.env[API_BASE_URL_ENV]?.trim();
  const bases = new Map<string, string>();
  if (!raw) return bases;
  for (const entry of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq < 0) {
      throw new Error(
        `${API_BASE_URL_ENV} entries are host=url, got: ${entry}`,
      );
    }
    const host = entry.slice(0, eq).trim().toLowerCase();
    const base = entry.slice(eq + 1).trim();
    if (!REWRITTEN_HOSTS.has(host)) {
      throw new Error(
        `${API_BASE_URL_ENV} names ${host}, which this server does not call; use one of ${[...REWRITTEN_HOSTS].join(", ")}`,
      );
    }
    if (bases.has(host)) {
      throw new Error(`${API_BASE_URL_ENV} names ${host} twice`);
    }
    let parsed: URL | undefined;
    try {
      parsed = new URL(base);
    } catch {
      parsed = undefined;
    }
    if (
      !parsed ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    ) {
      throw new Error(
        `${API_BASE_URL_ENV} base for ${host} must be an absolute http(s) URL, got: ${base}`,
      );
    }
    bases.set(host, base.replace(/\/+$/, ""));
  }
  return bases;
}

/**
 * Rewrites an https URL on a mapped host onto that host's base, path and query
 * preserved. Any other URL comes back unchanged.
 */
export function rewriteApiUrl(
  url: string | URL,
  bases: Map<string, string> = parseApiBaseUrls(),
): URL {
  const original = new URL(url);
  const base =
    original.protocol === "https:" ? bases.get(original.host) : undefined;
  if (base === undefined) return original;
  return new URL(`${base}${original.pathname}${original.search}`);
}

/**
 * Makes every request the client sends honour GOOGLE_DRIVE_MCP_API_BASE_URL.
 * A no-op when the variable is unset. The map is read once, here, so a
 * malformed value fails at startup rather than on the first call. Returns the
 * client for chaining.
 */
export function applyApiBaseUrl<T extends OAuth2Client>(client: T): T {
  const bases = parseApiBaseUrls();
  if (bases.size === 0) return client;
  client.transporter.interceptors.request.add({
    resolved: async (config) => {
      config.url = rewriteApiUrl(config.url as string | URL, bases);
      return config;
    },
  });
  return client;
}
