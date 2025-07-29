# Google Drive MCP Server

A Model Context Protocol (MCP) server that provides secure integration with Google Drive, Docs, Sheets, and Slides. It allows Claude Desktop and other MCP clients to manage files in Google Drive through a standardized interface.

## Features

- **Multi-format Support**: Work with Google Docs, Sheets, Slides, and regular files
- **File Management**: Create, update, delete, rename, and move files and folders
- **Advanced Search**: Search across your entire Google Drive
- **Folder Navigation**: List and navigate through folder hierarchies with path support (e.g., `/Work/Projects`)
- **MCP Resource Protocol**: Files accessible as MCP resources for reading content
- **Secure Authentication**: OAuth 2.0 with automatic token refresh

## Example Usage

This MCP server enables powerful file management workflows through natural language:

### 1. **Document Creation and Organization**
```
Create a new Google Doc called "Project Plan" in the folder /Work/Projects
with an outline for our Q1 initiatives including milestones and deliverables.
```

### 2. **File Search and Organization**
```
Search for files containing "budget" and organize them by moving each one
to the appropriate folder in your Drive hierarchy.
```

### 3. **Spreadsheet Creation**
```
Create a Google Sheet called "Sales Analysis 2024" with columns for Date, Product,
Quantity, and Revenue to track your sales data.
```

### 4. **Presentation Creation**
```
Create a presentation called "Product Roadmap" with slides outlining
our Q1 milestones, key features, and timeline.
```

### 5. **Spreadsheet Updates**
```
Update the "Team Contacts" spreadsheet with new employee information
by modifying specific cells or ranges with the provided data.
```

### 6. **Document Search**
```
Search for documents in the /Reports folder and create a summary
document listing the files you found.
```

### 7. **Folder and Document Creation**
```
Create a Templates folder and add standard documents like
a Meeting Notes template, Project Proposal template,
and Budget Spreadsheet template.
```

## Requirements

- **Node.js**: Version 18 or higher (LTS recommended)
- **Google Cloud Project**: With the following APIs enabled:
  - Google Drive API
  - Google Docs API
  - Google Sheets API
  - Google Slides API
- **OAuth 2.0 Credentials**: Desktop application type (Client ID only - no client secret required)

## Google Cloud Setup

### 1. Create a Google Cloud Project
- Go to the [Google Cloud Console](https://console.cloud.google.com)
- Click "Select a project" > "New Project"
- Name your project (e.g., "Google Drive MCP")
- Note the Project ID for later

### 2. Enable Required APIs
- In your project, go to "APIs & Services" > "Library"
- Search for and enable each of these APIs:
  - **Google Drive API**
  - **Google Docs API**
  - **Google Sheets API**
  - **Google Slides API**
- Wait for each API to be enabled before proceeding

### 3. Configure OAuth Consent Screen
- Go to "APIs & Services" > "OAuth consent screen"
- Under 'Branding' fill in the required fields:
  - App name: "My Personal Google Drive MCP"
  - User support email: Your email
  - Developer contact: Your email
- Under 'Audience':
  - Choose "External" (default choice) or "Internal" for Google Workspace accounts
  - Add your email as a test user
- Under 'Data Access' add scopes. The recommended set of scopes for best user experience is the following:
  - `./auth/drive.file`
  - `.../auth/documents`
  - `.../auth/spreadsheets`
  - `.../auth/presentations`
  - `.../auth/drive`
  - `.../auth/drive.readonly`

### 4. Create OAuth 2.0 Credentials
- Go to "APIs & Services" > "Credentials"
- Click "+ CREATE CREDENTIALS" > "OAuth client ID"
- Application type: **Desktop app** (Important!)
- Name: "Google Drive MCP Client"
- Click "Create"
- Download the JSON file
- Rename it to `gcp-oauth.keys.json`

## Installation

### Option 1: Use with npx (Recommended)

You can run the server directly without installation:

```bash
# Run the server (authentication happens automatically on first run)
npx @piotr-agier/google-drive-mcp

# Optional: Run authentication manually if needed
npx @piotr-agier/google-drive-mcp auth
```

### Option 2: Local Installation

1. Clone and install:
   ```bash
   git clone https://github.com/piotr-agier/google-drive-mcp.git
   cd google-drive-mcp
   npm install
   ```

2. Set up credentials:
   ```bash
   # Copy the example file
   cp gcp-oauth.keys.example.json gcp-oauth.keys.json
   
   # Edit gcp-oauth.keys.json with your OAuth client ID
   ```

3. Authenticate (optional):
   ```bash
   npm run auth
   ```
   
   Note: Authentication happens automatically on first run of an MCP client if you skip this step.

## Configuration

### OAuth Credentials Configuration

The server supports multiple methods for providing OAuth credentials (in order of priority):

#### 1. **Environment Variable** (Recommended)
```bash
export GOOGLE_DRIVE_OAUTH_CREDENTIALS="/path/to/your/gcp-oauth.keys.json"
```

#### 2. **Default File Location**
Place `gcp-oauth.keys.json` in the project root directory

### Token Storage

Authentication tokens are stored securely following the XDG Base Directory specification:

| Priority | Location | Configuration |
|----------|----------|---------------|
| 1 | Custom path | Set `GOOGLE_DRIVE_MCP_TOKEN_PATH` environment variable |
| 2 | XDG Config | `$XDG_CONFIG_HOME/google-drive-mcp/tokens.json` |
| 3 | Default | `~/.config/google-drive-mcp/tokens.json` |

**Security Notes:**
- Tokens are created with secure permissions (0600)
- Never commit tokens to version control
- Tokens auto-refresh before expiration
- Google OAuth apps in "Testing" status have refresh tokens that expire after 7 days (Google's policy)

## Usage with Claude Desktop

Add the server to your Claude Desktop configuration:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### Using npx (Recommended):
```json
{
  "mcpServers": {
    "google-drive": {
      "command": "npx",
      "args": ["@piotr-agier/google-drive-mcp"],
      "env": {
        "GOOGLE_DRIVE_OAUTH_CREDENTIALS": "/path/to/your/gcp-oauth.keys.json"
      }
    }
  }
}
```

### Using Local Installation:
```json
{
  "mcpServers": {
    "google-drive": {
      "command": "node",
      "args": ["/absolute/path/to/google-drive-mcp/dist/index.js"],
      "env": {
        "GOOGLE_DRIVE_OAUTH_CREDENTIALS": "/path/to/your/gcp-oauth.keys.json"
      }
    }
  }
}
```

**Note**: Replace `/path/to/your/gcp-oauth.keys.json` with the actual path to your OAuth credentials file.

## Available Tools

### Search and Navigation
- **search** - Search for files across Google Drive
  - `query`: Search terms

- **listFolder** - List contents of a folder
  - `folderId`: Folder ID (optional, defaults to root)
  - `pageSize`: Number of results (optional, max 100)
  - `pageToken`: Pagination token (optional)

### File Management
- **createTextFile** - Create a text or markdown file
  - `name`: File name (must end with .txt or .md)
  - `content`: File content
  - `parentFolderId`: Parent folder ID (optional)

- **updateTextFile** - Update existing text file
  - `fileId`: File ID to update
  - `content`: New content
  - `name`: New name (optional)

- **deleteItem** - Move a file or folder to trash (not a permanent deletion - items can be restored from Google Drive trash)
  - `itemId`: Item ID to move to trash

- **renameItem** - Rename a file or folder
  - `itemId`: Item ID to rename
  - `newName`: New name

- **moveItem** - Move a file or folder
  - `itemId`: Item ID to move
  - `destinationFolderId`: Destination folder ID

### Folder Operations
- **createFolder** - Create a new folder
  - `name`: Folder name
  - `parent`: Parent folder ID or path (optional)

### Google Workspace
- **createGoogleDoc** - Create a Google Doc
  - `name`: Document name
  - `content`: Document content
  - `parentFolderId`: Parent folder ID (optional)

- **updateGoogleDoc** - Update a Google Doc
  - `documentId`: Document ID
  - `content`: New content

- **createGoogleSheet** - Create a Google Sheet
  - `name`: Spreadsheet name
  - `data`: 2D array of cell values
  - `parentFolderId`: Parent folder ID (optional)

- **updateGoogleSheet** - Update a Google Sheet
  - `spreadsheetId`: Spreadsheet ID
  - `range`: Range to update (e.g., "A1:C10")
  - `data`: 2D array of new values

- **createGoogleSlides** - Create a presentation
  - `name`: Presentation name
  - `slides`: Array of slides with title and content
  - `parentFolderId`: Parent folder ID (optional)

- **updateGoogleSlides** - Update an existing presentation
  - `presentationId`: Presentation ID
  - `slides`: Array of slides with title and content (replaces all existing slides)

## Authentication Flow

The server uses OAuth 2.0 for secure authentication:

### Automatic Authentication (First Run)
1. Server detects missing tokens and starts local auth server
2. Your browser opens to Google's consent page
3. Grant the requested permissions
4. Tokens are saved securely to `~/.config/google-drive-mcp/tokens.json`
5. Server continues startup

### Token Management
- **Automatic Refresh**: Tokens refresh automatically before expiration
- **Secure Storage**: Tokens stored with 0600 permissions
- **Migration**: Legacy tokens are automatically migrated to secure location

### Manual Re-authentication

Run the auth command when you need to:
- Switch Google accounts
- Refresh expired tokens (Google expires refresh tokens after 7 days for apps in "Testing" status)
- Recover from revoked access

```bash
# Using npx
npx @piotr-agier/google-drive-mcp auth

# Using local installation
npm run auth
```

## Security

### Security Features
- **No Client Secrets**: Desktop OAuth flow works with client ID only
- **Secure Token Storage**: Tokens stored with 0600 permissions in XDG-compliant location
- **Scoped Access**: Minimal permissions requested (drive.file, documents, spreadsheets, presentations)
- **Local Execution**: All processing happens on your machine
- **Automatic Token Refresh**: Reduces need for re-authentication
- **Token Migration**: Legacy tokens automatically moved to secure location

### Best Practices
1. **Never commit credentials**: Add to `.gitignore`:
   ```
   gcp-oauth.keys.json
   client_secret*.json
   .config/
   ```

2. **Use environment variables** for production:
   ```bash
   export GOOGLE_DRIVE_OAUTH_CREDENTIALS="/secure/path/credentials.json"
   export GOOGLE_DRIVE_MCP_TOKEN_PATH="/secure/path/tokens.json"
   ```

3. **Monitor access**:
   - Check recent activity in Google Drive
   - Review OAuth app permissions regularly

### Revoking OAuth Access

If you need to revoke the Google Drive MCP's access to your Google account:

1. Visit [Google Account Permissions](https://myaccount.google.com/permissions)
2. Find "Google Drive MCP" or your custom app name in the list
3. Click on it and select "Remove Access"
4. Clear local tokens to complete the revocation:
   ```bash
   rm ~/.config/google-drive-mcp/tokens.json
   ```

After revoking access, you'll need to re-authenticate the next time you use the server.

## Troubleshooting

### Common Issues and Solutions

#### "OAuth credentials not found"
```
OAuth credentials not found. Please provide credentials using one of these methods:
1. Environment variable:
   export GOOGLE_DRIVE_OAUTH_CREDENTIALS="/path/to/gcp-oauth.keys.json"
2. Default file path:
   Place your gcp-oauth.keys.json file in the package root directory.
```

**Solution:**
- Download credentials from Google Cloud Console
- Either set the environment variable or place the file in the project root
- Ensure the file has proper read permissions

#### "Authentication failed" or Browser doesn't open
**Possible causes:**
1. **Wrong credential type**: Must be "Desktop app", not "Web application"
2. **Port blocked**: Ports 3000-3004 must be available
3. **Test user not added**: Add your email in OAuth consent screen

**Solution:**
```bash
# Check if ports are in use
lsof -i :3000-3004

# Kill processes if needed
kill -9 <PID>

# Re-run authentication
npx @piotr-agier/google-drive-mcp auth
```

#### "Tokens expired" or "Invalid grant"
**For Google OAuth apps in "Testing" status:**
- Google automatically expires refresh tokens after 7 days
- You'll need to re-authenticate weekly until you publish your app

**Solution:**
```bash
# Clear old tokens and re-authenticate
rm ~/.config/google-drive-mcp/tokens.json
npx @piotr-agier/google-drive-mcp auth
```

**For production:**
- Move app to "Published" status in Google Cloud Console
- Complete OAuth verification process

#### "Login Required" error even with valid tokens
**If you updated the OAuth scopes but still get errors:**
- Google caches app authorizations even after removing local tokens
- The app might be using old/limited scopes

**Solution:**
1. Go to [Google Account Permissions](https://myaccount.google.com/permissions)
2. Find and remove access for "Google Drive MCP" 
3. Clear local tokens: `rm ~/.config/google-drive-mcp/tokens.json`
4. Re-authenticate to grant all required scopes
5. Verify the consent screen shows ALL scopes including full Drive access

#### "API not enabled" errors
```
Error: Google Sheets API has not been used in project...
```

**Solution:**
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Select your project
3. Navigate to "APIs & Services" > "Library"
4. Search and enable the missing API
5. Wait 1-2 minutes for propagation

#### "Insufficient permissions"
**Check scopes in your credentials:**
- Need drive.file or drive scope
- Need docs, sheets, slides scopes for respective services

**Solution:**
- Re-create OAuth credentials with correct scopes
- Re-authenticate after updating credentials

#### Rate Limiting (429 errors)
**Google API Quotas:**
- Drive API: 12,000 requests per minute
- Docs/Sheets/Slides: 300 requests per minute

**Solution:**
- Implement exponential backoff
- Batch operations where possible
- Check quota usage in Google Cloud Console

### Debug Mode

Enable detailed logging:
```bash
# Set debug environment variable
export DEBUG=google-drive-mcp:*
npx @piotr-agier/google-drive-mcp
```

### Getting Help

1. **Check logs**: Server logs errors to stderr
2. **Verify setup**: Run `npx @piotr-agier/google-drive-mcp help`
3. **Test auth**: Run `npx @piotr-agier/google-drive-mcp auth`
4. **Report issues**: [GitHub Issues](https://github.com/piotr-agier/google-drive-mcp/issues)

## Development

### Project Structure
```
google-drive-mcp/
├── src/                    # Source code
│   ├── index.ts           # Main server implementation
│   ├── auth.ts            # Main authentication module
│   └── auth/              # Authentication components
│       ├── client.ts      # OAuth2 client setup
│       ├── server.ts      # Local auth server
│       ├── tokenManager.ts # Token storage and validation
│       └── utils.ts       # Auth utilities
├── dist/                  # Compiled JavaScript (generated)
├── scripts/               # Build scripts
│   └── build.js          # Custom build script
├── gcp-oauth.keys.json    # OAuth credentials (create from example)
├── gcp-oauth.keys.example.json # Example credentials file
├── package.json           # NPM package configuration
├── tsconfig.json          # TypeScript configuration
├── LICENSE                # MIT license
└── README.md             # This file
```

### Building
```bash
npm run build    # Compile TypeScript
npm run watch    # Compile and watch for changes
npm run typecheck # Type checking without compilation
```

### Scripts
- `npm start` - Start the compiled server
- `npm run auth` - Run authentication flow
- `npm run build` - Build the project (runs typecheck + custom build script)
- `npm run watch` - Build and watch for changes
- `npm run typecheck` - Run TypeScript type checking only
- `npm run lint` - Run TypeScript type checking (alias for typecheck)
- `npm run prepare` - Auto-runs build before npm publish
- `npm test` - Run tests (placeholder - no tests implemented yet)

## Advanced Configuration

### Environment Variables

#### User-Configured Variables

**Credentials** (required - use one of these methods):
| Variable | Description | Example |
|----------|-------------|---------|
| `GOOGLE_DRIVE_OAUTH_CREDENTIALS` | Path to your OAuth credentials JSON file | `/home/user/secrets/oauth.json` |
| *(or place file at)* | Default location: `gcp-oauth.keys.json` in project root | `./gcp-oauth.keys.json` |

**Optional** (for customization):
| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `GOOGLE_DRIVE_MCP_TOKEN_PATH` | Override token storage location | `~/.config/google-drive-mcp/tokens.json` | `/custom/path/tokens.json` |
| `DEBUG` | Enable debug logging | (disabled) | `google-drive-mcp:*` |

#### System Variables (used by the codebase if present)

These are standard system environment variables that the application reads but you typically don't need to set:

| Variable | Description | Used For |
|----------|-------------|----------|
| `XDG_CONFIG_HOME` | Linux/Unix config directory standard | Determining default token storage location |
| `NODE_ENV` | Node.js environment mode | May affect error handling and logging |

#### Deprecated Variables (do not use)

| Variable | Description |
|----------|-------------|
| `GOOGLE_TOKEN_PATH` | Legacy token path - use `GOOGLE_DRIVE_MCP_TOKEN_PATH` instead |
| `GOOGLE_CLIENT_SECRET_PATH` | Legacy credentials path - use `GOOGLE_DRIVE_OAUTH_CREDENTIALS` instead |

## License

MIT - See LICENSE file for details

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Support

- 📚 [Documentation](https://github.com/piotr-agier/google-drive-mcp)
- 🐛 [Issue Tracker](https://github.com/piotr-agier/google-drive-mcp/issues)

## Acknowledgments

- Built on [Model Context Protocol](https://modelcontextprotocol.io)
- Uses [Google APIs Node.js Client](https://github.com/googleapis/google-api-nodejs-client)
- Inspired by the MCP community