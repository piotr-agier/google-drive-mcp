import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

// Helper to get the project root directory reliably
function getProjectRoot(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // In build output (e.g., dist/auth/utils.js), __dirname is .../dist/auth
  // Go up TWO levels to get the project root
  const projectRoot = path.join(__dirname, "..", "..");
  return path.resolve(projectRoot);
}

// Returns the config directory for google-drive-mcp, following XDG Base Directory spec.
function getConfigDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME ||
    path.join(os.homedir(), '.config');
  return path.join(configHome, 'google-drive-mcp');
}

// Returns the absolute path for the saved token file.
// Uses XDG Base Directory spec with fallback to home directory
export function getSecureTokenPath(): string {
  // Check for custom token path environment variable first
  const customTokenPath = process.env.GOOGLE_DRIVE_MCP_TOKEN_PATH;
  if (customTokenPath) {
    return path.resolve(customTokenPath);
  }

  return path.join(getConfigDir(), 'tokens.json');
}

// Returns the legacy token path for backward compatibility
export function getLegacyTokenPath(): string {
  const projectRoot = getProjectRoot();
  return path.join(projectRoot, ".gcp-saved-tokens.json");
}

// Additional legacy paths to check
export function getAdditionalLegacyPaths(): string[] {
  return [
    process.env.GOOGLE_TOKEN_PATH,
    path.join(process.cwd(), 'google-tokens.json'),
    path.join(process.cwd(), '.gcp-saved-tokens.json')
  ].filter(Boolean) as string[];
}

// Returns all candidate paths for the credentials file, in priority order:
// 1. Environment variable GOOGLE_DRIVE_OAUTH_CREDENTIALS (highest priority)
// 2. Config directory ~/.config/google-drive-mcp/gcp-oauth.keys.json
// 3. Project root directory (legacy fallback)
export function getKeysFilePaths(): string[] {
  const paths: string[] = [];

  const envCredentialsPath = process.env.GOOGLE_DRIVE_OAUTH_CREDENTIALS;
  if (envCredentialsPath) {
    paths.push(path.resolve(envCredentialsPath));
  }

  paths.push(path.join(getConfigDir(), 'gcp-oauth.keys.json'));

  const projectRoot = getProjectRoot();
  paths.push(path.join(projectRoot, "gcp-oauth.keys.json"));

  return paths;
}

// Interface for OAuth credentials
export interface OAuthCredentials {
  client_id: string;
  client_secret?: string;
  redirect_uris?: string[];
}

// Generate helpful error message for missing credentials
export function generateCredentialsErrorMessage(): string {
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