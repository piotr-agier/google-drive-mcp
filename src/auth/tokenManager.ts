import { OAuth2Client, Credentials } from 'google-auth-library';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getSecureTokenPath, getLegacyTokenPath, getAdditionalLegacyPaths } from './utils.js';
import { GaxiosError } from 'gaxios';

export class TokenManager {
  private oauth2Client: OAuth2Client;
  private tokenPath: string;

  constructor(oauth2Client: OAuth2Client) {
    this.oauth2Client = oauth2Client;
    this.tokenPath = getSecureTokenPath();
    this.setupTokenRefresh();
  }

  // Method to expose the token path
  public getTokenPath(): string {
    return this.tokenPath;
  }

  private async ensureTokenDirectoryExists(): Promise<void> {
    try {
        const dir = path.dirname(this.tokenPath);
        await fs.mkdir(dir, { recursive: true });
    } catch (error: unknown) {
        // Ignore errors if directory already exists, re-throw others
        if (error instanceof Error && 'code' in error && (error as any).code !== 'EEXIST') {
            console.error('Failed to create token directory:', error);
            throw error;
        }
    }
  }

  private setupTokenRefresh(): void {
    this.oauth2Client.on("tokens", async (newTokens) => {
      try {
        await this.ensureTokenDirectoryExists();
        const currentTokens = JSON.parse(await fs.readFile(this.tokenPath, "utf-8"));
        const updatedTokens = {
          ...currentTokens,
          ...newTokens,
          refresh_token: newTokens.refresh_token || currentTokens.refresh_token,
        };
        await fs.writeFile(this.tokenPath, JSON.stringify(updatedTokens, null, 2), {
          mode: 0o600,
        });
        console.error("Tokens updated and saved");
      } catch (error: unknown) {
        // Handle case where currentTokens might not exist yet
        if (error instanceof Error && 'code' in error && (error as any).code === 'ENOENT') { 
          try {
             await fs.writeFile(this.tokenPath, JSON.stringify(newTokens, null, 2), { mode: 0o600 });
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

  private async migrateLegacyTokens(): Promise<boolean> {
    // Check all possible legacy locations
    const legacyPaths = [getLegacyTokenPath(), ...getAdditionalLegacyPaths()];
    
    for (const legacyPath of legacyPaths) {
      try {
        // Check if legacy tokens exist
        if (!(await fs.access(legacyPath).then(() => true).catch(() => false))) {
          continue; // Try next location
        }

        // Read legacy tokens
        const legacyTokens = JSON.parse(await fs.readFile(legacyPath, "utf-8"));
        
        if (!legacyTokens || typeof legacyTokens !== "object") {
          console.error("Invalid legacy token format at", legacyPath, ", skipping");
          continue;
        }

        // Ensure new token directory exists
        await this.ensureTokenDirectoryExists();
        
        // Copy to new location
        await fs.writeFile(this.tokenPath, JSON.stringify(legacyTokens, null, 2), {
          mode: 0o600,
        });
        
        console.error("Migrated tokens from legacy location:", legacyPath, "to:", this.tokenPath);
        
        // Optionally remove legacy file after successful migration
        try {
          await fs.unlink(legacyPath);
          console.error("Removed legacy token file");
        } catch (unlinkErr) {
          console.error("Warning: Could not remove legacy token file:", unlinkErr);
        }
        
        return true;
      } catch (error) {
        console.error("Error migrating legacy tokens from", legacyPath, ":", error);
        // Continue to next location
      }
    }
    
    return false; // No legacy tokens found or migrated
  }

  async loadSavedTokens(): Promise<boolean> {
    try {
      await this.ensureTokenDirectoryExists();
      
      // Check if current token file exists
      const tokenExists = await fs.access(this.tokenPath).then(() => true).catch(() => false);
      
      // If no current tokens, try to migrate from legacy location
      if (!tokenExists) {
        const migrated = await this.migrateLegacyTokens();
        if (!migrated) {
          console.error("No token file found at:", this.tokenPath);
          return false;
        }
      }

      const tokens = JSON.parse(await fs.readFile(this.tokenPath, "utf-8"));

      if (!tokens || typeof tokens !== "object") {
        console.error("Invalid token format in file:", this.tokenPath);
        return false;
      }

      this.oauth2Client.setCredentials(tokens);
      console.error('Tokens loaded and set on OAuth2Client:', {
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token,
        tokenLength: tokens.access_token?.length,
        expiryDate: tokens.expiry_date,
        scope: tokens.scope
      });
      console.error('OAuth2Client after setCredentials:', {
        hasCredentials: !!this.oauth2Client.credentials,
        credentialsAccessToken: !!this.oauth2Client.credentials?.access_token
      });
      return true;
    } catch (error: unknown) {
      console.error("Error loading tokens:", error);
      // Attempt to delete potentially corrupted token file
      if (error instanceof Error && 'code' in error && (error as any).code !== 'ENOENT') { 
          try { 
              await fs.unlink(this.tokenPath); 
              console.error("Removed potentially corrupted token file") 
            } catch (unlinkErr) { /* ignore */ } 
      }
      return false;
    }
  }

  async refreshTokensIfNeeded(): Promise<boolean> {
    const expiryDate = this.oauth2Client.credentials.expiry_date;
    const isExpired = expiryDate
      ? Date.now() >= expiryDate - 5 * 60 * 1000 // 5 minute buffer
      : !this.oauth2Client.credentials.access_token; // No token means we need one

    if (isExpired && this.oauth2Client.credentials.refresh_token) {
      console.error("Auth token expired or nearing expiry, refreshing...");
      try {
        const response = await this.oauth2Client.refreshAccessToken();
        const newTokens = response.credentials;

        if (!newTokens.access_token) {
          throw new Error("Received invalid tokens during refresh");
        }
        // The 'tokens' event listener should handle saving
        this.oauth2Client.setCredentials(newTokens);
        console.error("Token refreshed successfully");
        return true;
      } catch (refreshError) {
        if (refreshError instanceof GaxiosError && refreshError.response?.data?.error === 'invalid_grant') {
            console.error("Error refreshing auth token: Invalid grant. Token likely expired or revoked. Please re-authenticate.");
            // Optionally clear the potentially invalid tokens here
            await this.clearTokens(); 
            return false; // Indicate failure due to invalid grant
        } else {
            // Handle other refresh errors
            console.error("Error refreshing auth token:", refreshError);
            return false;
        }
      }
    } else if (!this.oauth2Client.credentials.access_token && !this.oauth2Client.credentials.refresh_token) {
        console.error("No access or refresh token available. Please re-authenticate.");
        return false;
    } else {
        // Token is valid or no refresh token available
        return true;
    }
  }

  async validateTokens(): Promise<boolean> {
    if (!this.oauth2Client.credentials || !this.oauth2Client.credentials.access_token) {
        // Try loading first if no credentials set
        if (!(await this.loadSavedTokens())) {
            return false; // No saved tokens to load
        }
        // Check again after loading
        if (!this.oauth2Client.credentials || !this.oauth2Client.credentials.access_token) {
            return false; // Still no token after loading
        }
    }
    return this.refreshTokensIfNeeded();
  }

  async saveTokens(tokens: Credentials): Promise<void> {
    try {
        await this.ensureTokenDirectoryExists();
        await fs.writeFile(this.tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
        this.oauth2Client.setCredentials(tokens);
        console.error("Tokens saved successfully to:", this.tokenPath);
    } catch (error: unknown) {
        console.error("Error saving tokens:", error);
        throw error;
    }
  }

  async clearTokens(): Promise<void> {
    try {
      this.oauth2Client.setCredentials({}); // Clear in memory
      await fs.unlink(this.tokenPath);
      console.error("Tokens cleared successfully");
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as any).code === 'ENOENT') {
        // File already gone, which is fine
        console.error("Token file already deleted");
      } else {
        console.error("Error clearing tokens:", error);
        // Don't re-throw, clearing is best-effort
      }
    }
  }
}