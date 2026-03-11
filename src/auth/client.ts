import { OAuth2Client } from 'google-auth-library';
import * as fs from 'fs/promises';
import { getKeysFilePaths, generateCredentialsErrorMessage, OAuthCredentials } from './utils.js';

function parseCredentialsFile(keys: Record<string, unknown>): OAuthCredentials {
  if (keys.installed) {
    const { client_id, client_secret, redirect_uris } = keys.installed as OAuthCredentials;
    return { client_id, client_secret, redirect_uris };
  } else if (keys.web) {
    const { client_id, client_secret, redirect_uris } = keys.web as OAuthCredentials;
    return { client_id, client_secret, redirect_uris };
  } else if (keys.client_id) {
    return {
      client_id: keys.client_id as string,
      client_secret: keys.client_secret as string | undefined,
      redirect_uris: (keys.redirect_uris as string[] | undefined) || ['http://localhost:3000/oauth2callback']
    };
  } else {
    throw new Error('Invalid credentials file format. Expected either "installed", "web" object or direct client_id field.');
  }
}

async function loadCredentialsFromFile(): Promise<OAuthCredentials> {
  const paths = getKeysFilePaths();

  for (const keysPath of paths) {
    try {
      const keysContent = await fs.readFile(keysPath, "utf-8");
      const keys = JSON.parse(keysContent);
      return parseCredentialsFile(keys);
    } catch (err: unknown) {
      // Re-throw parse/validation errors so the user gets actionable feedback
      if (err instanceof SyntaxError ||
          (err instanceof Error && err.message.includes('Invalid credentials'))) {
        throw new Error(`Invalid credentials file at ${keysPath}: ${(err as Error).message}`);
      }
      // File not found — try next path
    }
  }

  throw new Error(`Credentials file not found. Searched: ${paths.join(', ')}`);
}

async function loadCredentialsWithFallback(): Promise<OAuthCredentials> {
  try {
    return await loadCredentialsFromFile();
  } catch (fileError) {
    // Check for legacy client_secret.json
    const legacyPath = process.env.GOOGLE_CLIENT_SECRET_PATH || 'client_secret.json';
    try {
      const legacyContent = await fs.readFile(legacyPath, 'utf-8');
      const legacyKeys = JSON.parse(legacyContent);
      console.error('Warning: Using legacy client_secret.json. Please migrate to gcp-oauth.keys.json');
      
      if (legacyKeys.installed) {
        return legacyKeys.installed;
      } else if (legacyKeys.web) {
        return legacyKeys.web;
      } else {
        throw new Error('Invalid legacy credentials format');
      }
    } catch (_legacyError) {
      // Generate helpful error message
      const errorMessage = generateCredentialsErrorMessage();
      throw new Error(`${errorMessage}\n\nOriginal error: ${fileError instanceof Error ? fileError.message : fileError}`);
    }
  }
}

export async function initializeOAuth2Client(): Promise<OAuth2Client> {
  try {
    const credentials = await loadCredentialsWithFallback();
    
    // Use the first redirect URI as the default for the base client
    return new OAuth2Client({
      clientId: credentials.client_id,
      clientSecret: credentials.client_secret || undefined,
      redirectUri: credentials.redirect_uris?.[0] || 'http://localhost:3000/oauth2callback',
    });
  } catch (error) {
    throw new Error(`Error loading OAuth keys: ${error instanceof Error ? error.message : error}`);
  }
}

export async function loadCredentials(): Promise<{ client_id: string; client_secret?: string }> {
  try {
    const credentials = await loadCredentialsWithFallback();
    
    if (!credentials.client_id) {
        throw new Error('Client ID missing in credentials.');
    }
    return {
      client_id: credentials.client_id,
      client_secret: credentials.client_secret
    };
  } catch (error) {
    throw new Error(`Error loading credentials: ${error instanceof Error ? error.message : error}`);
  }
}