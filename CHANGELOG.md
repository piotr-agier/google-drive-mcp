# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Features

- **calendar:** surface event `attachments` in `getCalendarEvent`/`getCalendarEvents` responses, and accept an `attachments` array (max 25) in `createCalendarEvent`/`updateCalendarEvent` (sets the `supportsAttachments` API flag). `updateCalendarEvent` now also preserves an event's existing attachments instead of silently dropping them when `attachments` is not supplied ([#110](https://github.com/piotr-agier/google-drive-mcp/issues/110))
- **auth:** support Workspace domain-wide delegation via `GOOGLE_DRIVE_MCP_SUBJECT`; `GOOGLE_DRIVE_MCP_SCOPES` is now honored in service-account mode ([#107](https://github.com/piotr-agier/google-drive-mcp/pull/107))
- **resources:** add `GOOGLE_DRIVE_MCP_DISABLE_RESOURCES` env var (and `--no-resources` flag) to opt out of the MCP resource protocol (`gdrive:///` listing/reading); tools stay available. For tools-only clients or clients that hang enumerating a large Drive. The env var and `--no-resources[=<bool>]` accept `1/0`, `true/false`, `yes/no`, `on/off`; `--no-resources=false` re-enables resources, overriding a truthy env value ([#115](https://github.com/piotr-agier/google-drive-mcp/issues/115), [#128](https://github.com/piotr-agier/google-drive-mcp/pull/128))

### Bug Fixes

- **resources:** raise the `resources/list` page size from 10 to 1000 (Drive API max) so clients that eagerly enumerate the entire Drive (e.g. Gemini CLI) no longer hang during initialization ([#111](https://github.com/piotr-agier/google-drive-mcp/issues/111), [#128](https://github.com/piotr-agier/google-drive-mcp/pull/128))
- **docs:** honor `tabId` in `insertTable`, `editTableCell`, `insertSmartChip`, `createFootnote`, `applyTextStyle`/`formatGoogleDocText`, `applyParagraphStyle`/`formatGoogleDocParagraph`, and `createParagraphBullets` — these previously ignored `tabId` and silently edited the default tab of multi-tab documents while reporting success ([#114](https://github.com/piotr-agier/google-drive-mcp/issues/114), [#126](https://github.com/piotr-agier/google-drive-mcp/pull/126))
- **auth:** use loopback IP `127.0.0.1` instead of `localhost` for the OAuth callback redirect URI, matching the IPv4-only callback-server bind so the redirect resolves to the bound address on dual-stack hosts ([#124](https://github.com/piotr-agier/google-drive-mcp/pull/124)). Desktop-app OAuth clients (the recommended type) are unaffected; "Web application" clients that registered a `http://localhost:<port>` redirect must re-register it as `http://127.0.0.1:<port>` or auth fails with `redirect_uri_mismatch` — see README Troubleshooting

### Performance Improvements

- **docs:** `applyParagraphStyle` with `textToFind` + `tabId` now resolves the matched range and its enclosing paragraph from a single `documents.get`, instead of two full unmasked `includeTabsContent` fetches of the same document. The non-tab path is unchanged ([#114](https://github.com/piotr-agier/google-drive-mcp/issues/114), [#127](https://github.com/piotr-agier/google-drive-mcp/pull/127))

## [2.2.0](https://github.com/piotr-agier/google-drive-mcp/compare/v2.1.0...v2.2.0) (2026-04-20)

### Features

- **docs:** add optional `tabId` to `insertText`, `deleteRange`, `findAndReplaceInDoc`, and `updateGoogleDoc` for targeting specific tabs ([e2b5748](https://github.com/piotr-agier/google-drive-mcp/commit/e2b5748), [3bbf24f](https://github.com/piotr-agier/google-drive-mcp/commit/3bbf24f), [6d29b04](https://github.com/piotr-agier/google-drive-mcp/commit/6d29b04))
- **auth:** add `GOOGLE_DRIVE_MCP_AUTH_PORT` env var for configurable OAuth callback port ([95615b3](https://github.com/piotr-agier/google-drive-mcp/commit/95615b3), [f16fc3f](https://github.com/piotr-agier/google-drive-mcp/commit/f16fc3f))
- **drive:** add `emailMessage` support to `addPermission` and `shareFile` ([2fa3f52](https://github.com/piotr-agier/google-drive-mcp/commit/2fa3f52))

### Bug Fixes

- **docs:** fix `renameDocumentTab` ([e2b5748](https://github.com/piotr-agier/google-drive-mcp/commit/e2b5748))

## [2.1.0](https://github.com/piotr-agier/google-drive-mcp/compare/v2.0.2...v2.1.0) (2026-04-14)

### Features

- **slides:** add `insertSlidesImageFromUrl` and `insertSlidesLocalImage` tools ([8d7ae13](https://github.com/piotr-agier/google-drive-mcp/commit/8d7ae13))
- **slides:** add element management tools — move, delete, and inspect slide elements ([cb108df](https://github.com/piotr-agier/google-drive-mcp/commit/cb108df))

## [2.0.2](https://github.com/piotr-agier/google-drive-mcp/compare/v2.0.1...v2.0.2) (2026-04-04)

### Bug Fixes

- **docs:** use correct API field name for tab creation ([08caa89](https://github.com/piotr-agier/google-drive-mcp/commit/08caa89))
- use correct API field name for tab properties update ([8a67c75](https://github.com/piotr-agier/google-drive-mcp/commit/8a67c75))

## [2.0.1](https://github.com/piotr-agier/google-drive-mcp/compare/v2.0.0...v2.0.1) (2026-04-01)

### Bug Fixes

- **slides:** skip deleteText for empty speaker notes in Google Slides ([8f02fd1](https://github.com/piotr-agier/google-drive-mcp/commit/8f02fd1))

## [2.0.0](https://github.com/piotr-agier/google-drive-mcp/compare/v1.7.6...v2.0.0) (2026-03-28)

### Breaking Changes

- The server now supports two transport modes: **stdio** (default, unchanged) and **Streamable HTTP**. CLI arguments have been restructured to accommodate this — see README for details.

### Features

- **transport:** add Streamable HTTP transport mode (`--transport http`) with session management, SSE streaming, and configurable host/port ([f9aa097](https://github.com/piotr-agier/google-drive-mcp/commit/f9aa097))
- **auth:** support service account (`--service-account`) and external OAuth token (`--oauth-token`) authentication ([395ef05](https://github.com/piotr-agier/google-drive-mcp/commit/395ef05))

### Bug Fixes

- **transport:** add error handling to HTTP routes and extract shared route setup ([497e809](https://github.com/piotr-agier/google-drive-mcp/commit/497e809))
- **transport:** add session idle timeout, proper server cleanup, and security warning for non-localhost binding ([71ac0cb](https://github.com/piotr-agier/google-drive-mcp/commit/71ac0cb))

### Tests

- **transport:** add comprehensive HTTP transport and CLI argument tests ([03120c3](https://github.com/piotr-agier/google-drive-mcp/commit/03120c3))

## [1.7.6](https://github.com/piotr-agier/google-drive-mcp/compare/v1.7.5...v1.7.6) (2026-03-18)

### Features

- **docs:** add createFootnote tool ([fc0505a](https://github.com/piotr-agier/google-drive-mcp/commit/fc0505a))
- **docs:** extract tables and TOC in getGoogleDocContent ([5c97c4b](https://github.com/piotr-agier/google-drive-mcp/commit/5c97c4b))
- **docs:** extract inline elements in getGoogleDocContent ([7c7218e](https://github.com/piotr-agier/google-drive-mcp/commit/7c7218e))
- **drive:** add lockFile and unlockFile tools ([0a8b62b](https://github.com/piotr-agier/google-drive-mcp/commit/0a8b62b))
- **drive:** add createShortcut tool ([3b1efac](https://github.com/piotr-agier/google-drive-mcp/commit/3b1efac))

### Bug Fixes

- **docs,drive:** handle createFootnote partial failure, remove as-any casts ([329b8e3](https://github.com/piotr-agier/google-drive-mcp/commit/329b8e3))
- **drive:** unlockFile silently failed to remove content restriction ([efec828](https://github.com/piotr-agier/google-drive-mcp/commit/efec828))
- **docker,auth:** kill stale MCP process and simplify auth callback ([0dd0eba](https://github.com/piotr-agier/google-drive-mcp/commit/0dd0eba))
- **docs:** escape brackets in rich link titles and handle missing inlineObjects ([dfee405](https://github.com/piotr-agier/google-drive-mcp/commit/dfee405))
- **docker:** recreate container when image changes ([95e479b](https://github.com/piotr-agier/google-drive-mcp/commit/95e479b))

## [1.7.5](https://github.com/piotr-agier/google-drive-mcp/compare/v1.7.4...v1.7.5) (2026-03-14)

### Features

- **docker:** add wrapper script to reuse running container ([4945378](https://github.com/piotr-agier/google-drive-mcp/commit/4945378))

### Bug Fixes

- **docker:** improve wrapper script robustness and docs accuracy ([09e7bc9](https://github.com/piotr-agier/google-drive-mcp/commit/09e7bc9))
- **docker:** convert wrapper script line endings from CRLF to LF ([14659f1](https://github.com/piotr-agier/google-drive-mcp/commit/14659f1))
- **docs:** use $HOME instead of ~ in Docker volume mount examples ([ea2755f](https://github.com/piotr-agier/google-drive-mcp/commit/ea2755f))

## [1.7.4](https://github.com/piotr-agier/google-drive-mcp/compare/v1.7.3...v1.7.4) (2026-03-11)

### Bug Fixes

- **auth:** use stable config directory for credentials lookup ([50377ed](https://github.com/piotr-agier/google-drive-mcp/commit/50377ed))

### Refactors

- **auth:** remove dead code, surface parse errors, DRY config path ([661b4ce](https://github.com/piotr-agier/google-drive-mcp/commit/661b4ce))

## [1.7.3](https://github.com/piotr-agier/google-drive-mcp/compare/v1.7.2...v1.7.3) (2026-03-06)

### Features

- **docs:** add comment position context to listComments ([7a31c6f](https://github.com/piotr-agier/google-drive-mcp/commit/7a31c6f))

## [1.7.2](https://github.com/piotr-agier/google-drive-mcp/compare/v1.7.1...v1.7.2) (2026-03-03)

### Features

- **drive:** add convertToGoogleFormat param to uploadFile for native Google Workspace conversion ([4d7fc6d](https://github.com/piotr-agier/google-drive-mcp/commit/4d7fc6d))
- **docs:** add support for nested tabs to readGoogleDoc and getGoogleDocContent ([b0543a6](https://github.com/piotr-agier/google-drive-mcp/commit/b0543a6))

### Bug Fixes

- **sheets:** define nested items for appendSpreadsheetRows values schema ([75a71f5](https://github.com/piotr-agier/google-drive-mcp/commit/75a71f5))

## [1.7.1](https://github.com/piotr-agier/google-drive-mcp/compare/v1.7.0...v1.7.1) (2026-02-27)

### Features

- **search:** resolve folder paths in search results ([b10452b](https://github.com/piotr-agier/google-drive-mcp/commit/b10452b))
- **search:** add rawQuery for direct Google Drive API queries ([1da8349](https://github.com/piotr-agier/google-drive-mcp/commit/1da8349))

### Bug Fixes

- **search:** harden folder resolution and improve output consistency ([7384b8f](https://github.com/piotr-agier/google-drive-mcp/commit/7384b8f))
- remove authClearTokens and authSuggestScopePreset tools ([c373271](https://github.com/piotr-agier/google-drive-mcp/commit/c373271))

## [1.7.0](https://github.com/piotr-agier/google-drive-mcp/compare/v1.6.1...v1.7.0) (2026-02-26)

### Features

- add auth diagnostics and scope preset tools ([b5faad5](https://github.com/piotr-agier/google-drive-mcp/commit/b5faad5))
- add getRevisions and restoreRevision tools ([fc42683](https://github.com/piotr-agier/google-drive-mcp/commit/fc42683))

## [1.6.1](https://github.com/piotr-agier/google-drive-mcp/compare/v1.6.0...v1.6.1) (2026-02-26)

### Bug Fixes

- **search:** add corpora=allDrives so search returns Shared Drive results ([c0b9d6b](https://github.com/piotr-agier/google-drive-mcp/commit/c0b9d6b))

## [1.6.0](https://github.com/piotr-agier/google-drive-mcp/compare/v1.5.0...v1.6.0) (2026-02-26)

### Features

- add PDF ingestion and docs tab/chip transformation tools ([70ccca7](https://github.com/piotr-agier/google-drive-mcp/commit/70ccca7))
- implement real PDF splitting for uploadPdfWithSplit ([53f2b19](https://github.com/piotr-agier/google-drive-mcp/commit/53f2b19))

### Bug Fixes

- **insertSmartChip:** use correct Docs API structure, restrict to person chips only ([11e941a](https://github.com/piotr-agier/google-drive-mcp/commit/11e941a))

## [1.5.0](https://github.com/piotr-agier/google-drive-mcp/compare/v1.4.0...v1.5.0) (2026-02-26)

### Features

- add sheet governance and slide lifecycle tools ([9bc2563](https://github.com/piotr-agier/google-drive-mcp/commit/9bc2563))
- add sheets tab lifecycle and slides lifecycle/template helpers ([0af2a55](https://github.com/piotr-agier/google-drive-mcp/commit/0af2a55))
- add addSheet alias and slide thumbnail export ([d3c12d5](https://github.com/piotr-agier/google-drive-mcp/commit/d3c12d5))

### Bug Fixes

- **drive:** show inherited marker in listPermissions output ([b0423d2](https://github.com/piotr-agier/google-drive-mcp/commit/b0423d2))

## [1.4.0](https://github.com/piotr-agier/google-drive-mcp/compare/v1.3.3...v1.4.0) (2026-02-24)

### Features

- add docs formatting aliases, find/replace, and sharing permission tools ([464abcd](https://github.com/piotr-agier/google-drive-mcp/commit/464abcd))
- make shareFile idempotent by updating existing user permission ([f13e4c5](https://github.com/piotr-agier/google-drive-mcp/commit/f13e4c5))
- add removePermission by email, and find/replace dry-run ([1046046](https://github.com/piotr-agier/google-drive-mcp/commit/1046046))

## [1.3.3](https://github.com/piotr-agier/google-drive-mcp/compare/v1.3.2...v1.3.3) (2026-02-24)

### Bug Fixes

- **docs:** support multi-tab documents in readGoogleDoc ([cd46227](https://github.com/piotr-agier/google-drive-mcp/commit/cd46227))

## [1.3.2](https://github.com/piotr-agier/google-drive-mcp/compare/v1.3.1...v1.3.2) (2026-02-24)

### Features

- **drive:** add listSharedDrives tool ([dc1dd78](https://github.com/piotr-agier/google-drive-mcp/commit/dc1dd78))
- **auth:** allow OAuth scope override via env var ([45f42cb](https://github.com/piotr-agier/google-drive-mcp/commit/45f42cb))

### Bug Fixes

- **schema:** remove non-standard optional field from tool schemas ([943d71d](https://github.com/piotr-agier/google-drive-mcp/commit/943d71d))

## [1.3.1](https://github.com/piotr-agier/google-drive-mcp/compare/v1.3.0...v1.3.1) (2026-02-24)

### Bug Fixes

- CI/CD publishing fixes for npm OIDC trusted publishing ([160c0aa](https://github.com/piotr-agier/google-drive-mcp/commit/160c0aa))

## [1.3.0](https://github.com/piotr-agier/google-drive-mcp/compare/v1.2.0...v1.3.0) (2026-02-24)

### Features

- add includeFormatting option to getGoogleDocContent ([b30d6a0](https://github.com/piotr-agier/google-drive-mcp/commit/b30d6a0))
- add listComments pagination and multi-tab getGoogleDocContent ([a4992fc](https://github.com/piotr-agier/google-drive-mcp/commit/a4992fc))
- enrich fonts summary with sizes and styles per font ([f814577](https://github.com/piotr-agier/google-drive-mcp/commit/f814577))
- add 23 new tools for Calendar, Docs editing, Comments, Formatting ([baa8f6b](https://github.com/piotr-agier/google-drive-mcp/commit/baa8f6b))
- add 5 Phase 2 tools (Sheets management + copyFile) ([446f856](https://github.com/piotr-agier/google-drive-mcp/commit/446f856))
- add downloadFile tool ([95b70a5](https://github.com/piotr-agier/google-drive-mcp/commit/95b70a5))

### Bug Fixes

- bump @modelcontextprotocol/sdk to ^1.24.0 (CVE-2025-66414) ([4cf6024](https://github.com/piotr-agier/google-drive-mcp/commit/4cf6024))
- stop making uploaded images public by default in insertLocalImage ([a4d8df4](https://github.com/piotr-agier/google-drive-mcp/commit/a4d8df4))

## [1.2.0](https://github.com/piotr-agier/google-drive-mcp/compare/v1.1.2...v1.2.0) (2026-02-15)

### Features

- add uploadFile tool for binary file uploads ([4729309](https://github.com/piotr-agier/google-drive-mcp/commit/4729309))
- add Google Slides speaker notes support ([25b249e](https://github.com/piotr-agier/google-drive-mcp/commit/25b249e))
- add shared drives support to all Google Drive API operations ([d09caff](https://github.com/piotr-agier/google-drive-mcp/commit/d09caff))
- add valueInputOption parameter to createGoogleSheet and updateGoogleSheet ([77f56c7](https://github.com/piotr-agier/google-drive-mcp/commit/77f56c7))
- **search:** include file ID in search results ([68f031b](https://github.com/piotr-agier/google-drive-mcp/commit/68f031b))

## [1.1.2](https://github.com/piotr-agier/google-drive-mcp/releases/tag/v1.1.2) (2025-11-26)

### Features

- add pagination support to search tool ([b599b27](https://github.com/piotr-agier/google-drive-mcp/commit/b599b27))
- add comprehensive Google Sheets, Slides, and Docs formatting tools
- add Docker support with comprehensive documentation

### Bug Fixes

- fix sheet name parsing in Google Sheets formatting tools ([de693e5](https://github.com/piotr-agier/google-drive-mcp/commit/de693e5))
- fix 'Sheet not found' error for sheets with ID 0 ([c17fe97](https://github.com/piotr-agier/google-drive-mcp/commit/c17fe97))
