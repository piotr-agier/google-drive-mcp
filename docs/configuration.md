# Configuration reference

CLI arguments take priority over their environment-variable equivalents. Authentication mode is selected in this order: service account, external OAuth token, then local OAuth. Team mode is explicitly enabled and cannot be combined with the single-identity external authentication modes.

## Commands

| Command | Purpose |
|---|---|
| `auth` | Run the local OAuth flow |
| `start` | Start the MCP server; this is the default command |
| `version` | Print the package version |
| `help` | Print CLI help |

## CLI flags

| Flag | Default | Description |
|---|---:|---|
| `--transport <stdio\|http>` | `stdio` | Select the MCP transport |
| `--port <number>` | `3100` | HTTP listen port |
| `--host <address>` | `127.0.0.1` | HTTP bind address |
| `--team` | off | Enable multi-user team mode; requires HTTP |
| `--issuer-url <url>` | — | Public HTTPS issuer URL required by team mode; HTTP is accepted only for localhost |
| `--no-resources[=<bool>]` | false | Disable `gdrive:///` resources while leaving tools enabled; an explicit false value re-enables resources |
| `--api-timeout=<ms>` | `120000` | Per-attempt timeout; `0` disables it |
| `--retry-max=<n>` | `3` | Maximum retry attempts for transient failures; `0` disables retries |
| `--retry-base-delay=<ms>` | `1000` | Exponential-backoff base delay, capped at 30 seconds with jitter |

The timeout and retry settings currently apply to the retry-wrapped content insertion performed by `createGoogleDoc`; they are not applied to every Google API request.

## Credentials and local OAuth

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_DRIVE_OAUTH_CREDENTIALS` | config-directory file | Absolute or relative path to the OAuth credentials JSON |
| `GOOGLE_DRIVE_MCP_TOKEN_PATH` | `$XDG_CONFIG_HOME/google-drive-mcp/tokens.json` | Override the local token store |
| `GOOGLE_DRIVE_MCP_AUTH_PORT` | `3000` | First of five consecutive loopback callback ports |
| `GOOGLE_DRIVE_MCP_SCOPES` | full configured set | Comma-separated scope aliases or full HTTPS scope URLs |
| `XDG_CONFIG_HOME` | `~/.config` | Base directory used for credentials, tokens, and the default team store |

Credentials lookup order is:

1. `GOOGLE_DRIVE_OAUTH_CREDENTIALS`.
2. `$XDG_CONFIG_HOME/google-drive-mcp/gcp-oauth.keys.json`.
3. `gcp-oauth.keys.json` in the package/project root as a legacy fallback.

Token lookup and storage use `GOOGLE_DRIVE_MCP_TOKEN_PATH` first, then the XDG config location.

Supported scope aliases are `drive`, `drive.file`, `drive.readonly`, `documents`, `spreadsheets`, `presentations`, `calendar`, and `calendar.events`. Changing scopes normally requires re-authentication.

## Resources, timeout, and retry

| Variable | Default | Description |
|---|---:|---|
| `GOOGLE_DRIVE_MCP_DISABLE_RESOURCES` | false | Disable MCP resources; accepts `1/0`, `true/false`, `yes/no`, or `on/off` |
| `GOOGLE_DRIVE_MCP_API_TIMEOUT` | `120000` | Fallback for `--api-timeout` |
| `GOOGLE_DRIVE_MCP_RETRY_MAX` | `3` | Fallback for `--retry-max` |
| `GOOGLE_DRIVE_MCP_RETRY_BASE_DELAY` | `1000` | Fallback for `--retry-base-delay` |

## HTTP transport

| Variable | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_PORT` | `3100` | HTTP listen port |
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind address |
| `MCP_HTTP_ALLOWED_HOSTS` | issuer hostname in team mode | Additional comma-separated allowed `Host` values |

## Team mode

| Variable | Default | Description |
|---|---|---|
| `MCP_TEAM_MODE` | off | Enable team mode; requires HTTP |
| `MCP_TEAM_ISSUER_URL` | — | Public server URL; equivalent to `--issuer-url` |
| `MCP_TEAM_ALLOWED_DOMAINS` | any Google account | Comma-separated Workspace domains allowed to sign in |
| `MCP_TEAM_ALLOWED_REDIRECT_URIS` | open | Comma-separated allowlist for dynamically registered client redirects |
| `MCP_TEAM_TOKEN_TTL` | `3600` | Access-token lifetime in seconds, from 60 through 86400 |
| `MCP_TEAM_STORE` | `file` | `file` or `memory` |
| `MCP_TEAM_STORE_PATH` | config-directory `team-store.json` | Persistent team-store path |
| `MCP_TRUST_PROXY` | unset | Number of trusted reverse-proxy hops |

## Service account mode

| Variable | Description |
|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a service-account JSON key; activates service-account mode |
| `GOOGLE_DRIVE_MCP_SUBJECT` | Optional Workspace user to impersonate through domain-wide delegation |

## External OAuth token mode

| Variable | Description |
|---|---|
| `GOOGLE_DRIVE_MCP_ACCESS_TOKEN` | Pre-obtained access token; activates external-token mode |
| `GOOGLE_DRIVE_MCP_REFRESH_TOKEN` | Optional refresh token |
| `GOOGLE_DRIVE_MCP_CLIENT_ID` | Required with a refresh token |
| `GOOGLE_DRIVE_MCP_CLIENT_SECRET` | Required with a refresh token |

## Deprecated variables

| Variable | Replacement |
|---|---|
| `GOOGLE_TOKEN_PATH` | `GOOGLE_DRIVE_MCP_TOKEN_PATH` |
| `GOOGLE_CLIENT_SECRET_PATH` | `GOOGLE_DRIVE_OAUTH_CREDENTIALS` |

See [Authentication](authentication.md) for identity behavior and [Deployment](deployment.md) for HTTP, Docker, and team-mode guidance.
