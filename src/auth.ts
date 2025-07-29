// Main authentication module that re-exports and orchestrates the modular components
import { initializeOAuth2Client } from './auth/client.js';
import { AuthServer } from './auth/server.js';
import { TokenManager } from './auth/tokenManager.js';

export { TokenManager } from './auth/tokenManager.js';
export { initializeOAuth2Client } from './auth/client.js';
export { AuthServer } from './auth/server.js';

/**
 * Authenticate and return OAuth2 client
 * This is the main entry point for authentication in the MCP server
 */
export async function authenticate(): Promise<any> {
  console.error('Initializing authentication...');
  
  // Initialize OAuth2 client
  const oauth2Client = await initializeOAuth2Client();
  const tokenManager = new TokenManager(oauth2Client);
  
  // Try to validate existing tokens
  if (await tokenManager.validateTokens()) {
    console.error('Authentication successful - using existing tokens');
    console.error('OAuth2Client credentials:', {
      hasAccessToken: !!oauth2Client.credentials?.access_token,
      hasRefreshToken: !!oauth2Client.credentials?.refresh_token,
      expiryDate: oauth2Client.credentials?.expiry_date
    });
    return oauth2Client;
  }
  
  // No valid tokens, need to authenticate
  console.error('\n🔐 No valid authentication tokens found.');
  console.error('Starting authentication flow...\n');
  
  const authServer = new AuthServer(oauth2Client);
  const authSuccess = await authServer.start(true);
  
  if (!authSuccess) {
    throw new Error('Authentication failed. Please check your credentials and try again.');
  }
  
  // Wait for authentication to complete
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(async () => {
      if (authServer.authCompletedSuccessfully) {
        clearInterval(checkInterval);
        await authServer.stop();
        resolve();
      }
    }, 1000);
  });
  
  return oauth2Client;
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
    const intervalId = setInterval(async () => {
      if (authServer.authCompletedSuccessfully) {
        clearInterval(intervalId);
        await authServer.stop();
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