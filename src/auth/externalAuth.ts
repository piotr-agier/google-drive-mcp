// ---------------------------------------------------------------------------
// External authentication modes: Service Account & pre-obtained OAuth tokens
// ---------------------------------------------------------------------------

import { OAuth2Client } from 'google-auth-library';
import { GoogleAuth, GoogleAuthOptions } from 'google-auth-library';
import { resolveOAuthScopes } from './scopes.js';

// ---------------------------------------------------------------------------
// Service Account mode
// ---------------------------------------------------------------------------

/** True when `GOOGLE_APPLICATION_CREDENTIALS` is set (standard Google convention). */
export function isServiceAccountMode(): boolean {
  return !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
}

/**
 * Build `GoogleAuth` options from the current environment.
 *
 * When `GOOGLE_DRIVE_MCP_SUBJECT` is set, the returned options include
 * `clientOptions.subject`, which instructs `GoogleAuth` to mint a JWT that
 * impersonates the given user via domain-wide delegation. The Workspace admin
 * must have authorized the service account's client ID for the requested
 * scopes under Security → API controls → Manage Domain-wide Delegation.
 *
 * Scopes are resolved via {@link resolveOAuthScopes}, so `GOOGLE_DRIVE_MCP_SCOPES`
 * narrows the SA's authority the same way it does for interactive OAuth.
 *
 * Exported so tests can assert the shape without hitting the filesystem.
 */
export function buildServiceAccountAuthOptions(): GoogleAuthOptions {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS!;
  const subject = process.env.GOOGLE_DRIVE_MCP_SUBJECT?.trim();

  const options: GoogleAuthOptions = {
    keyFile,
    scopes: resolveOAuthScopes(),
  };

  if (subject) {
    options.clientOptions = { subject };
  }

  return options;
}

/**
 * Create an authorized client from a service account JSON key file.
 * `GoogleAuth` handles JWT signing and token refresh automatically.
 */
export async function createServiceAccountAuth(): Promise<any> {
  const options = buildServiceAccountAuthOptions();
  const subject = process.env.GOOGLE_DRIVE_MCP_SUBJECT?.trim();
  console.error(
    `Using service account credentials from ${options.keyFile}` +
      (subject ? ` (impersonating ${subject} via domain-wide delegation)` : ''),
  );

  const auth = new GoogleAuth(options);
  const client = await auth.getClient();
  console.error('Service account authentication successful');
  return client;
}

// ---------------------------------------------------------------------------
// External OAuth Token mode
// ---------------------------------------------------------------------------

/** True when `GOOGLE_DRIVE_MCP_ACCESS_TOKEN` is set. */
export function isExternalTokenMode(): boolean {
  return !!process.env.GOOGLE_DRIVE_MCP_ACCESS_TOKEN;
}

/**
 * Validate that the env-var combination makes sense.
 * Throws with an actionable message on mis-configuration.
 */
export function validateExternalTokenConfig(): void {
  const accessToken = process.env.GOOGLE_DRIVE_MCP_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new Error(
      'GOOGLE_DRIVE_MCP_ACCESS_TOKEN is set but empty. Provide a valid OAuth access token.'
    );
  }

  const refreshToken = process.env.GOOGLE_DRIVE_MCP_REFRESH_TOKEN?.trim();
  const clientId = process.env.GOOGLE_DRIVE_MCP_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_DRIVE_MCP_CLIENT_SECRET?.trim();

  if (refreshToken) {
    if (!clientId || !clientSecret) {
      throw new Error(
        'GOOGLE_DRIVE_MCP_REFRESH_TOKEN is set but GOOGLE_DRIVE_MCP_CLIENT_ID and/or ' +
          'GOOGLE_DRIVE_MCP_CLIENT_SECRET are missing. All three are required for automatic token refresh.'
      );
    }
  }

  // Warn about partial client credential sets (one without the other)
  if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
    throw new Error(
      'Both GOOGLE_DRIVE_MCP_CLIENT_ID and GOOGLE_DRIVE_MCP_CLIENT_SECRET must be provided together.'
    );
  }
}

/**
 * Create an OAuth2Client pre-loaded with externally-obtained credentials.
 * When a refresh token + client credentials are provided, the client will
 * auto-refresh transparently.
 */
export function createExternalOAuth2Client(): OAuth2Client {
  const accessToken = process.env.GOOGLE_DRIVE_MCP_ACCESS_TOKEN!.trim();
  const refreshToken = process.env.GOOGLE_DRIVE_MCP_REFRESH_TOKEN?.trim();
  const clientId = process.env.GOOGLE_DRIVE_MCP_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_DRIVE_MCP_CLIENT_SECRET?.trim();

  const oauth2Client = new OAuth2Client(clientId, clientSecret);

  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken || undefined,
  });

  if (!refreshToken) {
    console.error(
      'Warning: No refresh token provided. The access token will not auto-refresh when it expires.'
    );
  } else {
    console.error('External OAuth tokens configured with auto-refresh support.');
  }

  return oauth2Client;
}
