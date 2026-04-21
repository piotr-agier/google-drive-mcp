// Main authentication module that re-exports and orchestrates the modular components
import { OAuth2Client } from 'google-auth-library';
import { AccountClientFactory } from './auth/accountClientFactory.js';
import { AccountResolver } from './auth/accountResolver.js';
import { AccountStore } from './auth/accountStore.js';
import { initializeOAuth2Client } from './auth/client.js';
import {
  createExternalOAuth2Client,
  createServiceAccountAuth,
  isExternalTokenMode,
  isServiceAccountMode,
  validateExternalTokenConfig,
} from './auth/externalAuth.js';
import { resolveOAuthScopes } from './auth/scopes.js';
import { AuthServer } from './auth/server.js';
import { SessionStore } from './auth/sessionStore.js';
import { TokenManager } from './auth/tokenManager.js';
import { AccountRecord, AuthMode } from './auth/types.js';

export { TokenManager } from './auth/tokenManager.js';
export { initializeOAuth2Client } from './auth/client.js';
export { AuthServer } from './auth/server.js';
export { SCOPE_ALIASES, SCOPE_PRESETS, DEFAULT_SCOPES, resolveOAuthScopes } from './auth/scopes.js';
export {
  isServiceAccountMode, createServiceAccountAuth,
  isExternalTokenMode, validateExternalTokenConfig,
  createExternalOAuth2Client,
} from './auth/externalAuth.js';
export { AccountStore } from './auth/accountStore.js';
export { AccountResolver } from './auth/accountResolver.js';
export { AccountClientFactory } from './auth/accountClientFactory.js';
export { SessionStore, STDIO_SESSION_ID } from './auth/sessionStore.js';
export type {
  AccountRecord,
  AccountTargeting,
  AuthMode,
  RedactedAccountView,
  SessionState,
  ToolOpKind,
} from './auth/types.js';

export interface AuthSystem {
  mode: AuthMode;
  store: AccountStore;
  factory: AccountClientFactory;
  resolver: AccountResolver;
  sessions: SessionStore;
}

/**
 * Build the multi-account auth system.
 *
 * - Detects mode from env (service account > external token > local OAuth).
 * - Constructs AccountStore/Factory/Resolver/Sessions.
 * - Seeds synthetic accounts for non-local-OAuth modes.
 * - For local OAuth: loads v2 tokens.json (or migrates v1).
 *   If no accounts are registered, runs the interactive auth flow via AuthServer.
 */
export async function buildAuthSystem(): Promise<AuthSystem> {
  console.error('Initializing authentication...');

  if (isServiceAccountMode()) {
    const client = await createServiceAccountAuth();
    const store = new AccountStore({ mode: 'service-account' });
    await store.reload();
    store.setSyntheticAccount(buildSyntheticRecord('service-account'), client);
    return assembleSystem('service-account', store);
  }

  if (isExternalTokenMode()) {
    validateExternalTokenConfig();
    const client = createExternalOAuth2Client();
    const store = new AccountStore({ mode: 'external-token' });
    await store.reload();
    store.setSyntheticAccount(buildSyntheticRecord('external-token'), client);
    return assembleSystem('external-token', store);
  }

  // Local OAuth mode
  const store = new AccountStore({ mode: 'local-oauth' });
  await store.reload();

  if (store.list().length === 0) {
    // First-time auth: run the interactive browser flow.
    const oauth2Client = await initializeOAuth2Client();
    const tokenManager = new TokenManager(oauth2Client);
    const authServer = new AuthServer(oauth2Client);
    const started = await authServer.start(true);
    if (!started) {
      throw new Error('Authentication failed. Please check your credentials and try again.');
    }
    // Wait for the OAuth callback to populate tokens.json.
    await new Promise<void>((resolve) => {
      const poll = setInterval(async () => {
        if (authServer.authCompletedSuccessfully) {
          clearInterval(poll);
          await authServer.stop();
          resolve();
        }
      }, 1000);
    });
    // Validate + refresh, then re-read tokens.json (now in v1 shape) and migrate to v2.
    await tokenManager.validateTokens();
    await store.reload();
  } else {
    console.error(`Authentication: loaded ${store.list().length} account(s) from ${store.getFilePath()}`);
  }

  return assembleSystem('local-oauth', store);
}

function assembleSystem(mode: AuthMode, store: AccountStore): AuthSystem {
  const sessions = new SessionStore();
  const factory = new AccountClientFactory(store);
  const resolver = new AccountResolver(store, sessions);
  return { mode, store, factory, resolver, sessions };
}

function buildSyntheticRecord(alias: 'service-account' | 'external-token'): AccountRecord {
  const scope = resolveOAuthScopes().join(' ');
  const now = new Date().toISOString();
  return {
    alias,
    email: 'unknown',
    sub: `synthetic:${alias}`,
    accessToken: '',
    refreshToken: '',
    scope,
    tokenType: 'Bearer',
    expiryDate: 0,
    addedAt: now,
    lastRefreshedAt: now,
    pendingIdentity: true,
  };
}

/**
 * Authenticate and return the active OAuth2Client.
 *
 * Back-compat shim: callers that only want the raw client (e.g. tests, the
 * service-account priority test) keep working. New callers should use
 * `buildAuthSystem()` and pull clients from the factory per-alias.
 */
export async function authenticate(): Promise<OAuth2Client> {
  // Preserve legacy fast paths used by tests: synthetic-mode callers expect
  // the mode-specific client directly without touching AccountStore.
  if (isServiceAccountMode()) {
    return (await createServiceAccountAuth()) as OAuth2Client;
  }
  if (isExternalTokenMode()) {
    validateExternalTokenConfig();
    return createExternalOAuth2Client();
  }

  const system = await buildAuthSystem();
  const defaultAlias = system.store.getDefault() ?? system.store.list()[0]?.alias;
  if (!defaultAlias) {
    throw new Error('Authentication completed but no active account is available.');
  }
  return system.factory.getClient(defaultAlias);
}

/**
 * Manual authentication command
 * Used when running "npm run auth" or when the user needs to re-authenticate
 */
export async function runAuthCommand(): Promise<void> {
  try {
    console.error('Google Drive MCP - Manual Authentication');
    console.error('════════════════════════════════════════\n');

    // Initialize OAuth client
    const oauth2Client = await initializeOAuth2Client();

    // Create and start the auth server
    const authServer = new AuthServer(oauth2Client);

    // Start with browser opening (true by default)
    const success = await authServer.start(true);

    if (!success && !authServer.authCompletedSuccessfully) {
      // Failed to start and tokens weren't already valid
      console.error(
        "Authentication failed. Could not start server or validate existing tokens. Check port availability (3000-3004) and try again."
      );
      process.exit(1);
    } else if (authServer.authCompletedSuccessfully) {
      // Auth was successful (either existing tokens were valid or flow completed just now)
      console.error("\n✅ Authentication successful!");
      console.error("You can now use the Google Drive MCP server.");
      process.exit(0); // Exit cleanly if auth is already done
    }

    // If we reach here, the server started and is waiting for the browser callback
    console.error(
      "Authentication server started. Please complete the authentication in your browser..."
    );

    // Wait for completion
    const intervalId = setInterval(() => {
      if (authServer.authCompletedSuccessfully) {
        clearInterval(intervalId);
        console.error("\n✅ Authentication completed successfully!");
        console.error("You can now use the Google Drive MCP server.");
        process.exit(0);
      }
    }, 1000);
  } catch (error) {
    console.error("\n❌ Authentication failed:", error);
    process.exit(1);
  }
}
