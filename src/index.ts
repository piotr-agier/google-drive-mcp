#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from 'crypto';
import { google } from "googleapis";
import type { drive_v3, calendar_v3 } from "googleapis";
import {
  AccountClientFactory,
  AccountResolver,
  AccountStore,
  AuthServer,
  AuthSystem,
  STDIO_SESSION_ID,
  SessionStore,
  buildAuthSystem,
  initializeOAuth2Client,
} from './auth.js';
import type { AccountRecord, RedactedAccountView } from './auth/types.js';
import { ALIAS_PATTERN, RESERVED_ALIASES } from './auth/types.js';
import { resolveAddAccountScopes } from './auth/scopes.js';
import { fetchUserInfo } from './auth/userInfo.js';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import {
  getExtensionFromFilename,
  escapeDriveQuery,
} from './utils.js';
import type { AccountOps, AddAccountResult, ToolContext } from './types.js';
import { errorResponse } from './types.js';
import { loadRuntimeConfig, type RuntimeConfig } from './utils/cliArgs.js';

import * as driveTools from './tools/drive.js';
import * as docsTools from './tools/docs.js';
import * as sheetsTools from './tools/sheets.js';
import * as slidesTools from './tools/slides.js';
import * as calendarTools from './tools/calendar.js';
import { ADMIN_TOOLS, FALLBACK_META, TOOL_META } from './tools/toolMeta.js';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

// Auth system — initialized on first request.
let authSystem: AuthSystem | null = null;
let authSystemPromise: Promise<AuthSystem> | null = null;

// Per-account Drive/Calendar service caches, keyed by account alias.
const _driveByAlias = new Map<string, drive_v3.Drive>();
const _calendarByAlias = new Map<string, calendar_v3.Calendar>();

// Get package version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const VERSION = packageJson.version;

// -----------------------------------------------------------------------------
// LOGGING UTILITY
// -----------------------------------------------------------------------------
function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = data
    ? `[${timestamp}] ${message}: ${JSON.stringify(data)}`
    : `[${timestamp}] ${message}`;
  console.error(logMessage);
}

const runtimeConfig = loadRuntimeConfig();
log('Runtime config:', runtimeConfig);

// -----------------------------------------------------------------------------
// AUTH / ACCOUNT ACCESS
// -----------------------------------------------------------------------------

async function ensureAuthSystem(): Promise<AuthSystem> {
  if (authSystem) return authSystem;

  if (authSystemPromise) {
    log('Authentication already in progress, waiting...');
    authSystem = await authSystemPromise;
    return authSystem;
  }

  log('Initializing authentication');
  authSystemPromise = buildAuthSystem();
  try {
    authSystem = await authSystemPromise;
    log('Authentication complete');
    return authSystem;
  } finally {
    authSystemPromise = null;
  }
}

function requireAuthSystem(): AuthSystem {
  if (!authSystem) throw new Error('Authentication required');
  return authSystem;
}

/** The default account, or undefined when no accounts are authenticated. */
function defaultAccountOrUndefined(): AccountRecord | undefined {
  const sys = requireAuthSystem();
  const defaultAlias = sys.store.getDefault();
  if (defaultAlias) {
    const rec = sys.store.get(defaultAlias);
    if (rec) return rec;
  }
  return sys.store.list()[0];
}

async function getDefaultAccount(): Promise<AccountRecord> {
  const account = defaultAccountOrUndefined();
  if (!account) {
    throw new Error(
      'No accounts are authenticated. Run "manage_accounts add <alias>" to add one.',
    );
  }
  return account;
}

async function getDriveFor(account: AccountRecord): Promise<drive_v3.Drive> {
  const cached = _driveByAlias.get(account.alias);
  if (cached) return cached;
  const sys = requireAuthSystem();
  const client = await sys.factory.getClient(account.alias);
  const drive = google.drive({ version: 'v3', auth: client });
  _driveByAlias.set(account.alias, drive);
  return drive;
}

async function getCalendarFor(account: AccountRecord): Promise<calendar_v3.Calendar> {
  const cached = _calendarByAlias.get(account.alias);
  if (cached) return cached;
  const sys = requireAuthSystem();
  const client = await sys.factory.getClient(account.alias);
  const cal = google.calendar({ version: 'v3', auth: client });
  _calendarByAlias.set(account.alias, cal);
  return cal;
}

async function getAuthClientFor(account: AccountRecord): Promise<any> {
  const sys = requireAuthSystem();
  return sys.factory.getClient(account.alias);
}

// -----------------------------------------------------------------------------
// Account lifecycle API (consumed by `manage_accounts` handler via ctx)
// -----------------------------------------------------------------------------

function requireLocalOAuthMode(action: string): void {
  const sys = requireAuthSystem();
  if (sys.mode !== 'local-oauth') {
    throw new Error(
      `manage_accounts ${action} is only supported in local-OAuth mode. ` +
        `Current mode: ${sys.mode}. Unset GOOGLE_APPLICATION_CREDENTIALS and ` +
        `GOOGLE_DRIVE_MCP_ACCESS_TOKEN to switch to multi-account local OAuth.`,
    );
  }
}

function validateNewAlias(alias: string): void {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new Error(
      `Invalid alias "${alias}". Must match /^[a-z0-9][a-z0-9_-]{0,31}$/ — lowercase ` +
        `alphanumerics, hyphens, underscores; 1–32 chars; no leading hyphen.`,
    );
  }
  if (RESERVED_ALIASES.has(alias)) {
    throw new Error(
      `Alias "${alias}" is reserved. Choose a different name.`,
    );
  }
}

async function addAccountFlow(alias: string, openBrowser = true): Promise<AddAccountResult> {
  requireLocalOAuthMode('add');
  const sys = requireAuthSystem();
  const existing = sys.store.get(alias);
  // A brand-new alias must pass the full new-alias rules (pattern + reserved name).
  // An existing account may re-consent in place — to broaden scopes or recover a
  // revoked grant (including the migrated 'default') — so those guards are skipped
  // when the alias already exists.
  if (!existing) {
    validateNewAlias(alias);
  }

  // Fresh OAuth2Client for this flow — will receive tokens on callback.
  const flowClient = await initializeOAuth2Client();
  const scopes = resolveAddAccountScopes();

  let resolveCompletion!: (rec: AccountRecord) => void;
  let rejectCompletion!: (err: Error) => void;
  const completion = new Promise<AccountRecord>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const authServer = new AuthServer(flowClient, {
    promptMode: 'consent select_account',
    scopes,
    onTokens: async (tokens) => {
      try {
        flowClient.setCredentials(tokens);
        // On a re-consent, fall back to the account's existing identity if the
        // fresh userinfo lookup fails, so we never regress a known email/sub.
        let email = existing?.email ?? 'unknown';
        let sub = existing?.sub ?? `pending:${alias}:${Date.now()}`;
        let pendingIdentity = existing?.pendingIdentity ?? true;
        try {
          const info = await fetchUserInfo(flowClient);
          email = info.email;
          sub = info.sub;
          pendingIdentity = false;
        } catch (err) {
          log('Userinfo lookup failed; proceeding with existing/pending identity', {
            alias,
            error: (err as Error).message,
          });
        }
        const now = new Date().toISOString();
        const record: AccountRecord = {
          alias,
          email,
          sub,
          accessToken: tokens.access_token ?? '',
          // Google omits refresh_token on some re-consents; keep the prior one.
          refreshToken: tokens.refresh_token ?? existing?.refreshToken ?? '',
          scope: tokens.scope ?? scopes.join(' '),
          tokenType: 'Bearer',
          expiryDate: tokens.expiry_date ?? 0,
          addedAt: existing?.addedAt ?? now,
          lastRefreshedAt: now,
          pendingIdentity,
        };
        await sys.store.upsert(record);
        // Make it the default if it's the first account.
        if (!sys.store.getDefault()) {
          await sys.store.setDefault(alias);
        }
        resolveCompletion(record);
      } catch (err) {
        rejectCompletion(err as Error);
        // Rethrow so the AuthServer callback renders its failure page instead of
        // "success" when persistence failed — keeps the browser and tool in sync.
        throw err;
      }
    },
  });

  const started = await authServer.start(openBrowser);
  if (!started) {
    throw new Error(
      'Failed to start the OAuth server. Check port availability (3000-3004 by default).',
    );
  }
  const authUrl = authServer.getAuthorizeUrl();
  if (!authUrl) {
    throw new Error('Auth server started but could not generate an authorize URL.');
  }

  const cancel = async () => {
    await authServer.stop();
  };

  // Stop the auth server once completion resolves (success or rejection).
  completion
    .catch(() => undefined)
    .finally(async () => {
      try {
        await authServer.stop();
      } catch (_e) {
        /* ignore */
      }
    });

  return { authUrl, completion, cancel };
}

async function removeAccountFlow(alias: string): Promise<void> {
  requireLocalOAuthMode('remove');
  const sys = requireAuthSystem();
  if (!sys.store.get(alias)) {
    throw new Error(`No account with alias "${alias}".`);
  }
  await sys.store.remove(alias);
  sys.factory.evict(alias);
  _driveByAlias.delete(alias);
  _calendarByAlias.delete(alias);
}

async function setDefaultAccountFlow(alias: string | null): Promise<void> {
  requireLocalOAuthMode('set_default');
  const sys = requireAuthSystem();
  await sys.store.setDefault(alias);
}

function listAccountsRedacted(): RedactedAccountView[] {
  const sys = requireAuthSystem();
  return sys.store.listRedacted();
}

function buildAccountOps(): AccountOps {
  const sys = requireAuthSystem();
  return {
    mode: sys.mode,
    list: listAccountsRedacted,
    getDefault: () => sys.store.getDefault(),
    add: (alias, opts) => addAccountFlow(alias, opts?.openBrowser ?? true),
    remove: removeAccountFlow,
    setDefault: setDefaultAccountFlow,
  };
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

async function resolvePath(pathStr: string, drive: drive_v3.Drive): Promise<string> {
  if (!pathStr || pathStr === '/') return 'root';

  const parts = pathStr.replace(/^\/+|\/+$/g, '').split('/');
  let currentFolderId: string = 'root';

  for (const part of parts) {
    if (!part) continue;
    const escapedPart = escapeDriveQuery(part);
    const response = await drive.files.list({
      q: `'${currentFolderId}' in parents and name = '${escapedPart}' and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`,
      fields: 'files(id)',
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    });

    if (!response.data.files?.length) {
      const folderMetadata = {
        name: part,
        mimeType: FOLDER_MIME_TYPE,
        parents: [currentFolderId]
      };
      const folder = await drive.files.create({
        requestBody: folderMetadata,
        fields: 'id',
        supportsAllDrives: true
      });

      if (!folder.data.id) {
        throw new Error(`Failed to create intermediate folder: ${part}`);
      }

      currentFolderId = folder.data.id;
    } else {
      currentFolderId = response.data.files[0].id!;
    }
  }

  return currentFolderId;
}

async function resolveFolderId(input: string | undefined, drive: drive_v3.Drive): Promise<string> {
  if (!input) return 'root';

  if (input.startsWith('/')) {
    return resolvePath(input, drive);
  } else {
    return input;
  }
}

function validateTextFileExtension(name: string) {
  const ext = getExtensionFromFilename(name);
  if (!['txt', 'md'].includes(ext)) {
    throw new Error("File name must end with .txt or .md for text files.");
  }
}

async function checkFileExists(name: string, parentFolderId: string = 'root', drive: drive_v3.Drive): Promise<string | null> {
  try {
    const escapedName = escapeDriveQuery(name);
    const query = `name = '${escapedName}' and '${parentFolderId}' in parents and trashed = false`;

    const res = await drive.files.list({
      q: query,
      fields: 'files(id, name, mimeType)',
      pageSize: 1,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    });

    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0].id || null;
    }
    return null;
  } catch (error) {
    log('Error checking file existence:', error);
    return null;
  }
}

// -----------------------------------------------------------------------------
// DOMAIN MODULES
// -----------------------------------------------------------------------------
const domainModules = [driveTools, docsTools, sheetsTools, slidesTools, calendarTools];

// -----------------------------------------------------------------------------
// Per-tool `account` parameter plumbing
// -----------------------------------------------------------------------------

/**
 * Inject an optional `account` field into every non-admin tool's inputSchema
 * at registration time. Admin tools (authGetStatus, manage_accounts, etc.)
 * are left untouched.
 */
function withAccountParam(def: { name: string; description: string; inputSchema: Record<string, unknown> }) {
  if (ADMIN_TOOLS.has(def.name)) return def;
  const existing = (def.inputSchema.properties ?? {}) as Record<string, unknown>;
  if ('account' in existing) return def; // already annotated
  return {
    ...def,
    inputSchema: {
      ...def.inputSchema,
      properties: {
        ...existing,
        account: {
          type: 'string',
          description:
            'Alias of the Google account to target. Optional — defaults to the session/global default account, or the sole authenticated account. Run manage_accounts list to see available aliases.',
        },
      },
    },
  };
}

function normalizeAccountArg(raw: unknown): string | undefined {
  // `null`/`undefined`/empty → "not provided" (resolve against the default).
  // Check null first: `typeof null === 'object'` would otherwise fall into the
  // throw below.
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    // An array/object silently coerced to the default would route to the wrong
    // account and return partial results. Fail loudly instead (fanout dispatch
    // is not yet supported — see the resolver's Phase-3 notes).
    throw new Error(
      `The 'account' argument must be a single account alias (a string), but received ` +
        `${Array.isArray(raw) ? 'an array' : `a ${typeof raw}`}. Targeting multiple ` +
        `accounts in one call is not supported — make one call per account.`,
    );
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripAccountArg(args: Record<string, unknown>): Record<string, unknown> {
  if (!('account' in args)) return args;
  const copy: Record<string, unknown> = { ...args };
  delete copy.account;
  return copy;
}

/**
 * Build a tool context. When `scopedAccount` is provided, back-compat fields
 * (authClient, getDrive, getCalendar, resolvePath, resolveFolderId,
 * checkFileExists) point at that specific account; otherwise they resolve to
 * the system's default account. This lets tool handlers remain unchanged while
 * the dispatch layer transparently routes each call to the right identity.
 */
async function buildToolContext(
  sessionId: string,
  scopedAccount?: AccountRecord,
  opts: { tolerateClientFailure?: boolean } = {},
): Promise<ToolContext> {
  const sys = requireAuthSystem();
  const account = scopedAccount ?? defaultAccountOrUndefined();

  const noAccount = (): never => {
    throw new Error(
      'No accounts are authenticated. Run "manage_accounts add <alias>" to add one.',
    );
  };

  // Eagerly build the account-scoped clients for the back-compat fields. On the
  // admin path (tolerateClientFailure) a missing default (zero accounts) or a
  // client that can't be built (e.g. a revoked grant) must NOT block tools like
  // manage_accounts, so the failure is swallowed and these fields are left unset;
  // client-backed handlers then surface a clear error only when actually used. On
  // the normal path the resolver always supplies a usable account and any build
  // error (e.g. the revoked-grant reconnect hint) propagates to the caller.
  let drive: drive_v3.Drive | undefined;
  let calendar: calendar_v3.Calendar | undefined;
  let authClient: any;
  if (account) {
    try {
      drive = await getDriveFor(account);
      calendar = await getCalendarFor(account); // pre-warm calendar cache
      authClient = await sys.factory.getClient(account.alias);
    } catch (err) {
      if (!opts.tolerateClientFailure) throw err;
      log('Default-account client unavailable; continuing with a client-less admin context', {
        alias: account.alias,
        error: (err as Error).message,
      });
    }
  } else if (!opts.tolerateClientFailure) {
    noAccount();
  }

  return {
    authClient,
    google,
    getDrive: () => drive ?? noAccount(),
    getCalendar: () => calendar ?? noAccount(),
    log,
    resolvePath: (pathStr) => (drive ? resolvePath(pathStr, drive) : noAccount()),
    resolveFolderId: (input) => (drive ? resolveFolderId(input, drive) : noAccount()),
    checkFileExists: (name, parentFolderId) =>
      drive ? checkFileExists(name, parentFolderId, drive) : noAccount(),
    validateTextFileExtension,
    runtimeConfig,

    // Multi-account surface
    sessionId,
    resolveAccount: (input, kind, acceptableScopes) =>
      sys.resolver.resolve(input, kind, { sessionId, acceptableScopes }),
    getDriveFor,
    getCalendarFor,
    getAuthClientFor,
    accountOps: buildAccountOps(),
  };
}

// -----------------------------------------------------------------------------
// SERVER FACTORY
// -----------------------------------------------------------------------------

function createMcpServer(config: RuntimeConfig = runtimeConfig): Server {
  const resourcesEnabled = !config.disableResources;
  if (!resourcesEnabled) {
    log('Resources capability disabled via GOOGLE_DRIVE_MCP_DISABLE_RESOURCES / --no-resources');
  }

  const s = new Server(
    {
      name: "google-drive-mcp",
      version: VERSION,
    },
    {
      capabilities: {
        ...(resourcesEnabled ? { resources: {} } : {}),
        tools: {},
      },
    },
  );

  if (resourcesEnabled) {
    registerResourceHandlers(s);
  }

  s.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: domainModules.flatMap((m) => m.toolDefinitions).map(withAccountParam),
    };
  });

  s.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    await ensureAuthSystem();
    const toolName = request.params.name;
    const rawArgs = request.params.arguments ?? {};
    // Resolve per-session state against the transport's real session id — the
    // Mcp-Session-Id on HTTP (one server per session), or the 'stdio' sentinel
    // when the transport has none (stdio / in-memory). Each HTTP session must
    // not share the 'stdio' key, or per-session defaults would leak across
    // clients.
    const sessionId = extra?.sessionId ?? STDIO_SESSION_ID;
    log('Handling tool request', { tool: toolName });

    try {
      let ctx: ToolContext;
      let toolArgs: Record<string, unknown>;

      if (ADMIN_TOOLS.has(toolName)) {
        // Admin tools operate on system-wide state; they run with the default
        // account's context for back-compat but ignore any `account` arg. Tolerate
        // a missing/unusable default so manage_accounts still works with zero
        // accounts or a revoked default (its handlers only touch accountOps).
        ctx = await buildToolContext(sessionId, undefined, { tolerateClientFailure: true });
        toolArgs = rawArgs;
      } else {
        const meta = TOOL_META[toolName] ?? FALLBACK_META;
        const accountArg = normalizeAccountArg(rawArgs.account);
        const sys = requireAuthSystem();
        const targeting = await sys.resolver.resolve(accountArg, meta.opKind, {
          sessionId,
          acceptableScopes: meta.acceptableScopes,
        });
        if (targeting.kind === 'fanout') {
          // Phase 2 ships single-account dispatch only. Read-fanout is Phase 3.
          throw new Error(
            `Tool "${toolName}" resolved to multiple accounts (${targeting.accounts
              .map((a) => a.alias)
              .join(', ')}). Read-fanout is not yet supported. Specify 'account' explicitly ` +
              `or run manage_accounts set_default to pick one.`,
          );
        }
        const account = targeting.accounts[0];
        ctx = await buildToolContext(sessionId, account);
        toolArgs = stripAccountArg(rawArgs);
      }

      for (const mod of domainModules) {
        const result = await mod.handleTool(toolName, toolArgs, ctx);
        if (result !== null) return result;
      }
      return errorResponse('Tool not found');
    } catch (error) {
      log('Error in tool request handler', { error: (error as Error).message });
      return errorResponse((error as Error).message);
    }
  });

  return s;
}

// Registers the optional MCP "resources" capability handlers (gdrive:/// file
// listing and reading). Skipped entirely when the resources capability is
// disabled via GOOGLE_DRIVE_MCP_DISABLE_RESOURCES / --no-resources.
function registerResourceHandlers(s: Server): void {
  s.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    await ensureAuthSystem();
    log('Handling ListResources request', { params: request.params });
    const account = await getDefaultAccount();
    const drive = await getDriveFor(account);
    const pageSize = 1000;
    const params: {
      pageSize: number,
      fields: string,
      pageToken?: string,
      q: string,
      includeItemsFromAllDrives: boolean,
      supportsAllDrives: boolean
    } = {
      pageSize,
      fields: "nextPageToken, files(id, name, mimeType)",
      q: `trashed = false`,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    };

    if (request.params?.cursor) {
      params.pageToken = request.params.cursor;
    }

    const res = await drive.files.list(params);
    log('Listed files', { count: res.data.files?.length });
    const files = res.data.files || [];

    return {
      resources: files.map((file: drive_v3.Schema$File) => ({
        uri: `gdrive:///${file.id}`,
        mimeType: file.mimeType || 'application/octet-stream',
        name: file.name || 'Untitled',
      })),
      nextCursor: res.data.nextPageToken,
    };
  });

  s.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    await ensureAuthSystem();
    log('Handling ReadResource request', { uri: request.params.uri });
    const account = await getDefaultAccount();
    const drive = await getDriveFor(account);
    const fileId = request.params.uri.replace("gdrive:///", "");

    const file = await drive.files.get({
      fileId,
      fields: "mimeType",
      supportsAllDrives: true
    });
    const mimeType = file.data.mimeType;

    if (!mimeType) {
      throw new Error("File has no MIME type.");
    }

    if (mimeType.startsWith("application/vnd.google-apps")) {
      let exportMimeType;
      switch (mimeType) {
        case "application/vnd.google-apps.document": exportMimeType = "text/markdown"; break;
        case "application/vnd.google-apps.spreadsheet": exportMimeType = "text/csv"; break;
        case "application/vnd.google-apps.presentation": exportMimeType = "text/plain"; break;
        case "application/vnd.google-apps.drawing": exportMimeType = "image/png"; break;
        default: exportMimeType = "text/plain"; break;
      }

      const res = await drive.files.export(
        { fileId, mimeType: exportMimeType },
        { responseType: "text" },
      );

      log('Successfully read resource', { fileId, mimeType });
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: exportMimeType,
            text: res.data,
          },
        ],
      };
    } else {
      const res = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" },
      );
      const contentMime = mimeType || "application/octet-stream";

      if (contentMime.startsWith("text/") || contentMime === "application/json") {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: contentMime,
              text: Buffer.from(res.data as ArrayBuffer).toString("utf-8"),
            },
          ],
        };
      } else {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: contentMime,
              blob: Buffer.from(res.data as ArrayBuffer).toString("base64"),
            },
          ],
        };
      }
    }
  });
}

// Module-level server instance (used by stdio mode and tests)
const server = createMcpServer();

// -----------------------------------------------------------------------------
// CLI FUNCTIONS
// -----------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
Google Drive MCP Server v${VERSION}

Usage:
  npx @yourusername/google-drive-mcp [command] [options]

Commands:
  auth     Run the authentication flow
  start    Start the MCP server (default)
  version  Show version information
  help     Show this help message

Transport Options:
  --transport <stdio|http>   Transport mode (default: stdio)
  --port <number>            HTTP listen port (default: 3100)
  --host <address>           HTTP bind address (default: 127.0.0.1)

Options:
  --no-resources[=<bool>]    Disable the MCP resource protocol (gdrive:/// listing/reading);
                             tools stay available. Bare flag disables; --no-resources=false
                             re-enables (overrides a truthy GOOGLE_DRIVE_MCP_DISABLE_RESOURCES).
  --api-timeout=<ms>         Per-request API timeout in ms; 0 disables (default: 120000)
  --retry-max=<n>            Max retry attempts on transient failures; 0 disables (default: 3)
  --retry-base-delay=<ms>    Base delay for retry backoff in ms (default: 1000)

Examples:
  npx @yourusername/google-drive-mcp auth
  npx @yourusername/google-drive-mcp start
  npx @yourusername/google-drive-mcp start --transport http --port 3100
  npx @yourusername/google-drive-mcp version
  npx @yourusername/google-drive-mcp

Environment Variables:
  GOOGLE_DRIVE_OAUTH_CREDENTIALS        Path to OAuth credentials file
  GOOGLE_DRIVE_MCP_TOKEN_PATH           Path to store authentication tokens
  GOOGLE_DRIVE_MCP_AUTH_PORT            Starting port for OAuth callback server (default: 3000, uses 5 consecutive ports)

  Common Configuration:
  GOOGLE_DRIVE_MCP_SCOPES               Comma-separated scopes to request (aliases or full URLs; defaults to all Drive/Docs/Sheets/Slides/Calendar scopes). Applies to local OAuth, external OAuth, and service account modes.
  GOOGLE_DRIVE_MCP_DISABLE_RESOURCES    Disable the MCP resource protocol (gdrive:/// listing/reading); tools stay available. Accepts 1/0, true/false, yes/no, on/off. Mirrored by the --no-resources[=<bool>] flag. (default: enabled)

  Transport Configuration:
  MCP_TRANSPORT                         Transport mode: stdio or http (default: stdio)
  MCP_HTTP_PORT                         HTTP listen port (default: 3100)
  MCP_HTTP_HOST                         HTTP bind address (default: 127.0.0.1)

  Service Account Mode:
  GOOGLE_APPLICATION_CREDENTIALS        Path to service account JSON key file
  GOOGLE_DRIVE_MCP_SUBJECT              Workspace user to impersonate via domain-wide delegation (optional)

  External OAuth Token Mode:
  GOOGLE_DRIVE_MCP_ACCESS_TOKEN         Pre-obtained Google OAuth access token
  GOOGLE_DRIVE_MCP_REFRESH_TOKEN        Refresh token for auto-refresh (optional)
  GOOGLE_DRIVE_MCP_CLIENT_ID            OAuth client ID (required with refresh token)
  GOOGLE_DRIVE_MCP_CLIENT_SECRET        OAuth client secret (required with refresh token)
`);
}

function showVersion(): void {
  console.log(`Google Drive MCP Server v${VERSION}`);
}

async function runAuthServer(alias?: string): Promise<void> {
  try {
    // Assemble the multi-account system WITHOUT the empty-store first-time flow, so
    // the CLI drives a single additive consent below. This never flat-overwrites a
    // populated tokens.json — the pre-fix legacy path wiped every other account.
    authSystem = await buildAuthSystem({ interactiveIfEmpty: false });
    const sys = requireAuthSystem();

    if (sys.mode !== 'local-oauth') {
      console.log(
        `Auth mode is '${sys.mode}'; credentials come from the environment — ` +
          `no interactive login is required.`,
      );
      process.exit(0);
    }

    const target =
      alias ?? sys.store.getDefault() ?? sys.store.list()[0]?.alias ?? 'default';

    // Fresh install bootstrapping a reserved alias (e.g. 'default'): addAccountFlow
    // can't create a reserved alias, so use the standard first-time flow, which
    // creates 'default' via v1→v2 migration. Safe: the store is empty here, so there
    // is nothing to overwrite.
    if (sys.store.list().length === 0 && RESERVED_ALIASES.has(target)) {
      authSystem = await buildAuthSystem();
      const created = requireAuthSystem().store.getDefault() ?? 'default';
      console.log(`Authentication successful. Account '${created}' is ready.`);
      process.exit(0);
    }

    console.log(
      `${sys.store.get(target) ? 'Re-authenticating' : 'Authenticating'} account ` +
        `'${target}'. Complete the consent in your browser...`,
    );

    const { completion, cancel } = await addAccountFlow(target, true);
    const timeoutMs = 5 * 60 * 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for OAuth consent.`)),
        timeoutMs,
      );
    });
    try {
      const record = await Promise.race([completion, timeout]);
      console.log(
        `Authentication successful. Account '${record.alias}' (${record.email}) is ready.`,
      );
      process.exit(0);
    } catch (err) {
      await cancel().catch(() => undefined);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (error) {
    console.error('Authentication failed:', (error as Error).message ?? error);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// MAIN EXECUTION
// -----------------------------------------------------------------------------

interface CliArgs {
  command: string | undefined;
  authAlias?: string;
  transport: 'stdio' | 'http';
  httpPort: number;
  httpHost: string;
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  let command: string | undefined;
  let authAlias: string | undefined;
  let transport: string | undefined;
  let httpPort: string | undefined;
  let httpHost: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--version' || arg === '-v' || arg === '--help' || arg === '-h') {
      command = arg;
      continue;
    }

    if (arg === '--transport' && i + 1 < args.length) {
      transport = args[++i];
      continue;
    }
    if (arg === '--port' && i + 1 < args.length) {
      httpPort = args[++i];
      continue;
    }
    if (arg === '--host' && i + 1 < args.length) {
      httpHost = args[++i];
      continue;
    }

    if (!command && !arg.startsWith('--')) {
      command = arg;
      continue;
    }
    // Second positional (e.g. `auth work`) is the target account alias.
    if (command && authAlias === undefined && !arg.startsWith('--')) {
      authAlias = arg;
      continue;
    }
  }

  const resolvedTransport = transport || process.env.MCP_TRANSPORT || 'stdio';
  if (resolvedTransport !== 'stdio' && resolvedTransport !== 'http') {
    console.error(`Invalid transport: ${resolvedTransport}. Must be "stdio" or "http".`);
    process.exit(1);
  }

  const resolvedPort = parseInt(httpPort || process.env.MCP_HTTP_PORT || '3100', 10);
  if (isNaN(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
    console.error(`Invalid port: ${httpPort || process.env.MCP_HTTP_PORT}. Must be 1-65535.`);
    process.exit(1);
  }

  return {
    command,
    authAlias,
    transport: resolvedTransport,
    httpPort: resolvedPort,
    httpHost: httpHost || process.env.MCP_HTTP_HOST || '127.0.0.1',
  };
}

async function main() {
  const args = parseCliArgs();

  switch (args.command) {
    case "auth":
      await runAuthServer(args.authAlias);
      break;
    case "start":
    case undefined:
      if (args.transport === 'http') {
        await startHttpTransport(args);
      } else {
        await startStdioTransport();
      }
      break;
    case "version":
    case "--version":
    case "-v":
      showVersion();
      break;
    case "help":
    case "--help":
    case "-h":
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      showHelp();
      process.exit(1);
  }
}

async function startStdioTransport(): Promise<void> {
  try {
    console.error("Starting Google Drive MCP server (stdio)...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('Server started successfully');

    process.on("SIGINT", async () => {
      await server.close();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      await server.close();
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
}

/**
 * Create an Express app with MCP Streamable HTTP routes.
 * Shared by production (startHttpTransport) and tests.
 */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

interface CreateHttpAppOptions {
  sessionIdleTimeoutMs?: number;
}

function createHttpApp(host: string, options?: CreateHttpAppOptions) {
  const idleTimeoutMs = options?.sessionIdleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS;
  const app = createMcpExpressApp({ host });
  const sessions = new Map<string, HttpSession>();
  const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function resetSessionTimer(sid: string) {
    const existing = sessionTimers.get(sid);
    if (existing) clearTimeout(existing);
    sessionTimers.set(sid, setTimeout(async () => {
      const session = sessions.get(sid);
      if (session) {
        log(`Session idle timeout: ${sid}`);
        await session.transport.close();
        await session.server.close();
        sessions.delete(sid);
        if (authSystem) authSystem.sessions.delete(sid);
      }
      sessionTimers.delete(sid);
    }, idleTimeoutMs));
  }

  function clearSessionTimer(sid: string) {
    const timer = sessionTimers.get(sid);
    if (timer) {
      clearTimeout(timer);
      sessionTimers.delete(sid);
    }
  }

  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      // If we have an existing session, delegate to it
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        resetSessionTimer(sessionId);
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      // New session: only accept initialize requests
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Bad Request: expected initialize request or valid session ID' },
          id: null,
        });
        return;
      }

      // Create a new session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      // We don't know the session id until after handleRequest — build the
      // server with a placeholder and rewire when the id is assigned.
      const sessionServer = createMcpServer();

      await sessionServer.connect(transport);

      // Track the session once we know its ID (set after handleRequest processes init)
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          clearSessionTimer(sid);
          sessions.delete(sid);
          if (authSystem) authSystem.sessions.delete(sid);
          log(`Session closed: ${sid}`);
        }
      };

      await transport.handleRequest(req, res, req.body);

      const sid = transport.sessionId;
      if (sid) {
        sessions.set(sid, { transport, server: sessionServer });
        resetSessionTimer(sid);
        if (authSystem) authSystem.sessions.getOrCreate(sid);
        log(`New session created: ${sid}`);
      }
    } catch (error) {
      log('Error handling POST /mcp', { error: (error as Error).message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Bad Request: missing or invalid session ID' },
          id: null,
        });
        return;
      }
      const session = sessions.get(sessionId)!;
      resetSessionTimer(sessionId);
      await session.transport.handleRequest(req, res);
    } catch (error) {
      log('Error handling GET /mcp', { error: (error as Error).message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.delete('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Bad Request: missing or invalid session ID' },
          id: null,
        });
        return;
      }
      const session = sessions.get(sessionId)!;
      await session.transport.close();
      await session.server.close();
      sessions.delete(sessionId);
      if (authSystem) authSystem.sessions.delete(sessionId);
      res.status(200).end();
    } catch (error) {
      log('Error handling DELETE /mcp', { error: (error as Error).message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  return { app, sessions };
}

async function startHttpTransport(args: CliArgs): Promise<void> {
  try {
    const { httpPort, httpHost } = args;
    console.error(`Starting Google Drive MCP server (HTTP on ${httpHost}:${httpPort})...`);

    const { app, sessions } = createHttpApp(httpHost);

    const httpServer = app.listen(httpPort, httpHost, () => {
      log(`HTTP server listening on ${httpHost}:${httpPort}`);
    });

    const shutdown = async () => {
      log('Shutting down HTTP server...');
      for (const [sid, session] of sessions) {
        await session.transport.close();
        await session.server.close();
        sessions.delete(sid);
      }
      httpServer.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error('Failed to start HTTP server:', error);
    process.exit(1);
  }
}

// Export server, factory, and main for testing or potential programmatic use
export { main, server, createMcpServer, createHttpApp };

/**
 * Inject a fake auth client for testing — bypasses `buildAuthSystem()`.
 *
 * Seeds an in-memory AccountStore (mode: 'test') with a single synthetic
 * account whose OAuth client is the provided fake. All existing `ctx.getDrive`
 * / `ctx.authClient` access paths resolve to this single account.
 */
export function _setAuthClientForTesting(client: any) {
  const store = new AccountStore({ mode: 'test' });
  const record: AccountRecord = {
    alias: 'test',
    email: 'test@example.com',
    sub: 'synthetic:test',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    scope: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/presentations',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ].join(' '),
    tokenType: 'Bearer',
    expiryDate: Date.now() + 60 * 60 * 1000,
    addedAt: new Date().toISOString(),
    lastRefreshedAt: new Date().toISOString(),
  };
  store.setSyntheticAccount(record, client);
  const sessions = new SessionStore();
  const factory = new AccountClientFactory(store);
  const resolver = new AccountResolver(store, sessions);
  authSystem = { mode: 'test', store, factory, resolver, sessions };
  _driveByAlias.clear();
  _calendarByAlias.clear();
}

/**
 * Read-only accessor for the test-mode AuthSystem. Tests use this to inspect
 * SessionStore lifecycle and AccountStore state without exporting either.
 */
export function _getAuthSystemForTesting(): AuthSystem | null {
  return authSystem;
}

/**
 * Add a second (or Nth) synthetic account to the test-mode auth system.
 *
 * Must be called *after* `_setAuthClientForTesting`. Lets multi-account
 * dispatch tests verify per-alias routing without standing up a real OAuth
 * flow. The supplied `client` is what `factory.getClient(alias)` will return,
 * so test-side instrumentation on it (markers, spies) flows into the
 * per-account ctx that handlers receive.
 */
export async function _addSyntheticAccountForTesting(
  alias: string,
  client: any,
  opts?: { setDefault?: boolean; scope?: string },
): Promise<void> {
  if (!authSystem) {
    throw new Error('_setAuthClientForTesting must be called before _addSyntheticAccountForTesting');
  }
  const record: AccountRecord = {
    alias,
    email: `${alias}@example.com`,
    sub: `synthetic:${alias}`,
    accessToken: `test-access-${alias}`,
    refreshToken: `test-refresh-${alias}`,
    scope: opts?.scope ?? [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/presentations',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ].join(' '),
    tokenType: 'Bearer',
    expiryDate: Date.now() + 60 * 60 * 1000,
    addedAt: new Date().toISOString(),
    lastRefreshedAt: new Date().toISOString(),
  };
  // setSyntheticAccount unconditionally promotes its arg to default; remember the
  // current default first so we can restore it unless the caller wanted a switch.
  const prevDefault = authSystem.store.getDefault();
  authSystem.store.setSyntheticAccount(record, client);
  if (!opts?.setDefault && prevDefault && prevDefault !== alias) {
    await authSystem.store.setDefault(prevDefault);
  }
  // Evict any cached drive/calendar services for the new alias so subsequent
  // ctx access rebuilds them through the factory (which returns the synthetic
  // client we just registered).
  _driveByAlias.delete(alias);
  _calendarByAlias.delete(alias);
}

// Run the CLI (skip when imported by tests)
if (!process.env.MCP_TESTING) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
