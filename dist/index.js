#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { google } from "googleapis";

// src/auth/client.ts
import { OAuth2Client } from "google-auth-library";
import * as fs from "fs/promises";

// src/auth/utils.ts
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
function getProjectRoot() {
  const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.join(__dirname2, "..", "..");
  return path.resolve(projectRoot);
}
function getConfigDir() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "google-drive-mcp");
}
function getSecureTokenPath() {
  const customTokenPath = process.env.GOOGLE_DRIVE_MCP_TOKEN_PATH;
  if (customTokenPath) {
    return path.resolve(customTokenPath);
  }
  return path.join(getConfigDir(), "tokens.json");
}
function getLegacyTokenPath() {
  const projectRoot = getProjectRoot();
  return path.join(projectRoot, ".gcp-saved-tokens.json");
}
function getAdditionalLegacyPaths() {
  return [
    process.env.GOOGLE_TOKEN_PATH,
    path.join(process.cwd(), "google-tokens.json"),
    path.join(process.cwd(), ".gcp-saved-tokens.json")
  ].filter(Boolean);
}
function getKeysFilePaths() {
  const paths = [];
  const envCredentialsPath = process.env.GOOGLE_DRIVE_OAUTH_CREDENTIALS;
  if (envCredentialsPath) {
    paths.push(path.resolve(envCredentialsPath));
  }
  paths.push(path.join(getConfigDir(), "gcp-oauth.keys.json"));
  const projectRoot = getProjectRoot();
  paths.push(path.join(projectRoot, "gcp-oauth.keys.json"));
  return paths;
}
function generateCredentialsErrorMessage() {
  const configDir = getConfigDir();
  return `
OAuth credentials not found. Please provide credentials using one of these methods:

1. Config directory (recommended):
   Place your gcp-oauth.keys.json file in: ${configDir}/

2. Environment variable:
   Set GOOGLE_DRIVE_OAUTH_CREDENTIALS to the path of your credentials file:
   export GOOGLE_DRIVE_OAUTH_CREDENTIALS="/path/to/gcp-oauth.keys.json"

Token storage:
- Tokens are saved to: ${getSecureTokenPath()}
- To use a custom token location, set GOOGLE_DRIVE_MCP_TOKEN_PATH environment variable

To get OAuth credentials:
1. Go to the Google Cloud Console (https://console.cloud.google.com/)
2. Create or select a project
3. Enable the Google Drive, Docs, Sheets, and Slides APIs
4. Create OAuth 2.0 credentials (Desktop app type)
5. Download the credentials file as gcp-oauth.keys.json
`.trim();
}

// src/auth/client.ts
function parseCredentialsFile(keys) {
  if (keys.installed) {
    const { client_id, client_secret, redirect_uris } = keys.installed;
    return { client_id, client_secret, redirect_uris };
  } else if (keys.web) {
    const { client_id, client_secret, redirect_uris } = keys.web;
    return { client_id, client_secret, redirect_uris };
  } else if (keys.client_id) {
    return {
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      redirect_uris: keys.redirect_uris || ["http://localhost:3000/oauth2callback"]
    };
  } else {
    throw new Error('Invalid credentials file format. Expected either "installed", "web" object or direct client_id field.');
  }
}
async function loadCredentialsFromFile() {
  const paths = getKeysFilePaths();
  for (const keysPath of paths) {
    try {
      const keysContent = await fs.readFile(keysPath, "utf-8");
      const keys = JSON.parse(keysContent);
      return parseCredentialsFile(keys);
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof Error && err.message.includes("Invalid credentials")) {
        throw new Error(`Invalid credentials file at ${keysPath}: ${err.message}`);
      }
    }
  }
  throw new Error(`Credentials file not found. Searched: ${paths.join(", ")}`);
}
async function loadCredentialsWithFallback() {
  try {
    return await loadCredentialsFromFile();
  } catch (fileError) {
    const legacyPath = process.env.GOOGLE_CLIENT_SECRET_PATH || "client_secret.json";
    try {
      const legacyContent = await fs.readFile(legacyPath, "utf-8");
      const legacyKeys = JSON.parse(legacyContent);
      console.error("Warning: Using legacy client_secret.json. Please migrate to gcp-oauth.keys.json");
      if (legacyKeys.installed) {
        return legacyKeys.installed;
      } else if (legacyKeys.web) {
        return legacyKeys.web;
      } else {
        throw new Error("Invalid legacy credentials format");
      }
    } catch (_legacyError) {
      const errorMessage = generateCredentialsErrorMessage();
      throw new Error(`${errorMessage}

Original error: ${fileError instanceof Error ? fileError.message : fileError}`);
    }
  }
}
async function initializeOAuth2Client() {
  try {
    const credentials = await loadCredentialsWithFallback();
    return new OAuth2Client({
      clientId: credentials.client_id,
      clientSecret: credentials.client_secret || void 0,
      redirectUri: credentials.redirect_uris?.[0] || "http://localhost:3000/oauth2callback"
    });
  } catch (error) {
    throw new Error(`Error loading OAuth keys: ${error instanceof Error ? error.message : error}`);
  }
}
async function loadCredentials() {
  try {
    const credentials = await loadCredentialsWithFallback();
    if (!credentials.client_id) {
      throw new Error("Client ID missing in credentials.");
    }
    return {
      client_id: credentials.client_id,
      client_secret: credentials.client_secret
    };
  } catch (error) {
    throw new Error(`Error loading credentials: ${error instanceof Error ? error.message : error}`);
  }
}

// src/auth/server.ts
import express from "express";
import { OAuth2Client as OAuth2Client2 } from "google-auth-library";

// src/auth/tokenManager.ts
import * as fs2 from "fs/promises";
import * as path2 from "path";
import { GaxiosError } from "gaxios";
var TokenManager = class {
  constructor(oauth2Client) {
    this.oauth2Client = oauth2Client;
    this.tokenPath = getSecureTokenPath();
    this.setupTokenRefresh();
  }
  // Method to expose the token path
  getTokenPath() {
    return this.tokenPath;
  }
  async ensureTokenDirectoryExists() {
    try {
      const dir = path2.dirname(this.tokenPath);
      await fs2.mkdir(dir, { recursive: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code !== "EEXIST") {
        console.error("Failed to create token directory:", error);
        throw error;
      }
    }
  }
  setupTokenRefresh() {
    this.oauth2Client.on("tokens", async (newTokens) => {
      try {
        await this.ensureTokenDirectoryExists();
        const currentTokens = JSON.parse(await fs2.readFile(this.tokenPath, "utf-8"));
        const updatedTokens = {
          ...currentTokens,
          ...newTokens,
          refresh_token: newTokens.refresh_token || currentTokens.refresh_token
        };
        await fs2.writeFile(this.tokenPath, JSON.stringify(updatedTokens, null, 2), {
          mode: 384
        });
        console.error("Tokens updated and saved");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          try {
            await fs2.writeFile(this.tokenPath, JSON.stringify(newTokens, null, 2), { mode: 384 });
            console.error("New tokens saved");
          } catch (writeError) {
            console.error("Error saving initial tokens:", writeError);
          }
        } else {
          console.error("Error saving updated tokens:", error);
        }
      }
    });
  }
  async migrateLegacyTokens() {
    const legacyPaths = [getLegacyTokenPath(), ...getAdditionalLegacyPaths()];
    for (const legacyPath of legacyPaths) {
      try {
        if (!await fs2.access(legacyPath).then(() => true).catch(() => false)) {
          continue;
        }
        const legacyTokens = JSON.parse(await fs2.readFile(legacyPath, "utf-8"));
        if (!legacyTokens || typeof legacyTokens !== "object") {
          console.error("Invalid legacy token format at", legacyPath, ", skipping");
          continue;
        }
        await this.ensureTokenDirectoryExists();
        await fs2.writeFile(this.tokenPath, JSON.stringify(legacyTokens, null, 2), {
          mode: 384
        });
        console.error("Migrated tokens from legacy location:", legacyPath, "to:", this.tokenPath);
        try {
          await fs2.unlink(legacyPath);
          console.error("Removed legacy token file");
        } catch (unlinkErr) {
          console.error("Warning: Could not remove legacy token file:", unlinkErr);
        }
        return true;
      } catch (error) {
        console.error("Error migrating legacy tokens from", legacyPath, ":", error);
      }
    }
    return false;
  }
  async loadSavedTokens() {
    try {
      await this.ensureTokenDirectoryExists();
      const tokenExists = await fs2.access(this.tokenPath).then(() => true).catch(() => false);
      if (!tokenExists) {
        const migrated = await this.migrateLegacyTokens();
        if (!migrated) {
          console.error("No token file found at:", this.tokenPath);
          return false;
        }
      }
      const tokens = JSON.parse(await fs2.readFile(this.tokenPath, "utf-8"));
      if (!tokens || typeof tokens !== "object") {
        console.error("Invalid token format in file:", this.tokenPath);
        return false;
      }
      this.oauth2Client.setCredentials(tokens);
      console.error("Tokens loaded and set on OAuth2Client:", {
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token,
        tokenLength: tokens.access_token?.length,
        expiryDate: tokens.expiry_date,
        scope: tokens.scope
      });
      console.error("OAuth2Client after setCredentials:", {
        hasCredentials: !!this.oauth2Client.credentials,
        credentialsAccessToken: !!this.oauth2Client.credentials?.access_token
      });
      return true;
    } catch (error) {
      console.error("Error loading tokens:", error);
      if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
        try {
          await fs2.unlink(this.tokenPath);
          console.error("Removed potentially corrupted token file");
        } catch (_unlinkErr) {
        }
      }
      return false;
    }
  }
  async refreshTokensIfNeeded() {
    const expiryDate = this.oauth2Client.credentials.expiry_date;
    const isExpired = expiryDate ? Date.now() >= expiryDate - 5 * 60 * 1e3 : !this.oauth2Client.credentials.access_token;
    if (isExpired && this.oauth2Client.credentials.refresh_token) {
      console.error("Auth token expired or nearing expiry, refreshing...");
      try {
        const response = await this.oauth2Client.refreshAccessToken();
        const newTokens = response.credentials;
        if (!newTokens.access_token) {
          throw new Error("Received invalid tokens during refresh");
        }
        this.oauth2Client.setCredentials(newTokens);
        console.error("Token refreshed successfully");
        return true;
      } catch (refreshError) {
        if (refreshError instanceof GaxiosError && refreshError.response?.data?.error === "invalid_grant") {
          console.error("Error refreshing auth token: Invalid grant. Token likely expired or revoked. Please re-authenticate.");
          await this.clearTokens();
          return false;
        } else {
          console.error("Error refreshing auth token:", refreshError);
          return false;
        }
      }
    } else if (!this.oauth2Client.credentials.access_token && !this.oauth2Client.credentials.refresh_token) {
      console.error("No access or refresh token available. Please re-authenticate.");
      return false;
    } else {
      return true;
    }
  }
  async validateTokens() {
    if (!this.oauth2Client.credentials || !this.oauth2Client.credentials.access_token) {
      if (!await this.loadSavedTokens()) {
        return false;
      }
      if (!this.oauth2Client.credentials || !this.oauth2Client.credentials.access_token) {
        return false;
      }
    }
    return this.refreshTokensIfNeeded();
  }
  async saveTokens(tokens) {
    try {
      await this.ensureTokenDirectoryExists();
      await fs2.writeFile(this.tokenPath, JSON.stringify(tokens, null, 2), { mode: 384 });
      this.oauth2Client.setCredentials(tokens);
      console.error("Tokens saved successfully to:", this.tokenPath);
    } catch (error) {
      console.error("Error saving tokens:", error);
      throw error;
    }
  }
  async clearTokens() {
    try {
      this.oauth2Client.setCredentials({});
      await fs2.unlink(this.tokenPath);
      console.error("Tokens cleared successfully");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        console.error("Token file already deleted");
      } else {
        console.error("Error clearing tokens:", error);
      }
    }
  }
};

// src/auth/server.ts
import open from "open";

// src/auth/scopes.ts
var SCOPE_ALIASES = {
  drive: "https://www.googleapis.com/auth/drive",
  "drive.file": "https://www.googleapis.com/auth/drive.file",
  "drive.readonly": "https://www.googleapis.com/auth/drive.readonly",
  documents: "https://www.googleapis.com/auth/documents",
  spreadsheets: "https://www.googleapis.com/auth/spreadsheets",
  presentations: "https://www.googleapis.com/auth/presentations",
  calendar: "https://www.googleapis.com/auth/calendar",
  "calendar.events": "https://www.googleapis.com/auth/calendar.events"
};
var SCOPE_PRESETS = {
  readonly: ["drive.readonly"],
  "content-editor": ["drive.file", "documents", "spreadsheets", "presentations"],
  full: ["drive", "documents", "spreadsheets", "presentations", "calendar", "calendar.events"]
};
var DEFAULT_SCOPES = [
  "drive",
  "drive.file",
  "drive.readonly",
  "documents",
  "spreadsheets",
  "presentations",
  "calendar",
  "calendar.events"
].map((s) => SCOPE_ALIASES[s]);
function resolveOAuthScopes() {
  const raw = process.env.GOOGLE_DRIVE_MCP_SCOPES?.trim();
  if (!raw) return [...DEFAULT_SCOPES];
  const scopes = raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    if (SCOPE_ALIASES[s]) return SCOPE_ALIASES[s];
    if (s.startsWith("https://")) return s;
    const known = Object.keys(SCOPE_ALIASES).join(", ");
    throw new Error(
      `Unknown OAuth scope alias "${s}". Use a full URL (https://...) or one of: ${known}`
    );
  });
  if (scopes.length === 0) return [...DEFAULT_SCOPES];
  return [...new Set(scopes)];
}

// src/auth/server.ts
var SCOPES = resolveOAuthScopes();
var AuthServer = class {
  // Flag for standalone script
  constructor(oauth2Client) {
    // Used by TokenManager for validation/refresh
    this.flowOAuth2Client = null;
    this.server = null;
    this.authCompletedSuccessfully = false;
    this.baseOAuth2Client = oauth2Client;
    this.tokenManager = new TokenManager(oauth2Client);
    this.app = express();
    const raw = process.env.GOOGLE_DRIVE_MCP_AUTH_PORT;
    const portStart = raw ? Number(raw) : 3e3;
    if (!Number.isInteger(portStart) || portStart < 1 || portStart > 65531) {
      throw new Error(
        `Invalid GOOGLE_DRIVE_MCP_AUTH_PORT: "${raw}". Must be an integer between 1 and 65531.`
      );
    }
    this.portRange = { start: portStart, end: portStart + 4 };
    this.setupRoutes();
  }
  setupRoutes() {
    this.app.get("/", (req, res) => {
      const clientForUrl = this.flowOAuth2Client || this.baseOAuth2Client;
      const authUrl = clientForUrl.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        prompt: "consent"
      });
      res.send(`<h1>Google Drive Authentication</h1><a href="${authUrl}">Authenticate with Google</a>`);
    });
    this.app.get("/oauth2callback", async (req, res) => {
      const code = req.query.code;
      if (!code) {
        res.status(400).send("Authorization code missing");
        return;
      }
      if (!this.flowOAuth2Client) {
        res.status(500).send("Authentication flow not properly initiated.");
        return;
      }
      try {
        const { tokens } = await this.flowOAuth2Client.getToken(code);
        await this.tokenManager.saveTokens(tokens);
        this.authCompletedSuccessfully = true;
        const tokenPath = this.tokenManager.getTokenPath();
        res.send(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Authentication Successful</title>
              <style>
                  body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f4f4f4; margin: 0; }
                  .container { text-align: center; padding: 2em; background-color: #fff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                  h1 { color: #4CAF50; }
                  p { color: #333; margin-bottom: 0.5em; }
                  code { background-color: #eee; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
              </style>
          </head>
          <body>
              <div class="container">
                  <h1>Authentication Successful!</h1>
                  <p>Your authentication tokens have been saved successfully to:</p>
                  <p><code>${tokenPath}</code></p>
                  <p>You can now close this browser window.</p>
              </div>
          </body>
          </html>
        `);
      } catch (error) {
        this.authCompletedSuccessfully = false;
        const message = error instanceof Error ? error.message : "Unknown error";
        res.status(500).send(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Authentication Failed</title>
              <style>
                  body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f4f4f4; margin: 0; }
                  .container { text-align: center; padding: 2em; background-color: #fff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                  h1 { color: #F44336; }
                  p { color: #333; }
              </style>
          </head>
          <body>
              <div class="container">
                  <h1>Authentication Failed</h1>
                  <p>An error occurred during authentication:</p>
                  <p><code>${message}</code></p>
                  <p>Please try again or check the server logs.</p>
              </div>
          </body>
          </html>
        `);
      }
    });
  }
  async start(openBrowser = true) {
    if (await this.tokenManager.validateTokens()) {
      this.authCompletedSuccessfully = true;
      return true;
    }
    const port = await this.startServerOnAvailablePort();
    if (port === null) {
      this.authCompletedSuccessfully = false;
      return false;
    }
    try {
      const { client_id, client_secret } = await loadCredentials();
      this.flowOAuth2Client = new OAuth2Client2(
        client_id,
        client_secret || void 0,
        `http://localhost:${port}/oauth2callback`
      );
    } catch (error) {
      console.error("Failed to load credentials for auth flow:", error);
      this.authCompletedSuccessfully = false;
      await this.stop();
      return false;
    }
    if (openBrowser) {
      const authorizeUrl = this.flowOAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        prompt: "consent"
      });
      console.error("\n\u{1F510} AUTHENTICATION REQUIRED");
      console.error("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
      console.error("\nOpening your browser to authenticate...");
      console.error(`If the browser doesn't open, visit:
${authorizeUrl}
`);
      await open(authorizeUrl);
    }
    return true;
  }
  async startServerOnAvailablePort() {
    for (let port = this.portRange.start; port <= this.portRange.end; port++) {
      try {
        await new Promise((resolve3, reject) => {
          const testServer = this.app.listen(port, () => {
            this.server = testServer;
            console.error(`Authentication server listening on http://localhost:${port}`);
            resolve3();
          });
          testServer.on("error", (err) => {
            if (err.code === "EADDRINUSE") {
              testServer.close(() => reject(err));
            } else {
              reject(err);
            }
          });
        });
        return port;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) {
          console.error("Failed to start auth server:", error);
          return null;
        }
      }
    }
    console.error("No available ports for authentication server (tried ports", this.portRange.start, "-", this.portRange.end, ")");
    return null;
  }
  getRunningPort() {
    if (this.server) {
      const address = this.server.address();
      if (typeof address === "object" && address !== null) {
        return address.port;
      }
    }
    return null;
  }
  async stop() {
    return new Promise((resolve3, reject) => {
      if (this.server) {
        this.server.close((err) => {
          if (err) {
            reject(err);
          } else {
            this.server = null;
            resolve3();
          }
        });
      } else {
        resolve3();
      }
    });
  }
};

// src/auth/externalAuth.ts
import { OAuth2Client as OAuth2Client3 } from "google-auth-library";
import { GoogleAuth } from "google-auth-library";
function isServiceAccountMode() {
  return !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
}
async function createServiceAccountAuth() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  console.error(`Using service account credentials from ${keyFile}`);
  const auth = new GoogleAuth({
    keyFile,
    scopes: [...DEFAULT_SCOPES]
  });
  const client = await auth.getClient();
  console.error("Service account authentication successful");
  return client;
}
function isExternalTokenMode() {
  return !!process.env.GOOGLE_DRIVE_MCP_ACCESS_TOKEN;
}
function validateExternalTokenConfig() {
  const accessToken = process.env.GOOGLE_DRIVE_MCP_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new Error(
      "GOOGLE_DRIVE_MCP_ACCESS_TOKEN is set but empty. Provide a valid OAuth access token."
    );
  }
  const refreshToken = process.env.GOOGLE_DRIVE_MCP_REFRESH_TOKEN?.trim();
  const clientId = process.env.GOOGLE_DRIVE_MCP_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_DRIVE_MCP_CLIENT_SECRET?.trim();
  if (refreshToken) {
    if (!clientId || !clientSecret) {
      throw new Error(
        "GOOGLE_DRIVE_MCP_REFRESH_TOKEN is set but GOOGLE_DRIVE_MCP_CLIENT_ID and/or GOOGLE_DRIVE_MCP_CLIENT_SECRET are missing. All three are required for automatic token refresh."
      );
    }
  }
  if (clientId && !clientSecret || !clientId && clientSecret) {
    throw new Error(
      "Both GOOGLE_DRIVE_MCP_CLIENT_ID and GOOGLE_DRIVE_MCP_CLIENT_SECRET must be provided together."
    );
  }
}
function createExternalOAuth2Client() {
  const accessToken = process.env.GOOGLE_DRIVE_MCP_ACCESS_TOKEN.trim();
  const refreshToken = process.env.GOOGLE_DRIVE_MCP_REFRESH_TOKEN?.trim();
  const clientId = process.env.GOOGLE_DRIVE_MCP_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_DRIVE_MCP_CLIENT_SECRET?.trim();
  const oauth2Client = new OAuth2Client3(clientId, clientSecret);
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken || void 0
  });
  if (!refreshToken) {
    console.error(
      "Warning: No refresh token provided. The access token will not auto-refresh when it expires."
    );
  } else {
    console.error("External OAuth tokens configured with auto-refresh support.");
  }
  return oauth2Client;
}

// src/auth.ts
async function authenticate() {
  console.error("Initializing authentication...");
  if (isServiceAccountMode()) {
    return await createServiceAccountAuth();
  }
  if (isExternalTokenMode()) {
    validateExternalTokenConfig();
    return createExternalOAuth2Client();
  }
  const oauth2Client = await initializeOAuth2Client();
  const tokenManager = new TokenManager(oauth2Client);
  if (await tokenManager.validateTokens()) {
    console.error("Authentication successful - using existing tokens");
    console.error("OAuth2Client credentials:", {
      hasAccessToken: !!oauth2Client.credentials?.access_token,
      hasRefreshToken: !!oauth2Client.credentials?.refresh_token,
      expiryDate: oauth2Client.credentials?.expiry_date
    });
    return oauth2Client;
  }
  console.error("\n\u{1F510} No valid authentication tokens found.");
  console.error("Starting authentication flow...\n");
  const authServer = new AuthServer(oauth2Client);
  const authSuccess = await authServer.start(true);
  if (!authSuccess) {
    throw new Error("Authentication failed. Please check your credentials and try again.");
  }
  await new Promise((resolve3) => {
    const checkInterval = setInterval(async () => {
      if (authServer.authCompletedSuccessfully) {
        clearInterval(checkInterval);
        await authServer.stop();
        resolve3();
      }
    }, 1e3);
  });
  return oauth2Client;
}

// src/index.ts
import { fileURLToPath as fileURLToPath2 } from "url";
import { readFileSync } from "fs";
import { join as join4, dirname as dirname4 } from "path";

// src/utils.ts
function buildCalendarEventUpdate(existing, overrides) {
  return {
    summary: overrides.summary !== void 0 ? overrides.summary : existing.summary,
    description: overrides.description !== void 0 ? overrides.description : existing.description,
    location: overrides.location !== void 0 ? overrides.location : existing.location,
    start: overrides.start || existing.start,
    end: overrides.end || existing.end,
    attendees: overrides.attendees !== void 0 ? overrides.attendees.map((email) => ({ email })) : existing.attendees,
    recurrence: existing.recurrence,
    visibility: existing.visibility,
    reminders: existing.reminders
  };
}
function getExtensionFromFilename(filename) {
  return filename.split(".").pop()?.toLowerCase() || "";
}
var TEXT_MIME_TYPES = {
  txt: "text/plain",
  md: "text/markdown"
};
function getMimeTypeFromFilename(filename) {
  const ext = getExtensionFromFilename(filename);
  return TEXT_MIME_TYPES[ext] || "text/plain";
}
function escapeDriveQuery(value) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
function parseA1Range(range) {
  if (range.includes("!")) {
    const sheetName = range.split("!")[0].replace(/^'+|'+$/g, "");
    const cellRange = range.split("!")[1];
    return { sheetName, cellRange };
  }
  return { sheetName: "Sheet1", cellRange: range };
}
function colToIndex(col) {
  let num = 0;
  for (let i = 0; i < col.length; i++) {
    num = num * 26 + (col.charCodeAt(i) - "A".charCodeAt(0) + 1);
  }
  return num - 1;
}
function convertA1ToGridRange(a1Notation, sheetId) {
  const rangeRegex = /^([A-Z]*)([0-9]*)(:([A-Z]*)([0-9]*))?$/;
  const match = a1Notation.match(rangeRegex);
  if (!match) {
    throw new Error(`Invalid A1 notation: ${a1Notation}`);
  }
  const [, startCol, startRow, , endCol, endRow] = match;
  const gridRange = { sheetId };
  if (startCol) gridRange.startColumnIndex = colToIndex(startCol);
  if (startRow) gridRange.startRowIndex = parseInt(startRow) - 1;
  if (endCol) {
    gridRange.endColumnIndex = colToIndex(endCol) + 1;
  } else if (startCol && !endCol) {
    gridRange.endColumnIndex = gridRange.startColumnIndex + 1;
  }
  if (endRow) {
    gridRange.endRowIndex = parseInt(endRow);
  } else if (startRow && !endRow) {
    gridRange.endRowIndex = gridRange.startRowIndex + 1;
  }
  return gridRange;
}

// src/types.ts
function errorResponse(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// src/utils/cliArgs.ts
var DEFAULTS = {
  apiTimeout: 12e4,
  retryMax: 3,
  retryBaseDelay: 1e3
};
function parseIntOr(value, fallback) {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function loadRuntimeConfig(argv = process.argv.slice(2)) {
  const cfg = { ...DEFAULTS };
  cfg.apiTimeout = parseIntOr(process.env.GOOGLE_DRIVE_MCP_API_TIMEOUT, cfg.apiTimeout);
  cfg.retryMax = parseIntOr(process.env.GOOGLE_DRIVE_MCP_RETRY_MAX, cfg.retryMax);
  cfg.retryBaseDelay = parseIntOr(process.env.GOOGLE_DRIVE_MCP_RETRY_BASE_DELAY, cfg.retryBaseDelay);
  for (const arg of argv) {
    if (arg.startsWith("--api-timeout=")) {
      cfg.apiTimeout = parseIntOr(arg.split("=")[1], cfg.apiTimeout);
    } else if (arg.startsWith("--retry-max=")) {
      cfg.retryMax = parseIntOr(arg.split("=")[1], cfg.retryMax);
    } else if (arg.startsWith("--retry-base-delay=")) {
      cfg.retryBaseDelay = parseIntOr(arg.split("=")[1], cfg.retryBaseDelay);
    }
  }
  return cfg;
}

// src/tools/drive.ts
var drive_exports = {};
__export(drive_exports, {
  handleTool: () => handleTool,
  toolDefinitions: () => toolDefinitions
});
import { z } from "zod";
import { existsSync as existsSync2, statSync as statSync2, createReadStream } from "fs";
import { mkdtemp, readFile as readFile3, writeFile as writeFile2, rm } from "fs/promises";
import { tmpdir } from "os";
import { basename as basename2, extname as extname2, join as join3 } from "path";
import { PDFDocument } from "pdf-lib";

// src/download-file.ts
import { createWriteStream, existsSync, renameSync, statSync, unlinkSync } from "fs";
import { basename, dirname as dirname3, extname, isAbsolute, join as join2, relative, resolve as resolve2 } from "path";
import { pipeline } from "stream/promises";
var GOOGLE_WORKSPACE_EXPORT_FORMATS = {
  "application/vnd.google-apps.document": {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    md: "text/markdown",
    txt: "text/plain",
    html: "text/html",
    rtf: "application/rtf",
    odt: "application/vnd.oasis.opendocument.text",
    epub: "application/epub+zip"
  },
  "application/vnd.google-apps.spreadsheet": {
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv",
    pdf: "application/pdf",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    tsv: "text/tab-separated-values",
    html: "text/html"
  },
  "application/vnd.google-apps.presentation": {
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pdf: "application/pdf",
    txt: "text/plain",
    odp: "application/vnd.oasis.opendocument.presentation"
  },
  "application/vnd.google-apps.drawing": {
    png: "image/png",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    jpg: "image/jpeg"
  }
};
var GOOGLE_WORKSPACE_DEFAULT_EXPORT = {
  "application/vnd.google-apps.document": { mimeType: "application/pdf", ext: ".pdf" },
  "application/vnd.google-apps.spreadsheet": { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" },
  "application/vnd.google-apps.presentation": { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx" },
  "application/vnd.google-apps.drawing": { mimeType: "image/png", ext: ".png" }
};
function sanitizeDriveFilename(driveName) {
  return basename(driveName).replace(/^\.+/, "") || "download";
}
function isPathWithinDirectory(targetPath, directoryPath) {
  const relativePath = relative(resolve2(directoryPath), resolve2(targetPath));
  return relativePath === "" || !relativePath.startsWith("..") && !isAbsolute(relativePath);
}
function resolveWorkspaceExport(driveMimeType, args, resolvedPath, isDirectory) {
  const formatMap = GOOGLE_WORKSPACE_EXPORT_FORMATS[driveMimeType];
  if (!formatMap) {
    throw new Error(
      `Unsupported Google Workspace type for export: ${driveMimeType}. Supported types: Document, Spreadsheet, Presentation, Drawing.`
    );
  }
  if (args.exportMimeType) {
    const validMimes = Object.values(formatMap);
    if (!validMimes.includes(args.exportMimeType)) {
      throw new Error(
        `Unsupported export format '${args.exportMimeType}' for ${driveMimeType}. Supported: ${Object.entries(formatMap).map(([ext, mime]) => `${mime} (.${ext})`).join(", ")}`
      );
    }
    const extForMime = Object.entries(formatMap).find(([, mime]) => mime === args.exportMimeType)?.[0] || "bin";
    return { exportMime: args.exportMimeType, fileExtForName: `.${extForMime}` };
  }
  if (!isDirectory && extname(resolvedPath)) {
    const ext = extname(resolvedPath).slice(1).toLowerCase();
    if (formatMap[ext]) {
      return { exportMime: formatMap[ext], fileExtForName: `.${ext}` };
    }
  }
  const defaultExport = GOOGLE_WORKSPACE_DEFAULT_EXPORT[driveMimeType];
  return { exportMime: defaultExport.mimeType, fileExtForName: defaultExport.ext };
}
function buildTempPath(resolvedPath) {
  const random = Math.random().toString(16).slice(2);
  return `${resolvedPath}.download-${Date.now()}-${random}.tmp`;
}
async function downloadDriveFile(drive, args, log2) {
  if (!isAbsolute(args.localPath)) {
    throw new Error("localPath must be an absolute path");
  }
  const normalizedLocalPath = resolve2(args.localPath);
  const fileMeta = await drive.files.get({
    fileId: args.fileId,
    fields: "id, name, mimeType, size",
    supportsAllDrives: true
  });
  const driveMimeType = fileMeta.data.mimeType;
  const driveName = fileMeta.data.name || "download";
  if (!driveMimeType) {
    throw new Error("File has no MIME type");
  }
  const isWorkspaceFile = driveMimeType.startsWith("application/vnd.google-apps");
  const overwrite = args.overwrite ?? false;
  let resolvedPath = normalizedLocalPath;
  let isDirectory = false;
  if (existsSync(resolvedPath)) {
    isDirectory = statSync(resolvedPath).isDirectory();
  } else {
    const parentDir = dirname3(resolvedPath);
    if (!existsSync(parentDir)) {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }
  }
  let exportMime;
  let fileExtForName = "";
  if (isWorkspaceFile) {
    const exportSelection = resolveWorkspaceExport(driveMimeType, args, resolvedPath, isDirectory);
    exportMime = exportSelection.exportMime;
    fileExtForName = exportSelection.fileExtForName;
  }
  if (isDirectory) {
    const safeName = sanitizeDriveFilename(driveName);
    let fileName = safeName;
    if (isWorkspaceFile) {
      const nameWithoutExt = safeName.replace(/\.[^.]+$/, "");
      fileName = `${nameWithoutExt}${fileExtForName}`;
    }
    resolvedPath = join2(resolvedPath, fileName);
    if (!isPathWithinDirectory(resolvedPath, normalizedLocalPath)) {
      throw new Error("Resolved file path escapes the target directory");
    }
  }
  const targetExists = existsSync(resolvedPath);
  if (targetExists && !overwrite) {
    throw new Error(`File already exists at ${resolvedPath}. Set overwrite: true to replace it.`);
  }
  log2("Downloading file", {
    fileId: args.fileId,
    driveName,
    driveMimeType,
    isWorkspaceFile,
    exportMime,
    localPath: resolvedPath
  });
  const response = isWorkspaceFile ? await drive.files.export({ fileId: args.fileId, mimeType: exportMime }, { responseType: "stream" }) : await drive.files.get({ fileId: args.fileId, alt: "media", supportsAllDrives: true }, { responseType: "stream" });
  const writePath = overwrite && targetExists ? buildTempPath(resolvedPath) : resolvedPath;
  const dest = createWriteStream(writePath);
  try {
    await pipeline(response.data, dest);
    if (writePath !== resolvedPath) {
      renameSync(writePath, resolvedPath);
    }
  } catch (downloadErr) {
    try {
      unlinkSync(writePath);
    } catch {
    }
    throw downloadErr;
  }
  const finalStats = statSync(resolvedPath);
  log2("File downloaded successfully", {
    fileId: args.fileId,
    localPath: resolvedPath,
    size: finalStats.size
  });
  return {
    driveName,
    driveMimeType,
    exportMime,
    isWorkspaceFile,
    resolvedPath,
    size: finalStats.size
  };
}

// src/tools/drive.ts
var FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
var SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
var BINARY_MIME_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/opus",
  mp4: "video/mp4",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  "3gp": "video/3gpp",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  json: "application/json",
  xml: "application/xml",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "application/javascript",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};
var SearchSchema = z.object({
  query: z.string().min(1, "Search query is required"),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
  rawQuery: z.boolean().optional()
});
var CreateTextFileSchema = z.object({
  name: z.string().min(1, "File name is required"),
  content: z.string(),
  parentFolderId: z.string().optional()
});
var UpdateTextFileSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  content: z.string(),
  name: z.string().optional()
});
var CreateFolderSchema = z.object({
  name: z.string().min(1, "Folder name is required"),
  parent: z.string().optional()
});
var ListFolderSchema = z.object({
  folderId: z.string().optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional()
});
var ListSharedDrivesSchema = z.object({
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional()
});
var DeleteItemSchema = z.object({
  itemId: z.string().min(1, "Item ID is required")
});
var RenameItemSchema = z.object({
  itemId: z.string().min(1, "Item ID is required"),
  newName: z.string().min(1, "New name is required")
});
var MoveItemSchema = z.object({
  itemId: z.string().min(1, "Item ID is required"),
  destinationFolderId: z.string().optional()
});
var CopyFileSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  newName: z.string().optional(),
  parentFolderId: z.string().optional()
});
var CreateShortcutSchema = z.object({
  targetFileId: z.string().min(1, "Target file ID is required"),
  parentFolderId: z.string().optional(),
  shortcutName: z.string().optional()
});
var LockFileSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  reason: z.string().optional(),
  ownerRestricted: z.boolean().optional()
});
var UnlockFileSchema = z.object({
  fileId: z.string().min(1, "File ID is required")
});
var UploadFileSchema = z.object({
  localPath: z.string().min(1, "Local file path is required"),
  name: z.string().optional(),
  parentFolderId: z.string().optional(),
  mimeType: z.string().optional(),
  convertToGoogleFormat: z.boolean().optional()
});
var DownloadFileSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  localPath: z.string().min(1, "Local file path is required"),
  exportMimeType: z.string().optional(),
  overwrite: z.boolean().optional().default(false)
});
var ListPermissionsSchema = z.object({
  fileId: z.string().min(1, "File ID is required")
});
var AddPermissionSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  emailAddress: z.string().email("Valid email is required"),
  role: z.enum(["owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"]).default("reader"),
  type: z.enum(["user", "group", "domain", "anyone"]).default("user"),
  sendNotificationEmail: z.boolean().optional().default(false),
  emailMessage: z.string().optional()
});
var UpdatePermissionSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  permissionId: z.string().min(1, "Permission ID is required"),
  role: z.enum(["owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"])
});
var RemovePermissionSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  permissionId: z.string().optional(),
  emailAddress: z.string().email("Valid email is required").optional()
}).superRefine((data, ctx) => {
  if (!data.permissionId && !data.emailAddress) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Either permissionId or emailAddress is required" });
  }
});
var ShareFileSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  emailAddress: z.string().email("Valid email is required"),
  role: z.enum(["writer", "commenter", "reader"]).default("reader"),
  sendNotificationEmail: z.boolean().optional().default(true),
  emailMessage: z.string().optional()
});
var ConvertPdfToGoogleDocSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  newName: z.string().optional(),
  parentFolderId: z.string().optional()
});
var BulkConvertFolderPdfsSchema = z.object({
  folderId: z.string().min(1, "Folder ID is required"),
  maxResults: z.number().int().min(1).max(200).optional().default(100),
  continueOnError: z.boolean().optional().default(true)
});
var UploadPdfWithSplitSchema = z.object({
  localPath: z.string().min(1, "Local file path is required"),
  split: z.boolean().optional().default(false),
  maxPagesPerChunk: z.number().int().min(1).max(500).optional(),
  parentFolderId: z.string().optional(),
  namePrefix: z.string().optional()
});
async function splitPdfIntoChunkFiles(localPath, maxPagesPerChunk) {
  const sourceBytes = await readFile3(localPath);
  const source = await PDFDocument.load(sourceBytes);
  const pageCount = source.getPageCount();
  if (pageCount === 0) {
    throw new Error("PDF contains no pages.");
  }
  const tempDir = await mkdtemp(join3(tmpdir(), "gdrive-mcp-split-"));
  const files = [];
  for (let start = 0, part = 1; start < pageCount; start += maxPagesPerChunk, part++) {
    const end = Math.min(start + maxPagesPerChunk, pageCount);
    const chunkDoc = await PDFDocument.create();
    const pages = await chunkDoc.copyPages(source, Array.from({ length: end - start }, (_, i) => start + i));
    for (const page of pages) chunkDoc.addPage(page);
    const chunkBytes = await chunkDoc.save();
    const chunkPath = join3(tempDir, `part-${part}.pdf`);
    await writeFile2(chunkPath, chunkBytes);
    files.push(chunkPath);
  }
  return { tempDir, files };
}
var GetRevisionsSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  pageSize: z.number().int().min(1).max(200).optional().default(50),
  pageToken: z.string().optional()
});
var RestoreRevisionSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  revisionId: z.string().min(1, "Revision ID is required"),
  confirm: z.boolean().optional().default(false)
});
var AuthTestFileAccessSchema = z.object({
  fileId: z.string().optional()
});
function getGrantedScopesFromAuthClient(ctx) {
  const scopeRaw = ctx.authClient?.credentials?.scope;
  if (!scopeRaw || typeof scopeRaw !== "string") return [];
  return [...new Set(scopeRaw.split(" ").map((s) => s.trim()).filter(Boolean))];
}
function resolveScopeStatus(ctx) {
  const requestedScopes = resolveOAuthScopes();
  const grantedScopes = getGrantedScopesFromAuthClient(ctx);
  const missingScopes = requestedScopes.filter((s) => !grantedScopes.includes(s));
  return { requestedScopes, grantedScopes, missingScopes };
}
var toolDefinitions = [
  {
    name: "search",
    description: "Search for files in Google Drive. Set rawQuery=true to pass a raw Google Drive API query supporting operators like modifiedTime, createdTime, mimeType, name contains, etc.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. When rawQuery=true, this is passed directly to the Google Drive API as the q parameter." },
        pageSize: { type: "number", description: "Results per page (default 50, max 100)" },
        pageToken: { type: "string", description: "Token for next page of results" },
        rawQuery: { type: "boolean", description: "If true, pass query directly to Google Drive API without wrapping in fullText contains. Enables date filters, mimeType filters, etc." }
      },
      required: ["query"]
    }
  },
  {
    name: "createTextFile",
    description: "Create a new text or markdown file",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name (.txt or .md)" },
        content: { type: "string", description: "File content" },
        parentFolderId: { type: "string", description: "Parent folder ID" }
      },
      required: ["name", "content"]
    }
  },
  {
    name: "updateTextFile",
    description: "Update an existing text or markdown file",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "ID of the file to update" },
        content: { type: "string", description: "New file content" },
        name: { type: "string", description: "New name (.txt or .md)" }
      },
      required: ["fileId", "content"]
    }
  },
  {
    name: "createFolder",
    description: "Create a new folder in Google Drive",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Folder name" },
        parent: { type: "string", description: "Parent folder ID or path" }
      },
      required: ["name"]
    }
  },
  {
    name: "listFolder",
    description: "List contents of a folder (defaults to root)",
    inputSchema: {
      type: "object",
      properties: {
        folderId: { type: "string", description: "Folder ID" },
        pageSize: { type: "number", description: "Items to return (default 50, max 100)" },
        pageToken: { type: "string", description: "Token for next page" }
      }
    }
  },
  {
    name: "listSharedDrives",
    description: "List available Google Shared Drives",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "number", description: "Drives to return (default 50, max 100)" },
        pageToken: { type: "string", description: "Token for next page" }
      }
    }
  },
  {
    name: "deleteItem",
    description: "Move a file or folder to trash (can be restored from Google Drive trash)",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "ID of the item to delete" }
      },
      required: ["itemId"]
    }
  },
  {
    name: "renameItem",
    description: "Rename a file or folder",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "ID of the item to rename" },
        newName: { type: "string", description: "New name" }
      },
      required: ["itemId", "newName"]
    }
  },
  {
    name: "moveItem",
    description: "Move a file or folder",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "ID of the item to move" },
        destinationFolderId: { type: "string", description: "Destination folder ID" }
      },
      required: ["itemId"]
    }
  },
  {
    name: "copyFile",
    description: "Creates a copy of a Google Drive file or document",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "ID of the file to copy" },
        newName: { type: "string", description: "Name for the copied file. If not provided, will use 'Copy of [original name]'" },
        parentFolderId: { type: "string", description: "ID or path of the destination folder (defaults to same folder as original)" }
      },
      required: ["fileId"]
    }
  },
  {
    name: "uploadFile",
    description: "Upload a local file (any type: image, audio, video, PDF, etc.) to Google Drive",
    inputSchema: {
      type: "object",
      properties: {
        localPath: { type: "string", description: "Absolute path to the local file to upload" },
        name: { type: "string", description: "File name in Drive (defaults to local filename)" },
        parentFolderId: { type: "string", description: "Parent folder ID or path (e.g., '/Work/Projects'). Creates folders if needed. Defaults to root." },
        mimeType: { type: "string", description: "MIME type (auto-detected from extension if omitted)" },
        convertToGoogleFormat: { type: "boolean", description: "Convert uploaded file to Google Workspace format (e.g., .docx to Google Doc, .xlsx to Google Sheet, .pptx to Google Slides). Defaults to false." }
      },
      required: ["localPath"]
    }
  },
  {
    name: "downloadFile",
    description: "Download a Google Drive file to a local path. For Google Workspace files (Docs, Sheets, Slides, Drawings), exports to the specified format. For regular files, downloads as-is. Streams directly to disk.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID" },
        localPath: { type: "string", description: "Absolute local path to save the file (must start with /). Can be a directory (filename auto-resolved from Drive metadata) or a full file path. Path is normalized before use." },
        exportMimeType: {
          type: "string",
          description: "For Google Workspace files: MIME type to export as (e.g., 'application/pdf', 'text/csv'). Auto-detected from file extension if omitted. Ignored for non-Workspace files."
        },
        overwrite: {
          type: "boolean",
          description: "Whether to overwrite if file already exists at localPath. When false (default), returns an error instead of replacing the file."
        }
      },
      required: ["fileId", "localPath"]
    }
  },
  {
    name: "listPermissions",
    description: "List sharing permissions for a file",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID" }
      },
      required: ["fileId"]
    }
  },
  {
    name: "addPermission",
    description: "Add a sharing permission to a file",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID" },
        emailAddress: { type: "string", description: "Target user/group email" },
        role: { type: "string", enum: ["owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"], description: "Permission role" },
        type: { type: "string", enum: ["user", "group", "domain", "anyone"], description: "Principal type" },
        sendNotificationEmail: { type: "boolean", description: "Send notification email" },
        emailMessage: { type: "string", description: "Custom message to include in the notification email. Ignored unless sendNotificationEmail is true." }
      },
      required: ["fileId", "emailAddress"]
    }
  },
  {
    name: "updatePermission",
    description: "Update an existing permission role",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID" },
        permissionId: { type: "string", description: "Permission ID" },
        role: { type: "string", enum: ["owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"], description: "New role" }
      },
      required: ["fileId", "permissionId", "role"]
    }
  },
  {
    name: "removePermission",
    description: "Remove a permission from a file (by permissionId or emailAddress)",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID" },
        permissionId: { type: "string", description: "Permission ID" },
        emailAddress: { type: "string", description: "User email (alternative to permissionId)" }
      },
      required: ["fileId"]
    }
  },
  {
    name: "shareFile",
    description: "Convenience wrapper to share a file with a user email",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID" },
        emailAddress: { type: "string", description: "User email" },
        role: { type: "string", enum: ["writer", "commenter", "reader"], description: "Access role" },
        sendNotificationEmail: { type: "boolean", description: "Send notification email" },
        emailMessage: { type: "string", description: "Custom message to include in the notification email. Ignored unless sendNotificationEmail is true." }
      },
      required: ["fileId", "emailAddress"]
    }
  },
  {
    name: "convertPdfToGoogleDoc",
    description: "Convert an existing PDF in Drive into an editable Google Doc",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "PDF file ID in Google Drive" },
        newName: { type: "string", description: "Optional name for converted Doc" },
        parentFolderId: { type: "string", description: "Optional destination folder ID" }
      },
      required: ["fileId"]
    }
  },
  {
    name: "bulkConvertFolderPdfs",
    description: "Convert all PDFs in a folder into Google Docs and return per-file results",
    inputSchema: {
      type: "object",
      properties: {
        folderId: { type: "string", description: "Folder ID containing PDFs" },
        maxResults: { type: "number", description: "Maximum PDFs to process (1-200, default: 100)" },
        continueOnError: { type: "boolean", description: "Continue conversion when one file fails (default: true)" }
      },
      required: ["folderId"]
    }
  },
  {
    name: "uploadPdfWithSplit",
    description: "Upload PDF and optionally split into chunked parts (metadata split plan for now)",
    inputSchema: {
      type: "object",
      properties: {
        localPath: { type: "string", description: "Absolute path to local PDF" },
        split: { type: "boolean", description: "Enable split mode" },
        maxPagesPerChunk: { type: "number", description: "Target max pages per chunk (advisory metadata)" },
        parentFolderId: { type: "string", description: "Optional destination folder ID" },
        namePrefix: { type: "string", description: "Optional output name prefix" }
      },
      required: ["localPath"]
    }
  },
  {
    name: "getRevisions",
    description: "List revisions for a file",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID" },
        pageSize: { type: "number", description: "Max revisions to return (default 50, max 200)" },
        pageToken: { type: "string", description: "Page token for pagination" }
      },
      required: ["fileId"]
    }
  },
  {
    name: "restoreRevision",
    description: "Restore a file to a selected revision (creates a new head revision). Note: workspace files (Docs, Sheets, Slides) are restored via export/import and may lose some formatting.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID" },
        revisionId: { type: "string", description: "Revision ID to restore" },
        confirm: { type: "boolean", description: "Safety flag. Must be true to execute restore." }
      },
      required: ["fileId", "revisionId"]
    }
  },
  {
    name: "authGetStatus",
    description: "Show authentication/token status and scope diagnostics",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "authListScopes",
    description: "List configured/requested scopes and currently granted scopes",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "authTestFileAccess",
    description: "Run auth diagnostics against Drive API/file access",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Optional file ID for targeted access check" }
      }
    }
  },
  {
    name: "createShortcut",
    description: "Create a shortcut (link) to a file or folder in Google Drive. Useful for referencing the same document from multiple locations without duplicating it.",
    inputSchema: {
      type: "object",
      properties: {
        targetFileId: {
          type: "string",
          description: "The file or folder ID (not a path) to create a shortcut to"
        },
        parentFolderId: {
          type: "string",
          description: "ID or path of the folder where the shortcut will be created"
        },
        shortcutName: {
          type: "string",
          description: "Custom name for the shortcut (defaults to original file name)"
        }
      },
      required: ["targetFileId"]
    }
  },
  {
    name: "lockFile",
    description: "Lock a file to prevent editing by setting content restrictions. The file remains readable but cannot be modified until unlocked.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: {
          type: "string",
          description: "ID of the file to lock"
        },
        reason: {
          type: "string",
          description: "Reason for locking the file (shown to users who try to edit)"
        },
        ownerRestricted: {
          type: "boolean",
          description: "If true, only the file owner can unlock the file (default: false)"
        }
      },
      required: ["fileId"]
    }
  },
  {
    name: "unlockFile",
    description: "Unlock a previously locked file by removing content restrictions, restoring full edit access.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: {
          type: "string",
          description: "ID of the file to unlock"
        }
      },
      required: ["fileId"]
    }
  }
];
async function handleTool(toolName, args, ctx) {
  switch (toolName) {
    case "search": {
      let resolveParentPath2 = function(folderId, depth = 0) {
        if (depth >= 10) return Promise.resolve(folderId);
        if (folderId in pathCache) return pathCache[folderId];
        const promise = (async () => {
          try {
            const folderRes = await ctx.getDrive().files.get({
              fileId: folderId,
              fields: "name, parents",
              supportsAllDrives: true
            });
            const name = folderRes.data.name || folderId;
            const parents = folderRes.data.parents;
            if (parents && parents.length > 0 && parents[0] !== folderId) {
              const parentPath = await resolveParentPath2(parents[0], depth + 1);
              return `${parentPath}/${name}`;
            }
            return name;
          } catch {
            return folderId;
          }
        })();
        pathCache[folderId] = promise;
        return promise;
      };
      var resolveParentPath = resolveParentPath2;
      const validation = SearchSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const { query: userQuery, pageSize, pageToken, rawQuery } = validation.data;
      let formattedQuery;
      if (rawQuery) {
        formattedQuery = /\btrashed\s*=/.test(userQuery) ? userQuery : `${userQuery} and trashed = false`;
      } else {
        const escapedQuery = escapeDriveQuery(userQuery);
        formattedQuery = `fullText contains '${escapedQuery}' and trashed = false`;
      }
      const res = await ctx.getDrive().files.list({
        q: formattedQuery,
        pageSize: Math.min(pageSize || 50, 100),
        pageToken,
        fields: "nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, size, parents)",
        corpora: "allDrives",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true
      });
      const pathCache = {};
      const files = res.data.files || [];
      const fileLines = await Promise.all(
        files.map(async (f) => {
          let folderPath = "";
          if (f.parents && f.parents.length > 0) {
            folderPath = await resolveParentPath2(f.parents[0]);
          }
          return `${f.name} (${f.mimeType}) [id: ${f.id}, path: ${folderPath || "/"}] [created: ${f.createdTime || "N/A"}, modified: ${f.modifiedTime || "N/A"}]`;
        })
      );
      ctx.log("Search results", { query: userQuery, rawQuery: !!rawQuery, resultCount: files.length });
      let response = `Found ${files.length} files:
${fileLines.join("\n")}`;
      if (res.data.nextPageToken) {
        response += `

More results available. Use pageToken: ${res.data.nextPageToken}`;
      }
      return {
        content: [{ type: "text", text: response }],
        isError: false
      };
    }
    case "createTextFile": {
      const validation = CreateTextFileSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      ctx.validateTextFileExtension(data.name);
      const parentFolderId = await ctx.resolveFolderId(data.parentFolderId);
      const existingFileId = await ctx.checkFileExists(data.name, parentFolderId);
      if (existingFileId) {
        return errorResponse(
          `A file named "${data.name}" already exists in this location. To update it, use updateTextFile with fileId: ${existingFileId}`
        );
      }
      const fileMetadata = {
        name: data.name,
        mimeType: getMimeTypeFromFilename(data.name),
        parents: [parentFolderId]
      };
      const file = await ctx.getDrive().files.create({
        requestBody: fileMetadata,
        media: {
          mimeType: fileMetadata.mimeType,
          body: data.content
        },
        supportsAllDrives: true
      });
      ctx.log("File created successfully", { fileId: file.data?.id });
      return {
        content: [{
          type: "text",
          text: `Created file: ${file.data?.name || data.name}
ID: ${file.data?.id || "unknown"}`
        }],
        isError: false
      };
    }
    case "updateTextFile": {
      const validation = UpdateTextFileSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      const existingFile = await ctx.getDrive().files.get({
        fileId: data.fileId,
        fields: "mimeType, name, parents",
        supportsAllDrives: true
      });
      const currentMimeType = existingFile.data.mimeType || "text/plain";
      if (!Object.values(TEXT_MIME_TYPES).includes(currentMimeType)) {
        return errorResponse("File is not a text or markdown file.");
      }
      const updateMetadata = {};
      if (data.name) {
        ctx.validateTextFileExtension(data.name);
        updateMetadata.name = data.name;
        updateMetadata.mimeType = getMimeTypeFromFilename(data.name);
      }
      const updatedFile = await ctx.getDrive().files.update({
        fileId: data.fileId,
        requestBody: updateMetadata,
        media: {
          mimeType: updateMetadata.mimeType || currentMimeType,
          body: data.content
        },
        fields: "id, name, modifiedTime, webViewLink",
        supportsAllDrives: true
      });
      return {
        content: [{
          type: "text",
          text: `Updated file: ${updatedFile.data.name}
Modified: ${updatedFile.data.modifiedTime}`
        }],
        isError: false
      };
    }
    case "createFolder": {
      const validation = CreateFolderSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      const parentFolderId = await ctx.resolveFolderId(data.parent);
      const existingFolderId = await ctx.checkFileExists(data.name, parentFolderId);
      if (existingFolderId) {
        return errorResponse(
          `A folder named "${data.name}" already exists in this location. Folder ID: ${existingFolderId}`
        );
      }
      const folderMetadata = {
        name: data.name,
        mimeType: FOLDER_MIME_TYPE,
        parents: [parentFolderId]
      };
      const folder = await ctx.getDrive().files.create({
        requestBody: folderMetadata,
        fields: "id, name, webViewLink",
        supportsAllDrives: true
      });
      ctx.log("Folder created successfully", { folderId: folder.data.id, name: folder.data.name });
      return {
        content: [{
          type: "text",
          text: `Created folder: ${folder.data.name}
ID: ${folder.data.id}`
        }],
        isError: false
      };
    }
    case "listFolder": {
      const validation = ListFolderSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      const targetFolderId = data.folderId || "root";
      const res = await ctx.getDrive().files.list({
        q: `'${targetFolderId}' in parents and trashed = false`,
        pageSize: Math.min(data.pageSize || 50, 100),
        pageToken: data.pageToken,
        fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size)",
        orderBy: "name",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true
      });
      const files = res.data.files || [];
      const formattedFiles = files.map((file) => {
        const isFolder = file.mimeType === FOLDER_MIME_TYPE;
        return `${isFolder ? "\u{1F4C1}" : "\u{1F4C4}"} ${file.name} (ID: ${file.id})`;
      }).join("\n");
      let response = `Contents of folder:

${formattedFiles}`;
      if (res.data.nextPageToken) {
        response += `

More items available. Use pageToken: ${res.data.nextPageToken}`;
      }
      return {
        content: [{ type: "text", text: response }],
        isError: false
      };
    }
    case "listSharedDrives": {
      const validation = ListSharedDrivesSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      const res = await ctx.getDrive().drives.list({
        pageSize: Math.min(data.pageSize || 50, 100),
        pageToken: data.pageToken,
        fields: "nextPageToken, drives(id, name, createdTime, hidden)"
      });
      const drives = res.data.drives || [];
      if (drives.length === 0) {
        return { content: [{ type: "text", text: "No shared drives found." }], isError: false };
      }
      const formatted = drives.map((d) => `${d.name} (ID: ${d.id}${d.hidden ? ", hidden" : ""})`).join("\n");
      let response = `Found ${drives.length} shared drives:
${formatted}`;
      if (res.data.nextPageToken) {
        response += `

More results available. Use pageToken: ${res.data.nextPageToken}`;
      }
      return {
        content: [{ type: "text", text: response }],
        isError: false
      };
    }
    case "deleteItem": {
      const validation = DeleteItemSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      const item = await ctx.getDrive().files.get({ fileId: data.itemId, fields: "name", supportsAllDrives: true });
      await ctx.getDrive().files.update({
        fileId: data.itemId,
        requestBody: {
          trashed: true
        },
        supportsAllDrives: true
      });
      ctx.log("Item moved to trash successfully", { itemId: data.itemId, name: item.data.name });
      return {
        content: [{ type: "text", text: `Successfully moved to trash: ${item.data.name}` }],
        isError: false
      };
    }
    case "renameItem": {
      const validation = RenameItemSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      const item = await ctx.getDrive().files.get({ fileId: data.itemId, fields: "name, mimeType", supportsAllDrives: true });
      if (Object.values(TEXT_MIME_TYPES).includes(item.data.mimeType || "")) {
        ctx.validateTextFileExtension(data.newName);
      }
      const updatedItem = await ctx.getDrive().files.update({
        fileId: data.itemId,
        requestBody: { name: data.newName },
        fields: "id, name, modifiedTime",
        supportsAllDrives: true
      });
      return {
        content: [{
          type: "text",
          text: `Successfully renamed "${item.data.name}" to "${updatedItem.data.name}"`
        }],
        isError: false
      };
    }
    case "moveItem": {
      const validation = MoveItemSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      const destinationFolderId = data.destinationFolderId ? await ctx.resolveFolderId(data.destinationFolderId) : "root";
      if (data.destinationFolderId === data.itemId) {
        return errorResponse("Cannot move a folder into itself.");
      }
      const item = await ctx.getDrive().files.get({ fileId: data.itemId, fields: "name, parents", supportsAllDrives: true });
      await ctx.getDrive().files.update({
        fileId: data.itemId,
        addParents: destinationFolderId,
        removeParents: item.data.parents?.join(",") || "",
        fields: "id, name, parents",
        supportsAllDrives: true
      });
      const destinationFolder = await ctx.getDrive().files.get({
        fileId: destinationFolderId,
        fields: "name",
        supportsAllDrives: true
      });
      return {
        content: [{
          type: "text",
          text: `Successfully moved "${item.data.name}" to "${destinationFolder.data.name}"`
        }],
        isError: false
      };
    }
    case "copyFile": {
      const validation = CopyFileSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      const originalFile = await ctx.getDrive().files.get({
        fileId: data.fileId,
        fields: "name,parents",
        supportsAllDrives: true
      });
      const copyMetadata = {
        name: data.newName || `Copy of ${originalFile.data.name}`
      };
      if (data.parentFolderId) {
        const resolvedParentId = await ctx.resolveFolderId(data.parentFolderId);
        copyMetadata.parents = [resolvedParentId];
      } else if (originalFile.data.parents) {
        copyMetadata.parents = originalFile.data.parents;
      }
      const response = await ctx.getDrive().files.copy({
        fileId: data.fileId,
        requestBody: copyMetadata,
        fields: "id,name,webViewLink,parents",
        supportsAllDrives: true
      });
      return {
        content: [{ type: "text", text: `Successfully copied file as "${response.data.name}"
New file ID: ${response.data.id}
Link: ${response.data.webViewLink}` }],
        isError: false
      };
    }
    case "createShortcut": {
      const validation = CreateShortcutSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      const parentId = await ctx.resolveFolderId(data.parentFolderId);
      const targetFile = await ctx.getDrive().files.get({
        fileId: data.targetFileId,
        fields: "id, name, mimeType",
        supportsAllDrives: true
      });
      const shortcutName = data.shortcutName || targetFile.data.name || "Shortcut";
      const shortcut = await ctx.getDrive().files.create({
        requestBody: {
          name: shortcutName,
          mimeType: SHORTCUT_MIME_TYPE,
          shortcutDetails: {
            targetId: data.targetFileId
          },
          parents: [parentId]
        },
        fields: "id, name, webViewLink, shortcutDetails",
        supportsAllDrives: true
      });
      ctx.log("Shortcut created", {
        shortcutId: shortcut.data.id,
        targetId: data.targetFileId,
        name: shortcutName
      });
      return {
        content: [{
          type: "text",
          text: `Shortcut created successfully!

Shortcut: ${shortcut.data.name} (${shortcut.data.id})
Target: ${targetFile.data.name} (${data.targetFileId})
Location: folder ${parentId}
Link: ${shortcut.data.webViewLink || "N/A"}`
        }],
        isError: false
      };
    }
    case "lockFile": {
      const validation = LockFileSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      const fileInfo = await ctx.getDrive().files.get({
        fileId: data.fileId,
        fields: "id, name, contentRestrictions",
        supportsAllDrives: true
      });
      const existingRestrictions = fileInfo.data.contentRestrictions || [];
      if (existingRestrictions.some((r) => r.readOnly)) {
        return {
          content: [{
            type: "text",
            text: `File "${fileInfo.data.name}" is already locked.`
          }],
          isError: false
        };
      }
      await ctx.getDrive().files.update({
        fileId: data.fileId,
        requestBody: {
          contentRestrictions: [{
            readOnly: true,
            reason: data.reason || "Locked via MCP",
            ownerRestricted: data.ownerRestricted ?? false
          }]
        },
        supportsAllDrives: true
      });
      ctx.log("File locked", { fileId: data.fileId, name: fileInfo.data.name, reason: data.reason });
      return {
        content: [{
          type: "text",
          text: `File locked successfully!

File: ${fileInfo.data.name}
Reason: ${data.reason || "Locked via MCP"}${data.ownerRestricted ? "\nOwner-restricted: only the file owner can unlock" : ""}

The file is now read-only and cannot be edited or deleted.`
        }],
        isError: false
      };
    }
    case "unlockFile": {
      const validation = UnlockFileSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      const fileInfo = await ctx.getDrive().files.get({
        fileId: data.fileId,
        fields: "id, name, contentRestrictions",
        supportsAllDrives: true
      });
      const existingRestrictions = fileInfo.data.contentRestrictions || [];
      if (!existingRestrictions.some((r) => r.readOnly)) {
        return {
          content: [{
            type: "text",
            text: `File "${fileInfo.data.name}" is not locked.`
          }],
          isError: false
        };
      }
      await ctx.getDrive().files.update({
        fileId: data.fileId,
        requestBody: {
          contentRestrictions: [{ readOnly: false }]
        },
        supportsAllDrives: true
      });
      ctx.log("File unlocked", { fileId: data.fileId, name: fileInfo.data.name });
      return {
        content: [{
          type: "text",
          text: `File unlocked successfully!

File: ${fileInfo.data.name}

The file can now be edited and deleted.`
        }],
        isError: false
      };
    }
    case "uploadFile": {
      const validation = UploadFileSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      if (!existsSync2(data.localPath)) {
        return errorResponse(`File not found: ${data.localPath}`);
      }
      const stats = statSync2(data.localPath);
      const fileName = data.name || data.localPath.split(/[\\/]/).pop() || "upload";
      const ext = fileName.split(".").pop()?.toLowerCase() || "";
      const detectedMime = data.mimeType || BINARY_MIME_TYPES[ext] || "application/octet-stream";
      const parentId = await ctx.resolveFolderId(data.parentFolderId);
      const GOOGLE_FORMAT_MAP = {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "application/vnd.google-apps.document",
        "application/msword": "application/vnd.google-apps.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "application/vnd.google-apps.spreadsheet",
        "application/vnd.ms-excel": "application/vnd.google-apps.spreadsheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": "application/vnd.google-apps.presentation",
        "application/vnd.ms-powerpoint": "application/vnd.google-apps.presentation"
      };
      const targetMimeType = data.convertToGoogleFormat ? GOOGLE_FORMAT_MAP[detectedMime] : void 0;
      if (data.convertToGoogleFormat && !targetMimeType) {
        return errorResponse(
          `Cannot convert MIME type "${detectedMime}" to a Google Workspace format. Supported: .docx, .doc, .xlsx, .xls, .pptx, .ppt`
        );
      }
      const uploadName = targetMimeType ? fileName.replace(/\.[^.]+$/, "") : fileName;
      ctx.log("Uploading file", { localPath: data.localPath, name: uploadName, mimeType: detectedMime, convertToGoogle: !!targetMimeType, size: stats.size });
      const requestBody = {
        name: uploadName,
        parents: [parentId]
      };
      if (targetMimeType) {
        requestBody.mimeType = targetMimeType;
      }
      const file = await ctx.getDrive().files.create({
        requestBody,
        media: {
          mimeType: detectedMime,
          body: createReadStream(data.localPath)
        },
        fields: "id, name, size, mimeType, webViewLink",
        supportsAllDrives: true
      });
      ctx.log("File uploaded successfully", { fileId: file.data?.id });
      return {
        content: [{
          type: "text",
          text: [
            `Uploaded: ${file.data?.name || fileName}`,
            `ID: ${file.data?.id || "unknown"}`,
            `Size: ${file.data?.size || stats.size} bytes`,
            `Type: ${file.data?.mimeType || detectedMime}`,
            file.data?.webViewLink ? `Link: ${file.data.webViewLink}` : ""
          ].filter(Boolean).join("\n")
        }],
        isError: false
      };
    }
    case "downloadFile": {
      const validation = DownloadFileSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const data = validation.data;
      const downloadResult = await downloadDriveFile(ctx.getDrive(), data, ctx.log);
      return {
        content: [{
          type: "text",
          text: [
            `Downloaded: ${downloadResult.driveName}`,
            `Saved to: ${downloadResult.resolvedPath}`,
            `Size: ${downloadResult.size} bytes`,
            downloadResult.isWorkspaceFile ? `Export format: ${downloadResult.exportMime}` : `Type: ${downloadResult.driveMimeType}`
          ].join("\n")
        }],
        isError: false
      };
    }
    case "listPermissions": {
      const validation = ListPermissionsSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;
      const response = await ctx.getDrive().permissions.list({
        fileId: data.fileId,
        fields: "permissions(id,type,role,emailAddress,domain,displayName,permissionDetails(inherited,inheritedFrom,permissionType))",
        supportsAllDrives: true
      });
      const permissions = response.data.permissions || [];
      if (permissions.length === 0) {
        return { content: [{ type: "text", text: "No permissions found." }], isError: false };
      }
      const lines = permissions.map((p) => {
        const who = p.emailAddress || p.domain || p.displayName || p.type || "unknown";
        const inherited = p.permissionDetails?.some((d) => d.inherited === true) ?? false;
        const inheritedFrom = p.permissionDetails?.find((d) => d.inheritedFrom)?.inheritedFrom;
        const inheritedMarker = inherited ? ` [inherited${inheritedFrom ? ` from ${inheritedFrom}` : ""}]` : " [direct]";
        return `- ${p.id}: ${who} (${p.type}) => ${p.role}${inheritedMarker}`;
      });
      return { content: [{ type: "text", text: `Permissions for file ${data.fileId}:
${lines.join("\n")}` }], isError: false };
    }
    case "addPermission": {
      const validation = AddPermissionSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;
      const response = await ctx.getDrive().permissions.create({
        fileId: data.fileId,
        requestBody: {
          type: data.type,
          role: data.role,
          emailAddress: data.emailAddress
        },
        sendNotificationEmail: data.sendNotificationEmail,
        ...data.emailMessage && { emailMessage: data.emailMessage },
        fields: "id,type,role,emailAddress",
        supportsAllDrives: true
      });
      return { content: [{ type: "text", text: `Permission added: ${response.data.id} (${response.data.role}) for ${response.data.emailAddress || data.emailAddress}` }], isError: false };
    }
    case "updatePermission": {
      const validation = UpdatePermissionSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;
      const response = await ctx.getDrive().permissions.update({
        fileId: data.fileId,
        permissionId: data.permissionId,
        requestBody: { role: data.role },
        fields: "id,type,role,emailAddress",
        supportsAllDrives: true
      });
      return { content: [{ type: "text", text: `Permission updated: ${response.data.id} => ${response.data.role}` }], isError: false };
    }
    case "removePermission": {
      const validation = RemovePermissionSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;
      let permissionId = data.permissionId;
      if (!permissionId && data.emailAddress) {
        const listed = await ctx.getDrive().permissions.list({
          fileId: data.fileId,
          fields: "permissions(id,type,emailAddress)",
          supportsAllDrives: true
        });
        const found = (listed.data.permissions || []).find(
          (p) => p.type === "user" && (p.emailAddress || "").toLowerCase() === data.emailAddress.toLowerCase()
        );
        if (!found?.id) {
          return errorResponse(`No permission found for ${data.emailAddress}`);
        }
        permissionId = found.id;
      }
      if (!permissionId) {
        return errorResponse("Could not resolve a permission ID to remove");
      }
      await ctx.getDrive().permissions.delete({
        fileId: data.fileId,
        permissionId,
        supportsAllDrives: true
      });
      return { content: [{ type: "text", text: `Permission removed: ${permissionId}` }], isError: false };
    }
    case "shareFile": {
      const validation = ShareFileSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;
      const existing = await ctx.getDrive().permissions.list({
        fileId: data.fileId,
        fields: "permissions(id,type,emailAddress,role)",
        supportsAllDrives: true
      });
      const existingPerm = (existing.data.permissions || []).find(
        (p) => p.type === "user" && (p.emailAddress || "").toLowerCase() === data.emailAddress.toLowerCase()
      );
      if (existingPerm?.id) {
        if (existingPerm.role === data.role) {
          return {
            content: [{ type: "text", text: `No changes needed: ${data.emailAddress} already has role ${data.role}. Permission ID: ${existingPerm.id}` }],
            isError: false
          };
        }
        const updated = await ctx.getDrive().permissions.update({
          fileId: data.fileId,
          permissionId: existingPerm.id,
          requestBody: { role: data.role },
          fields: "id,type,role,emailAddress",
          supportsAllDrives: true
        });
        return {
          content: [{ type: "text", text: `Updated existing permission for ${updated.data.emailAddress || data.emailAddress} to ${updated.data.role}. Permission ID: ${updated.data.id}` }],
          isError: false
        };
      }
      const response = await ctx.getDrive().permissions.create({
        fileId: data.fileId,
        requestBody: {
          type: "user",
          role: data.role,
          emailAddress: data.emailAddress
        },
        sendNotificationEmail: data.sendNotificationEmail,
        ...data.emailMessage && { emailMessage: data.emailMessage },
        fields: "id,type,role,emailAddress",
        supportsAllDrives: true
      });
      return {
        content: [{ type: "text", text: `Shared file with ${response.data.emailAddress || data.emailAddress} as ${response.data.role}. Permission ID: ${response.data.id}` }],
        isError: false
      };
    }
    case "convertPdfToGoogleDoc": {
      const validation = ConvertPdfToGoogleDocSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;
      const source = await ctx.getDrive().files.get({
        fileId: data.fileId,
        fields: "id,name,mimeType,parents",
        supportsAllDrives: true
      });
      if (source.data.mimeType !== "application/pdf") {
        return errorResponse(`File ${data.fileId} is not a PDF (mimeType=${source.data.mimeType || "unknown"})`);
      }
      const parentId = data.parentFolderId || source.data.parents?.[0];
      const converted = await ctx.getDrive().files.copy({
        fileId: data.fileId,
        requestBody: {
          name: data.newName || `${source.data.name || "Converted PDF"} (Doc)`,
          mimeType: "application/vnd.google-apps.document",
          ...parentId ? { parents: [parentId] } : {}
        },
        fields: "id,name,webViewLink,mimeType",
        supportsAllDrives: true
      });
      return { content: [{ type: "text", text: `Converted PDF to Google Doc: ${converted.data.name}
ID: ${converted.data.id}
Link: ${converted.data.webViewLink}` }], isError: false };
    }
    case "bulkConvertFolderPdfs": {
      const validation = BulkConvertFolderPdfsSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;
      const list = await ctx.getDrive().files.list({
        q: `'${data.folderId}' in parents and mimeType='application/pdf' and trashed=false`,
        pageSize: data.maxResults,
        fields: "files(id,name,mimeType)",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true
      });
      const files = list.data.files || [];
      const results = [];
      for (const f of files) {
        try {
          const converted = await ctx.getDrive().files.copy({
            fileId: f.id,
            requestBody: {
              name: `${f.name || "Converted PDF"} (Doc)`,
              mimeType: "application/vnd.google-apps.document",
              parents: [data.folderId]
            },
            fields: "id,name",
            supportsAllDrives: true
          });
          results.push({ id: f.id ?? void 0, name: f.name ?? void 0, docId: converted.data.id ?? void 0, ok: true });
        } catch (err) {
          const message = err?.message || "Unknown conversion error";
          results.push({ id: f.id ?? void 0, name: f.name ?? void 0, ok: false, error: message });
          if (!data.continueOnError) break;
        }
      }
      const ok = results.filter((r) => r.ok).length;
      const fail = results.length - ok;
      return {
        content: [{ type: "text", text: `Bulk PDF conversion finished. Processed=${results.length}, Success=${ok}, Failed=${fail}

${results.map((r) => r.ok ? `\u2705 ${r.name} -> ${r.docId}` : `\u274C ${r.name}: ${r.error}`).join("\n")}` }],
        isError: false
      };
    }
    case "uploadPdfWithSplit": {
      const validation = UploadPdfWithSplitSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;
      if (!existsSync2(data.localPath)) return errorResponse(`File not found: ${data.localPath}`);
      const parentId = await ctx.resolveFolderId(data.parentFolderId);
      if (!data.split) {
        const fileName = data.namePrefix || basename2(data.localPath) || "upload.pdf";
        const uploaded = await ctx.getDrive().files.create({
          requestBody: { name: fileName, parents: [parentId] },
          media: { mimeType: "application/pdf", body: createReadStream(data.localPath) },
          fields: "id,name,webViewLink",
          supportsAllDrives: true
        });
        return {
          content: [{ type: "text", text: `Uploaded PDF without split: ${uploaded.data.name}
ID: ${uploaded.data.id}` }],
          isError: false
        };
      }
      const maxPagesPerChunk = data.maxPagesPerChunk ?? 25;
      const baseName = data.namePrefix || basename2(data.localPath, extname2(data.localPath));
      let tempDir;
      try {
        const splitResult = await splitPdfIntoChunkFiles(data.localPath, maxPagesPerChunk);
        tempDir = splitResult.tempDir;
        const uploadedParts = [];
        for (let i = 0; i < splitResult.files.length; i++) {
          const partPath = splitResult.files[i];
          const partName = `${baseName}-part-${i + 1}.pdf`;
          const uploaded = await ctx.getDrive().files.create({
            requestBody: { name: partName, parents: [parentId] },
            media: { mimeType: "application/pdf", body: createReadStream(partPath) },
            fields: "id,name,webViewLink",
            supportsAllDrives: true
          });
          uploadedParts.push({ id: uploaded.data.id, name: uploaded.data.name });
        }
        const lines = uploadedParts.map((p, idx) => `- part ${idx + 1}: ${p.name} (ID: ${p.id})`);
        return {
          content: [{
            type: "text",
            text: `Uploaded split PDF into ${uploadedParts.length} part(s) using maxPagesPerChunk=${maxPagesPerChunk}
${lines.join("\n")}`
          }],
          isError: false
        };
      } finally {
        if (tempDir) {
          await rm(tempDir, { recursive: true, force: true });
        }
      }
    }
    case "getRevisions": {
      const validation = GetRevisionsSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;
      const response = await ctx.getDrive().revisions.list({
        fileId: data.fileId,
        pageSize: data.pageSize,
        pageToken: data.pageToken,
        fields: "nextPageToken,revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress),keepForever,size,originalFilename)"
      });
      const revisions = response.data.revisions || [];
      if (revisions.length === 0) {
        return { content: [{ type: "text", text: `No revisions found for file ${data.fileId}.` }], isError: false };
      }
      const lines = revisions.map((r) => {
        const who = r.lastModifyingUser?.displayName || r.lastModifyingUser?.emailAddress || "unknown";
        return `- ${r.id}: ${r.modifiedTime || "unknown-time"} by ${who}${r.keepForever ? " [kept]" : ""}`;
      });
      let text = `Revisions for file ${data.fileId}:
${lines.join("\n")}`;
      if (response.data.nextPageToken) {
        text += `

More revisions available. Use pageToken="${response.data.nextPageToken}" to fetch the next page.`;
      }
      return {
        content: [{ type: "text", text }],
        isError: false
      };
    }
    case "restoreRevision": {
      const validation = RestoreRevisionSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;
      if (!data.confirm) {
        return errorResponse("Refusing restore: set confirm=true to restore a revision.");
      }
      try {
        const current = await ctx.getDrive().files.get({
          fileId: data.fileId,
          fields: "name,mimeType",
          supportsAllDrives: true
        });
        const fileMimeType = current.data.mimeType || "";
        const isWorkspaceFile = fileMimeType.startsWith("application/vnd.google-apps.");
        let revisionBody;
        let uploadMimeType;
        if (isWorkspaceFile) {
          const revision = await ctx.getDrive().revisions.get({
            fileId: data.fileId,
            revisionId: data.revisionId,
            fields: "id,exportLinks"
          });
          const exportLinks = revision.data.exportLinks || {};
          const formatMap = GOOGLE_WORKSPACE_EXPORT_FORMATS[fileMimeType];
          const editableMimes = formatMap ? Object.entries(formatMap).filter(([ext]) => ext !== "pdf").map(([, mime]) => mime) : [];
          const selectedMime = editableMimes.find((m) => exportLinks[m]) || Object.keys(exportLinks).find((m) => m !== "application/pdf") || Object.keys(exportLinks)[0];
          if (!selectedMime || !exportLinks[selectedMime]) {
            return errorResponse("Selected revision has no usable export links for restore.");
          }
          uploadMimeType = selectedMime;
          const exportResponse = await ctx.authClient.request({ url: exportLinks[selectedMime], responseType: "stream" });
          revisionBody = exportResponse.data;
        } else {
          const revision = await ctx.getDrive().revisions.get(
            { fileId: data.fileId, revisionId: data.revisionId, alt: "media" },
            { responseType: "stream" }
          );
          revisionBody = revision.data;
          uploadMimeType = fileMimeType || "application/octet-stream";
        }
        await ctx.getDrive().files.update({
          fileId: data.fileId,
          media: {
            mimeType: uploadMimeType,
            body: revisionBody
          },
          supportsAllDrives: true
        });
        const restoreMsg = `Restored file ${data.fileId} (${current.data.name || "unnamed"}) from revision ${data.revisionId}.`;
        const workspaceWarning = isWorkspaceFile ? "\n\nWarning: This workspace file was restored via export/import. Some formatting or features (e.g. comments, suggestions, version history metadata) may have been lost." : "";
        return {
          content: [{
            type: "text",
            text: restoreMsg + workspaceWarning
          }],
          isError: false
        };
      } catch (err) {
        return errorResponse(`Failed to restore revision: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    case "authGetStatus": {
      const tokenPath = getSecureTokenPath();
      const tokenFileExists = existsSync2(tokenPath);
      let scopeStatus;
      try {
        scopeStatus = resolveScopeStatus(ctx);
      } catch (e) {
        return errorResponse(`Invalid scope configuration: ${e instanceof Error ? e.message : String(e)}`);
      }
      const { requestedScopes, grantedScopes, missingScopes } = scopeStatus;
      const expiryDate = ctx.authClient?.credentials?.expiry_date;
      const expiresInSec = expiryDate ? Math.floor((expiryDate - Date.now()) / 1e3) : null;
      const payload = {
        tokenFilePath: tokenPath,
        tokenFileExists,
        hasAccessToken: !!ctx.authClient?.credentials?.access_token,
        hasRefreshToken: !!ctx.authClient?.credentials?.refresh_token,
        expiryDate: expiryDate || null,
        expiresInSec,
        requestedScopes,
        grantedScopes,
        missingScopes
      };
      const status = !tokenFileExists || !payload.hasRefreshToken ? "needs_reauth" : missingScopes.length > 0 ? "scope_mismatch" : "ok";
      let text = `Auth status (${status}):
${JSON.stringify(payload, null, 2)}

Summary: token file ${tokenFileExists ? "found" : "missing"}, missing scopes=${missingScopes.length}.`;
      if (grantedScopes.length === 0 && payload.hasAccessToken) {
        text += "\nNote: granted scopes may appear empty when the token was loaded from disk. This does not necessarily indicate missing permissions.";
      }
      return {
        content: [{ type: "text", text }],
        isError: false
      };
    }
    case "authListScopes": {
      let scopeStatus;
      try {
        scopeStatus = resolveScopeStatus(ctx);
      } catch (e) {
        return errorResponse(`Invalid scope configuration: ${e instanceof Error ? e.message : String(e)}`);
      }
      const { requestedScopes, grantedScopes, missingScopes } = scopeStatus;
      const presetsResolved = Object.fromEntries(
        Object.entries(SCOPE_PRESETS).map(([k, v]) => [k, v.map((s) => SCOPE_ALIASES[s] || s)])
      );
      let text = `Scopes:
${JSON.stringify({ requestedScopes, grantedScopes, missingScopes, presets: presetsResolved }, null, 2)}`;
      if (grantedScopes.length === 0 && !!ctx.authClient?.credentials?.access_token) {
        text += "\nNote: granted scopes may appear empty when the token was loaded from disk. This does not necessarily indicate missing permissions.";
      }
      return {
        content: [{ type: "text", text }],
        isError: false
      };
    }
    case "authTestFileAccess": {
      const validation = AuthTestFileAccessSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const data = validation.data;
      try {
        let check;
        if (data.fileId) {
          const file = await ctx.getDrive().files.get({
            fileId: data.fileId,
            fields: "id,name,mimeType,permissions",
            supportsAllDrives: true
          });
          check = { mode: "file", fileId: file.data.id, name: file.data.name, mimeType: file.data.mimeType };
        } else {
          const list = await ctx.getDrive().files.list({
            pageSize: 1,
            fields: "files(id,name,mimeType)",
            includeItemsFromAllDrives: true,
            supportsAllDrives: true
          });
          check = { mode: "list", visibleCount: list.data.files?.length || 0, sample: list.data.files?.[0] || null };
        }
        return {
          content: [{ type: "text", text: `Auth access check OK:
${JSON.stringify(check, null, 2)}` }],
          isError: false
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Auth access check failed:
${JSON.stringify({ message }, null, 2)}` }],
          isError: true
        };
      }
    }
    default:
      return null;
  }
}

// src/tools/docs.ts
var docs_exports = {};
__export(docs_exports, {
  buildFlatTextFromDoc: () => buildFlatTextFromDoc,
  extractRowCells: () => extractRowCells,
  handleTool: () => handleTool2,
  matchDocxToDriveComments: () => matchDocxToDriveComments,
  resolveContextFromDocx: () => resolveContextFromDocx,
  toolDefinitions: () => toolDefinitions2
});
import { z as z2 } from "zod";
import JSZip from "jszip";

// src/utils/driveImageUpload.ts
import { existsSync as existsSync3, createReadStream as createReadStream2 } from "fs";
import { basename as basename3, extname as extname3 } from "path";
var MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};
async function uploadImageToDrive(ctx, localFilePath, options = {}) {
  const { parentFolderId, makePublic = false } = options;
  if (!existsSync3(localFilePath)) {
    throw new Error(`Image file not found: ${localFilePath}`);
  }
  const fileName = basename3(localFilePath);
  const ext = extname3(localFilePath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] || "application/octet-stream";
  const requestBody = {
    name: fileName,
    mimeType
  };
  if (parentFolderId) requestBody.parents = [parentFolderId];
  const drive = ctx.getDrive();
  const uploadResponse = await drive.files.create({
    requestBody,
    media: { mimeType, body: createReadStream2(localFilePath) },
    fields: "id,webViewLink,webContentLink",
    supportsAllDrives: true
  });
  const fileId = uploadResponse.data.id;
  if (!fileId) throw new Error("Failed to upload image to Drive - no file ID returned");
  if (makePublic) {
    await drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" }
    });
  }
  const fileInfo = await drive.files.get({
    fileId,
    fields: "webContentLink",
    supportsAllDrives: true
  });
  const webContentLink = fileInfo.data.webContentLink;
  if (!webContentLink) throw new Error("Failed to get web content link for uploaded image");
  return { fileId, webContentLink };
}
async function deleteDriveFile(ctx, fileId) {
  await ctx.getDrive().files.delete({ fileId, supportsAllDrives: true });
}

// src/utils/retry.ts
var RETRYABLE_STATUS = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var RETRYABLE_CODES = /* @__PURE__ */ new Set(["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"]);
function isRetryable(err) {
  if (!err) return false;
  if (RETRYABLE_STATUS.has(err.code) || RETRYABLE_STATUS.has(err.status)) return true;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  const msg = (err.message || "").toLowerCase();
  if (msg.includes("timeout") || msg.includes("rate limit")) return true;
  return false;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, cfg, opLabel = "operation") {
  let lastErr;
  for (let attempt = 0; attempt <= cfg.retryMax; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === cfg.retryMax) throw err;
      const delay = cfg.retryBaseDelay * Math.pow(2, attempt);
      console.error(`[${opLabel}] retry ${attempt + 1}/${cfg.retryMax} after ${delay}ms:`, err.message);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// src/tools/docs.ts
function hexToRgbColor(hex) {
  if (!hex) return null;
  let hexClean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (hexClean.length === 3) {
    hexClean = hexClean[0] + hexClean[0] + hexClean[1] + hexClean[1] + hexClean[2] + hexClean[2];
  }
  if (hexClean.length !== 6) return null;
  const bigint = parseInt(hexClean, 16);
  if (isNaN(bigint)) return null;
  const r = (bigint >> 16 & 255) / 255;
  const g = (bigint >> 8 & 255) / 255;
  const b = (bigint & 255) / 255;
  return { red: r, green: g, blue: b };
}
function rgbColorToHex(color) {
  if (!color?.color?.rgbColor) return null;
  const rgb = color.color.rgbColor;
  const r = Math.round((rgb.red || 0) * 255);
  const g = Math.round((rgb.green || 0) * 255);
  const b = Math.round((rgb.blue || 0) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
function collectAllTabsWithLevel(tabs, level = 0) {
  const result = [];
  for (const tab of tabs) {
    result.push({ tab, level });
    if (tab.childTabs && tab.childTabs.length > 0) {
      result.push(...collectAllTabsWithLevel(tab.childTabs, level + 1));
    }
  }
  return result;
}
function findTabById(tabs, targetId) {
  for (const tab of tabs) {
    if (tab.tabProperties?.tabId === targetId) {
      return tab;
    }
    if (tab.childTabs && tab.childTabs.length > 0) {
      const found = findTabById(tab.childTabs, targetId);
      if (found) return found;
    }
  }
  return null;
}
async function executeBatchUpdate(ctx, documentId, requests) {
  if (!requests || requests.length === 0) {
    return {};
  }
  const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
  try {
    const response = await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests }
    });
    return response.data;
  } catch (error) {
    ctx.log("Google Docs batchUpdate error:", error.message);
    if (error.code === 404) throw new Error(`Document not found (ID: ${documentId})`);
    if (error.code === 403) throw new Error(`Permission denied for document (ID: ${documentId})`);
    throw new Error(`Google Docs API Error: ${error.message}`);
  }
}
async function findTextRange(ctx, documentId, textToFind, instance = 1) {
  const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
  try {
    const res = await docs.documents.get({
      documentId,
      fields: "body(content(paragraph(elements(startIndex,endIndex,textRun(content))),table,startIndex,endIndex))"
    });
    if (!res.data.body?.content) {
      return null;
    }
    let fullText = "";
    const segments = [];
    const collectTextFromContent = (content) => {
      content.forEach((element) => {
        if (element.paragraph?.elements) {
          element.paragraph.elements.forEach((pe) => {
            if (pe.textRun?.content && pe.startIndex !== void 0 && pe.endIndex !== void 0) {
              const text = pe.textRun.content;
              fullText += text;
              segments.push({ text, start: pe.startIndex, end: pe.endIndex });
            }
          });
        }
        if (element.table?.tableRows) {
          element.table.tableRows.forEach((row) => {
            if (row.tableCells) {
              row.tableCells.forEach((cell) => {
                if (cell.content) {
                  collectTextFromContent(cell.content);
                }
              });
            }
          });
        }
      });
    };
    collectTextFromContent(res.data.body.content);
    segments.sort((a, b) => a.start - b.start);
    let foundCount = 0;
    let searchStartIndex = 0;
    while (foundCount < instance) {
      const currentIndex = fullText.indexOf(textToFind, searchStartIndex);
      if (currentIndex === -1) break;
      foundCount++;
      if (foundCount === instance) {
        const targetStartInFullText = currentIndex;
        const targetEndInFullText = currentIndex + textToFind.length;
        let currentPosInFullText = 0;
        let startIndex = -1;
        let endIndex = -1;
        for (const seg of segments) {
          const segStartInFullText = currentPosInFullText;
          const segEndInFullText = segStartInFullText + seg.text.length;
          if (startIndex === -1 && targetStartInFullText >= segStartInFullText && targetStartInFullText < segEndInFullText) {
            startIndex = seg.start + (targetStartInFullText - segStartInFullText);
          }
          if (targetEndInFullText > segStartInFullText && targetEndInFullText <= segEndInFullText) {
            endIndex = seg.start + (targetEndInFullText - segStartInFullText);
            break;
          }
          currentPosInFullText = segEndInFullText;
        }
        if (startIndex !== -1 && endIndex !== -1) {
          return { startIndex, endIndex };
        }
      }
      searchStartIndex = currentIndex + 1;
    }
    return null;
  } catch (error) {
    ctx.log("Error finding text in document:", error.message);
    if (error.code === 404) throw new Error(`Document not found (ID: ${documentId})`);
    throw new Error(`Failed to search document: ${error.message}`);
  }
}
async function getParagraphRange(ctx, documentId, indexWithin) {
  const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
  try {
    const res = await docs.documents.get({
      documentId,
      fields: "body(content(startIndex,endIndex,paragraph,table))"
    });
    if (!res.data.body?.content) {
      return null;
    }
    const findParagraphInContent = (content) => {
      for (const element of content) {
        if (element.startIndex !== void 0 && element.endIndex !== void 0) {
          if (indexWithin >= element.startIndex && indexWithin < element.endIndex) {
            if (element.paragraph) {
              return { startIndex: element.startIndex, endIndex: element.endIndex };
            }
            if (element.table?.tableRows) {
              for (const row of element.table.tableRows) {
                if (row.tableCells) {
                  for (const cell of row.tableCells) {
                    if (cell.content) {
                      const result = findParagraphInContent(cell.content);
                      if (result) return result;
                    }
                  }
                }
              }
            }
          }
        }
      }
      return null;
    };
    return findParagraphInContent(res.data.body.content);
  } catch (error) {
    ctx.log("Error getting paragraph range:", error.message);
    throw new Error(`Failed to find paragraph: ${error.message}`);
  }
}
function buildUpdateTextStyleRequest(startIndex, endIndex, style) {
  const textStyle = {};
  const fieldsToUpdate = [];
  if (style.bold !== void 0) {
    textStyle.bold = style.bold;
    fieldsToUpdate.push("bold");
  }
  if (style.italic !== void 0) {
    textStyle.italic = style.italic;
    fieldsToUpdate.push("italic");
  }
  if (style.underline !== void 0) {
    textStyle.underline = style.underline;
    fieldsToUpdate.push("underline");
  }
  if (style.strikethrough !== void 0) {
    textStyle.strikethrough = style.strikethrough;
    fieldsToUpdate.push("strikethrough");
  }
  if (style.fontSize !== void 0) {
    textStyle.fontSize = { magnitude: style.fontSize, unit: "PT" };
    fieldsToUpdate.push("fontSize");
  }
  if (style.fontFamily !== void 0) {
    textStyle.weightedFontFamily = { fontFamily: style.fontFamily };
    fieldsToUpdate.push("weightedFontFamily");
  }
  if (style.foregroundColor !== void 0) {
    const rgbColor = hexToRgbColor(style.foregroundColor);
    if (!rgbColor) throw new Error(`Invalid foreground hex color: ${style.foregroundColor}`);
    textStyle.foregroundColor = { color: { rgbColor } };
    fieldsToUpdate.push("foregroundColor");
  }
  if (style.backgroundColor !== void 0) {
    const rgbColor = hexToRgbColor(style.backgroundColor);
    if (!rgbColor) throw new Error(`Invalid background hex color: ${style.backgroundColor}`);
    textStyle.backgroundColor = { color: { rgbColor } };
    fieldsToUpdate.push("backgroundColor");
  }
  if (style.linkUrl !== void 0) {
    textStyle.link = { url: style.linkUrl };
    fieldsToUpdate.push("link");
  }
  if (fieldsToUpdate.length === 0) return null;
  return {
    request: {
      updateTextStyle: {
        range: { startIndex, endIndex },
        textStyle,
        fields: fieldsToUpdate.join(",")
      }
    },
    fields: fieldsToUpdate
  };
}
function buildUpdateParagraphStyleRequest(startIndex, endIndex, style) {
  const paragraphStyle = {};
  const fieldsToUpdate = [];
  if (style.alignment !== void 0) {
    paragraphStyle.alignment = style.alignment;
    fieldsToUpdate.push("alignment");
  }
  if (style.indentStart !== void 0) {
    paragraphStyle.indentStart = { magnitude: style.indentStart, unit: "PT" };
    fieldsToUpdate.push("indentStart");
  }
  if (style.indentEnd !== void 0) {
    paragraphStyle.indentEnd = { magnitude: style.indentEnd, unit: "PT" };
    fieldsToUpdate.push("indentEnd");
  }
  if (style.spaceAbove !== void 0) {
    paragraphStyle.spaceAbove = { magnitude: style.spaceAbove, unit: "PT" };
    fieldsToUpdate.push("spaceAbove");
  }
  if (style.spaceBelow !== void 0) {
    paragraphStyle.spaceBelow = { magnitude: style.spaceBelow, unit: "PT" };
    fieldsToUpdate.push("spaceBelow");
  }
  if (style.namedStyleType !== void 0) {
    paragraphStyle.namedStyleType = style.namedStyleType;
    fieldsToUpdate.push("namedStyleType");
  }
  if (style.keepWithNext !== void 0) {
    paragraphStyle.keepWithNext = style.keepWithNext;
    fieldsToUpdate.push("keepWithNext");
  }
  if (fieldsToUpdate.length === 0) return null;
  return {
    request: {
      updateParagraphStyle: {
        range: { startIndex, endIndex },
        paragraphStyle,
        fields: fieldsToUpdate.join(",")
      }
    },
    fields: fieldsToUpdate
  };
}
async function insertInlineImageHelper(ctx, documentId, imageUrl, index, width, height) {
  try {
    new URL(imageUrl);
  } catch (_e) {
    throw new Error(`Invalid image URL format: ${imageUrl}`);
  }
  const request = {
    insertInlineImage: {
      location: { index },
      uri: imageUrl
    }
  };
  if (width && height) {
    request.insertInlineImage.objectSize = {
      height: { magnitude: height, unit: "PT" },
      width: { magnitude: width, unit: "PT" }
    };
  }
  return executeBatchUpdate(ctx, documentId, [request]);
}
var MAX_ROW_XML_DISTANCE = 1e5;
var MAX_PARAGRAPH_XML_DISTANCE = 5e4;
var MAX_PARAGRAPH_CONTEXT_LENGTH = 300;
function buildFlatTextFromDoc(docData) {
  function extractSegments(bodyContent) {
    const segs = [];
    function fromElements(elements) {
      for (const el of elements) {
        if (el.textRun?.content && el.startIndex != null) {
          segs.push({ text: el.textRun.content, startIndex: el.startIndex });
        }
      }
    }
    for (const el of bodyContent) {
      if (el.paragraph?.elements) {
        fromElements(el.paragraph.elements);
      } else if (el.table) {
        for (const row of el.table.tableRows || []) {
          for (const cell of row.tableCells || []) {
            for (const cc of cell.content || []) {
              if (cc.paragraph?.elements) fromElements(cc.paragraph.elements);
              if (cc.table) {
                const nested = extractSegments([cc]);
                segs.push(...nested);
              }
            }
          }
        }
      }
    }
    return segs;
  }
  const allSegments = [];
  const tabs = docData.tabs;
  if (tabs && tabs.length > 0) {
    for (const tab of tabs) {
      const bc = tab.documentTab?.body?.content;
      if (bc) allSegments.push(...extractSegments(bc));
    }
  } else if (docData.body?.content) {
    allSegments.push(...extractSegments(docData.body.content));
  }
  let flatText = "";
  const offsetMap = [];
  for (const seg of allSegments) {
    for (let i = 0; i < seg.text.length; i++) {
      offsetMap.push(seg.startIndex + i);
      flatText += seg.text[i];
    }
  }
  return { flatText, offsetMap };
}
function extractRowCells(rowXml) {
  const cells = [];
  let searchFrom = 0;
  while (true) {
    const tcStart1 = rowXml.indexOf("<w:tc>", searchFrom);
    const tcStart2 = rowXml.indexOf("<w:tc ", searchFrom);
    const tcStart = tcStart1 === -1 && tcStart2 === -1 ? -1 : tcStart1 === -1 ? tcStart2 : tcStart2 === -1 ? tcStart1 : Math.min(tcStart1, tcStart2);
    if (tcStart === -1) break;
    const tcEnd = rowXml.indexOf("</w:tc>", tcStart);
    if (tcEnd === -1) break;
    const cellXml = rowXml.substring(tcStart, tcEnd);
    const tTexts = [];
    const tRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let t;
    while ((t = tRegex.exec(cellXml)) !== null) tTexts.push(t[1]);
    if (tTexts.length > 0) cells.push(tTexts.join(""));
    searchFrom = tcEnd + 7;
  }
  return cells;
}
async function resolveContextFromDocx(docxData) {
  const zip = await JSZip.loadAsync(docxData);
  const commentsXml = await zip.file("word/comments.xml")?.async("string");
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!commentsXml || !documentXml) return null;
  const docxComments = /* @__PURE__ */ new Map();
  const commentTagRegex = /<w:comment\s+[^>]*?w:id="(\d+)"[^>]*>/g;
  let cMatch;
  while ((cMatch = commentTagRegex.exec(commentsXml)) !== null) {
    const id = parseInt(cMatch[1]);
    const tagStr = cMatch[0];
    const authorMatch = tagStr.match(/w:author="([^"]*)"/);
    const dateMatch = tagStr.match(/w:date="([^"]*)"/);
    const author = authorMatch ? authorMatch[1] : "";
    const date = dateMatch ? dateMatch[1] : "";
    const endPos = commentsXml.indexOf("</w:comment>", cMatch.index);
    if (endPos !== -1) {
      const body = commentsXml.substring(cMatch.index, endPos);
      const texts = [];
      const tRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
      let tMatch;
      while ((tMatch = tRegex.exec(body)) !== null) {
        texts.push(tMatch[1]);
      }
      docxComments.set(id, { author, date, content: texts.join("") });
    }
  }
  const contextsBefore = /* @__PURE__ */ new Map();
  const contextsAfter = /* @__PURE__ */ new Map();
  const rowCells = /* @__PURE__ */ new Map();
  const rangeStartRegex = /<w:commentRangeStart\s+w:id="(\d+)"\/>/g;
  let rMatch;
  while ((rMatch = rangeStartRegex.exec(documentXml)) !== null) {
    const docxId = parseInt(rMatch[1]);
    const startPos = rMatch.index;
    const trStart = documentXml.lastIndexOf("<w:tr>", startPos);
    const trEnd = documentXml.indexOf("</w:tr>", startPos);
    if (trStart !== -1 && trEnd !== -1 && startPos - trStart < MAX_ROW_XML_DISTANCE) {
      const rowXml = documentXml.substring(trStart, trEnd);
      const cellTexts = extractRowCells(rowXml);
      const commentMarker = `commentRangeStart w:id="${docxId}"`;
      let commentCellIdx = -1;
      let cellSearchFrom = 0;
      for (let ci = 0; ci < cellTexts.length; ci++) {
        const tcStart1 = rowXml.indexOf("<w:tc>", cellSearchFrom);
        const tcStart2 = rowXml.indexOf("<w:tc ", cellSearchFrom);
        const tcStart = tcStart1 === -1 && tcStart2 === -1 ? -1 : tcStart1 === -1 ? tcStart2 : tcStart2 === -1 ? tcStart1 : Math.min(tcStart1, tcStart2);
        if (tcStart === -1) break;
        const tcEnd = rowXml.indexOf("</w:tc>", tcStart);
        if (tcEnd === -1) break;
        const cellXml = rowXml.substring(tcStart, tcEnd);
        if (cellXml.includes(commentMarker)) {
          commentCellIdx = ci;
        }
        cellSearchFrom = tcEnd + 7;
      }
      if (cellTexts.length > 0) {
        const allTexts = cellTexts;
        rowCells.set(docxId, allTexts);
        if (commentCellIdx !== -1) {
          const before = cellTexts.slice(0, commentCellIdx);
          let after = cellTexts.slice(commentCellIdx + 1);
          if (commentCellIdx === cellTexts.length - 1) {
            const nextTrStart = documentXml.indexOf("<w:tr>", trEnd);
            const nextTrEnd = nextTrStart !== -1 ? documentXml.indexOf("</w:tr>", nextTrStart) : -1;
            if (nextTrStart !== -1 && nextTrEnd !== -1) {
              const nextRowXml = documentXml.substring(nextTrStart, nextTrEnd);
              after = extractRowCells(nextRowXml);
            }
          }
          const commentText = cellTexts[commentCellIdx];
          contextsBefore.set(docxId, [...before, commentText].join(" | "));
          contextsAfter.set(docxId, [commentText, ...after].join(" | "));
        } else {
          contextsBefore.set(docxId, allTexts.join(" | "));
          contextsAfter.set(docxId, "");
        }
        continue;
      }
    }
    const pStart = documentXml.lastIndexOf("<w:p ", startPos);
    const pEnd = documentXml.indexOf("</w:p>", startPos);
    if (pStart !== -1 && pEnd !== -1 && startPos - pStart < MAX_PARAGRAPH_XML_DISTANCE) {
      const pXml = documentXml.substring(pStart, pEnd);
      const pTexts = [];
      const tRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
      let t;
      while ((t = tRegex.exec(pXml)) !== null) pTexts.push(t[1]);
      const pText = pTexts.join("").trim();
      if (pText) {
        contextsBefore.set(docxId, pText.length > MAX_PARAGRAPH_CONTEXT_LENGTH ? pText.substring(0, MAX_PARAGRAPH_CONTEXT_LENGTH) + "..." : pText);
        contextsAfter.set(docxId, "");
      }
    }
  }
  return { docxComments, contextsBefore, contextsAfter, rowCells };
}
function matchDocxToDriveComments(driveComments, docxResult, contextMap, flatText, offsetMap) {
  const { docxComments, contextsBefore, contextsAfter } = docxResult;
  for (const comment of driveComments) {
    if (contextMap.has(comment.id)) continue;
    if (comment.resolved) continue;
    const apiAuthor = comment.author?.displayName || "";
    const apiDate = (comment.createdTime || "").replace(/\.\d+Z$/, "Z");
    let matchedDocxId = null;
    for (const [docxId, docxComment] of docxComments) {
      if (docxComment.author === apiAuthor && docxComment.date === apiDate) {
        matchedDocxId = docxId;
        break;
      }
    }
    if (matchedDocxId !== null) {
      const ctxBefore = contextsBefore.get(matchedDocxId) || "";
      const ctxAfter = contextsAfter.get(matchedDocxId) || "";
      if (ctxBefore || ctxAfter) {
        const entry = {
          contextBefore: ctxBefore,
          contextAfter: ctxAfter
        };
        const quoted = comment.quotedFileContent?.value;
        if (quoted && flatText && offsetMap.length > 0 && ctxBefore) {
          const beforePattern = ctxBefore.split(" | ").join("\n");
          const findAll = (pattern) => {
            const results = [];
            let from = 0;
            while (true) {
              const idx = flatText.indexOf(pattern, from);
              if (idx === -1) break;
              results.push(idx);
              from = idx + 1;
            }
            return results;
          };
          let matches = findAll(beforePattern);
          if (matches.length !== 1 && ctxAfter) {
            const afterCells = ctxAfter.split(" | ");
            const afterWithoutAnchor = afterCells.slice(1).join("\n");
            if (afterWithoutAnchor) {
              const fullPattern = beforePattern + "\n" + afterWithoutAnchor;
              matches = findAll(fullPattern);
            }
          }
          if (matches.length === 1) {
            const patternStart = matches[0];
            const qIdx = patternStart + beforePattern.length - quoted.length;
            const endIdx = qIdx + quoted.length - 1;
            if (endIdx < offsetMap.length && flatText.substring(qIdx, qIdx + quoted.length) === quoted) {
              entry.startIndex = offsetMap[qIdx];
              entry.endIndex = offsetMap[endIdx] + 1;
            }
          }
        }
        contextMap.set(comment.id, entry);
      }
      docxComments.delete(matchedDocxId);
    }
  }
}
var CreateGoogleDocSchema = z2.object({
  name: z2.string().min(1, "Document name is required"),
  content: z2.string(),
  parentFolderId: z2.string().optional()
});
var UpdateGoogleDocSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  content: z2.string(),
  tabId: z2.string().optional()
});
var GetGoogleDocContentSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  includeFormatting: z2.boolean().optional()
});
var InsertTextSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  text: z2.string().min(1, "Text to insert is required"),
  index: z2.number().int().min(1, "Index must be at least 1 (1-based)"),
  tabId: z2.string().optional()
});
var DeleteRangeSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  startIndex: z2.number().int().min(1, "Start index must be at least 1"),
  endIndex: z2.number().int().min(1, "End index must be at least 1"),
  tabId: z2.string().optional()
}).refine((data) => data.endIndex > data.startIndex, {
  message: "End index must be greater than start index",
  path: ["endIndex"]
});
var ReadGoogleDocSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  format: z2.enum(["text", "json", "markdown"]).optional().default("text"),
  maxLength: z2.number().int().min(1).optional(),
  tabId: z2.string().optional()
});
var ListDocumentTabsSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  includeContent: z2.boolean().optional().default(false)
});
var ApplyTextStyleSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  startIndex: z2.number().int().min(1).optional(),
  endIndex: z2.number().int().min(1).optional(),
  textToFind: z2.string().min(1).optional(),
  matchInstance: z2.number().int().min(1).optional().default(1),
  bold: z2.boolean().optional(),
  italic: z2.boolean().optional(),
  underline: z2.boolean().optional(),
  strikethrough: z2.boolean().optional(),
  fontSize: z2.number().min(1).optional(),
  fontFamily: z2.string().optional(),
  foregroundColor: z2.string().optional(),
  backgroundColor: z2.string().optional(),
  linkUrl: z2.string().url().optional()
});
var ApplyParagraphStyleSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  startIndex: z2.number().int().min(1).optional(),
  endIndex: z2.number().int().min(1).optional(),
  textToFind: z2.string().min(1).optional(),
  matchInstance: z2.number().int().min(1).optional().default(1),
  indexWithinParagraph: z2.number().int().min(1).optional(),
  alignment: z2.enum(["START", "END", "CENTER", "JUSTIFIED"]).optional(),
  indentStart: z2.number().min(0).optional(),
  indentEnd: z2.number().min(0).optional(),
  spaceAbove: z2.number().min(0).optional(),
  spaceBelow: z2.number().min(0).optional(),
  namedStyleType: z2.enum(["NORMAL_TEXT", "TITLE", "SUBTITLE", "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"]).optional(),
  keepWithNext: z2.boolean().optional()
});
var CreateParagraphBulletsSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  startIndex: z2.number().int().min(1).optional(),
  endIndex: z2.number().int().min(1).optional(),
  textToFind: z2.string().min(1).optional(),
  matchInstance: z2.number().int().min(1).optional().default(1),
  bulletPreset: z2.enum([
    "BULLET_DISC_CIRCLE_SQUARE",
    "BULLET_DIAMONDX_ARROW3D_SQUARE",
    "BULLET_CHECKBOX",
    "BULLET_ARROW_DIAMOND_DISC",
    "BULLET_STAR_CIRCLE_SQUARE",
    "BULLET_ARROW3D_CIRCLE_SQUARE",
    "BULLET_LEFTTRIANGLE_DIAMOND_DISC",
    "NUMBERED_DECIMAL_ALPHA_ROMAN",
    "NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS",
    "NUMBERED_DECIMAL_NESTED",
    "NUMBERED_UPPERALPHA_ALPHA_ROMAN",
    "NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL",
    "NUMBERED_ZERODECIMAL_ALPHA_ROMAN",
    "NONE"
  ]).default("BULLET_DISC_CIRCLE_SQUARE")
});
var ListCommentsSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  includeDeleted: z2.boolean().optional(),
  pageSize: z2.number().int().min(1).max(100).optional(),
  pageToken: z2.string().optional()
});
var GetCommentSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  commentId: z2.string().min(1, "Comment ID is required")
});
var AddCommentSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  startIndex: z2.number().int().min(1, "Start index must be at least 1"),
  endIndex: z2.number().int().min(1, "End index must be at least 1"),
  commentText: z2.string().min(1, "Comment text is required")
});
var ReplyToCommentSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  commentId: z2.string().min(1, "Comment ID is required"),
  replyText: z2.string().min(1, "Reply text is required"),
  resolve: z2.boolean().optional().describe("Set to true to resolve the comment thread after replying")
});
var DeleteCommentSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  commentId: z2.string().min(1, "Comment ID is required")
});
var InsertTableSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  rows: z2.number().int().min(1, "Must have at least 1 row"),
  columns: z2.number().int().min(1, "Must have at least 1 column"),
  index: z2.number().int().min(1, "Index must be at least 1 (1-based)")
});
var EditTableCellSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  tableStartIndex: z2.number().int().min(1, "Table start index is required"),
  rowIndex: z2.number().int().min(0, "Row index must be at least 0 (0-based)"),
  columnIndex: z2.number().int().min(0, "Column index must be at least 0 (0-based)"),
  textContent: z2.string().optional().describe("New text content for the cell"),
  bold: z2.boolean().optional(),
  italic: z2.boolean().optional(),
  fontSize: z2.number().optional(),
  alignment: z2.enum(["START", "CENTER", "END", "JUSTIFIED"]).optional()
});
var InsertImageFromUrlSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  imageUrl: z2.string().url("Must be a valid URL"),
  index: z2.number().int().min(1, "Index must be at least 1 (1-based)"),
  width: z2.number().optional().describe("Width in points"),
  height: z2.number().optional().describe("Height in points")
});
var InsertLocalImageSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  localImagePath: z2.string().min(1, "Local image path is required"),
  index: z2.number().int().min(1, "Index must be at least 1 (1-based)"),
  width: z2.number().optional().describe("Width in points"),
  height: z2.number().optional().describe("Height in points"),
  uploadToSameFolder: z2.boolean().optional().default(true).describe("Upload to same folder as document"),
  makePublic: z2.boolean().optional().default(false).describe("Make uploaded image publicly accessible. Required if the document is not shared with the service account.")
});
var ListGoogleDocsSchema = z2.object({
  maxResults: z2.number().int().min(1).max(100).optional().default(20).describe("Maximum number of documents to return (1-100)."),
  query: z2.string().optional().describe("Search query to filter documents by name or content."),
  orderBy: z2.enum(["name", "modifiedTime", "createdTime"]).optional().default("modifiedTime").describe("Sort order for results.")
});
var GetDocumentInfoSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required")
});
var FindAndReplaceInDocSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  findText: z2.string().min(1, "findText is required"),
  replaceText: z2.string(),
  matchCase: z2.boolean().optional().default(false),
  dryRun: z2.boolean().optional().default(false),
  tabId: z2.string().optional()
});
var AddDocumentTabSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  title: z2.string().min(1, "Tab title is required")
});
var RenameDocumentTabSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  tabId: z2.string().min(1, "Tab ID is required"),
  title: z2.string().min(1, "Tab title is required")
});
var InsertSmartChipSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  index: z2.number().int().min(1, "Index must be at least 1"),
  chipType: z2.enum(["person"]),
  personEmail: z2.string().email("Valid email is required for person chip")
});
var ReadSmartChipsSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required")
});
var CreateFootnoteSchema = z2.object({
  documentId: z2.string().min(1, "Document ID is required"),
  index: z2.number().int().min(1, "Index must be at least 1").optional(),
  endOfSegment: z2.boolean().optional(),
  content: z2.string().optional()
}).refine((data) => data.index !== void 0 || data.endOfSegment === true, {
  message: "Either 'index' or 'endOfSegment: true' must be provided"
});
var toolDefinitions2 = [
  {
    name: "createGoogleDoc",
    description: "Create a new Google Doc",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Doc name" },
        content: { type: "string", description: "Doc content" },
        parentFolderId: { type: "string", description: "Parent folder ID" }
      },
      required: ["name", "content"]
    }
  },
  {
    name: "updateGoogleDoc",
    description: "Update an existing Google Doc (replaces all content). For multi-tab docs, specify tabId to replace a single tab's content atomically; leaves other tabs untouched.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Doc ID" },
        content: { type: "string", description: "New content" },
        tabId: { type: "string", description: "Optional. Tab ID to replace (from listDocumentTabs). If set, delete+insert run in a single atomic batchUpdate scoped to that tab." }
      },
      required: ["documentId", "content"]
    }
  },
  {
    name: "insertText",
    description: "Insert text at a specific index in a Google Doc (surgical edit, doesn't replace entire doc). For multi-tab docs, specify tabId to target a specific tab.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        text: { type: "string", description: "Text to insert" },
        index: { type: "number", description: "Position to insert at (1-based)" },
        tabId: { type: "string", description: "Optional. Tab ID to insert into (from listDocumentTabs). If omitted, inserts into the first/default tab." }
      },
      required: ["documentId", "text", "index"]
    }
  },
  {
    name: "deleteRange",
    description: "Delete content between start and end indices in a Google Doc. For multi-tab docs, specify tabId to target a specific tab.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        startIndex: { type: "number", description: "Start index (1-based, inclusive)" },
        endIndex: { type: "number", description: "End index (exclusive)" },
        tabId: { type: "string", description: "Optional. Tab ID to delete from (from listDocumentTabs). If omitted, deletes from the first/default tab." }
      },
      required: ["documentId", "startIndex", "endIndex"]
    }
  },
  {
    name: "readGoogleDoc",
    description: "Read content of a Google Doc with format options. Supports multi-tab documents.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        format: { type: "string", enum: ["text", "json", "markdown"], description: "Output format (default: text)" },
        maxLength: { type: "number", description: "Maximum characters to return" },
        tabId: { type: "string", description: "Read a specific tab by ID (from listDocumentTabs). If omitted, all tabs are returned." }
      },
      required: ["documentId"]
    }
  },
  {
    name: "listDocumentTabs",
    description: "List all tabs in a Google Doc with their IDs and hierarchy",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        includeContent: { type: "boolean", description: "Include content summary (character count) for each tab" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "applyTextStyle",
    description: "Apply text formatting (bold, italic, color, etc.) to a range or found text. Use EITHER startIndex+endIndex OR textToFind for targeting.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        startIndex: { type: "number", description: "Start index (1-based) - use with endIndex" },
        endIndex: { type: "number", description: "End index (exclusive) - use with startIndex" },
        textToFind: { type: "string", description: "Text to find and format (alternative to indices)" },
        matchInstance: { type: "number", description: "Which instance of textToFind (default: 1)" },
        bold: { type: "boolean", description: "Make text bold" },
        italic: { type: "boolean", description: "Make text italic" },
        underline: { type: "boolean", description: "Underline text" },
        strikethrough: { type: "boolean", description: "Strikethrough text" },
        fontSize: { type: "number", description: "Font size in points" },
        fontFamily: { type: "string", description: "Font family name" },
        foregroundColor: { type: "string", description: "Hex color (e.g., #FF0000)" },
        backgroundColor: { type: "string", description: "Hex background color" },
        linkUrl: { type: "string", description: "URL for hyperlink" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "applyParagraphStyle",
    description: "Apply paragraph formatting. Use EITHER startIndex+endIndex OR textToFind OR indexWithinParagraph for targeting.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        startIndex: { type: "number", description: "Start index (1-based) - use with endIndex" },
        endIndex: { type: "number", description: "End index (exclusive) - use with startIndex" },
        textToFind: { type: "string", description: "Text within the target paragraph" },
        matchInstance: { type: "number", description: "Which instance of textToFind (default: 1)" },
        indexWithinParagraph: { type: "number", description: "Any index within the target paragraph" },
        alignment: { type: "string", enum: ["START", "END", "CENTER", "JUSTIFIED"], description: "Text alignment" },
        indentStart: { type: "number", description: "Left indent in points" },
        indentEnd: { type: "number", description: "Right indent in points" },
        spaceAbove: { type: "number", description: "Space above in points" },
        spaceBelow: { type: "number", description: "Space below in points" },
        namedStyleType: { type: "string", enum: ["NORMAL_TEXT", "TITLE", "SUBTITLE", "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"], description: "Named paragraph style" },
        keepWithNext: { type: "boolean", description: "Keep with next paragraph" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "formatGoogleDocText",
    description: "Apply text formatting (bold, italic, font, color, links) to a range or found text in a Google Doc. Alias for applyTextStyle.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        startIndex: { type: "number", description: "Start index (1-based) - use with endIndex" },
        endIndex: { type: "number", description: "End index (exclusive) - use with startIndex" },
        textToFind: { type: "string", description: "Text to find and format (alternative to indices)" },
        matchInstance: { type: "number", description: "Which instance of textToFind (default: 1)" },
        bold: { type: "boolean", description: "Make text bold" },
        italic: { type: "boolean", description: "Make text italic" },
        underline: { type: "boolean", description: "Underline text" },
        strikethrough: { type: "boolean", description: "Strikethrough text" },
        fontSize: { type: "number", description: "Font size in points" },
        fontFamily: { type: "string", description: "Font family name" },
        foregroundColor: { type: "string", description: "Hex color (e.g., #FF0000)" },
        backgroundColor: { type: "string", description: "Hex background color" },
        linkUrl: { type: "string", description: "URL for hyperlink" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "formatGoogleDocParagraph",
    description: "Apply paragraph formatting (alignment, indentation, spacing, heading style) in a Google Doc. Alias for applyParagraphStyle.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        startIndex: { type: "number", description: "Start index (1-based) - use with endIndex" },
        endIndex: { type: "number", description: "End index (exclusive) - use with startIndex" },
        textToFind: { type: "string", description: "Text within the target paragraph" },
        matchInstance: { type: "number", description: "Which instance of textToFind (default: 1)" },
        indexWithinParagraph: { type: "number", description: "Any index within the target paragraph" },
        alignment: { type: "string", enum: ["START", "END", "CENTER", "JUSTIFIED"], description: "Text alignment" },
        indentStart: { type: "number", description: "Left indent in points" },
        indentEnd: { type: "number", description: "Right indent in points" },
        spaceAbove: { type: "number", description: "Space above in points" },
        spaceBelow: { type: "number", description: "Space below in points" },
        namedStyleType: { type: "string", enum: ["NORMAL_TEXT", "TITLE", "SUBTITLE", "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"], description: "Named paragraph style" },
        keepWithNext: { type: "boolean", description: "Keep with next paragraph" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "createParagraphBullets",
    description: "Add or remove bullet points / numbered lists on paragraphs in a Google Doc. Target paragraphs by startIndex+endIndex or textToFind. Use bulletPreset='NONE' to remove bullets.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        startIndex: { type: "number", description: "Start index (1-based) - use with endIndex" },
        endIndex: { type: "number", description: "End index (exclusive) - use with startIndex" },
        textToFind: { type: "string", description: "Text within the target paragraph(s) to bulletize" },
        matchInstance: { type: "number", description: "Which instance of textToFind (default: 1)" },
        bulletPreset: { type: "string", enum: ["BULLET_DISC_CIRCLE_SQUARE", "BULLET_DIAMONDX_ARROW3D_SQUARE", "BULLET_CHECKBOX", "BULLET_ARROW_DIAMOND_DISC", "BULLET_STAR_CIRCLE_SQUARE", "BULLET_ARROW3D_CIRCLE_SQUARE", "BULLET_LEFTTRIANGLE_DIAMOND_DISC", "NUMBERED_DECIMAL_ALPHA_ROMAN", "NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS", "NUMBERED_DECIMAL_NESTED", "NUMBERED_UPPERALPHA_ALPHA_ROMAN", "NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL", "NUMBERED_ZERODECIMAL_ALPHA_ROMAN", "NONE"], description: "Bullet style preset. Use NONE to remove bullets. Default: BULLET_DISC_CIRCLE_SQUARE" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "findAndReplaceInDoc",
    description: "Find and replace text across a Google Document. Dry-run mode counts matches from paragraph text only (may differ from actual replacements which cover tables, headers, footers, etc.). For multi-tab docs, specify tabId to scope replacements to a single tab.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        findText: { type: "string", description: "Text to find" },
        replaceText: { type: "string", description: "Replacement text" },
        matchCase: { type: "boolean", description: "Case-sensitive match (default: false)" },
        dryRun: { type: "boolean", description: "Only count approximate matches from paragraph text, do not modify document (default: false). Ignores tabId \u2014 always scans the full document body." },
        tabId: { type: "string", description: "Optional. Tab ID to scope replacements to (from listDocumentTabs). If omitted, replaces across all tabs." }
      },
      required: ["documentId", "findText", "replaceText"]
    }
  },
  {
    name: "listComments",
    description: "List all comments in a Google Document",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        includeDeleted: { type: "boolean", description: "Whether to include deleted comments (default: false)" },
        pageSize: { type: "number", description: "Max comments to return (1-100, default: 100)" },
        pageToken: { type: "string", description: "Token for next page of results" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "getComment",
    description: "Get a specific comment with its full thread of replies",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        commentId: { type: "string", description: "The comment ID" }
      },
      required: ["documentId", "commentId"]
    }
  },
  {
    name: "addComment",
    description: "Add a comment anchored to a specific text range. Note: Due to Google API limitations, programmatic comments appear in 'All Comments' but may not be visibly anchored in the document UI.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        startIndex: { type: "number", description: "Start index (1-based)" },
        endIndex: { type: "number", description: "End index (exclusive)" },
        commentText: { type: "string", description: "The comment content" }
      },
      required: ["documentId", "startIndex", "endIndex", "commentText"]
    }
  },
  {
    name: "replyToComment",
    description: "Add a reply to an existing comment",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        commentId: { type: "string", description: "The comment ID to reply to" },
        replyText: { type: "string", description: "The reply content" },
        resolve: { type: "boolean", description: "Set to true to resolve the comment thread after replying (default: false)" }
      },
      required: ["documentId", "commentId", "replyText"]
    }
  },
  {
    name: "deleteComment",
    description: "Delete a comment from the document",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        commentId: { type: "string", description: "The comment ID to delete" }
      },
      required: ["documentId", "commentId"]
    }
  },
  {
    name: "getGoogleDocContent",
    description: "Get content of a Google Doc with text indices for formatting",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document ID" },
        includeFormatting: { type: "boolean", description: "Include font, style, and color info for each text span (default: false)" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "insertTable",
    description: "Insert a new table with the specified dimensions at a given index",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        rows: { type: "number", description: "Number of rows for the new table" },
        columns: { type: "number", description: "Number of columns for the new table" },
        index: { type: "number", description: "The index (1-based) where the table should be inserted" }
      },
      required: ["documentId", "rows", "columns", "index"]
    }
  },
  {
    name: "editTableCell",
    description: "Edit the content and/or style of a specific table cell. Requires knowing the table start index.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        tableStartIndex: { type: "number", description: "The starting index of the TABLE element" },
        rowIndex: { type: "number", description: "Row index (0-based)" },
        columnIndex: { type: "number", description: "Column index (0-based)" },
        textContent: { type: "string", description: "New text content for the cell (replaces existing)" },
        bold: { type: "boolean", description: "Make text bold" },
        italic: { type: "boolean", description: "Make text italic" },
        fontSize: { type: "number", description: "Font size in points" },
        alignment: { type: "string", enum: ["START", "CENTER", "END", "JUSTIFIED"], description: "Text alignment" }
      },
      required: ["documentId", "tableStartIndex", "rowIndex", "columnIndex"]
    }
  },
  {
    name: "insertImageFromUrl",
    description: "Insert an inline image into a Google Document from a publicly accessible URL",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        imageUrl: { type: "string", description: "Publicly accessible URL to the image" },
        index: { type: "number", description: "The index (1-based) where the image should be inserted" },
        width: { type: "number", description: "Width of the image in points" },
        height: { type: "number", description: "Height of the image in points" }
      },
      required: ["documentId", "imageUrl", "index"]
    }
  },
  {
    name: "insertLocalImage",
    description: "Upload a local image file to Google Drive and insert it into a Google Document",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The document ID" },
        localImagePath: { type: "string", description: "Absolute path to the local image file" },
        index: { type: "number", description: "The index (1-based) where the image should be inserted" },
        width: { type: "number", description: "Width of the image in points" },
        height: { type: "number", description: "Height of the image in points" },
        uploadToSameFolder: { type: "boolean", description: "Upload to same folder as document (default: true)" },
        makePublic: { type: "boolean", description: "Make uploaded image publicly accessible (anyone with the link can view). Set to true if the Docs API cannot access the image through the authenticated user's permissions. Default: false" }
      },
      required: ["documentId", "localImagePath", "index"]
    }
  },
  {
    name: "listGoogleDocs",
    description: "Lists Google Documents from your Google Drive with optional filtering.",
    inputSchema: {
      type: "object",
      properties: {
        maxResults: { type: "integer", description: "Maximum number of documents to return (1-100)." },
        query: { type: "string", description: "Search query to filter documents by name or content." },
        orderBy: { type: "string", enum: ["name", "modifiedTime", "createdTime"], description: "Sort order for results." }
      },
      required: []
    }
  },
  {
    name: "getDocumentInfo",
    description: "Gets detailed information about a specific Google Document.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "The ID of the Google Document (from the URL)." }
      },
      required: ["documentId"]
    }
  },
  {
    name: "addDocumentTab",
    description: "Add a new tab in a Google Doc",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document ID" },
        title: { type: "string", description: "Tab title" }
      },
      required: ["documentId", "title"]
    }
  },
  {
    name: "renameDocumentTab",
    description: "Rename an existing Google Doc tab",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document ID" },
        tabId: { type: "string", description: "Tab ID" },
        title: { type: "string", description: "New tab title" }
      },
      required: ["documentId", "tabId", "title"]
    }
  },
  {
    name: "insertSmartChip",
    description: "Insert a person smart chip (mention) at a document index. Only person chips are supported by the Docs API; date and file chips are read-only.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document ID" },
        index: { type: "number", description: "Insertion index (1-based)" },
        chipType: { type: "string", enum: ["person"], description: "Smart chip type (only 'person' is supported)" },
        personEmail: { type: "string", description: "Email address for the person mention" }
      },
      required: ["documentId", "index", "chipType", "personEmail"]
    }
  },
  {
    name: "readSmartChips",
    description: "Read smart chip-like elements (person mentions, rich links, date chips) from the default tab of a document",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document ID" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "createFootnote",
    description: "Create a footnote in a Google Doc. Footnotes cannot be inserted inside equations, headers, footers, or other footnotes.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Document ID" },
        index: { type: "number", description: "1-based character index where the footnote reference should be inserted" },
        endOfSegment: { type: "boolean", description: "If true, insert footnote at the end of the document body (use instead of index)" },
        content: { type: "string", description: "Optional text content for the footnote body" }
      },
      required: ["documentId"]
    }
  }
];
async function handleTool2(toolName, args, ctx) {
  switch (toolName) {
    // =========================================================================
    // CREATE / UPDATE GOOGLE DOC
    // =========================================================================
    case "createGoogleDoc": {
      const validation = CreateGoogleDocSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const parentFolderId = await ctx.resolveFolderId(a.parentFolderId);
      const existingFileId = await ctx.checkFileExists(a.name, parentFolderId);
      if (existingFileId) {
        return errorResponse(
          `A document named "${a.name}" already exists in this location. To update it, use updateGoogleDoc with documentId: ${existingFileId}`
        );
      }
      let docResponse;
      try {
        docResponse = await ctx.getDrive().files.create({
          requestBody: {
            name: a.name,
            mimeType: "application/vnd.google-apps.document",
            parents: [parentFolderId]
          },
          fields: "id, name, webViewLink",
          supportsAllDrives: true
        });
      } catch (createError) {
        ctx.log("Drive files.create error details:", {
          message: createError.message,
          code: createError.code,
          errors: createError.errors,
          status: createError.status
        });
        throw createError;
      }
      const doc = docResponse.data;
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      try {
        await withRetry(
          () => docs.documents.batchUpdate({
            documentId: doc.id,
            requestBody: {
              requests: [
                {
                  insertText: { location: { index: 1 }, text: a.content }
                },
                // Ensure the text is formatted as normal text, not as a header
                {
                  updateParagraphStyle: {
                    range: {
                      startIndex: 1,
                      endIndex: a.content.length + 1
                    },
                    paragraphStyle: {
                      namedStyleType: "NORMAL_TEXT"
                    },
                    fields: "namedStyleType"
                  }
                }
              ]
            }
          }),
          ctx.runtimeConfig,
          `createGoogleDoc.batchUpdate(${a.name})`
        );
      } catch (batchErr) {
        ctx.log("batchUpdate failed after retries, doc exists empty:", batchErr);
        return {
          content: [{
            type: "text",
            text: `Created Google Doc (content insertion failed): ${doc.name}
ID: ${doc.id}
Link: ${doc.webViewLink}
Error: ${batchErr.message}
You can retry content insertion with updateGoogleDoc.`
          }],
          isError: false
        };
      }
      return {
        content: [{ type: "text", text: `Created Google Doc: ${doc.name}
ID: ${doc.id}
Link: ${doc.webViewLink}` }],
        isError: false
      };
    }
    case "updateGoogleDoc": {
      const validation = UpdateGoogleDocSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      if (a.tabId) {
        const document2 = await docs.documents.get({ documentId: a.documentId, includeTabsContent: true });
        const tabs = document2.data.tabs;
        const tab = tabs ? findTabById(tabs, a.tabId) : null;
        if (!tab) {
          return errorResponse(`Tab with ID "${a.tabId}" not found. Use listDocumentTabs to see available tabs.`);
        }
        const bodyContent = tab.documentTab?.body?.content;
        const lastEndIndex = bodyContent?.[bodyContent.length - 1]?.endIndex ?? 1;
        const deleteEndIndex2 = Math.max(1, lastEndIndex - 1);
        const requests = [];
        if (deleteEndIndex2 > 1) {
          requests.push({
            deleteContentRange: {
              range: { startIndex: 1, endIndex: deleteEndIndex2, tabId: a.tabId }
            }
          });
        }
        requests.push({
          insertText: { location: { index: 1, tabId: a.tabId }, text: a.content }
        });
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: 1, endIndex: a.content.length + 1, tabId: a.tabId },
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            fields: "namedStyleType"
          }
        });
        await docs.documents.batchUpdate({
          documentId: a.documentId,
          requestBody: { requests }
        });
        return {
          content: [{ type: "text", text: `Updated Google Doc: ${document2.data.title} (tab: ${a.tabId})` }],
          isError: false
        };
      }
      const document = await docs.documents.get({ documentId: a.documentId });
      const endIndex = document.data.body?.content?.[document.data.body.content.length - 1]?.endIndex || 1;
      const deleteEndIndex = Math.max(1, endIndex - 1);
      if (deleteEndIndex > 1) {
        await docs.documents.batchUpdate({
          documentId: a.documentId,
          requestBody: {
            requests: [{
              deleteContentRange: {
                range: { startIndex: 1, endIndex: deleteEndIndex }
              }
            }]
          }
        });
      }
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [
            {
              insertText: { location: { index: 1 }, text: a.content }
            },
            {
              updateParagraphStyle: {
                range: {
                  startIndex: 1,
                  endIndex: a.content.length + 1
                },
                paragraphStyle: {
                  namedStyleType: "NORMAL_TEXT"
                },
                fields: "namedStyleType"
              }
            }
          ]
        }
      });
      return {
        content: [{ type: "text", text: `Updated Google Doc: ${document.data.title}` }],
        isError: false
      };
    }
    // =========================================================================
    // DOC CONTENT
    // =========================================================================
    case "getGoogleDocContent": {
      let resolveInlineElementText2 = function(el, inlineObjects) {
        if (el.person?.personProperties) {
          const p = el.person.personProperties;
          if (p.name && p.email) return `@${p.name} (${p.email})`;
          return `@${p.name || p.email || ""}`;
        }
        if (el.richLink?.richLinkProperties) {
          const rl = el.richLink.richLinkProperties;
          const title = (rl.title || rl.uri || "").replace(/[\[\]]/g, "\\$&");
          const uri = rl.uri;
          return title && uri ? `[${title}](${uri})` : title || null;
        }
        if (el.inlineObjectElement?.inlineObjectId) {
          if (inlineObjects) {
            const obj = inlineObjects[el.inlineObjectElement.inlineObjectId];
            const desc = obj?.inlineObjectProperties?.embeddedObject?.description || obj?.inlineObjectProperties?.embeddedObject?.title;
            return desc ? `[image: ${desc}]` : "[image]";
          }
          return "[image]";
        }
        if (el.footnoteReference) {
          return `[^${el.footnoteReference.footnoteNumber || ""}]`;
        }
        if (el.horizontalRule) {
          return "---\n";
        }
        return null;
      }, extractSegments2 = function(bodyContent, inlineObjects) {
        const segments = [];
        function getCellText(cellContent) {
          const before = segments.length;
          processContent(cellContent);
          const cellSegs = segments.splice(before);
          return cellSegs.map((s) => s.text.replace(/\n$/g, "")).join(" ").replace(/\|/g, "\\|").trim();
        }
        function processContent(content) {
          for (const element of content) {
            if (element.paragraph?.elements) {
              for (const textElement of element.paragraph.elements) {
                if (textElement.textRun?.content && textElement.startIndex != null && textElement.endIndex != null) {
                  const seg = {
                    text: textElement.textRun.content,
                    startIndex: textElement.startIndex,
                    endIndex: textElement.endIndex
                  };
                  if (withFormatting) {
                    const ts = textElement.textRun.textStyle;
                    if (ts) {
                      if (ts.weightedFontFamily?.fontFamily) seg.fontFamily = ts.weightedFontFamily.fontFamily;
                      if (ts.fontSize?.magnitude != null) seg.fontSize = ts.fontSize.magnitude;
                      if (ts.bold) seg.bold = true;
                      if (ts.italic) seg.italic = true;
                      if (ts.underline) seg.underline = true;
                      if (ts.strikethrough) seg.strikethrough = true;
                      const fg = rgbColorToHex(ts.foregroundColor);
                      const bg = rgbColorToHex(ts.backgroundColor);
                      if (fg) seg.foregroundColor = fg;
                      if (bg) seg.backgroundColor = bg;
                    }
                  }
                  segments.push(seg);
                } else {
                  const inlineText = resolveInlineElementText2(textElement, inlineObjects);
                  if (inlineText && textElement.startIndex != null && textElement.endIndex != null) {
                    segments.push({
                      text: inlineText,
                      startIndex: textElement.startIndex,
                      endIndex: textElement.endIndex
                    });
                  }
                }
              }
            } else if (element.table?.tableRows) {
              const rows = [];
              for (let rowIdx = 0; rowIdx < element.table.tableRows.length; rowIdx++) {
                const row = element.table.tableRows[rowIdx];
                if (!row.tableCells) continue;
                const cellTexts = [];
                for (const cell of row.tableCells) {
                  cellTexts.push(cell.content ? getCellText(cell.content) : "");
                }
                rows.push("| " + cellTexts.join(" | ") + " |");
                if (rowIdx === 0) {
                  rows.push("| " + cellTexts.map(() => "---").join(" | ") + " |");
                }
              }
              const md = rows.join("\n") + "\n\n";
              if (element.startIndex != null && element.endIndex != null) {
                segments.push({
                  text: md,
                  startIndex: element.startIndex,
                  endIndex: element.endIndex
                });
              }
            } else if (element.tableOfContents?.content) {
              processContent(element.tableOfContents.content);
            }
          }
        }
        processContent(bodyContent);
        return segments;
      }, formatSegments2 = function(segments) {
        let result = "";
        for (const segment of segments) {
          const hasMeta = withFormatting && hasFormattingInfo2(segment);
          const meta = hasMeta ? buildMetaLine2(segment) : null;
          const lines = segment.text.split("\n");
          let offset = segment.startIndex;
          for (const line of lines) {
            if (line.trim()) {
              if (meta) {
                result += `[${offset}-${offset + line.length}] ${meta}
  ${line}
`;
              } else {
                result += `[${offset}-${offset + line.length}] ${line}
`;
              }
            }
            offset += line.length + 1;
          }
        }
        return result;
      }, hasFormattingInfo2 = function(seg) {
        return !!(seg.fontFamily || seg.fontSize || seg.bold || seg.italic || seg.underline || seg.strikethrough || seg.foregroundColor || seg.backgroundColor);
      }, buildMetaLine2 = function(seg) {
        const parts = [];
        if (seg.fontFamily) parts.push(`font="${seg.fontFamily}"`);
        if (seg.fontSize) parts.push(`size=${seg.fontSize}pt`);
        const styles = [];
        if (seg.bold) styles.push("bold");
        if (seg.italic) styles.push("italic");
        if (seg.underline) styles.push("underline");
        if (seg.strikethrough) styles.push("strikethrough");
        if (styles.length > 0) parts.push(`style=${styles.join(",")}`);
        if (seg.foregroundColor) parts.push(`color=${seg.foregroundColor}`);
        if (seg.backgroundColor) parts.push(`bg=${seg.backgroundColor}`);
        return parts.join(", ");
      }, trackFonts2 = function(segments) {
        if (!withFormatting) return;
        for (const seg of segments) {
          if (seg.fontFamily) {
            let info = fontUsage.get(seg.fontFamily);
            if (!info) {
              info = { sizes: /* @__PURE__ */ new Set(), styles: /* @__PURE__ */ new Set(), charCount: 0 };
              fontUsage.set(seg.fontFamily, info);
            }
            if (seg.fontSize) info.sizes.add(seg.fontSize);
            if (seg.bold) info.styles.add("bold");
            if (seg.italic) info.styles.add("italic");
            if (seg.underline) info.styles.add("underline");
            if (seg.strikethrough) info.styles.add("strikethrough");
            info.charCount += seg.endIndex - seg.startIndex;
          }
        }
      };
      var resolveInlineElementText = resolveInlineElementText2, extractSegments = extractSegments2, formatSegments = formatSegments2, hasFormattingInfo = hasFormattingInfo2, buildMetaLine = buildMetaLine2, trackFonts = trackFonts2;
      const validation = GetGoogleDocContentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const withFormatting = a.includeFormatting === true;
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      const document = await docs.documents.get({
        documentId: a.documentId,
        includeTabsContent: true
      });
      const fontUsage = /* @__PURE__ */ new Map();
      const tabs = document.data.tabs;
      let formattedContent = "Document content with indices:\n\n";
      let totalLength = 0;
      if (tabs && tabs.length > 0) {
        const allTabs = collectAllTabsWithLevel(tabs);
        const isMultiTab = allTabs.length > 1;
        for (const { tab, level } of allTabs) {
          const bodyContent = tab.documentTab?.body?.content;
          if (isMultiTab) {
            const title = tab.tabProperties?.title || "Untitled";
            const indent = "  ".repeat(level);
            formattedContent += `${indent}=== Tab: ${title} ===
`;
          }
          if (bodyContent) {
            const tabInlineObjects = tab.documentTab?.inlineObjects;
            const segments = extractSegments2(bodyContent, tabInlineObjects);
            trackFonts2(segments);
            formattedContent += formatSegments2(segments);
            if (segments.length > 0) {
              totalLength += segments[segments.length - 1].endIndex;
            }
          }
          if (isMultiTab) {
            formattedContent += "\n";
          }
        }
      } else {
        const bodyContent = document.data.body?.content;
        if (bodyContent) {
          const legacyInlineObjects = document.data.inlineObjects;
          const segments = extractSegments2(bodyContent, legacyInlineObjects);
          trackFonts2(segments);
          formattedContent += formatSegments2(segments);
          totalLength = segments.length > 0 ? segments[segments.length - 1].endIndex : 0;
        }
      }
      if (withFormatting && fontUsage.size > 0) {
        formattedContent += "\n--- Fonts summary ---\n";
        const sorted = [...fontUsage.entries()].sort((a2, b) => b[1].charCount - a2[1].charCount);
        for (const [font, info] of sorted) {
          const sizesStr = info.sizes.size > 0 ? [...info.sizes].sort((a2, b) => a2 - b).join(", ") + " pt" : "default size";
          const stylesStr = info.styles.size > 0 ? [...info.styles].sort().join(", ") : "normal";
          formattedContent += `${font}: sizes [${sizesStr}], styles [${stylesStr}], ~${info.charCount} chars
`;
        }
      }
      return {
        content: [{
          type: "text",
          text: formattedContent + `
Total length: ${totalLength} characters`
        }],
        isError: false
      };
    }
    // =========================================================================
    // DOC EDITING TOOLS
    // =========================================================================
    case "insertText": {
      const validation = InsertTextSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const location = { index: a.index };
      if (a.tabId) location.tabId = a.tabId;
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [{
            insertText: {
              location,
              text: a.text
            }
          }]
        }
      });
      return {
        content: [{ type: "text", text: `Successfully inserted ${a.text.length} characters at index ${a.index}${a.tabId ? ` in tab ${a.tabId}` : ""}` }],
        isError: false
      };
    }
    case "deleteRange": {
      const validation = DeleteRangeSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      if (a.endIndex <= a.startIndex) {
        return errorResponse("endIndex must be greater than startIndex");
      }
      const range = {
        startIndex: a.startIndex,
        endIndex: a.endIndex
      };
      if (a.tabId) range.tabId = a.tabId;
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [{
            deleteContentRange: { range }
          }]
        }
      });
      return {
        content: [{ type: "text", text: `Successfully deleted content from index ${a.startIndex} to ${a.endIndex}${a.tabId ? ` in tab ${a.tabId}` : ""}` }],
        isError: false
      };
    }
    case "readGoogleDoc": {
      let extractText2 = function(bodyContent) {
        let result = "";
        for (const element of bodyContent) {
          if (element.paragraph?.elements) {
            for (const elem of element.paragraph.elements) {
              if (elem.textRun?.content) {
                result += elem.textRun.content;
              }
            }
          } else if (element.table) {
            for (const row of element.table.tableRows || []) {
              for (const cell of row.tableCells || []) {
                for (const cellContent of cell.content || []) {
                  if (cellContent.paragraph?.elements) {
                    for (const elem of cellContent.paragraph.elements) {
                      if (elem.textRun?.content) {
                        result += elem.textRun.content;
                      }
                    }
                  }
                }
                result += "	";
              }
              result += "\n";
            }
          }
        }
        return result;
      };
      var extractText = extractText2;
      const validation = ReadGoogleDocSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      const docResponse = await docs.documents.get({
        documentId: a.documentId,
        includeTabsContent: true
      });
      const doc = docResponse.data;
      const format = a.format || "text";
      if (format === "json") {
        let result = JSON.stringify(doc, null, 2);
        if (a.maxLength && result.length > a.maxLength) {
          result = result.substring(0, a.maxLength) + "\n... (truncated)";
        }
        return {
          content: [{ type: "text", text: result }],
          isError: false
        };
      }
      let text = "";
      const tabs = doc.tabs;
      if (tabs && tabs.length > 0) {
        if (a.tabId) {
          const tab = findTabById(tabs, a.tabId);
          if (!tab) {
            return errorResponse(`Tab with ID "${a.tabId}" not found. Use listDocumentTabs to see available tabs.`);
          }
          const bodyContent = tab.documentTab?.body?.content;
          if (bodyContent) {
            text = extractText2(bodyContent);
          }
        } else {
          const allTabs = collectAllTabsWithLevel(tabs);
          const isMultiTab = allTabs.length > 1;
          for (const { tab, level } of allTabs) {
            const bodyContent = tab.documentTab?.body?.content;
            if (isMultiTab) {
              const title = tab.tabProperties?.title || "Untitled";
              const indent = "  ".repeat(level);
              text += `${indent}=== Tab: ${title} ===
`;
            }
            if (bodyContent) {
              text += extractText2(bodyContent);
            }
            if (isMultiTab) {
              text += "\n";
            }
          }
        }
      } else {
        const body = doc.body;
        if (body?.content) {
          text = extractText2(body.content);
        }
      }
      if (format === "markdown") {
        text = `# ${doc.title}

${text}`;
      }
      if (a.maxLength && text.length > a.maxLength) {
        text = text.substring(0, a.maxLength) + "\n... (truncated)";
      }
      return {
        content: [{ type: "text", text }],
        isError: false
      };
    }
    case "listDocumentTabs": {
      const validation = ListDocumentTabsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      const docResponse = await docs.documents.get({
        documentId: a.documentId,
        includeTabsContent: true
      });
      const doc = docResponse.data;
      const tabs = doc.tabs;
      if (!tabs || tabs.length === 0) {
        let contentInfo = "";
        if (a.includeContent) {
          let charCount = 0;
          const body = doc.body;
          if (body?.content) {
            for (const element of body.content) {
              if (element.paragraph?.elements) {
                for (const elem of element.paragraph.elements) {
                  if (elem.textRun?.content) {
                    charCount += elem.textRun.content.length;
                  }
                }
              }
            }
          }
          contentInfo = ` (${charCount} characters)`;
        }
        return {
          content: [{ type: "text", text: `Document "${doc.title}" has a single tab (standard format).${contentInfo}` }],
          isError: false
        };
      }
      const processTab = (tab, depth = 0) => {
        const indent = "  ".repeat(depth);
        let result = `${indent}- Tab: "${tab.tabProperties?.title || "Untitled"}" (ID: ${tab.tabProperties?.tabId})`;
        if (a.includeContent && tab.documentTab?.body?.content) {
          let charCount = 0;
          for (const element of tab.documentTab.body.content) {
            if (element.paragraph?.elements) {
              for (const elem of element.paragraph.elements) {
                if (elem.textRun?.content) {
                  charCount += elem.textRun.content.length;
                }
              }
            }
          }
          result += ` (${charCount} characters)`;
        }
        if (tab.childTabs) {
          for (const childTab of tab.childTabs) {
            result += "\n" + processTab(childTab, depth + 1);
          }
        }
        return result;
      };
      let tabList = `Document "${doc.title}" tabs:
`;
      for (const tab of tabs) {
        tabList += processTab(tab) + "\n";
      }
      return {
        content: [{ type: "text", text: tabList }],
        isError: false
      };
    }
    // =========================================================================
    // TEXT & PARAGRAPH STYLE
    // =========================================================================
    case "applyTextStyle":
    case "formatGoogleDocText": {
      const validation = ApplyTextStyleSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      let startIndex;
      let endIndex;
      if (a.startIndex !== void 0 && a.endIndex !== void 0) {
        startIndex = a.startIndex;
        endIndex = a.endIndex;
      } else if (a.textToFind !== void 0) {
        const range = await findTextRange(
          ctx,
          a.documentId,
          a.textToFind,
          a.matchInstance || 1
        );
        if (!range) {
          return errorResponse(`Text "${a.textToFind}" not found in document`);
        }
        startIndex = range.startIndex;
        endIndex = range.endIndex;
      } else {
        return errorResponse("Must provide either startIndex+endIndex or textToFind");
      }
      const style = {
        bold: a.bold,
        italic: a.italic,
        underline: a.underline,
        strikethrough: a.strikethrough,
        fontSize: a.fontSize,
        fontFamily: a.fontFamily,
        foregroundColor: a.foregroundColor,
        backgroundColor: a.backgroundColor,
        linkUrl: a.linkUrl
      };
      const styleResult = buildUpdateTextStyleRequest(startIndex, endIndex, style);
      if (!styleResult) {
        return errorResponse("No valid style options provided");
      }
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [styleResult.request]
        }
      });
      return {
        content: [{ type: "text", text: `Successfully applied text style to range ${startIndex}-${endIndex}` }],
        isError: false
      };
    }
    case "applyParagraphStyle":
    case "formatGoogleDocParagraph": {
      const validation = ApplyParagraphStyleSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      let startIndex;
      let endIndex;
      if (a.startIndex !== void 0 && a.endIndex !== void 0) {
        startIndex = a.startIndex;
        endIndex = a.endIndex;
      } else if (a.textToFind !== void 0) {
        const range = await findTextRange(
          ctx,
          a.documentId,
          a.textToFind,
          a.matchInstance || 1
        );
        if (!range) {
          return errorResponse(`Text "${a.textToFind}" not found in document`);
        }
        const paraRange = await getParagraphRange(ctx, a.documentId, range.startIndex);
        if (!paraRange) {
          return errorResponse("Could not determine paragraph boundaries");
        }
        startIndex = paraRange.startIndex;
        endIndex = paraRange.endIndex;
      } else if (a.indexWithinParagraph !== void 0) {
        const paraRange = await getParagraphRange(ctx, a.documentId, a.indexWithinParagraph);
        if (!paraRange) {
          return errorResponse("Could not determine paragraph boundaries");
        }
        startIndex = paraRange.startIndex;
        endIndex = paraRange.endIndex;
      } else {
        return errorResponse("Must provide either startIndex+endIndex, textToFind, or indexWithinParagraph");
      }
      const style = {
        alignment: a.alignment,
        indentStart: a.indentStart,
        indentEnd: a.indentEnd,
        spaceAbove: a.spaceAbove,
        spaceBelow: a.spaceBelow,
        namedStyleType: a.namedStyleType,
        keepWithNext: a.keepWithNext
      };
      const styleResult = buildUpdateParagraphStyleRequest(startIndex, endIndex, style);
      if (!styleResult) {
        return errorResponse("No valid style options provided");
      }
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [styleResult.request]
        }
      });
      return {
        content: [{ type: "text", text: `Successfully applied paragraph style to range ${startIndex}-${endIndex}` }],
        isError: false
      };
    }
    case "createParagraphBullets": {
      const validation = CreateParagraphBulletsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      let startIndex;
      let endIndex;
      if (a.startIndex !== void 0 && a.endIndex !== void 0) {
        startIndex = a.startIndex;
        endIndex = a.endIndex;
      } else if (a.textToFind !== void 0) {
        const range = await findTextRange(
          ctx,
          a.documentId,
          a.textToFind,
          a.matchInstance || 1
        );
        if (!range) {
          return errorResponse(`Text "${a.textToFind}" not found in document`);
        }
        startIndex = range.startIndex;
        endIndex = range.endIndex;
      } else {
        return errorResponse("Must provide either startIndex+endIndex or textToFind");
      }
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      if (a.bulletPreset === "NONE") {
        await docs.documents.batchUpdate({
          documentId: a.documentId,
          requestBody: {
            requests: [{
              deleteParagraphBullets: {
                range: { startIndex, endIndex }
              }
            }]
          }
        });
        return {
          content: [{ type: "text", text: `Removed bullets from range ${startIndex}-${endIndex}` }],
          isError: false
        };
      }
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [{
            createParagraphBullets: {
              range: { startIndex, endIndex },
              bulletPreset: a.bulletPreset
            }
          }]
        }
      });
      return {
        content: [{ type: "text", text: `Applied ${a.bulletPreset} bullets to range ${startIndex}-${endIndex}` }],
        isError: false
      };
    }
    case "findAndReplaceInDoc": {
      const validation = FindAndReplaceInDocSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      if (a.dryRun) {
        const doc = await docs.documents.get({ documentId: a.documentId });
        let text = "";
        const content = doc.data.body?.content || [];
        for (const el of content) {
          if (el.paragraph?.elements) {
            for (const elem of el.paragraph.elements) {
              if (elem.textRun?.content) text += elem.textRun.content;
            }
          }
        }
        const escaped = a.findText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const flags = a.matchCase ? "g" : "gi";
        const matches = text.match(new RegExp(escaped, flags));
        const count = matches ? matches.length : 0;
        return {
          content: [{ type: "text", text: `Dry run (paragraph text only, approximate): found ${count} occurrence(s) of "${a.findText}". Note: actual replacement covers the full document including tables, headers, and footers.` }],
          isError: false
        };
      }
      const replaceAllText = {
        containsText: { text: a.findText, matchCase: a.matchCase },
        replaceText: a.replaceText
      };
      if (a.tabId) replaceAllText.tabsCriteria = { tabIds: [a.tabId] };
      const response = await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [{ replaceAllText }]
        }
      });
      const occurrences = response.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
      return {
        content: [{ type: "text", text: `Replaced ${occurrences} occurrence(s) of "${a.findText}"${a.tabId ? ` in tab ${a.tabId}` : ""}.` }],
        isError: false
      };
    }
    // =========================================================================
    // COMMENT TOOLS (use Drive API v3)
    // =========================================================================
    case "listComments": {
      const validation = ListCommentsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const response = await ctx.getDrive().comments.list({
        fileId: a.documentId,
        fields: "comments(id,content,quotedFileContent,author,createdTime,resolved,replies(id,content,author,createdTime)),nextPageToken",
        pageSize: a.pageSize || 100,
        pageToken: a.pageToken,
        includeDeleted: a.includeDeleted || false
      });
      const comments = response.data.comments || [];
      const nextPageToken = response.data.nextPageToken;
      if (comments.length === 0) {
        return {
          content: [{ type: "text", text: "No comments found in this document." }],
          isError: false
        };
      }
      const contextMap = /* @__PURE__ */ new Map();
      let flatText = "";
      let offsetMap = [];
      let needsDocxFallback = false;
      let isGoogleDoc = false;
      try {
        const fileInfo = await ctx.getDrive().files.get({
          fileId: a.documentId,
          fields: "mimeType",
          supportsAllDrives: true
        });
        isGoogleDoc = fileInfo.data.mimeType === "application/vnd.google-apps.document";
      } catch (err) {
        ctx.log("Failed to check file MIME type:", err);
      }
      if (isGoogleDoc) {
        try {
          let getContext2 = function(matchStart, matchLen) {
            const matchText = flatText.substring(matchStart, matchStart + matchLen);
            const beforeStart = Math.max(0, matchStart - 120);
            let before = flatText.substring(beforeStart, matchStart).trim();
            if (beforeStart > 0) before = "..." + before;
            before = before + matchText;
            const afterEnd = Math.min(flatText.length, matchStart + matchLen + 120);
            let after = flatText.substring(matchStart + matchLen, afterEnd).trim();
            if (afterEnd < flatText.length) after = after + "...";
            after = matchText + after;
            return { before, after };
          };
          var getContext = getContext2;
          const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
          const docResponse = await docs.documents.get({
            documentId: a.documentId,
            includeTabsContent: true
          });
          const result = buildFlatTextFromDoc(docResponse.data);
          flatText = result.flatText;
          offsetMap = result.offsetMap;
          const ambiguousComments = [];
          for (const comment of comments) {
            const quoted = comment.quotedFileContent?.value;
            if (!quoted) continue;
            const positions = [];
            let searchFrom = 0;
            while (true) {
              const idx = flatText.indexOf(quoted, searchFrom);
              if (idx === -1) break;
              positions.push(idx);
              searchFrom = idx + 1;
            }
            if (positions.length === 1) {
              const surrounding = getContext2(positions[0], quoted.length);
              const entry = {
                contextBefore: surrounding.before,
                contextAfter: surrounding.after
              };
              const endIdx = positions[0] + quoted.length - 1;
              if (endIdx < offsetMap.length) {
                entry.startIndex = offsetMap[positions[0]];
                entry.endIndex = offsetMap[endIdx] + 1;
              }
              if (comment.id) contextMap.set(comment.id, entry);
            } else if (positions.length > 1) {
              ambiguousComments.push(comment);
            }
          }
          needsDocxFallback = ambiguousComments.length > 0;
        } catch (err) {
          ctx.log("Tier 1 context extraction failed:", err);
          needsDocxFallback = true;
        }
      }
      if (needsDocxFallback) {
        const unresolved = comments.filter((c) => !contextMap.has(c.id) && !c.resolved);
        if (unresolved.length > 0) {
          try {
            const docxResponse = await ctx.getDrive().files.export({
              fileId: a.documentId,
              mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            }, { responseType: "arraybuffer" });
            const docxResult = await resolveContextFromDocx(docxResponse.data);
            if (docxResult) {
              matchDocxToDriveComments(comments, docxResult, contextMap, flatText, offsetMap);
            }
          } catch (err) {
            ctx.log("Tier 2 DOCX context extraction failed:", err);
          }
        }
      }
      const formattedComments = comments.map((comment, index) => {
        const status = comment.resolved ? " [RESOLVED]" : "";
        const author = comment.author?.displayName || "Unknown";
        const date = comment.createdTime ? new Date(comment.createdTime).toLocaleDateString() : "Unknown date";
        const quotedText = comment.quotedFileContent?.value;
        const commentCtx = contextMap.get(comment.id);
        let positionInfo = "";
        const indexStr = commentCtx?.startIndex != null ? ` [chars ${commentCtx.startIndex}-${commentCtx.endIndex}]` : "";
        if (quotedText) {
          const snippet = quotedText.length > 100 ? quotedText.substring(0, 100) + "..." : quotedText;
          positionInfo = `
   Anchored to: "${snippet}"${indexStr}`;
        }
        if (commentCtx) {
          if (commentCtx.contextBefore) positionInfo += `
   Context before: "${commentCtx.contextBefore}"`;
          if (commentCtx.contextAfter) positionInfo += `
   Context after: "${commentCtx.contextAfter}"`;
        }
        let result = `${index + 1}. ${author} (${date})${status}${positionInfo}
   Comment: ${comment.content}`;
        if (comment.replies && comment.replies.length > 0) {
          for (const reply of comment.replies) {
            const replyAuthor = reply.author?.displayName || "Unknown";
            const replyDate = reply.createdTime ? new Date(reply.createdTime).toLocaleDateString() : "Unknown date";
            const replyContent = reply.content || "(empty)";
            result += `
   \u2514\u2500 ${replyAuthor} (${replyDate}): ${replyContent}`;
          }
        }
        result += `
   Comment ID: ${comment.id}`;
        return result;
      }).join("\n\n");
      let text = `Found ${comments.length} comment${comments.length === 1 ? "" : "s"}:

${formattedComments}`;
      if (nextPageToken) {
        text += `

More comments available. Use pageToken: "${nextPageToken}" to fetch the next page.`;
      }
      return {
        content: [{ type: "text", text }],
        isError: false
      };
    }
    case "getComment": {
      const validation = GetCommentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const response = await ctx.getDrive().comments.get({
        fileId: a.documentId,
        commentId: a.commentId,
        fields: "id,content,quotedFileContent,author,createdTime,resolved,replies(id,content,author,createdTime)"
      });
      const comment = response.data;
      const author = comment.author?.displayName || "Unknown";
      const date = comment.createdTime ? new Date(comment.createdTime).toLocaleDateString() : "Unknown date";
      const status = comment.resolved ? " [RESOLVED]" : "";
      const quotedText = comment.quotedFileContent?.value || "No quoted text";
      const anchor = quotedText !== "No quoted text" ? `
Anchored to: "${quotedText}"` : "";
      let result = `${author} (${date})${status}${anchor}
${comment.content}`;
      if (comment.replies && comment.replies.length > 0) {
        result += "\n\nReplies:";
        comment.replies.forEach((reply, index) => {
          const replyAuthor = reply.author?.displayName || "Unknown";
          const replyDate = reply.createdTime ? new Date(reply.createdTime).toLocaleDateString() : "Unknown date";
          result += `
${index + 1}. ${replyAuthor} (${replyDate})
   ${reply.content}`;
        });
      }
      return {
        content: [{ type: "text", text: result }],
        isError: false
      };
    }
    case "addComment": {
      const validation = AddCommentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      if (a.endIndex <= a.startIndex) {
        return errorResponse("endIndex must be greater than startIndex");
      }
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      const doc = await docs.documents.get({ documentId: a.documentId });
      let quotedText = "";
      const content = doc.data.body?.content || [];
      for (const element of content) {
        if (element.paragraph?.elements) {
          for (const textElement of element.paragraph.elements) {
            if (textElement.textRun) {
              const elementStart = textElement.startIndex || 0;
              const elementEnd = textElement.endIndex || 0;
              if (elementEnd > a.startIndex && elementStart < a.endIndex) {
                const text = textElement.textRun.content || "";
                const startOffset = Math.max(0, a.startIndex - elementStart);
                const endOffset = Math.min(text.length, a.endIndex - elementStart);
                quotedText += text.substring(startOffset, endOffset);
              }
            }
          }
        }
      }
      const response = await ctx.getDrive().comments.create({
        fileId: a.documentId,
        fields: "id,content,quotedFileContent,author,createdTime",
        requestBody: {
          content: a.commentText,
          quotedFileContent: {
            value: quotedText,
            mimeType: "text/html"
          },
          // Reverse-engineered anchor format for positioning comments.
          // Not part of the public Drive API -- may break if Google changes internals.
          // See: https://stackoverflow.com/questions/51789168
          anchor: JSON.stringify({
            r: a.documentId,
            a: [{
              txt: {
                o: a.startIndex - 1,
                // Drive API uses 0-based indexing
                l: a.endIndex - a.startIndex,
                ml: a.endIndex - a.startIndex
              }
            }]
          })
        }
      });
      return {
        content: [{ type: "text", text: `Comment added successfully. Comment ID: ${response.data.id}` }],
        isError: false
      };
    }
    case "replyToComment": {
      const validation = ReplyToCommentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const response = await ctx.getDrive().replies.create({
        fileId: a.documentId,
        commentId: a.commentId,
        fields: "id,content,author,createdTime",
        requestBody: {
          content: a.replyText,
          ...a.resolve && { action: "resolve" }
        }
      });
      const resolveNote = a.resolve ? " Comment thread resolved." : "";
      return {
        content: [{ type: "text", text: `Reply added successfully. Reply ID: ${response.data.id}${resolveNote}` }],
        isError: false
      };
    }
    case "deleteComment": {
      const validation = DeleteCommentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      await ctx.getDrive().comments.delete({
        fileId: a.documentId,
        commentId: a.commentId
      });
      return {
        content: [{ type: "text", text: `Comment ${a.commentId} has been deleted.` }],
        isError: false
      };
    }
    // =========================================================================
    // TABLE & MEDIA TOOLS
    // =========================================================================
    case "insertTable": {
      const validation = InsertTableSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const request_body = {
        insertTable: {
          location: { index: a.index },
          rows: a.rows,
          columns: a.columns
        }
      };
      await executeBatchUpdate(ctx, a.documentId, [request_body]);
      return {
        content: [{ type: "text", text: `Successfully inserted ${a.rows}x${a.columns} table at index ${a.index}` }],
        isError: false
      };
    }
    case "editTableCell": {
      const validation = EditTableCellSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      const docRes = await docs.documents.get({
        documentId: a.documentId,
        fields: "body(content)"
      });
      let table = null;
      const findTable = (content) => {
        for (const elem of content) {
          if (elem.table && elem.startIndex === a.tableStartIndex) {
            table = elem.table;
            return;
          }
        }
      };
      if (docRes.data.body?.content) {
        findTable(docRes.data.body.content);
      }
      if (!table) {
        return errorResponse(`No table found at index ${a.tableStartIndex}`);
      }
      const row = table.tableRows?.[a.rowIndex];
      if (!row) {
        return errorResponse(`Row ${a.rowIndex} not found in table`);
      }
      const cell = row.tableCells?.[a.columnIndex];
      if (!cell) {
        return errorResponse(`Column ${a.columnIndex} not found in row ${a.rowIndex}`);
      }
      const cellStartIndex = cell.startIndex;
      const cellEndIndex = cell.endIndex;
      const requests = [];
      if (a.textContent !== void 0) {
        const cellContentStart = cellStartIndex + 1;
        const cellContentEnd = cellEndIndex - 1;
        if (cellContentEnd > cellContentStart) {
          requests.push({
            deleteContentRange: {
              range: { startIndex: cellContentStart, endIndex: cellContentEnd }
            }
          });
        }
        if (a.textContent.length > 0) {
          requests.push({
            insertText: {
              location: { index: cellContentStart },
              text: a.textContent
            }
          });
        }
      }
      if (a.bold !== void 0 || a.italic !== void 0 || a.fontSize !== void 0) {
        const textStyle = {};
        const fields = [];
        if (a.bold !== void 0) {
          textStyle.bold = a.bold;
          fields.push("bold");
        }
        if (a.italic !== void 0) {
          textStyle.italic = a.italic;
          fields.push("italic");
        }
        if (a.fontSize !== void 0) {
          textStyle.fontSize = { magnitude: a.fontSize, unit: "PT" };
          fields.push("fontSize");
        }
        if (fields.length > 0) {
          const styleStart = cellStartIndex + 1;
          const styleEnd = a.textContent !== void 0 ? styleStart + a.textContent.length : cellEndIndex - 1;
          requests.push({
            updateTextStyle: {
              range: { startIndex: styleStart, endIndex: styleEnd },
              textStyle,
              fields: fields.join(",")
            }
          });
        }
      }
      if (a.alignment !== void 0) {
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: cellStartIndex + 1, endIndex: cellEndIndex - 1 },
            paragraphStyle: { alignment: a.alignment },
            fields: "alignment"
          }
        });
      }
      if (requests.length === 0) {
        return errorResponse("No changes specified for the table cell");
      }
      await executeBatchUpdate(ctx, a.documentId, requests);
      return {
        content: [{ type: "text", text: `Successfully edited cell at row ${a.rowIndex}, column ${a.columnIndex}` }],
        isError: false
      };
    }
    case "insertImageFromUrl": {
      const validation = InsertImageFromUrlSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      await insertInlineImageHelper(ctx, a.documentId, a.imageUrl, a.index, a.width, a.height);
      return {
        content: [{ type: "text", text: `Successfully inserted image from URL at index ${a.index}` }],
        isError: false
      };
    }
    case "insertLocalImage": {
      const validation = InsertLocalImageSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      let parentFolderId;
      if (a.uploadToSameFolder !== false) {
        const fileInfo = await ctx.getDrive().files.get({
          fileId: a.documentId,
          fields: "parents",
          supportsAllDrives: true
        });
        parentFolderId = fileInfo.data.parents?.[0];
      }
      const { webContentLink: imageUrl } = await uploadImageToDrive(ctx, a.localImagePath, {
        parentFolderId,
        makePublic: a.makePublic
      });
      await insertInlineImageHelper(ctx, a.documentId, imageUrl, a.index, a.width, a.height);
      return {
        content: [{ type: "text", text: `Successfully uploaded and inserted local image at index ${a.index}
Image URL: ${imageUrl}` }],
        isError: false
      };
    }
    // =========================================================================
    // GOOGLE DOCS DISCOVERY & MANAGEMENT TOOLS
    // =========================================================================
    case "listGoogleDocs": {
      const validation = ListGoogleDocsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      let queryString = "mimeType='application/vnd.google-apps.document' and trashed=false";
      if (a.query) {
        const escapedQuery = escapeDriveQuery(a.query);
        queryString += ` and (name contains '${escapedQuery}' or fullText contains '${escapedQuery}')`;
      }
      const response = await ctx.getDrive().files.list({
        q: queryString,
        pageSize: a.maxResults,
        orderBy: a.orderBy === "name" ? "name" : a.orderBy,
        fields: "files(id,name,modifiedTime,createdTime,size,webViewLink,owners(displayName,emailAddress))",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      const files = response.data.files || [];
      if (files.length === 0) {
        return { content: [{ type: "text", text: "No Google Docs found matching your criteria." }], isError: false };
      }
      let result = `Found ${files.length} Google Document(s):

`;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const modifiedDate = file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString() : "Unknown";
        const owner = file.owners?.[0]?.displayName || "Unknown";
        result += `${i + 1}. **${file.name}**
`;
        result += `   ID: ${file.id}
`;
        result += `   Modified: ${modifiedDate}
`;
        result += `   Owner: ${owner}
`;
        result += `   Link: ${file.webViewLink}

`;
      }
      return { content: [{ type: "text", text: result }], isError: false };
    }
    case "getDocumentInfo": {
      const validation = GetDocumentInfoSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const response = await ctx.getDrive().files.get({
        fileId: a.documentId,
        fields: "id,name,description,mimeType,size,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),shared,parents,version"
      });
      const file = response.data;
      if (!file) {
        return errorResponse(`Document with ID ${a.documentId} not found.`);
      }
      const createdDate = file.createdTime ? new Date(file.createdTime).toLocaleString() : "Unknown";
      const modifiedDate = file.modifiedTime ? new Date(file.modifiedTime).toLocaleString() : "Unknown";
      const owner = file.owners?.[0];
      const lastModifier = file.lastModifyingUser;
      let result = `**Document Information:**

`;
      result += `**Name:** ${file.name}
`;
      result += `**ID:** ${file.id}
`;
      result += `**Type:** Google Document
`;
      result += `**Created:** ${createdDate}
`;
      result += `**Last Modified:** ${modifiedDate}
`;
      if (owner) {
        result += `**Owner:** ${owner.displayName} (${owner.emailAddress})
`;
      }
      if (lastModifier) {
        result += `**Last Modified By:** ${lastModifier.displayName} (${lastModifier.emailAddress})
`;
      }
      if (file.description) {
        result += `**Description:** ${file.description}
`;
      }
      result += `**Shared:** ${file.shared ? "Yes" : "No"}
`;
      result += `**Version:** ${file.version || "Unknown"}
`;
      result += `**View Link:** ${file.webViewLink}
`;
      return { content: [{ type: "text", text: result }], isError: false };
    }
    case "addDocumentTab": {
      const validation = AddDocumentTabSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        // addDocumentTab is not yet in the googleapis TypeScript types — cast required
        requestBody: { requests: [{ addDocumentTab: { tabProperties: { title: a.title } } }] }
      });
      return { content: [{ type: "text", text: `Requested creation of tab "${a.title}" in document ${a.documentId}.` }], isError: false };
    }
    case "renameDocumentTab": {
      const validation = RenameDocumentTabSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        // updateDocumentTabProperties is not yet in the googleapis TypeScript types — cast required.
        // Per Google Docs API spec: tabId lives INSIDE tabProperties (it's the tab identifier),
        // and `fields` is a FieldMask for which properties to update (excludes tabId).
        requestBody: { requests: [{ updateDocumentTabProperties: { tabProperties: { tabId: a.tabId, title: a.title }, fields: "title" } }] }
      });
      return { content: [{ type: "text", text: `Renamed tab ${a.tabId} to "${a.title}".` }], isError: false };
    }
    case "insertSmartChip": {
      const validation = InsertSmartChipSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [{
            insertPerson: {
              personProperties: { email: a.personEmail },
              location: { index: a.index }
            }
            // insertPerson is not yet in the googleapis TypeScript types — cast required
          }]
        }
      });
      return { content: [{ type: "text", text: `Inserted person smart chip for ${a.personEmail} at index ${a.index}.` }], isError: false };
    }
    case "readSmartChips": {
      const validation = ReadSmartChipsSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      const doc = await docs.documents.get({ documentId: a.documentId });
      const body = doc.data.body?.content || [];
      const hits = [];
      for (const block of body) {
        for (const el of block?.paragraph?.elements || []) {
          if (el?.richLink) hits.push(`richLink: ${el.richLink.richLinkProperties?.uri || "unknown"}`);
          if (el?.person) hits.push(`person: ${el.person.personProperties?.email || "unknown"}`);
        }
      }
      return { content: [{ type: "text", text: hits.length ? hits.join("\n") : "No smart chips detected (note: only the default tab is scanned)." }], isError: false };
    }
    case "createFootnote": {
      const validation = CreateFootnoteSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const docs = ctx.google.docs({ version: "v1", auth: ctx.authClient });
      const createFootnoteReq = {};
      if (a.index !== void 0) {
        createFootnoteReq.location = { index: a.index };
      } else {
        createFootnoteReq.endOfSegmentLocation = { segmentId: "" };
      }
      const res = await docs.documents.batchUpdate({
        documentId: a.documentId,
        requestBody: {
          requests: [{ createFootnote: createFootnoteReq }]
        }
      });
      const footnoteId = res.data.replies?.[0]?.createFootnote?.footnoteId;
      if (!footnoteId) {
        return errorResponse("Failed to create footnote \u2014 no footnoteId in response.");
      }
      const locationDesc = a.index !== void 0 ? `at index ${a.index}` : "at end of document";
      if (a.content) {
        try {
          await docs.documents.batchUpdate({
            documentId: a.documentId,
            requestBody: {
              requests: [{
                insertText: {
                  location: { segmentId: footnoteId, index: 0 },
                  text: a.content
                }
              }]
            }
          });
        } catch (err) {
          return { content: [{ type: "text", text: `Created footnote ${footnoteId} ${locationDesc}, but failed to insert content: ${err.message}` }], isError: true };
        }
      }
      return { content: [{ type: "text", text: `Created footnote ${footnoteId} ${locationDesc}.${a.content ? " Content inserted." : ""}` }], isError: false };
    }
    default:
      return null;
  }
}

// src/tools/sheets.ts
var sheets_exports = {};
__export(sheets_exports, {
  handleTool: () => handleTool3,
  toolDefinitions: () => toolDefinitions3
});
import { z as z3 } from "zod";
var CreateGoogleSheetSchema = z3.object({
  name: z3.string().min(1, "Sheet name is required"),
  data: z3.array(z3.array(z3.string())),
  parentFolderId: z3.string().optional(),
  valueInputOption: z3.enum(["RAW", "USER_ENTERED"]).optional()
});
var UpdateGoogleSheetSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  range: z3.string().min(1, "Range is required"),
  data: z3.array(z3.array(z3.string())),
  valueInputOption: z3.enum(["RAW", "USER_ENTERED"]).optional()
});
var GetGoogleSheetContentSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  range: z3.string().min(1, "Range is required")
});
var FormatGoogleSheetCellsSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  range: z3.string().min(1, "Range is required"),
  backgroundColor: z3.object({
    red: z3.number().min(0).max(1).optional(),
    green: z3.number().min(0).max(1).optional(),
    blue: z3.number().min(0).max(1).optional()
  }).optional(),
  horizontalAlignment: z3.enum(["LEFT", "CENTER", "RIGHT"]).optional(),
  verticalAlignment: z3.enum(["TOP", "MIDDLE", "BOTTOM"]).optional(),
  wrapStrategy: z3.enum(["OVERFLOW_CELL", "CLIP", "WRAP"]).optional()
});
var FormatGoogleSheetTextSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  range: z3.string().min(1, "Range is required"),
  bold: z3.boolean().optional(),
  italic: z3.boolean().optional(),
  strikethrough: z3.boolean().optional(),
  underline: z3.boolean().optional(),
  fontSize: z3.number().min(1).optional(),
  fontFamily: z3.string().optional(),
  foregroundColor: z3.object({
    red: z3.number().min(0).max(1).optional(),
    green: z3.number().min(0).max(1).optional(),
    blue: z3.number().min(0).max(1).optional()
  }).optional()
});
var FormatGoogleSheetNumbersSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  range: z3.string().min(1, "Range is required"),
  pattern: z3.string().min(1, "Pattern is required"),
  type: z3.enum(["NUMBER", "CURRENCY", "PERCENT", "DATE", "TIME", "DATE_TIME", "SCIENTIFIC"]).optional()
});
var SetGoogleSheetBordersSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  range: z3.string().min(1, "Range is required"),
  style: z3.enum(["SOLID", "DASHED", "DOTTED", "DOUBLE"]),
  width: z3.number().min(1).max(3).optional(),
  color: z3.object({
    red: z3.number().min(0).max(1).optional(),
    green: z3.number().min(0).max(1).optional(),
    blue: z3.number().min(0).max(1).optional()
  }).optional(),
  top: z3.boolean().optional(),
  bottom: z3.boolean().optional(),
  left: z3.boolean().optional(),
  right: z3.boolean().optional(),
  innerHorizontal: z3.boolean().optional(),
  innerVertical: z3.boolean().optional()
});
var MergeGoogleSheetCellsSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  range: z3.string().min(1, "Range is required"),
  mergeType: z3.enum(["MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS"])
});
var AddGoogleSheetConditionalFormatSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  range: z3.string().min(1, "Range is required"),
  condition: z3.object({
    type: z3.enum(["NUMBER_GREATER", "NUMBER_LESS", "TEXT_CONTAINS", "TEXT_STARTS_WITH", "TEXT_ENDS_WITH", "CUSTOM_FORMULA"]),
    value: z3.string()
  }),
  format: z3.object({
    backgroundColor: z3.object({
      red: z3.number().min(0).max(1).optional(),
      green: z3.number().min(0).max(1).optional(),
      blue: z3.number().min(0).max(1).optional()
    }).optional(),
    textFormat: z3.object({
      bold: z3.boolean().optional(),
      foregroundColor: z3.object({
        red: z3.number().min(0).max(1).optional(),
        green: z3.number().min(0).max(1).optional(),
        blue: z3.number().min(0).max(1).optional()
      }).optional()
    }).optional()
  })
});
var GetSpreadsheetInfoSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required")
});
var AppendSpreadsheetRowsSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  range: z3.string().min(1, "Range is required"),
  values: z3.array(z3.array(z3.any())),
  valueInputOption: z3.enum(["RAW", "USER_ENTERED"]).optional().default("USER_ENTERED")
});
var AddSpreadsheetSheetSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  sheetTitle: z3.string().min(1, "Sheet title is required")
});
var AddSheetSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  title: z3.string().min(1, "Sheet title is required")
});
var ListSheetsSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required")
});
var RenameSheetSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  sheetId: z3.number().int(),
  newTitle: z3.string().min(1, "New title is required")
});
var DeleteSheetSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  sheetId: z3.number().int()
});
var AddDataValidationSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  range: z3.string().min(1, "Range is required"),
  conditionType: z3.enum(["ONE_OF_LIST", "NUMBER_GREATER", "NUMBER_LESS", "TEXT_CONTAINS"]),
  values: z3.array(z3.string()).min(1, "At least one value is required"),
  strict: z3.boolean().optional().default(true),
  showCustomUi: z3.boolean().optional().default(true)
});
var ProtectRangeSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  range: z3.string().min(1, "Range is required"),
  description: z3.string().optional(),
  warningOnly: z3.boolean().optional().default(false)
});
var AddNamedRangeSchema = z3.object({
  spreadsheetId: z3.string().min(1, "Spreadsheet ID is required"),
  name: z3.string().min(1, "Name is required"),
  range: z3.string().min(1, "Range is required")
});
var ListGoogleSheetsSchema = z3.object({
  maxResults: z3.number().int().min(1).max(100).optional().default(20),
  query: z3.string().optional(),
  orderBy: z3.enum(["name", "modifiedTime", "createdTime"]).optional().default("modifiedTime")
});
var toolDefinitions3 = [
  {
    name: "createGoogleSheet",
    description: "Create a new Google Sheet. By default uses RAW mode which stores values as-is. Set valueInputOption to 'USER_ENTERED' only when you need formulas to be evaluated.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Sheet name" },
        data: {
          type: "array",
          description: "Data as array of arrays",
          items: { type: "array", items: { type: "string" } }
        },
        parentFolderId: { type: "string", description: "Parent folder ID (defaults to root)" },
        valueInputOption: {
          type: "string",
          enum: ["RAW", "USER_ENTERED"],
          description: "RAW (default): Values stored exactly as provided - formulas stored as text strings. Safe for untrusted data. USER_ENTERED: Values parsed like spreadsheet UI - formulas (=SUM, =IF, etc.) are evaluated. SECURITY WARNING: USER_ENTERED can execute formulas, only use with trusted data, never with user-provided input that could contain malicious formulas like =IMPORTDATA() or =IMPORTRANGE()."
        }
      },
      required: ["name", "data"]
    }
  },
  {
    name: "updateGoogleSheet",
    description: "Update an existing Google Sheet. By default uses RAW mode which stores values as-is. Set valueInputOption to 'USER_ENTERED' only when you need formulas to be evaluated.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Sheet ID" },
        range: { type: "string", description: "Range to update (e.g., 'Sheet1!A1:C10')" },
        data: {
          type: "array",
          description: "2D array of values to write",
          items: { type: "array", items: { type: "string" } }
        },
        valueInputOption: {
          type: "string",
          enum: ["RAW", "USER_ENTERED"],
          description: "RAW (default): Values stored exactly as provided - formulas stored as text strings. Safe for untrusted data. USER_ENTERED: Values parsed like spreadsheet UI - formulas (=SUM, =IF, etc.) are evaluated. SECURITY WARNING: USER_ENTERED can execute formulas, only use with trusted data, never with user-provided input that could contain malicious formulas like =IMPORTDATA() or =IMPORTRANGE()."
        }
      },
      required: ["spreadsheetId", "range", "data"]
    }
  },
  {
    name: "getGoogleSheetContent",
    description: "Get content of a Google Sheet with cell information",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        range: { type: "string", description: "Range to get (e.g., 'Sheet1!A1:C10')" }
      },
      required: ["spreadsheetId", "range"]
    }
  },
  {
    name: "formatGoogleSheetCells",
    description: "Format cells in a Google Sheet (background, borders, alignment)",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        range: { type: "string", description: "Range to format (e.g., 'A1:C10')" },
        backgroundColor: {
          type: "object",
          description: "Background color (RGB values 0-1)",
          properties: {
            red: { type: "number" },
            green: { type: "number" },
            blue: { type: "number" }
          }
        },
        horizontalAlignment: {
          type: "string",
          description: "Horizontal alignment",
          enum: ["LEFT", "CENTER", "RIGHT"]
        },
        verticalAlignment: {
          type: "string",
          description: "Vertical alignment",
          enum: ["TOP", "MIDDLE", "BOTTOM"]
        },
        wrapStrategy: {
          type: "string",
          description: "Text wrapping",
          enum: ["OVERFLOW_CELL", "CLIP", "WRAP"]
        }
      },
      required: ["spreadsheetId", "range"]
    }
  },
  {
    name: "formatGoogleSheetText",
    description: "Apply text formatting to cells in a Google Sheet",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        range: { type: "string", description: "Range to format (e.g., 'A1:C10')" },
        bold: { type: "boolean", description: "Make text bold" },
        italic: { type: "boolean", description: "Make text italic" },
        strikethrough: { type: "boolean", description: "Strikethrough text" },
        underline: { type: "boolean", description: "Underline text" },
        fontSize: { type: "number", description: "Font size in points" },
        fontFamily: { type: "string", description: "Font family name" },
        foregroundColor: {
          type: "object",
          description: "Text color (RGB values 0-1)",
          properties: {
            red: { type: "number" },
            green: { type: "number" },
            blue: { type: "number" }
          }
        }
      },
      required: ["spreadsheetId", "range"]
    }
  },
  {
    name: "formatGoogleSheetNumbers",
    description: "Apply number formatting to cells in a Google Sheet",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        range: { type: "string", description: "Range to format (e.g., 'A1:C10')" },
        pattern: {
          type: "string",
          description: "Number format pattern (e.g., '#,##0.00', 'yyyy-mm-dd', '$#,##0.00', '0.00%')"
        },
        type: {
          type: "string",
          description: "Format type",
          enum: ["NUMBER", "CURRENCY", "PERCENT", "DATE", "TIME", "DATE_TIME", "SCIENTIFIC"]
        }
      },
      required: ["spreadsheetId", "range", "pattern"]
    }
  },
  {
    name: "setGoogleSheetBorders",
    description: "Set borders for cells in a Google Sheet",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        range: { type: "string", description: "Range to format (e.g., 'A1:C10')" },
        style: {
          type: "string",
          description: "Border style",
          enum: ["SOLID", "DASHED", "DOTTED", "DOUBLE"]
        },
        width: { type: "number", description: "Border width (1-3)" },
        color: {
          type: "object",
          description: "Border color (RGB values 0-1)",
          properties: {
            red: { type: "number" },
            green: { type: "number" },
            blue: { type: "number" }
          }
        },
        top: { type: "boolean", description: "Apply to top border" },
        bottom: { type: "boolean", description: "Apply to bottom border" },
        left: { type: "boolean", description: "Apply to left border" },
        right: { type: "boolean", description: "Apply to right border" },
        innerHorizontal: { type: "boolean", description: "Apply to inner horizontal borders" },
        innerVertical: { type: "boolean", description: "Apply to inner vertical borders" }
      },
      required: ["spreadsheetId", "range", "style"]
    }
  },
  {
    name: "mergeGoogleSheetCells",
    description: "Merge cells in a Google Sheet",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        range: { type: "string", description: "Range to merge (e.g., 'A1:C3')" },
        mergeType: {
          type: "string",
          description: "Merge type",
          enum: ["MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS"]
        }
      },
      required: ["spreadsheetId", "range", "mergeType"]
    }
  },
  {
    name: "addGoogleSheetConditionalFormat",
    description: "Add conditional formatting to a Google Sheet",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        range: { type: "string", description: "Range to apply formatting (e.g., 'A1:C10')" },
        condition: {
          type: "object",
          description: "Condition configuration",
          properties: {
            type: {
              type: "string",
              description: "Condition type",
              enum: ["NUMBER_GREATER", "NUMBER_LESS", "TEXT_CONTAINS", "TEXT_STARTS_WITH", "TEXT_ENDS_WITH", "CUSTOM_FORMULA"]
            },
            value: { type: "string", description: "Value to compare or formula" }
          }
        },
        format: {
          type: "object",
          description: "Format to apply when condition is true",
          properties: {
            backgroundColor: {
              type: "object",
              properties: {
                red: { type: "number" },
                green: { type: "number" },
                blue: { type: "number" }
              }
            },
            textFormat: {
              type: "object",
              properties: {
                bold: { type: "boolean" },
                foregroundColor: {
                  type: "object",
                  properties: {
                    red: { type: "number" },
                    green: { type: "number" },
                    blue: { type: "number" }
                  }
                }
              }
            }
          }
        }
      },
      required: ["spreadsheetId", "range", "condition", "format"]
    }
  },
  {
    name: "getSpreadsheetInfo",
    description: "Gets detailed information about a Google Spreadsheet including all sheets/tabs",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The ID of the Google Spreadsheet (from the URL)" }
      },
      required: ["spreadsheetId"]
    }
  },
  {
    name: "appendSpreadsheetRows",
    description: "Appends rows of data to the end of a sheet in a Google Spreadsheet",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The ID of the Google Spreadsheet (from the URL)" },
        range: { type: "string", description: "A1 notation range indicating where to append (e.g., 'A1' or 'Sheet1!A1'). Data will be appended starting from this range." },
        values: {
          type: "array",
          description: "2D array of values to append. Each inner array represents a row.",
          items: {
            type: "array",
            items: {
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "null" }
              ]
            }
          }
        },
        valueInputOption: { type: "string", description: "How input data should be interpreted (RAW or USER_ENTERED)", enum: ["RAW", "USER_ENTERED"], default: "USER_ENTERED" }
      },
      required: ["spreadsheetId", "range", "values"]
    }
  },
  {
    name: "addSpreadsheetSheet",
    description: "Adds a new sheet/tab to an existing Google Spreadsheet",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The ID of the Google Spreadsheet (from the URL)" },
        sheetTitle: { type: "string", description: "Title for the new sheet/tab" }
      },
      required: ["spreadsheetId", "sheetTitle"]
    }
  },
  {
    name: "addSheet",
    description: "Alias for addSpreadsheetSheet (adds a new sheet/tab)",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        title: { type: "string", description: "Title for the new sheet/tab" }
      },
      required: ["spreadsheetId", "title"]
    }
  },
  {
    name: "listSheets",
    description: "List tabs/sheets in a Google Spreadsheet",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" }
      },
      required: ["spreadsheetId"]
    }
  },
  {
    name: "renameSheet",
    description: "Rename a sheet/tab by sheetId",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        sheetId: { type: "number", description: "Sheet ID" },
        newTitle: { type: "string", description: "New title" }
      },
      required: ["spreadsheetId", "sheetId", "newTitle"]
    }
  },
  {
    name: "deleteSheet",
    description: "Delete a sheet/tab by sheetId",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        sheetId: { type: "number", description: "Sheet ID" }
      },
      required: ["spreadsheetId", "sheetId"]
    }
  },
  {
    name: "addDataValidation",
    description: "Add data validation rules to a sheet range",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        range: { type: "string", description: "A1 range" },
        conditionType: { type: "string", enum: ["ONE_OF_LIST", "NUMBER_GREATER", "NUMBER_LESS", "TEXT_CONTAINS"], description: "Validation condition type" },
        values: { type: "array", items: { type: "string" }, description: "Condition values (e.g. list items, threshold)" },
        strict: { type: "boolean", description: "Reject invalid values" },
        showCustomUi: { type: "boolean", description: "Show dropdown/custom UI" }
      },
      required: ["spreadsheetId", "range", "conditionType", "values"]
    }
  },
  {
    name: "protectRange",
    description: "Protect a range in a spreadsheet",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        range: { type: "string", description: "A1 range" },
        description: { type: "string", description: "Protection description" },
        warningOnly: { type: "boolean", description: "Warn instead of enforce" }
      },
      required: ["spreadsheetId", "range"]
    }
  },
  {
    name: "addNamedRange",
    description: "Create a named range",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet ID" },
        name: { type: "string", description: "Named range name" },
        range: { type: "string", description: "A1 range" }
      },
      required: ["spreadsheetId", "name", "range"]
    }
  },
  {
    name: "listGoogleSheets",
    description: "Lists Google Spreadsheets from your Google Drive with optional filtering",
    inputSchema: {
      type: "object",
      properties: {
        maxResults: { type: "number", description: "Maximum number of spreadsheets to return (1-100)", default: 20 },
        query: { type: "string", description: "Search query to filter spreadsheets by name or content" },
        orderBy: { type: "string", description: "Sort order for results", enum: ["name", "modifiedTime", "createdTime"], default: "modifiedTime" }
      },
      required: []
    }
  }
];
async function resolveGridRange(sheetsService, spreadsheetId, range) {
  const rangeData = await sheetsService.spreadsheets.get({
    spreadsheetId,
    ranges: [range],
    fields: "sheets(properties(sheetId,title))"
  });
  const { sheetName, cellRange: a1Range } = parseA1Range(range);
  const sheet = rangeData.data.sheets?.find((s) => s.properties?.title === sheetName);
  if (!sheet || sheet.properties?.sheetId === void 0 || sheet.properties?.sheetId === null) {
    return `Sheet "${sheetName}" not found`;
  }
  return convertA1ToGridRange(a1Range, sheet.properties.sheetId);
}
async function handleTool3(toolName, args, ctx) {
  switch (toolName) {
    case "createGoogleSheet": {
      const validation = CreateGoogleSheetSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const parentFolderId = await ctx.resolveFolderId(a.parentFolderId);
      const existingFileId = await ctx.checkFileExists(a.name, parentFolderId);
      if (existingFileId) {
        return errorResponse(
          `A spreadsheet named "${a.name}" already exists in this location. To update it, use updateGoogleSheet with spreadsheetId: ${existingFileId}`
        );
      }
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const spreadsheet = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: a.name },
          sheets: [{
            properties: {
              sheetId: 0,
              title: "Sheet1",
              gridProperties: {
                rowCount: Math.max(a.data.length, 1e3),
                columnCount: Math.max(a.data[0]?.length || 0, 26)
              }
            }
          }]
        }
      });
      await ctx.getDrive().files.update({
        fileId: spreadsheet.data.spreadsheetId || "",
        addParents: parentFolderId,
        removeParents: "root",
        fields: "id, name, webViewLink",
        supportsAllDrives: true
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheet.data.spreadsheetId,
        range: "Sheet1!A1",
        valueInputOption: a.valueInputOption || "RAW",
        requestBody: { values: a.data }
      });
      return {
        content: [{ type: "text", text: `Created Google Sheet: ${a.name}
ID: ${spreadsheet.data.spreadsheetId}` }],
        isError: false
      };
    }
    case "updateGoogleSheet": {
      const validation = UpdateGoogleSheetSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      await sheets.spreadsheets.values.update({
        spreadsheetId: a.spreadsheetId,
        range: a.range,
        valueInputOption: a.valueInputOption || "RAW",
        requestBody: { values: a.data }
      });
      return {
        content: [{ type: "text", text: `Updated Google Sheet range: ${a.range}` }],
        isError: false
      };
    }
    case "getGoogleSheetContent": {
      const validation = GetGoogleSheetContentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: a.spreadsheetId,
        range: a.range
      });
      const values = response.data.values || [];
      let content = `Content for range ${a.range}:

`;
      if (values.length === 0) {
        content += "(empty range)";
      } else {
        values.forEach((row, rowIndex) => {
          content += `Row ${rowIndex + 1}: ${row.join(", ")}
`;
        });
      }
      return {
        content: [{ type: "text", text: content }],
        isError: false
      };
    }
    case "formatGoogleSheetCells": {
      const validation = FormatGoogleSheetCellsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: "sheets(properties(sheetId,title))"
      });
      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);
      const sheet = rangeData.data.sheets?.find((s) => s.properties?.title === sheetName);
      if (!sheet || sheet.properties?.sheetId === void 0 || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }
      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId);
      const requests = [{
        repeatCell: {
          range: gridRange,
          cell: {
            userEnteredFormat: {
              ...a.backgroundColor && {
                backgroundColor: {
                  red: a.backgroundColor.red || 0,
                  green: a.backgroundColor.green || 0,
                  blue: a.backgroundColor.blue || 0
                }
              },
              ...a.horizontalAlignment && { horizontalAlignment: a.horizontalAlignment },
              ...a.verticalAlignment && { verticalAlignment: a.verticalAlignment },
              ...a.wrapStrategy && { wrapStrategy: a.wrapStrategy }
            }
          },
          fields: [
            a.backgroundColor && "userEnteredFormat.backgroundColor",
            a.horizontalAlignment && "userEnteredFormat.horizontalAlignment",
            a.verticalAlignment && "userEnteredFormat.verticalAlignment",
            a.wrapStrategy && "userEnteredFormat.wrapStrategy"
          ].filter(Boolean).join(",")
        }
      }];
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: { requests }
      });
      return {
        content: [{ type: "text", text: `Formatted cells in range ${a.range}` }],
        isError: false
      };
    }
    case "formatGoogleSheetText": {
      const validation = FormatGoogleSheetTextSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: "sheets(properties(sheetId,title))"
      });
      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);
      const sheet = rangeData.data.sheets?.find((s) => s.properties?.title === sheetName);
      if (!sheet || sheet.properties?.sheetId === void 0 || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }
      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId);
      const textFormat = {};
      const fields = [];
      if (a.bold !== void 0) {
        textFormat.bold = a.bold;
        fields.push("bold");
      }
      if (a.italic !== void 0) {
        textFormat.italic = a.italic;
        fields.push("italic");
      }
      if (a.strikethrough !== void 0) {
        textFormat.strikethrough = a.strikethrough;
        fields.push("strikethrough");
      }
      if (a.underline !== void 0) {
        textFormat.underline = a.underline;
        fields.push("underline");
      }
      if (a.fontSize !== void 0) {
        textFormat.fontSize = a.fontSize;
        fields.push("fontSize");
      }
      if (a.fontFamily !== void 0) {
        textFormat.fontFamily = a.fontFamily;
        fields.push("fontFamily");
      }
      if (a.foregroundColor) {
        textFormat.foregroundColor = {
          red: a.foregroundColor.red || 0,
          green: a.foregroundColor.green || 0,
          blue: a.foregroundColor.blue || 0
        };
        fields.push("foregroundColor");
      }
      const requests = [{
        repeatCell: {
          range: gridRange,
          cell: {
            userEnteredFormat: { textFormat }
          },
          fields: "userEnteredFormat.textFormat(" + fields.join(",") + ")"
        }
      }];
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: { requests }
      });
      return {
        content: [{ type: "text", text: `Applied text formatting to range ${a.range}` }],
        isError: false
      };
    }
    case "formatGoogleSheetNumbers": {
      const validation = FormatGoogleSheetNumbersSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: "sheets(properties(sheetId,title))"
      });
      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);
      const sheet = rangeData.data.sheets?.find((s) => s.properties?.title === sheetName);
      if (!sheet || sheet.properties?.sheetId === void 0 || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }
      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId);
      const numberFormat = {
        pattern: a.pattern
      };
      if (a.type) {
        numberFormat.type = a.type;
      }
      const requests = [{
        repeatCell: {
          range: gridRange,
          cell: {
            userEnteredFormat: { numberFormat }
          },
          fields: "userEnteredFormat.numberFormat"
        }
      }];
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: { requests }
      });
      return {
        content: [{ type: "text", text: `Applied number formatting to range ${a.range}` }],
        isError: false
      };
    }
    case "setGoogleSheetBorders": {
      const validation = SetGoogleSheetBordersSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: "sheets(properties(sheetId,title))"
      });
      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);
      const sheet = rangeData.data.sheets?.find((s) => s.properties?.title === sheetName);
      if (!sheet || sheet.properties?.sheetId === void 0 || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }
      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId);
      const border = {
        style: a.style,
        width: a.width || 1,
        color: a.color ? {
          red: a.color.red || 0,
          green: a.color.green || 0,
          blue: a.color.blue || 0
        } : void 0
      };
      const updateBordersRequest = {
        updateBorders: {
          range: gridRange
        }
      };
      if (a.top !== false) updateBordersRequest.updateBorders.top = border;
      if (a.bottom !== false) updateBordersRequest.updateBorders.bottom = border;
      if (a.left !== false) updateBordersRequest.updateBorders.left = border;
      if (a.right !== false) updateBordersRequest.updateBorders.right = border;
      if (a.innerHorizontal) updateBordersRequest.updateBorders.innerHorizontal = border;
      if (a.innerVertical) updateBordersRequest.updateBorders.innerVertical = border;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: { requests: [updateBordersRequest] }
      });
      return {
        content: [{ type: "text", text: `Set borders for range ${a.range}` }],
        isError: false
      };
    }
    case "mergeGoogleSheetCells": {
      const validation = MergeGoogleSheetCellsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: "sheets(properties(sheetId,title))"
      });
      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);
      const sheet = rangeData.data.sheets?.find((s) => s.properties?.title === sheetName);
      if (!sheet || sheet.properties?.sheetId === void 0 || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }
      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId);
      const requests = [{
        mergeCells: {
          range: gridRange,
          mergeType: a.mergeType
        }
      }];
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: { requests }
      });
      return {
        content: [{ type: "text", text: `Merged cells in range ${a.range} with type ${a.mergeType}` }],
        isError: false
      };
    }
    case "addGoogleSheetConditionalFormat": {
      const validation = AddGoogleSheetConditionalFormatSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const rangeData = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        ranges: [a.range],
        fields: "sheets(properties(sheetId,title))"
      });
      const { sheetName, cellRange: a1Range } = parseA1Range(a.range);
      const sheet = rangeData.data.sheets?.find((s) => s.properties?.title === sheetName);
      if (!sheet || sheet.properties?.sheetId === void 0 || sheet.properties?.sheetId === null) {
        return errorResponse(`Sheet "${sheetName}" not found`);
      }
      const gridRange = convertA1ToGridRange(a1Range, sheet.properties.sheetId);
      const booleanCondition = {};
      switch (a.condition.type) {
        case "NUMBER_GREATER":
          booleanCondition.type = "NUMBER_GREATER";
          booleanCondition.values = [{ userEnteredValue: a.condition.value }];
          break;
        case "NUMBER_LESS":
          booleanCondition.type = "NUMBER_LESS";
          booleanCondition.values = [{ userEnteredValue: a.condition.value }];
          break;
        case "TEXT_CONTAINS":
          booleanCondition.type = "TEXT_CONTAINS";
          booleanCondition.values = [{ userEnteredValue: a.condition.value }];
          break;
        case "TEXT_STARTS_WITH":
          booleanCondition.type = "TEXT_STARTS_WITH";
          booleanCondition.values = [{ userEnteredValue: a.condition.value }];
          break;
        case "TEXT_ENDS_WITH":
          booleanCondition.type = "TEXT_ENDS_WITH";
          booleanCondition.values = [{ userEnteredValue: a.condition.value }];
          break;
        case "CUSTOM_FORMULA":
          booleanCondition.type = "CUSTOM_FORMULA";
          booleanCondition.values = [{ userEnteredValue: a.condition.value }];
          break;
      }
      const format = {};
      if (a.format.backgroundColor) {
        format.backgroundColor = {
          red: a.format.backgroundColor.red || 0,
          green: a.format.backgroundColor.green || 0,
          blue: a.format.backgroundColor.blue || 0
        };
      }
      if (a.format.textFormat) {
        format.textFormat = {};
        if (a.format.textFormat.bold !== void 0) {
          format.textFormat.bold = a.format.textFormat.bold;
        }
        if (a.format.textFormat.foregroundColor) {
          format.textFormat.foregroundColor = {
            red: a.format.textFormat.foregroundColor.red || 0,
            green: a.format.textFormat.foregroundColor.green || 0,
            blue: a.format.textFormat.foregroundColor.blue || 0
          };
        }
      }
      const requests = [{
        addConditionalFormatRule: {
          rule: {
            ranges: [gridRange],
            booleanRule: {
              condition: booleanCondition,
              format
            }
          },
          index: 0
        }
      }];
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: { requests }
      });
      return {
        content: [{ type: "text", text: `Added conditional formatting to range ${a.range}` }],
        isError: false
      };
    }
    case "getSpreadsheetInfo": {
      const validation = GetSpreadsheetInfoSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const response = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        fields: "spreadsheetId,properties.title,sheets.properties"
      });
      const metadata = response.data;
      let result = `**Spreadsheet Information:**

`;
      result += `**Title:** ${metadata.properties?.title || "Untitled"}
`;
      result += `**ID:** ${metadata.spreadsheetId}
`;
      result += `**URL:** https://docs.google.com/spreadsheets/d/${metadata.spreadsheetId}

`;
      const sheetList = metadata.sheets || [];
      result += `**Sheets (${sheetList.length}):**
`;
      for (let i = 0; i < sheetList.length; i++) {
        const props = sheetList[i].properties;
        result += `${i + 1}. **${props?.title || "Untitled"}**
`;
        result += `   - Sheet ID: ${props?.sheetId}
`;
        result += `   - Grid: ${props?.gridProperties?.rowCount || 0} rows \xD7 ${props?.gridProperties?.columnCount || 0} columns
`;
        if (props?.hidden) {
          result += `   - Status: Hidden
`;
        }
        result += `
`;
      }
      return {
        content: [{ type: "text", text: result }],
        isError: false
      };
    }
    case "appendSpreadsheetRows": {
      const validation = AppendSpreadsheetRowsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId: a.spreadsheetId,
        range: a.range,
        valueInputOption: a.valueInputOption || "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: a.values }
      });
      const updatedCells = response.data.updates?.updatedCells || 0;
      const updatedRows = response.data.updates?.updatedRows || 0;
      const updatedRange = response.data.updates?.updatedRange || a.range;
      return {
        content: [{ type: "text", text: `Successfully appended ${updatedRows} row(s) (${updatedCells} cells) to spreadsheet. Updated range: ${updatedRange}` }],
        isError: false
      };
    }
    case "addSpreadsheetSheet":
    case "addSheet": {
      const isAlias = toolName === "addSheet";
      const validation = isAlias ? AddSheetSchema.safeParse(args) : AddSpreadsheetSheetSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const spreadsheetId = validation.data.spreadsheetId;
      const sheetTitle = isAlias ? validation.data.title : validation.data.sheetTitle;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title: sheetTitle
              }
            }
          }]
        }
      });
      const addedSheet = response.data.replies?.[0]?.addSheet?.properties;
      if (!addedSheet) {
        return errorResponse("Failed to add sheet - no sheet properties returned.");
      }
      return {
        content: [{ type: "text", text: `Successfully added sheet "${addedSheet.title}" (Sheet ID: ${addedSheet.sheetId}) to spreadsheet.` }],
        isError: false
      };
    }
    case "listSheets": {
      const validation = ListSheetsSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const response = await sheets.spreadsheets.get({
        spreadsheetId: a.spreadsheetId,
        fields: "sheets.properties(sheetId,title,index,hidden)"
      });
      const tabs = response.data.sheets || [];
      if (tabs.length === 0) {
        return { content: [{ type: "text", text: "No sheets found." }], isError: false };
      }
      const lines = tabs.map((s) => `- ${s.properties?.title} (id: ${s.properties?.sheetId}, index: ${s.properties?.index}${s.properties?.hidden ? ", hidden" : ""})`);
      return { content: [{ type: "text", text: `Sheets in spreadsheet ${a.spreadsheetId}:
${lines.join("\n")}` }], isError: false };
    }
    case "renameSheet": {
      const validation = RenameSheetSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: {
          requests: [{
            updateSheetProperties: {
              properties: { sheetId: a.sheetId, title: a.newTitle },
              fields: "title"
            }
          }]
        }
      });
      return { content: [{ type: "text", text: `Renamed sheet ${a.sheetId} to "${a.newTitle}".` }], isError: false };
    }
    case "deleteSheet": {
      const validation = DeleteSheetSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: {
          requests: [{
            deleteSheet: { sheetId: a.sheetId }
          }]
        }
      });
      return { content: [{ type: "text", text: `Deleted sheet ${a.sheetId}.` }], isError: false };
    }
    case "addDataValidation": {
      const validation = AddDataValidationSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const gridRange = await resolveGridRange(sheets, a.spreadsheetId, a.range);
      if (typeof gridRange === "string") return errorResponse(gridRange);
      const conditionValues = a.values.map((v) => ({ userEnteredValue: v }));
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: {
          requests: [{
            setDataValidation: {
              range: gridRange,
              rule: {
                condition: {
                  type: a.conditionType,
                  values: conditionValues
                },
                strict: a.strict,
                showCustomUi: a.showCustomUi
              }
            }
          }]
        }
      });
      return { content: [{ type: "text", text: `Added data validation (${a.conditionType}) to ${a.range}.` }], isError: false };
    }
    case "protectRange": {
      const validation = ProtectRangeSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const gridRange = await resolveGridRange(sheets, a.spreadsheetId, a.range);
      if (typeof gridRange === "string") return errorResponse(gridRange);
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: {
          requests: [{
            addProtectedRange: {
              protectedRange: {
                range: gridRange,
                description: a.description,
                warningOnly: a.warningOnly
              }
            }
          }]
        }
      });
      const protectedRangeId = response.data.replies?.[0]?.addProtectedRange?.protectedRange?.protectedRangeId;
      return { content: [{ type: "text", text: `Protected range ${a.range}${protectedRangeId ? ` (id: ${protectedRangeId})` : ""}.` }], isError: false };
    }
    case "addNamedRange": {
      const validation = AddNamedRangeSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const sheets = ctx.google.sheets({ version: "v4", auth: ctx.authClient });
      const gridRange = await resolveGridRange(sheets, a.spreadsheetId, a.range);
      if (typeof gridRange === "string") return errorResponse(gridRange);
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: a.spreadsheetId,
        requestBody: {
          requests: [{
            addNamedRange: {
              namedRange: {
                name: a.name,
                range: gridRange
              }
            }
          }]
        }
      });
      const namedRangeId = response.data.replies?.[0]?.addNamedRange?.namedRange?.namedRangeId;
      return { content: [{ type: "text", text: `Added named range "${a.name}" for ${a.range}${namedRangeId ? ` (id: ${namedRangeId})` : ""}.` }], isError: false };
    }
    case "listGoogleSheets": {
      const validation = ListGoogleSheetsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      let queryString = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
      if (a.query) {
        const escapedQuery = escapeDriveQuery(a.query);
        queryString += ` and (name contains '${escapedQuery}' or fullText contains '${escapedQuery}')`;
      }
      const response = await ctx.getDrive().files.list({
        q: queryString,
        pageSize: a.maxResults || 20,
        orderBy: a.orderBy === "name" ? "name" : a.orderBy,
        fields: "files(id,name,modifiedTime,createdTime,webViewLink,owners(displayName,emailAddress))",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      const files = response.data.files || [];
      if (files.length === 0) {
        return {
          content: [{ type: "text", text: "No Google Spreadsheets found matching your criteria." }],
          isError: false
        };
      }
      let result = `Found ${files.length} Google Spreadsheet(s):

`;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const modifiedDate = file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString() : "Unknown";
        const owner = file.owners?.[0]?.displayName || "Unknown";
        result += `${i + 1}. **${file.name}**
`;
        result += `   ID: ${file.id}
`;
        result += `   Modified: ${modifiedDate}
`;
        result += `   Owner: ${owner}
`;
        result += `   Link: ${file.webViewLink}

`;
      }
      return {
        content: [{ type: "text", text: result }],
        isError: false
      };
    }
    default:
      return null;
  }
}

// src/tools/slides.ts
var slides_exports = {};
__export(slides_exports, {
  handleTool: () => handleTool4,
  toolDefinitions: () => toolDefinitions4
});
import { z as z4 } from "zod";
import { v4 as uuidv4 } from "uuid";
var CreateGoogleSlidesSchema = z4.object({
  name: z4.string().min(1, "Presentation name is required"),
  slides: z4.array(z4.object({
    title: z4.string(),
    content: z4.string()
  })).min(1, "At least one slide is required"),
  parentFolderId: z4.string().optional()
});
var UpdateGoogleSlidesSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  slides: z4.array(z4.object({
    title: z4.string(),
    content: z4.string()
  })).min(1, "At least one slide is required")
});
var GetGoogleSlidesContentSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  slideIndex: z4.number().min(0).optional()
});
var FormatGoogleSlidesTextSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  objectId: z4.string().min(1, "Object ID is required"),
  startIndex: z4.number().min(0).optional(),
  endIndex: z4.number().min(0).optional(),
  bold: z4.boolean().optional(),
  italic: z4.boolean().optional(),
  underline: z4.boolean().optional(),
  strikethrough: z4.boolean().optional(),
  fontSize: z4.number().optional(),
  fontFamily: z4.string().optional(),
  foregroundColor: z4.object({
    red: z4.number().min(0).max(1).optional(),
    green: z4.number().min(0).max(1).optional(),
    blue: z4.number().min(0).max(1).optional()
  }).optional()
});
var FormatGoogleSlidesParagraphSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  objectId: z4.string().min(1, "Object ID is required"),
  alignment: z4.enum(["START", "CENTER", "END", "JUSTIFIED"]).optional(),
  lineSpacing: z4.number().optional(),
  bulletStyle: z4.enum(["NONE", "DISC", "ARROW", "SQUARE", "DIAMOND", "STAR", "NUMBERED"]).optional()
});
var StyleGoogleSlidesShapeSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  objectId: z4.string().min(1, "Shape object ID is required"),
  backgroundColor: z4.object({
    red: z4.number().min(0).max(1).optional(),
    green: z4.number().min(0).max(1).optional(),
    blue: z4.number().min(0).max(1).optional(),
    alpha: z4.number().min(0).max(1).optional()
  }).optional(),
  outlineColor: z4.object({
    red: z4.number().min(0).max(1).optional(),
    green: z4.number().min(0).max(1).optional(),
    blue: z4.number().min(0).max(1).optional()
  }).optional(),
  outlineWeight: z4.number().optional(),
  outlineDashStyle: z4.enum(["SOLID", "DOT", "DASH", "DASH_DOT", "LONG_DASH", "LONG_DASH_DOT"]).optional()
});
var SetGoogleSlidesBackgroundSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  pageObjectIds: z4.array(z4.string()).min(1, "At least one page object ID is required"),
  backgroundColor: z4.object({
    red: z4.number().min(0).max(1).optional(),
    green: z4.number().min(0).max(1).optional(),
    blue: z4.number().min(0).max(1).optional(),
    alpha: z4.number().min(0).max(1).optional()
  })
});
var CreateGoogleSlidesTextBoxSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  pageObjectId: z4.string().min(1, "Page object ID is required"),
  text: z4.string().min(1, "Text content is required"),
  x: z4.number(),
  y: z4.number(),
  width: z4.number(),
  height: z4.number(),
  fontSize: z4.number().optional(),
  bold: z4.boolean().optional(),
  italic: z4.boolean().optional()
});
var CreateGoogleSlidesShapeSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  pageObjectId: z4.string().min(1, "Page object ID is required"),
  shapeType: z4.enum(["RECTANGLE", "ELLIPSE", "DIAMOND", "TRIANGLE", "STAR", "ROUND_RECTANGLE", "ARROW"]),
  x: z4.number(),
  y: z4.number(),
  width: z4.number(),
  height: z4.number(),
  backgroundColor: z4.object({
    red: z4.number().min(0).max(1).optional(),
    green: z4.number().min(0).max(1).optional(),
    blue: z4.number().min(0).max(1).optional(),
    alpha: z4.number().min(0).max(1).optional()
  }).optional()
});
var GetGoogleSlidesSpeakerNotesSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  slideIndex: z4.number().min(0, "Slide index must be non-negative")
});
var UpdateGoogleSlidesSpeakerNotesSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  slideIndex: z4.number().min(0, "Slide index must be non-negative"),
  notes: z4.string()
});
var DeleteGoogleSlideSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  slideObjectId: z4.string().min(1, "Slide object ID is required")
});
var DuplicateSlideSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  slideObjectId: z4.string().min(1, "Slide object ID is required")
});
var ReorderSlidesSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  slideObjectIds: z4.array(z4.string().min(1)).min(1, "At least one slide object ID is required"),
  insertionIndex: z4.number().int().min(0)
});
var ReplaceAllTextInSlidesSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  containsText: z4.string().min(1, "containsText is required"),
  replaceText: z4.string(),
  matchCase: z4.boolean().optional().default(false)
});
var ExportSlideThumbnailSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  slideObjectId: z4.string().min(1, "Slide object ID is required"),
  mimeType: z4.enum(["PNG", "JPEG"]).optional().default("PNG"),
  size: z4.enum(["SMALL", "MEDIUM", "LARGE"]).optional().default("LARGE")
});
var InsertSlidesImageFromUrlSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  pageObjectId: z4.string().min(1, "Slide/page object ID is required"),
  imageUrl: z4.string().url("A valid image URL is required"),
  x: z4.number().optional().default(0),
  y: z4.number().optional().default(0),
  width: z4.number().optional(),
  height: z4.number().optional()
});
var MoveSlideElementSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  objectId: z4.string().min(1, "Element object ID is required"),
  x: z4.number().optional(),
  y: z4.number().optional(),
  width: z4.number().optional(),
  height: z4.number().optional()
});
var DeleteSlideElementSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  objectId: z4.string().min(1, "Element object ID is required")
});
var GetSlideElementInfoSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  slideObjectId: z4.string().optional()
});
var InsertSlidesLocalImageSchema = z4.object({
  presentationId: z4.string().min(1, "Presentation ID is required"),
  pageObjectId: z4.string().min(1, "Slide/page object ID is required"),
  localImagePath: z4.string().min(1, "Local image path is required"),
  x: z4.number().optional().default(0),
  y: z4.number().optional().default(0),
  width: z4.number().optional(),
  height: z4.number().optional()
});
async function insertImageIntoSlide(ctx, presentationId, pageObjectId, imageUrl, x, y, width, height) {
  const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
  const objectId = `img_${uuidv4().substring(0, 8)}`;
  const elementProperties = {
    pageObjectId,
    transform: {
      scaleX: 1,
      scaleY: 1,
      translateX: x,
      translateY: y,
      unit: "EMU"
    }
  };
  if (width != null && height != null) {
    elementProperties.size = {
      width: { magnitude: width, unit: "EMU" },
      height: { magnitude: height, unit: "EMU" }
    };
  }
  await slidesService.presentations.batchUpdate({
    presentationId,
    requestBody: {
      requests: [{
        createImage: { objectId, url: imageUrl, elementProperties }
      }]
    }
  });
  return {
    content: [{ type: "text", text: `Inserted image into slide ${pageObjectId} (objectId: ${objectId})` }],
    isError: false
  };
}
var toolDefinitions4 = [
  {
    name: "createGoogleSlides",
    description: "Create a new Google Slides presentation",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Presentation name" },
        slides: {
          type: "array",
          description: "Array of slide objects",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              content: { type: "string" }
            }
          }
        },
        parentFolderId: { type: "string", description: "Parent folder ID (defaults to root)" }
      },
      required: ["name", "slides"]
    }
  },
  {
    name: "updateGoogleSlides",
    description: "Update an existing Google Slides presentation",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        slides: {
          type: "array",
          description: "Array of slide objects to replace existing slides",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              content: { type: "string" }
            }
          }
        }
      },
      required: ["presentationId", "slides"]
    }
  },
  {
    name: "getGoogleSlidesContent",
    description: "Get content of Google Slides with element IDs for formatting",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        slideIndex: { type: "number", description: "Specific slide index (optional)" }
      },
      required: ["presentationId"]
    }
  },
  {
    name: "formatGoogleSlidesText",
    description: "Apply text formatting to elements in Google Slides",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        objectId: { type: "string", description: "Object ID of the text element" },
        startIndex: { type: "number", description: "Start index (0-based)" },
        endIndex: { type: "number", description: "End index (0-based)" },
        bold: { type: "boolean", description: "Make text bold" },
        italic: { type: "boolean", description: "Make text italic" },
        underline: { type: "boolean", description: "Underline text" },
        strikethrough: { type: "boolean", description: "Strikethrough text" },
        fontSize: { type: "number", description: "Font size in points" },
        fontFamily: { type: "string", description: "Font family name" },
        foregroundColor: {
          type: "object",
          description: "Text color (RGB values 0-1)",
          properties: {
            red: { type: "number" },
            green: { type: "number" },
            blue: { type: "number" }
          }
        }
      },
      required: ["presentationId", "objectId"]
    }
  },
  {
    name: "formatGoogleSlidesParagraph",
    description: "Apply paragraph formatting to text in Google Slides",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        objectId: { type: "string", description: "Object ID of the text element" },
        alignment: {
          type: "string",
          description: "Text alignment",
          enum: ["START", "CENTER", "END", "JUSTIFIED"]
        },
        lineSpacing: { type: "number", description: "Line spacing multiplier" },
        bulletStyle: {
          type: "string",
          description: "Bullet style",
          enum: ["NONE", "DISC", "ARROW", "SQUARE", "DIAMOND", "STAR", "NUMBERED"]
        }
      },
      required: ["presentationId", "objectId"]
    }
  },
  {
    name: "styleGoogleSlidesShape",
    description: "Style shapes in Google Slides",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        objectId: { type: "string", description: "Shape object ID" },
        backgroundColor: {
          type: "object",
          description: "Background color (RGBA values 0-1)",
          properties: {
            red: { type: "number" },
            green: { type: "number" },
            blue: { type: "number" },
            alpha: { type: "number" }
          }
        },
        outlineColor: {
          type: "object",
          description: "Outline color (RGB values 0-1)",
          properties: {
            red: { type: "number" },
            green: { type: "number" },
            blue: { type: "number" }
          }
        },
        outlineWeight: { type: "number", description: "Outline thickness in points" },
        outlineDashStyle: {
          type: "string",
          description: "Outline dash style",
          enum: ["SOLID", "DOT", "DASH", "DASH_DOT", "LONG_DASH", "LONG_DASH_DOT"]
        }
      },
      required: ["presentationId", "objectId"]
    }
  },
  {
    name: "setGoogleSlidesBackground",
    description: "Set background color for slides",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        pageObjectIds: {
          type: "array",
          description: "Array of slide IDs to update",
          items: { type: "string" }
        },
        backgroundColor: {
          type: "object",
          description: "Background color (RGBA values 0-1)",
          properties: {
            red: { type: "number" },
            green: { type: "number" },
            blue: { type: "number" },
            alpha: { type: "number" }
          }
        }
      },
      required: ["presentationId", "pageObjectIds", "backgroundColor"]
    }
  },
  {
    name: "createGoogleSlidesTextBox",
    description: "Create a text box in Google Slides",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        pageObjectId: { type: "string", description: "Slide ID" },
        text: { type: "string", description: "Text content" },
        x: { type: "number", description: "X position in EMU (1/360000 cm)" },
        y: { type: "number", description: "Y position in EMU" },
        width: { type: "number", description: "Width in EMU" },
        height: { type: "number", description: "Height in EMU" },
        fontSize: { type: "number", description: "Font size in points" },
        bold: { type: "boolean", description: "Make text bold" },
        italic: { type: "boolean", description: "Make text italic" }
      },
      required: ["presentationId", "pageObjectId", "text", "x", "y", "width", "height"]
    }
  },
  {
    name: "createGoogleSlidesShape",
    description: "Create a shape in Google Slides",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        pageObjectId: { type: "string", description: "Slide ID" },
        shapeType: {
          type: "string",
          description: "Shape type",
          enum: ["RECTANGLE", "ELLIPSE", "DIAMOND", "TRIANGLE", "STAR", "ROUND_RECTANGLE", "ARROW"]
        },
        x: { type: "number", description: "X position in EMU" },
        y: { type: "number", description: "Y position in EMU" },
        width: { type: "number", description: "Width in EMU" },
        height: { type: "number", description: "Height in EMU" },
        backgroundColor: {
          type: "object",
          description: "Fill color (RGBA values 0-1)",
          properties: {
            red: { type: "number" },
            green: { type: "number" },
            blue: { type: "number" },
            alpha: { type: "number" }
          }
        }
      },
      required: ["presentationId", "pageObjectId", "shapeType", "x", "y", "width", "height"]
    }
  },
  {
    name: "getGoogleSlidesSpeakerNotes",
    description: "Get speaker notes from a specific slide in Google Slides",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        slideIndex: { type: "number", description: "Slide index (0-based)" }
      },
      required: ["presentationId", "slideIndex"]
    }
  },
  {
    name: "updateGoogleSlidesSpeakerNotes",
    description: "Update speaker notes for a specific slide in Google Slides",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        slideIndex: { type: "number", description: "Slide index (0-based)" },
        notes: { type: "string", description: "Speaker notes content" }
      },
      required: ["presentationId", "slideIndex", "notes"]
    }
  },
  {
    name: "deleteGoogleSlide",
    description: "Delete a slide from a presentation",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        slideObjectId: { type: "string", description: "Slide object ID" }
      },
      required: ["presentationId", "slideObjectId"]
    }
  },
  {
    name: "duplicateSlide",
    description: "Duplicate a slide in a presentation",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        slideObjectId: { type: "string", description: "Slide object ID" }
      },
      required: ["presentationId", "slideObjectId"]
    }
  },
  {
    name: "reorderSlides",
    description: "Reorder one or more slides in a presentation",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        slideObjectIds: { type: "array", items: { type: "string" }, description: "Slide object IDs to move" },
        insertionIndex: { type: "number", description: "Target insertion index" }
      },
      required: ["presentationId", "slideObjectIds", "insertionIndex"]
    }
  },
  {
    name: "replaceAllTextInSlides",
    description: "Replace all matching text across presentation slides",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        containsText: { type: "string", description: "Text to find" },
        replaceText: { type: "string", description: "Replacement text" },
        matchCase: { type: "boolean", description: "Case-sensitive match" }
      },
      required: ["presentationId", "containsText", "replaceText"]
    }
  },
  {
    name: "exportSlideThumbnail",
    description: "Export a slide thumbnail URL",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        slideObjectId: { type: "string", description: "Slide object ID" },
        mimeType: { type: "string", enum: ["PNG", "JPEG"], description: "Thumbnail MIME type" },
        size: { type: "string", enum: ["SMALL", "MEDIUM", "LARGE"], description: "Thumbnail size" }
      },
      required: ["presentationId", "slideObjectId"]
    }
  },
  {
    name: "insertSlidesImageFromUrl",
    description: "Insert an image into a Google Slides slide from a publicly accessible URL",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        pageObjectId: { type: "string", description: "Slide/page object ID to insert the image into" },
        imageUrl: { type: "string", description: "Publicly accessible URL of the image" },
        x: { type: "number", description: "X position in EMU (default: 0)" },
        y: { type: "number", description: "Y position in EMU (default: 0)" },
        width: { type: "number", description: "Width in EMU (omit to auto-size)" },
        height: { type: "number", description: "Height in EMU (omit to auto-size)" }
      },
      required: ["presentationId", "pageObjectId", "imageUrl"]
    }
  },
  {
    name: "getSlideElementInfo",
    description: "Get position, size, and transform of all elements on a slide. Returns actual rendered bounds.",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        slideObjectId: { type: "string", description: "Slide object ID (omit to get all slides)" }
      },
      required: ["presentationId"]
    }
  },
  {
    name: "moveSlideElement",
    description: "Move and/or resize an element (image, text box, shape) on a Google Slides slide",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        objectId: { type: "string", description: "Element object ID to move/resize" },
        x: { type: "number", description: "New X position in EMU" },
        y: { type: "number", description: "New Y position in EMU" },
        width: { type: "number", description: "New width in EMU" },
        height: { type: "number", description: "New height in EMU" }
      },
      required: ["presentationId", "objectId"]
    }
  },
  {
    name: "deleteSlideElement",
    description: "Delete an element (image, text box, shape) from a Google Slides slide",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        objectId: { type: "string", description: "Element object ID to delete" }
      },
      required: ["presentationId", "objectId"]
    }
  },
  {
    name: "insertSlidesLocalImage",
    description: "Upload a local image file to Google Drive and insert it into a Google Slides slide",
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Presentation ID" },
        pageObjectId: { type: "string", description: "Slide/page object ID to insert the image into" },
        localImagePath: { type: "string", description: "Absolute path to the local image file" },
        x: { type: "number", description: "X position in EMU (default: 0)" },
        y: { type: "number", description: "Y position in EMU (default: 0)" },
        width: { type: "number", description: "Width in EMU (omit to auto-size)" },
        height: { type: "number", description: "Height in EMU (omit to auto-size)" }
      },
      required: ["presentationId", "pageObjectId", "localImagePath"]
    }
  }
];
async function handleTool4(toolName, args, ctx) {
  switch (toolName) {
    case "createGoogleSlides": {
      const validation = CreateGoogleSlidesSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const parentFolderId = await ctx.resolveFolderId(a.parentFolderId);
      const existingFileId = await ctx.checkFileExists(a.name, parentFolderId);
      if (existingFileId) {
        return errorResponse(
          `A presentation named "${a.name}" already exists in this location. File ID: ${existingFileId}. To modify it, you can use Google Slides directly.`
        );
      }
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const presentation = await slidesService.presentations.create({
        requestBody: { title: a.name }
      });
      await ctx.getDrive().files.update({
        fileId: presentation.data.presentationId,
        addParents: parentFolderId,
        removeParents: "root",
        supportsAllDrives: true
      });
      for (const slide of a.slides) {
        const slideObjectId = `slide_${uuidv4().substring(0, 8)}`;
        await slidesService.presentations.batchUpdate({
          presentationId: presentation.data.presentationId,
          requestBody: {
            requests: [{
              createSlide: {
                objectId: slideObjectId,
                slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" }
              }
            }]
          }
        });
        const slidePage = await slidesService.presentations.pages.get({
          presentationId: presentation.data.presentationId,
          pageObjectId: slideObjectId
        });
        let titlePlaceholderId = "";
        let bodyPlaceholderId = "";
        slidePage.data.pageElements?.forEach((el) => {
          if (el.shape?.placeholder?.type === "TITLE") {
            titlePlaceholderId = el.objectId;
          } else if (el.shape?.placeholder?.type === "BODY") {
            bodyPlaceholderId = el.objectId;
          }
        });
        await slidesService.presentations.batchUpdate({
          presentationId: presentation.data.presentationId,
          requestBody: {
            requests: [
              { insertText: { objectId: titlePlaceholderId, text: slide.title, insertionIndex: 0 } },
              { insertText: { objectId: bodyPlaceholderId, text: slide.content, insertionIndex: 0 } }
            ]
          }
        });
      }
      return {
        content: [{
          type: "text",
          text: `Created Google Slides presentation: ${a.name}
ID: ${presentation.data.presentationId}
Link: https://docs.google.com/presentation/d/${presentation.data.presentationId}`
        }],
        isError: false
      };
    }
    case "updateGoogleSlides": {
      const validation = UpdateGoogleSlidesSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const currentPresentation = await slidesService.presentations.get({
        presentationId: a.presentationId
      });
      if (!currentPresentation.data.slides) {
        return errorResponse("No slides found in presentation");
      }
      const slideIdsToDelete = currentPresentation.data.slides.slice(1).map((slide) => slide.objectId).filter((id) => id !== void 0);
      const requests = [];
      if (slideIdsToDelete.length > 0) {
        slideIdsToDelete.forEach((slideId) => {
          requests.push({
            deleteObject: { objectId: slideId }
          });
        });
      }
      if (a.slides.length === 0) {
        return errorResponse("At least one slide must be provided");
      }
      const firstSlide = currentPresentation.data.slides[0];
      if (firstSlide && firstSlide.pageElements) {
        firstSlide.pageElements.forEach((element) => {
          if (element.objectId && element.shape?.text) {
            requests.push({
              deleteText: {
                objectId: element.objectId,
                textRange: { type: "ALL" }
              }
            });
          }
        });
      }
      const firstSlideContent = a.slides[0];
      if (firstSlide && firstSlide.pageElements) {
        let titlePlaceholderId;
        let bodyPlaceholderId;
        firstSlide.pageElements.forEach((element) => {
          if (element.shape?.placeholder?.type === "TITLE" || element.shape?.placeholder?.type === "CENTERED_TITLE") {
            titlePlaceholderId = element.objectId || void 0;
          } else if (element.shape?.placeholder?.type === "BODY" || element.shape?.placeholder?.type === "SUBTITLE") {
            bodyPlaceholderId = element.objectId || void 0;
          }
        });
        if (titlePlaceholderId) {
          requests.push({
            insertText: {
              objectId: titlePlaceholderId,
              text: firstSlideContent.title,
              insertionIndex: 0
            }
          });
        }
        if (bodyPlaceholderId) {
          requests.push({
            insertText: {
              objectId: bodyPlaceholderId,
              text: firstSlideContent.content,
              insertionIndex: 0
            }
          });
        }
      }
      for (let i = 1; i < a.slides.length; i++) {
        const slideId = `slide_${Date.now()}_${i}`;
        requests.push({
          createSlide: {
            objectId: slideId,
            slideLayoutReference: {
              predefinedLayout: "TITLE_AND_BODY"
            }
          }
        });
      }
      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: { requests }
      });
      if (a.slides.length > 1) {
        const contentRequests = [];
        const updatedPresentation = await slidesService.presentations.get({
          presentationId: a.presentationId
        });
        for (let i = 1; i < a.slides.length && updatedPresentation.data.slides; i++) {
          const slide = a.slides[i];
          const presentationSlide = updatedPresentation.data.slides[i];
          if (presentationSlide && presentationSlide.pageElements) {
            presentationSlide.pageElements.forEach((element) => {
              if (element.objectId) {
                if (element.shape?.placeholder?.type === "TITLE" || element.shape?.placeholder?.type === "CENTERED_TITLE") {
                  contentRequests.push({
                    insertText: {
                      objectId: element.objectId,
                      text: slide.title,
                      insertionIndex: 0
                    }
                  });
                } else if (element.shape?.placeholder?.type === "BODY" || element.shape?.placeholder?.type === "SUBTITLE") {
                  contentRequests.push({
                    insertText: {
                      objectId: element.objectId,
                      text: slide.content,
                      insertionIndex: 0
                    }
                  });
                }
              }
            });
          }
        }
        if (contentRequests.length > 0) {
          await slidesService.presentations.batchUpdate({
            presentationId: a.presentationId,
            requestBody: { requests: contentRequests }
          });
        }
      }
      return {
        content: [{
          type: "text",
          text: `Updated Google Slides presentation with ${a.slides.length} slide(s)
Link: https://docs.google.com/presentation/d/${a.presentationId}`
        }],
        isError: false
      };
    }
    case "getGoogleSlidesContent": {
      const validation = GetGoogleSlidesContentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const presentation = await slidesService.presentations.get({
        presentationId: a.presentationId
      });
      if (!presentation.data.slides) {
        return errorResponse("No slides found in presentation");
      }
      let content = "Presentation content with element IDs:\n\n";
      const slides = a.slideIndex !== void 0 ? [presentation.data.slides[a.slideIndex]] : presentation.data.slides;
      slides.forEach((slide, index) => {
        if (!slide || !slide.objectId) return;
        content += `
Slide ${a.slideIndex ?? index} (ID: ${slide.objectId}):
`;
        content += "----------------------------\n";
        if (slide.pageElements) {
          slide.pageElements.forEach((element) => {
            if (!element.objectId) return;
            if (element.shape?.text) {
              content += `  Text Box (ID: ${element.objectId}):
`;
              const textElements = element.shape.text.textElements || [];
              let text = "";
              textElements.forEach((textElement) => {
                if (textElement.textRun?.content) {
                  text += textElement.textRun.content;
                }
              });
              content += `    "${text.trim()}"
`;
            } else if (element.shape) {
              content += `  Shape (ID: ${element.objectId}): ${element.shape.shapeType || "Unknown"}
`;
            } else if (element.image) {
              content += `  Image (ID: ${element.objectId})
`;
            } else if (element.video) {
              content += `  Video (ID: ${element.objectId})
`;
            } else if (element.table) {
              content += `  Table (ID: ${element.objectId})
`;
            }
          });
        }
      });
      return {
        content: [{ type: "text", text: content }],
        isError: false
      };
    }
    case "formatGoogleSlidesText": {
      const validation = FormatGoogleSlidesTextSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const textStyle = {};
      const fields = [];
      if (a.bold !== void 0) {
        textStyle.bold = a.bold;
        fields.push("bold");
      }
      if (a.italic !== void 0) {
        textStyle.italic = a.italic;
        fields.push("italic");
      }
      if (a.underline !== void 0) {
        textStyle.underline = a.underline;
        fields.push("underline");
      }
      if (a.strikethrough !== void 0) {
        textStyle.strikethrough = a.strikethrough;
        fields.push("strikethrough");
      }
      if (a.fontSize !== void 0) {
        textStyle.fontSize = {
          magnitude: a.fontSize,
          unit: "PT"
        };
        fields.push("fontSize");
      }
      if (a.fontFamily !== void 0) {
        textStyle.fontFamily = a.fontFamily;
        fields.push("fontFamily");
      }
      if (a.foregroundColor) {
        textStyle.foregroundColor = {
          opaqueColor: {
            rgbColor: {
              red: a.foregroundColor.red || 0,
              green: a.foregroundColor.green || 0,
              blue: a.foregroundColor.blue || 0
            }
          }
        };
        fields.push("foregroundColor");
      }
      if (fields.length === 0) {
        return errorResponse("No formatting options specified");
      }
      const updateRequest = {
        updateTextStyle: {
          objectId: a.objectId,
          style: textStyle,
          fields: fields.join(",")
        }
      };
      if (a.startIndex !== void 0 && a.endIndex !== void 0) {
        updateRequest.updateTextStyle.textRange = {
          type: "FIXED_RANGE",
          startIndex: a.startIndex,
          endIndex: a.endIndex
        };
      } else {
        updateRequest.updateTextStyle.textRange = { type: "ALL" };
      }
      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: { requests: [updateRequest] }
      });
      return {
        content: [{ type: "text", text: `Applied text formatting to object ${a.objectId}` }],
        isError: false
      };
    }
    case "formatGoogleSlidesParagraph": {
      const validation = FormatGoogleSlidesParagraphSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const requests = [];
      if (a.alignment) {
        requests.push({
          updateParagraphStyle: {
            objectId: a.objectId,
            style: { alignment: a.alignment },
            fields: "alignment"
          }
        });
      }
      if (a.lineSpacing !== void 0) {
        requests.push({
          updateParagraphStyle: {
            objectId: a.objectId,
            style: { lineSpacing: a.lineSpacing },
            fields: "lineSpacing"
          }
        });
      }
      if (a.bulletStyle) {
        if (a.bulletStyle === "NONE") {
          requests.push({
            deleteParagraphBullets: {
              objectId: a.objectId
            }
          });
        } else if (a.bulletStyle === "NUMBERED") {
          requests.push({
            createParagraphBullets: {
              objectId: a.objectId,
              bulletPreset: "NUMBERED_DIGIT_ALPHA_ROMAN"
            }
          });
        } else {
          requests.push({
            createParagraphBullets: {
              objectId: a.objectId,
              bulletPreset: `BULLET_${a.bulletStyle}_CIRCLE_SQUARE`
            }
          });
        }
      }
      if (requests.length === 0) {
        return errorResponse("No formatting options specified");
      }
      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: { requests }
      });
      return {
        content: [{ type: "text", text: `Applied paragraph formatting to object ${a.objectId}` }],
        isError: false
      };
    }
    case "styleGoogleSlidesShape": {
      const validation = StyleGoogleSlidesShapeSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const shapeProperties = {};
      const fields = [];
      if (a.backgroundColor) {
        shapeProperties.shapeBackgroundFill = {
          solidFill: {
            color: {
              rgbColor: {
                red: a.backgroundColor.red || 0,
                green: a.backgroundColor.green || 0,
                blue: a.backgroundColor.blue || 0
              }
            },
            alpha: a.backgroundColor.alpha || 1
          }
        };
        fields.push("shapeBackgroundFill");
      }
      const outline = {};
      let hasOutlineChanges = false;
      if (a.outlineColor) {
        outline.outlineFill = {
          solidFill: {
            color: {
              rgbColor: {
                red: a.outlineColor.red || 0,
                green: a.outlineColor.green || 0,
                blue: a.outlineColor.blue || 0
              }
            }
          }
        };
        hasOutlineChanges = true;
      }
      if (a.outlineWeight !== void 0) {
        outline.weight = {
          magnitude: a.outlineWeight,
          unit: "PT"
        };
        hasOutlineChanges = true;
      }
      if (a.outlineDashStyle !== void 0) {
        outline.dashStyle = a.outlineDashStyle;
        hasOutlineChanges = true;
      }
      if (hasOutlineChanges) {
        shapeProperties.outline = outline;
        fields.push("outline");
      }
      if (fields.length === 0) {
        return errorResponse("No styling options specified");
      }
      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: {
          requests: [{
            updateShapeProperties: {
              objectId: a.objectId,
              shapeProperties,
              fields: fields.join(",")
            }
          }]
        }
      });
      return {
        content: [{ type: "text", text: `Applied styling to shape ${a.objectId}` }],
        isError: false
      };
    }
    case "setGoogleSlidesBackground": {
      const validation = SetGoogleSlidesBackgroundSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const requests = a.pageObjectIds.map((pageObjectId) => ({
        updatePageProperties: {
          objectId: pageObjectId,
          pageProperties: {
            pageBackgroundFill: {
              solidFill: {
                color: {
                  rgbColor: {
                    red: a.backgroundColor.red || 0,
                    green: a.backgroundColor.green || 0,
                    blue: a.backgroundColor.blue || 0
                  }
                },
                alpha: a.backgroundColor.alpha || 1
              }
            }
          },
          fields: "pageBackgroundFill"
        }
      }));
      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: { requests }
      });
      return {
        content: [{ type: "text", text: `Set background color for ${a.pageObjectIds.length} slide(s)` }],
        isError: false
      };
    }
    case "createGoogleSlidesTextBox": {
      const validation = CreateGoogleSlidesTextBoxSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const elementId = `textBox_${uuidv4().substring(0, 8)}`;
      const requests = [
        {
          createShape: {
            objectId: elementId,
            shapeType: "TEXT_BOX",
            elementProperties: {
              pageObjectId: a.pageObjectId,
              size: {
                width: { magnitude: a.width, unit: "EMU" },
                height: { magnitude: a.height, unit: "EMU" }
              },
              transform: {
                scaleX: 1,
                scaleY: 1,
                translateX: a.x,
                translateY: a.y,
                unit: "EMU"
              }
            }
          }
        },
        {
          insertText: {
            objectId: elementId,
            text: a.text,
            insertionIndex: 0
          }
        }
      ];
      if (a.fontSize || a.bold || a.italic) {
        const textStyle = {};
        const fields = [];
        if (a.fontSize) {
          textStyle.fontSize = {
            magnitude: a.fontSize,
            unit: "PT"
          };
          fields.push("fontSize");
        }
        if (a.bold !== void 0) {
          textStyle.bold = a.bold;
          fields.push("bold");
        }
        if (a.italic !== void 0) {
          textStyle.italic = a.italic;
          fields.push("italic");
        }
        if (fields.length > 0) {
          requests.push({
            updateTextStyle: {
              objectId: elementId,
              style: textStyle,
              fields: fields.join(","),
              textRange: { type: "ALL" }
            }
          });
        }
      }
      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: { requests }
      });
      return {
        content: [{ type: "text", text: `Created text box with ID: ${elementId}` }],
        isError: false
      };
    }
    case "createGoogleSlidesShape": {
      const validation = CreateGoogleSlidesShapeSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const elementId = `shape_${uuidv4().substring(0, 8)}`;
      const createRequest = {
        createShape: {
          objectId: elementId,
          shapeType: a.shapeType,
          elementProperties: {
            pageObjectId: a.pageObjectId,
            size: {
              width: { magnitude: a.width, unit: "EMU" },
              height: { magnitude: a.height, unit: "EMU" }
            },
            transform: {
              scaleX: 1,
              scaleY: 1,
              translateX: a.x,
              translateY: a.y,
              unit: "EMU"
            }
          }
        }
      };
      const requests = [createRequest];
      if (a.backgroundColor) {
        requests.push({
          updateShapeProperties: {
            objectId: elementId,
            shapeProperties: {
              shapeBackgroundFill: {
                solidFill: {
                  color: {
                    rgbColor: {
                      red: a.backgroundColor.red || 0,
                      green: a.backgroundColor.green || 0,
                      blue: a.backgroundColor.blue || 0
                    }
                  },
                  alpha: a.backgroundColor.alpha || 1
                }
              }
            },
            fields: "shapeBackgroundFill"
          }
        });
      }
      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: { requests }
      });
      return {
        content: [{ type: "text", text: `Created ${a.shapeType} shape with ID: ${elementId}` }],
        isError: false
      };
    }
    case "getGoogleSlidesSpeakerNotes": {
      const validation = GetGoogleSlidesSpeakerNotesSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const presentation = await slidesService.presentations.get({
        presentationId: a.presentationId
      });
      if (!presentation.data.slides || a.slideIndex >= presentation.data.slides.length) {
        return errorResponse(`Slide index ${a.slideIndex} not found in presentation (has ${presentation.data.slides?.length ?? 0} slides)`);
      }
      const slide = presentation.data.slides[a.slideIndex];
      const notesObjectId = slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
      if (!notesObjectId) {
        return {
          content: [{ type: "text", text: "No speaker notes found for this slide" }],
          isError: false
        };
      }
      const notesPageObjectId = slide.slideProperties?.notesPage?.objectId;
      if (!notesPageObjectId) {
        return {
          content: [{ type: "text", text: "No speaker notes found for this slide" }],
          isError: false
        };
      }
      const notesPage = presentation.data.slides?.[a.slideIndex]?.slideProperties?.notesPage;
      if (!notesPage || !notesPage.pageElements) {
        return {
          content: [{ type: "text", text: "No speaker notes found for this slide" }],
          isError: false
        };
      }
      const speakerNotesElement = notesPage.pageElements.find(
        (element) => element.objectId === notesObjectId
      );
      if (!speakerNotesElement || !speakerNotesElement.shape?.text) {
        return {
          content: [{ type: "text", text: "No speaker notes found for this slide" }],
          isError: false
        };
      }
      let notesText = "";
      const textElements = speakerNotesElement.shape.text.textElements || [];
      textElements.forEach((textElement) => {
        if (textElement.textRun?.content) {
          notesText += textElement.textRun.content;
        }
      });
      return {
        content: [{ type: "text", text: notesText.trim() || "No speaker notes found for this slide" }],
        isError: false
      };
    }
    case "updateGoogleSlidesSpeakerNotes": {
      const validation = UpdateGoogleSlidesSpeakerNotesSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const presentation = await slidesService.presentations.get({
        presentationId: a.presentationId
      });
      if (!presentation.data.slides || a.slideIndex >= presentation.data.slides.length) {
        return errorResponse(`Slide index ${a.slideIndex} not found in presentation (has ${presentation.data.slides?.length ?? 0} slides)`);
      }
      const slide = presentation.data.slides[a.slideIndex];
      const notesObjectId = slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
      if (!notesObjectId) {
        return errorResponse("This slide does not have a speaker notes object. Speaker notes may need to be initialized manually in Google Slides first.");
      }
      const notesPage = slide.slideProperties?.notesPage;
      const speakerNotesShape = notesPage?.pageElements?.find(
        (el) => el.objectId === notesObjectId
      );
      const existingTextElements = speakerNotesShape?.shape?.text?.textElements || [];
      const hasExistingText = existingTextElements.some(
        (el) => el.textRun?.content
      );
      const requests = [];
      if (hasExistingText) {
        requests.push({ deleteText: { objectId: notesObjectId, textRange: { type: "ALL" } } });
      }
      requests.push({ insertText: { objectId: notesObjectId, text: a.notes, insertionIndex: 0 } });
      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: { requests }
      });
      return {
        content: [{ type: "text", text: `Successfully updated speaker notes for slide ${a.slideIndex}` }],
        isError: false
      };
    }
    case "deleteGoogleSlide": {
      const validation = DeleteGoogleSlideSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: {
          requests: [{ deleteObject: { objectId: a.slideObjectId } }]
        }
      });
      return {
        content: [{ type: "text", text: `Deleted slide ${a.slideObjectId}` }],
        isError: false
      };
    }
    case "duplicateSlide": {
      const validation = DuplicateSlideSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const response = await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: {
          requests: [{ duplicateObject: { objectId: a.slideObjectId } }]
        }
      });
      const dupId = response.data.replies?.[0]?.duplicateObject?.objectId;
      return {
        content: [{ type: "text", text: `Duplicated slide ${a.slideObjectId}${dupId ? ` -> ${dupId}` : ""}` }],
        isError: false
      };
    }
    case "reorderSlides": {
      const validation = ReorderSlidesSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: {
          requests: [{
            updateSlidesPosition: {
              slideObjectIds: a.slideObjectIds,
              insertionIndex: a.insertionIndex
            }
          }]
        }
      });
      return {
        content: [{ type: "text", text: `Reordered ${a.slideObjectIds.length} slide(s) to index ${a.insertionIndex}` }],
        isError: false
      };
    }
    case "replaceAllTextInSlides": {
      const validation = ReplaceAllTextInSlidesSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const response = await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: {
          requests: [{
            replaceAllText: {
              containsText: {
                text: a.containsText,
                matchCase: a.matchCase
              },
              replaceText: a.replaceText
            }
          }]
        }
      });
      const count = response.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
      return {
        content: [{ type: "text", text: `Replaced ${count} occurrence(s) of "${a.containsText}" in slides.` }],
        isError: false
      };
    }
    case "exportSlideThumbnail": {
      const validation = ExportSlideThumbnailSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const response = await slidesService.presentations.pages.getThumbnail({
        presentationId: a.presentationId,
        pageObjectId: a.slideObjectId,
        "thumbnailProperties.mimeType": a.mimeType,
        "thumbnailProperties.thumbnailSize": a.size
      });
      const url = response.data?.contentUrl;
      if (!url) return errorResponse("No thumbnail URL returned by Google Slides API.");
      return {
        content: [{ type: "text", text: `Slide thumbnail URL (${a.mimeType}, ${a.size}): ${url}` }],
        isError: false
      };
    }
    case "getSlideElementInfo": {
      const validation = GetSlideElementInfoSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const sizeOnly = await slidesService.presentations.get({
        presentationId: a.presentationId,
        fields: "pageSize"
      });
      const slideWidth = sizeOnly.data.pageSize?.width?.magnitude || 9144e3;
      const slideHeight = sizeOnly.data.pageSize?.height?.magnitude || 6858e3;
      let slides = [];
      if (a.slideObjectId) {
        const page = await slidesService.presentations.pages.get({
          presentationId: a.presentationId,
          pageObjectId: a.slideObjectId,
          fields: "objectId,pageElements(objectId,transform,size,shape/shapeType,image)"
        });
        slides = [page.data];
      } else {
        const withSlides = await slidesService.presentations.get({
          presentationId: a.presentationId,
          fields: "slides(objectId,pageElements(objectId,transform,size,shape/shapeType,image))"
        });
        slides = withSlides.data.slides || [];
      }
      const lines = [`Slide dimensions: ${slideWidth} x ${slideHeight} EMU`];
      for (const slide of slides) {
        lines.push(`
--- Slide: ${slide.objectId} ---`);
        for (const el of slide.pageElements || []) {
          const t = el.transform || {};
          const s = el.size || {};
          const intrW = s.width?.magnitude || 0;
          const intrH = s.height?.magnitude || 0;
          const scX = t.scaleX || 1;
          const scY = t.scaleY || 1;
          const tx = t.translateX || 0;
          const ty = t.translateY || 0;
          const renderedW = intrW * scX;
          const renderedH = intrH * scY;
          const right = tx + renderedW;
          const bottom = ty + renderedH;
          const offPage = tx < 0 || ty < 0 || right > slideWidth || bottom > slideHeight ? " *** OFF PAGE ***" : "";
          lines.push(`  ${el.objectId} (${el.shape ? "shape:" + el.shape.shapeType : el.image ? "image" : "other"})`);
          lines.push(`    intrinsic: ${intrW} x ${intrH}, scale: ${scX} x ${scY}`);
          lines.push(`    rendered: ${Math.round(renderedW)} x ${Math.round(renderedH)} at (${tx}, ${ty})`);
          lines.push(`    bounds: right=${Math.round(right)}, bottom=${Math.round(bottom)}${offPage}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
    }
    case "moveSlideElement": {
      const validation = MoveSlideElementSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      const pres = await slidesService.presentations.get({
        presentationId: a.presentationId,
        fields: "slides(pageElements(objectId,transform,size))"
      });
      let currentTransform = null;
      let currentSize = null;
      for (const slide of pres.data.slides || []) {
        for (const el of slide.pageElements || []) {
          if (el.objectId === a.objectId) {
            currentTransform = el.transform || null;
            currentSize = el.size || null;
            break;
          }
        }
        if (currentTransform) break;
      }
      if (!currentTransform) {
        return errorResponse(`Element ${a.objectId} not found in presentation`);
      }
      const origWidth = currentSize?.width?.magnitude || 3e6;
      const origHeight = currentSize?.height?.magnitude || 3e6;
      const curScaleX = currentTransform.scaleX || 1;
      const curScaleY = currentTransform.scaleY || 1;
      const newScaleX = a.width !== void 0 ? a.width / origWidth : curScaleX;
      const newScaleY = a.height !== void 0 ? a.height / origHeight : curScaleY;
      const newX = a.x ?? (currentTransform.translateX || 0);
      const newY = a.y ?? (currentTransform.translateY || 0);
      const newTransform = {
        scaleX: newScaleX,
        scaleY: newScaleY,
        translateX: newX,
        translateY: newY,
        shearX: currentTransform.shearX || 0,
        shearY: currentTransform.shearY || 0,
        unit: "EMU"
      };
      const requests = [{
        updatePageElementTransform: {
          objectId: a.objectId,
          applyMode: "ABSOLUTE",
          transform: newTransform
        }
      }];
      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: { requests }
      });
      const didResize = a.width !== void 0 || a.height !== void 0;
      const action = didResize ? "Moved/resized" : "Moved";
      return {
        content: [{ type: "text", text: `${action} element ${a.objectId} to (${newX}, ${newY})` }],
        isError: false
      };
    }
    case "deleteSlideElement": {
      const validation = DeleteSlideElementSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const slidesService = ctx.google.slides({ version: "v1", auth: ctx.authClient });
      await slidesService.presentations.batchUpdate({
        presentationId: a.presentationId,
        requestBody: {
          requests: [{ deleteObject: { objectId: a.objectId } }]
        }
      });
      return {
        content: [{ type: "text", text: `Deleted element ${a.objectId}` }],
        isError: false
      };
    }
    case "insertSlidesImageFromUrl": {
      const validation = InsertSlidesImageFromUrlSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      return insertImageIntoSlide(ctx, a.presentationId, a.pageObjectId, a.imageUrl, a.x, a.y, a.width, a.height);
    }
    case "insertSlidesLocalImage": {
      const validation = InsertSlidesLocalImageSchema.safeParse(args);
      if (!validation.success) return errorResponse(validation.error.errors[0].message);
      const a = validation.data;
      const { fileId, webContentLink } = await uploadImageToDrive(ctx, a.localImagePath, {
        makePublic: true
      });
      try {
        const result = await insertImageIntoSlide(
          ctx,
          a.presentationId,
          a.pageObjectId,
          webContentLink,
          a.x,
          a.y,
          a.width,
          a.height
        );
        await deleteDriveFile(ctx, fileId).catch(
          (err) => ctx.log(`insertSlidesLocalImage: failed to delete intermediary Drive file ${fileId}`, err)
        );
        return result;
      } catch (err) {
        await deleteDriveFile(ctx, fileId).catch(() => {
        });
        throw err;
      }
    }
    default:
      return null;
  }
}

// src/tools/calendar.ts
var calendar_exports = {};
__export(calendar_exports, {
  handleTool: () => handleTool5,
  toolDefinitions: () => toolDefinitions5
});
import { z as z5 } from "zod";
function formatCalendarEvent(event) {
  const result = {
    id: event.id || "",
    summary: event.summary,
    description: event.description,
    location: event.location,
    status: event.status,
    htmlLink: event.htmlLink,
    created: event.created,
    updated: event.updated
  };
  if (event.start) {
    result.start = {
      dateTime: event.start.dateTime,
      date: event.start.date,
      timeZone: event.start.timeZone
    };
  }
  if (event.end) {
    result.end = {
      dateTime: event.end.dateTime,
      date: event.end.date,
      timeZone: event.end.timeZone
    };
  }
  if (event.hangoutLink) {
    result.hangoutLink = event.hangoutLink;
  }
  if (event.conferenceData?.entryPoints) {
    const videoEntry = event.conferenceData.entryPoints.find((ep) => ep.entryPointType === "video");
    if (videoEntry?.uri) {
      result.meetingLink = videoEntry.uri;
    }
  }
  if (event.attendees) {
    result.attendees = event.attendees.map((a) => ({
      email: a.email || "",
      displayName: a.displayName,
      responseStatus: a.responseStatus
    }));
  }
  if (event.organizer) {
    result.organizer = {
      email: event.organizer.email,
      displayName: event.organizer.displayName
    };
  }
  if (event.recurrence) {
    result.recurrence = event.recurrence;
  }
  return result;
}
function formatEventForDisplay(event) {
  const lines = [];
  lines.push(`**${event.summary || "(No title)"}**`);
  if (event.start) {
    const startStr = event.start.dateTime || event.start.date || "";
    const endStr = event.end?.dateTime || event.end?.date || "";
    if (event.start.date) {
      lines.push(`Date: ${startStr}${endStr && endStr !== startStr ? ` - ${endStr}` : ""}`);
    } else {
      lines.push(`Time: ${startStr} - ${endStr}`);
    }
  }
  if (event.location) lines.push(`Location: ${event.location}`);
  if (event.description) lines.push(`Description: ${event.description}`);
  if (event.hangoutLink || event.meetingLink) {
    lines.push(`Meeting: ${event.meetingLink || event.hangoutLink}`);
  }
  if (event.attendees && event.attendees.length > 0) {
    lines.push(`Attendees: ${event.attendees.map((a) => a.email).join(", ")}`);
  }
  if (event.htmlLink) lines.push(`Link: ${event.htmlLink}`);
  lines.push(`Event ID: ${event.id}`);
  return lines.join("\n");
}
var ListCalendarsSchema = z5.object({
  showHidden: z5.boolean().optional().default(false).describe("Include hidden calendars")
});
var GetCalendarEventsSchema = z5.object({
  calendarId: z5.string().optional().default("primary").describe("Calendar ID (default: primary)"),
  timeMin: z5.string().optional().describe("Start of time range (RFC3339, e.g., '2024-01-01T00:00:00Z')"),
  timeMax: z5.string().optional().describe("End of time range (RFC3339)"),
  query: z5.string().optional().describe("Free text search in events"),
  maxResults: z5.number().int().min(1).max(250).optional().default(50).describe("Maximum events to return (1-250)"),
  singleEvents: z5.boolean().optional().default(true).describe("Expand recurring events into instances"),
  orderBy: z5.enum(["startTime", "updated"]).optional().default("startTime").describe("Sort order")
});
var GetCalendarEventSchema = z5.object({
  eventId: z5.string().min(1, "Event ID is required"),
  calendarId: z5.string().optional().default("primary").describe("Calendar ID (default: primary)")
});
var CreateCalendarEventSchema = z5.object({
  summary: z5.string().min(1, "Event title is required"),
  calendarId: z5.string().optional().default("primary").describe("Calendar ID (default: primary)"),
  description: z5.string().optional().describe("Event description"),
  location: z5.string().optional().describe("Event location"),
  start: z5.object({
    dateTime: z5.string().optional().describe("RFC3339 timestamp for timed events"),
    date: z5.string().optional().describe("Date for all-day events (YYYY-MM-DD)"),
    timeZone: z5.string().optional().describe("Time zone (e.g., 'America/Los_Angeles')")
  }).describe("Start time"),
  end: z5.object({
    dateTime: z5.string().optional().describe("RFC3339 timestamp for timed events"),
    date: z5.string().optional().describe("Date for all-day events (YYYY-MM-DD)"),
    timeZone: z5.string().optional().describe("Time zone (e.g., 'America/Los_Angeles')")
  }).describe("End time"),
  attendees: z5.array(z5.string()).optional().describe("Email addresses of attendees"),
  sendUpdates: z5.enum(["all", "externalOnly", "none"]).optional().default("none").describe("Send notifications to attendees (default: none)"),
  conferenceType: z5.enum(["hangoutsMeet"]).optional().describe("Add Google Meet link"),
  recurrence: z5.array(z5.string()).optional().describe("RRULE strings for recurring events"),
  visibility: z5.enum(["default", "public", "private", "confidential"]).optional().describe("Event visibility")
});
var UpdateCalendarEventSchema = z5.object({
  eventId: z5.string().min(1, "Event ID is required"),
  calendarId: z5.string().optional().default("primary").describe("Calendar ID (default: primary)"),
  summary: z5.string().optional().describe("New event title"),
  description: z5.string().optional().describe("New event description"),
  location: z5.string().optional().describe("New event location"),
  start: z5.object({
    dateTime: z5.string().optional(),
    date: z5.string().optional(),
    timeZone: z5.string().optional()
  }).optional().describe("New start time"),
  end: z5.object({
    dateTime: z5.string().optional(),
    date: z5.string().optional(),
    timeZone: z5.string().optional()
  }).optional().describe("New end time"),
  attendees: z5.array(z5.string()).optional().describe("Updated attendee emails (replaces existing)"),
  sendUpdates: z5.enum(["all", "externalOnly", "none"]).optional().default("none").describe("Send notifications about the update (default: none)")
});
var DeleteCalendarEventSchema = z5.object({
  eventId: z5.string().min(1, "Event ID is required"),
  calendarId: z5.string().optional().default("primary").describe("Calendar ID (default: primary)"),
  sendUpdates: z5.enum(["all", "externalOnly", "none"]).optional().default("none").describe("Send cancellation notifications to attendees (default: none)")
});
var toolDefinitions5 = [
  {
    name: "listCalendars",
    description: "List all accessible Google Calendars for the authenticated user",
    inputSchema: {
      type: "object",
      properties: {
        showHidden: { type: "boolean", description: "Include hidden calendars (default: false)" }
      }
    }
  },
  {
    name: "getCalendarEvents",
    description: "Get events from a Google Calendar with optional filtering",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar ID (default: primary)" },
        timeMin: { type: "string", description: "Start of time range (RFC3339, e.g., '2024-01-01T00:00:00Z')" },
        timeMax: { type: "string", description: "End of time range (RFC3339)" },
        query: { type: "string", description: "Free text search in events" },
        maxResults: { type: "number", description: "Maximum events to return (1-250, default: 50)" },
        singleEvents: { type: "boolean", description: "Expand recurring events into instances (default: true)" },
        orderBy: { type: "string", enum: ["startTime", "updated"], description: "Sort order (default: startTime)" }
      }
    }
  },
  {
    name: "getCalendarEvent",
    description: "Get a single calendar event by ID",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "The event ID to retrieve" },
        calendarId: { type: "string", description: "Calendar ID (default: primary)" }
      },
      required: ["eventId"]
    }
  },
  {
    name: "createCalendarEvent",
    description: "Create a new calendar event. Supports timed events, all-day events, and Google Meet integration.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title" },
        calendarId: { type: "string", description: "Calendar ID (default: primary)" },
        description: { type: "string", description: "Event description" },
        location: { type: "string", description: "Event location" },
        start: {
          type: "object",
          description: "Start time (use dateTime for timed events, date for all-day)",
          properties: {
            dateTime: { type: "string", description: "RFC3339 timestamp (e.g., '2024-01-15T09:00:00-08:00')" },
            date: { type: "string", description: "Date for all-day events (YYYY-MM-DD)" },
            timeZone: { type: "string", description: "Time zone (e.g., 'America/Los_Angeles')" }
          }
        },
        end: {
          type: "object",
          description: "End time",
          properties: {
            dateTime: { type: "string" },
            date: { type: "string" },
            timeZone: { type: "string" }
          }
        },
        attendees: { type: "array", items: { type: "string" }, description: "Email addresses of attendees" },
        sendUpdates: { type: "string", enum: ["all", "externalOnly", "none"], description: "Send notifications (default: none)" },
        conferenceType: { type: "string", enum: ["hangoutsMeet"], description: "Add Google Meet link" },
        recurrence: { type: "array", items: { type: "string" }, description: "RRULE strings for recurring events" },
        visibility: { type: "string", enum: ["default", "public", "private", "confidential"], description: "Event visibility" }
      },
      required: ["summary", "start", "end"]
    }
  },
  {
    name: "updateCalendarEvent",
    description: "Update an existing calendar event",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "The event ID to update" },
        calendarId: { type: "string", description: "Calendar ID (default: primary)" },
        summary: { type: "string", description: "New event title" },
        description: { type: "string", description: "New event description" },
        location: { type: "string", description: "New event location" },
        start: {
          type: "object",
          properties: {
            dateTime: { type: "string" },
            date: { type: "string" },
            timeZone: { type: "string" }
          }
        },
        end: {
          type: "object",
          properties: {
            dateTime: { type: "string" },
            date: { type: "string" },
            timeZone: { type: "string" }
          }
        },
        attendees: { type: "array", items: { type: "string" }, description: "Updated attendee emails (replaces existing)" },
        sendUpdates: { type: "string", enum: ["all", "externalOnly", "none"], description: "Send notifications (default: none)" }
      },
      required: ["eventId"]
    }
  },
  {
    name: "deleteCalendarEvent",
    description: "Delete a calendar event",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "The event ID to delete" },
        calendarId: { type: "string", description: "Calendar ID (default: primary)" },
        sendUpdates: { type: "string", enum: ["all", "externalOnly", "none"], description: "Send cancellation notifications (default: none)" }
      },
      required: ["eventId"]
    }
  }
];
async function handleTool5(toolName, args, ctx) {
  switch (toolName) {
    case "listCalendars": {
      const validation = ListCalendarsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const parsed = validation.data;
      const response = await ctx.getCalendar().calendarList.list({
        showHidden: parsed.showHidden,
        maxResults: 250
      });
      const calendars = response.data.items || [];
      if (calendars.length === 0) {
        return { content: [{ type: "text", text: "No calendars found." }], isError: false };
      }
      const lines = calendars.map((cal) => {
        const primary = cal.primary ? " (PRIMARY)" : "";
        const role = cal.accessRole ? ` [${cal.accessRole}]` : "";
        return `- ${cal.summary}${primary}${role}
  ID: ${cal.id}`;
      });
      return {
        content: [{ type: "text", text: `Found ${calendars.length} calendar(s):

${lines.join("\n\n")}` }],
        isError: false
      };
    }
    case "getCalendarEvents": {
      const validation = GetCalendarEventsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const parsed = validation.data;
      const params = {
        calendarId: parsed.calendarId || "primary",
        maxResults: parsed.maxResults || 50,
        singleEvents: parsed.singleEvents !== false,
        orderBy: parsed.orderBy || "startTime"
      };
      if (parsed.timeMin) params.timeMin = parsed.timeMin;
      if (parsed.timeMax) params.timeMax = parsed.timeMax;
      if (parsed.query) params.q = parsed.query;
      const response = await ctx.getCalendar().events.list(params);
      const events = response.data.items || [];
      if (events.length === 0) {
        return { content: [{ type: "text", text: "No events found." }], isError: false };
      }
      const formattedEvents = events.map((e) => formatEventForDisplay(formatCalendarEvent(e)));
      return {
        content: [{ type: "text", text: `Found ${events.length} event(s):

${formattedEvents.join("\n\n---\n\n")}` }],
        isError: false
      };
    }
    case "getCalendarEvent": {
      const validation = GetCalendarEventSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const parsed = validation.data;
      const response = await ctx.getCalendar().events.get({
        calendarId: parsed.calendarId || "primary",
        eventId: parsed.eventId
      });
      const formatted = formatEventForDisplay(formatCalendarEvent(response.data));
      return {
        content: [{ type: "text", text: formatted }],
        isError: false
      };
    }
    case "createCalendarEvent": {
      const validation = CreateCalendarEventSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const parsed = validation.data;
      const eventResource = {
        summary: parsed.summary,
        description: parsed.description,
        location: parsed.location,
        start: parsed.start,
        end: parsed.end,
        visibility: parsed.visibility
      };
      if (parsed.attendees && parsed.attendees.length > 0) {
        eventResource.attendees = parsed.attendees.map((email) => ({ email }));
      }
      if (parsed.recurrence) {
        eventResource.recurrence = parsed.recurrence;
      }
      let conferenceDataVersion = 0;
      if (parsed.conferenceType === "hangoutsMeet") {
        eventResource.conferenceData = {
          createRequest: {
            requestId: `meet-${Date.now()}`,
            conferenceSolutionKey: { type: "hangoutsMeet" }
          }
        };
        conferenceDataVersion = 1;
      }
      const insertParams = {
        calendarId: parsed.calendarId || "primary",
        requestBody: eventResource,
        sendUpdates: parsed.sendUpdates
      };
      if (conferenceDataVersion > 0) {
        insertParams.conferenceDataVersion = conferenceDataVersion;
      }
      const response = await ctx.getCalendar().events.insert(insertParams);
      const created = formatCalendarEvent(response.data);
      return {
        content: [{ type: "text", text: `Event created successfully!

${formatEventForDisplay(created)}` }],
        isError: false
      };
    }
    case "updateCalendarEvent": {
      const validation = UpdateCalendarEventSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const parsed = validation.data;
      const existingResponse = await ctx.getCalendar().events.get({
        calendarId: parsed.calendarId || "primary",
        eventId: parsed.eventId
      });
      const existing = existingResponse.data;
      const eventResource = buildCalendarEventUpdate(existing, parsed);
      const response = await ctx.getCalendar().events.update({
        calendarId: parsed.calendarId || "primary",
        eventId: parsed.eventId,
        requestBody: eventResource,
        sendUpdates: parsed.sendUpdates
      });
      const updated = formatCalendarEvent(response.data);
      return {
        content: [{ type: "text", text: `Event updated successfully!

${formatEventForDisplay(updated)}` }],
        isError: false
      };
    }
    case "deleteCalendarEvent": {
      const validation = DeleteCalendarEventSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const parsed = validation.data;
      await ctx.getCalendar().events.delete({
        calendarId: parsed.calendarId || "primary",
        eventId: parsed.eventId,
        sendUpdates: parsed.sendUpdates
      });
      return {
        content: [{ type: "text", text: `Event ${parsed.eventId} has been deleted.` }],
        isError: false
      };
    }
    default:
      return null;
  }
}

// src/index.ts
var _drive = null;
var _calendar = null;
var _lastAuthClient = null;
function getDrive() {
  if (!authClient) throw new Error("Authentication required");
  if (_drive && _lastAuthClient === authClient) return _drive;
  _drive = google.drive({ version: "v3", auth: authClient });
  log("Drive service created");
  return _drive;
}
function getCalendar() {
  if (!authClient) throw new Error("Authentication required");
  if (_calendar && _lastAuthClient === authClient) return _calendar;
  _calendar = google.calendar({ version: "v3", auth: authClient });
  log("Calendar service created");
  return _calendar;
}
var FOLDER_MIME_TYPE2 = "application/vnd.google-apps.folder";
var authClient = null;
var authenticationPromise = null;
var __filename = fileURLToPath2(import.meta.url);
var __dirname = dirname4(__filename);
var packageJsonPath = join4(__dirname, "..", "package.json");
var packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
var VERSION = packageJson.version;
var runtimeConfig = loadRuntimeConfig();
log("Runtime config:", runtimeConfig);
function log(message, data) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const logMessage = data ? `[${timestamp}] ${message}: ${JSON.stringify(data)}` : `[${timestamp}] ${message}`;
  console.error(logMessage);
}
async function resolvePath(pathStr) {
  if (!pathStr || pathStr === "/") return "root";
  const parts = pathStr.replace(/^\/+|\/+$/g, "").split("/");
  let currentFolderId = "root";
  for (const part of parts) {
    if (!part) continue;
    const escapedPart = escapeDriveQuery(part);
    const response = await getDrive().files.list({
      q: `'${currentFolderId}' in parents and name = '${escapedPart}' and mimeType = '${FOLDER_MIME_TYPE2}' and trashed = false`,
      fields: "files(id)",
      spaces: "drive",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    });
    if (!response.data.files?.length) {
      const folderMetadata = {
        name: part,
        mimeType: FOLDER_MIME_TYPE2,
        parents: [currentFolderId]
      };
      const folder = await getDrive().files.create({
        requestBody: folderMetadata,
        fields: "id",
        supportsAllDrives: true
      });
      if (!folder.data.id) {
        throw new Error(`Failed to create intermediate folder: ${part}`);
      }
      currentFolderId = folder.data.id;
    } else {
      currentFolderId = response.data.files[0].id;
    }
  }
  return currentFolderId;
}
async function resolveFolderId(input) {
  if (!input) return "root";
  if (input.startsWith("/")) {
    return resolvePath(input);
  } else {
    return input;
  }
}
function validateTextFileExtension(name) {
  const ext = getExtensionFromFilename(name);
  if (!["txt", "md"].includes(ext)) {
    throw new Error("File name must end with .txt or .md for text files.");
  }
}
async function checkFileExists(name, parentFolderId = "root") {
  try {
    const escapedName = escapeDriveQuery(name);
    const query = `name = '${escapedName}' and '${parentFolderId}' in parents and trashed = false`;
    const res = await getDrive().files.list({
      q: query,
      fields: "files(id, name, mimeType)",
      pageSize: 1,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    });
    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0].id || null;
    }
    return null;
  } catch (error) {
    log("Error checking file existence:", error);
    return null;
  }
}
async function ensureAuthenticated() {
  if (authClient) return;
  if (authenticationPromise) {
    log("Authentication already in progress, waiting...");
    authClient = await authenticationPromise;
    return;
  }
  log("Initializing authentication");
  authenticationPromise = authenticate();
  try {
    authClient = await authenticationPromise;
    log("Authentication complete");
  } finally {
    authenticationPromise = null;
  }
}
var domainModules = [drive_exports, docs_exports, sheets_exports, slides_exports, calendar_exports];
function buildToolContext() {
  return {
    authClient,
    google,
    getDrive,
    getCalendar,
    log,
    resolvePath,
    resolveFolderId,
    checkFileExists,
    validateTextFileExtension,
    runtimeConfig
  };
}
function createMcpServer() {
  const s = new Server(
    {
      name: "google-drive-mcp",
      version: VERSION
    },
    {
      capabilities: {
        resources: {},
        tools: {}
      }
    }
  );
  s.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    await ensureAuthenticated();
    log("Handling ListResources request", { params: request.params });
    const pageSize = 10;
    const params = {
      pageSize,
      fields: "nextPageToken, files(id, name, mimeType)",
      q: `trashed = false`,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    };
    if (request.params?.cursor) {
      params.pageToken = request.params.cursor;
    }
    const res = await getDrive().files.list(params);
    log("Listed files", { count: res.data.files?.length });
    const files = res.data.files || [];
    return {
      resources: files.map((file) => ({
        uri: `gdrive:///${file.id}`,
        mimeType: file.mimeType || "application/octet-stream",
        name: file.name || "Untitled"
      })),
      nextCursor: res.data.nextPageToken
    };
  });
  s.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    await ensureAuthenticated();
    log("Handling ReadResource request", { uri: request.params.uri });
    const fileId = request.params.uri.replace("gdrive:///", "");
    const file = await getDrive().files.get({
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
        case "application/vnd.google-apps.document":
          exportMimeType = "text/markdown";
          break;
        case "application/vnd.google-apps.spreadsheet":
          exportMimeType = "text/csv";
          break;
        case "application/vnd.google-apps.presentation":
          exportMimeType = "text/plain";
          break;
        case "application/vnd.google-apps.drawing":
          exportMimeType = "image/png";
          break;
        default:
          exportMimeType = "text/plain";
          break;
      }
      const res = await getDrive().files.export(
        { fileId, mimeType: exportMimeType },
        { responseType: "text" }
      );
      log("Successfully read resource", { fileId, mimeType });
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: exportMimeType,
            text: res.data
          }
        ]
      };
    } else {
      const res = await getDrive().files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" }
      );
      const contentMime = mimeType || "application/octet-stream";
      if (contentMime.startsWith("text/") || contentMime === "application/json") {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: contentMime,
              text: Buffer.from(res.data).toString("utf-8")
            }
          ]
        };
      } else {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: contentMime,
              blob: Buffer.from(res.data).toString("base64")
            }
          ]
        };
      }
    }
  });
  s.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: domainModules.flatMap((m) => m.toolDefinitions)
    };
  });
  s.setRequestHandler(CallToolRequestSchema, async (request) => {
    await ensureAuthenticated();
    log("Handling tool request", { tool: request.params.name });
    const ctx = buildToolContext();
    try {
      for (const mod of domainModules) {
        const result = await mod.handleTool(request.params.name, request.params.arguments ?? {}, ctx);
        if (result !== null) return result;
      }
      return errorResponse("Tool not found");
    } catch (error) {
      log("Error in tool request handler", { error: error.message });
      return errorResponse(error.message);
    }
  });
  return s;
}
var server = createMcpServer();
function showHelp() {
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

  Transport Configuration:
  MCP_TRANSPORT                         Transport mode: stdio or http (default: stdio)
  MCP_HTTP_PORT                         HTTP listen port (default: 3100)
  MCP_HTTP_HOST                         HTTP bind address (default: 127.0.0.1)

  Service Account Mode:
  GOOGLE_APPLICATION_CREDENTIALS        Path to service account JSON key file

  External OAuth Token Mode:
  GOOGLE_DRIVE_MCP_ACCESS_TOKEN         Pre-obtained Google OAuth access token
  GOOGLE_DRIVE_MCP_REFRESH_TOKEN        Refresh token for auto-refresh (optional)
  GOOGLE_DRIVE_MCP_CLIENT_ID            OAuth client ID (required with refresh token)
  GOOGLE_DRIVE_MCP_CLIENT_SECRET        OAuth client secret (required with refresh token)
`);
}
function showVersion() {
  console.log(`Google Drive MCP Server v${VERSION}`);
}
async function runAuthServer() {
  try {
    const oauth2Client = await initializeOAuth2Client();
    const authServerInstance = new AuthServer(oauth2Client);
    const success = await authServerInstance.start(true);
    if (!success && !authServerInstance.authCompletedSuccessfully) {
      const { start, end } = authServerInstance.portRange;
      console.error(
        `Authentication failed. Could not start server or validate existing tokens. Check port availability (${start}-${end}) and try again.`
      );
      process.exit(1);
    } else if (authServerInstance.authCompletedSuccessfully) {
      console.log("Authentication successful.");
      process.exit(0);
    }
    console.log(
      "Authentication server started. Please complete the authentication in your browser..."
    );
    const intervalId = setInterval(async () => {
      if (authServerInstance.authCompletedSuccessfully) {
        clearInterval(intervalId);
        await authServerInstance.stop();
        console.log("Authentication completed successfully!");
        process.exit(0);
      }
    }, 1e3);
  } catch (error) {
    console.error("Authentication failed:", error);
    process.exit(1);
  }
}
function parseCliArgs() {
  const args = process.argv.slice(2);
  let command;
  let transport;
  let httpPort;
  let httpHost;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--version" || arg === "-v" || arg === "--help" || arg === "-h") {
      command = arg;
      continue;
    }
    if (arg === "--transport" && i + 1 < args.length) {
      transport = args[++i];
      continue;
    }
    if (arg === "--port" && i + 1 < args.length) {
      httpPort = args[++i];
      continue;
    }
    if (arg === "--host" && i + 1 < args.length) {
      httpHost = args[++i];
      continue;
    }
    if (!command && !arg.startsWith("--")) {
      command = arg;
      continue;
    }
  }
  const resolvedTransport = transport || process.env.MCP_TRANSPORT || "stdio";
  if (resolvedTransport !== "stdio" && resolvedTransport !== "http") {
    console.error(`Invalid transport: ${resolvedTransport}. Must be "stdio" or "http".`);
    process.exit(1);
  }
  const resolvedPort = parseInt(httpPort || process.env.MCP_HTTP_PORT || "3100", 10);
  if (isNaN(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
    console.error(`Invalid port: ${httpPort || process.env.MCP_HTTP_PORT}. Must be 1-65535.`);
    process.exit(1);
  }
  return {
    command,
    transport: resolvedTransport,
    httpPort: resolvedPort,
    httpHost: httpHost || process.env.MCP_HTTP_HOST || "127.0.0.1"
  };
}
async function main() {
  const args = parseCliArgs();
  switch (args.command) {
    case "auth":
      await runAuthServer();
      break;
    case "start":
    case void 0:
      if (args.transport === "http") {
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
async function startStdioTransport() {
  try {
    console.error("Starting Google Drive MCP server (stdio)...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("Server started successfully");
    process.on("SIGINT", async () => {
      await server.close();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      await server.close();
      process.exit(0);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}
var SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1e3;
function createHttpApp(host, options) {
  const idleTimeoutMs = options?.sessionIdleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS;
  const app = createMcpExpressApp({ host });
  const sessions = /* @__PURE__ */ new Map();
  const sessionTimers = /* @__PURE__ */ new Map();
  function resetSessionTimer(sid) {
    const existing = sessionTimers.get(sid);
    if (existing) clearTimeout(existing);
    sessionTimers.set(sid, setTimeout(async () => {
      const session = sessions.get(sid);
      if (session) {
        log(`Session idle timeout: ${sid}`);
        await session.transport.close();
        await session.server.close();
        sessions.delete(sid);
      }
      sessionTimers.delete(sid);
    }, idleTimeoutMs));
  }
  function clearSessionTimer(sid) {
    const timer = sessionTimers.get(sid);
    if (timer) {
      clearTimeout(timer);
      sessionTimers.delete(sid);
    }
  }
  app.post("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        resetSessionTimer(sessionId);
        await session.transport.handleRequest(req, res, req.body);
        return;
      }
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Bad Request: expected initialize request or valid session ID" },
          id: null
        });
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID()
      });
      const sessionServer = createMcpServer();
      await sessionServer.connect(transport);
      transport.onclose = () => {
        const sid2 = transport.sessionId;
        if (sid2) {
          clearSessionTimer(sid2);
          sessions.delete(sid2);
          log(`Session closed: ${sid2}`);
        }
      };
      await transport.handleRequest(req, res, req.body);
      const sid = transport.sessionId;
      if (sid) {
        sessions.set(sid, { transport, server: sessionServer });
        resetSessionTimer(sid);
        log(`New session created: ${sid}`);
      }
    } catch (error) {
      log("Error handling POST /mcp", { error: error.message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });
  app.get("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Bad Request: missing or invalid session ID" },
          id: null
        });
        return;
      }
      const session = sessions.get(sessionId);
      resetSessionTimer(sessionId);
      await session.transport.handleRequest(req, res);
    } catch (error) {
      log("Error handling GET /mcp", { error: error.message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });
  app.delete("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Bad Request: missing or invalid session ID" },
          id: null
        });
        return;
      }
      const session = sessions.get(sessionId);
      await session.transport.close();
      await session.server.close();
      sessions.delete(sessionId);
      res.status(200).end();
    } catch (error) {
      log("Error handling DELETE /mcp", { error: error.message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });
  return { app, sessions };
}
async function startHttpTransport(args) {
  try {
    const { httpPort, httpHost } = args;
    console.error(`Starting Google Drive MCP server (HTTP on ${httpHost}:${httpPort})...`);
    const { app, sessions } = createHttpApp(httpHost);
    const httpServer = app.listen(httpPort, httpHost, () => {
      log(`HTTP server listening on ${httpHost}:${httpPort}`);
    });
    const shutdown = async () => {
      log("Shutting down HTTP server...");
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
    console.error("Failed to start HTTP server:", error);
    process.exit(1);
  }
}
function _setAuthClientForTesting(client) {
  authClient = client;
  _drive = null;
  _calendar = null;
  _lastAuthClient = null;
}
if (!process.env.MCP_TESTING) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
export {
  _setAuthClientForTesting,
  createHttpApp,
  createMcpServer,
  main,
  server
};
//# sourceMappingURL=index.js.map
