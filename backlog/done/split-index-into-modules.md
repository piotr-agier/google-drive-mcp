# Split index.ts into per-domain tool modules

**File:** `src/index.ts` (6200+ lines)
**Severity:** Critical (maintainability)

## Problem

All tool definitions, schemas, helpers, and handlers live in a single 6200+ line file with one massive `switch` statement. This makes it hard to navigate, review, and test individual tools in isolation.

## Proposed structure

```
src/
  index.ts              — server setup, auth, CLI, tool registration
  tools/
    calendar.ts         — Calendar schemas, helpers, handlers
    docs.ts             — Google Docs editing schemas, helpers, handlers
    sheets.ts           — Sheets schemas, helpers, handlers
    comments.ts         — Comment tool schemas, handlers
    slides.ts           — Slides schemas, helpers, handlers
    drive.ts            — Drive file ops (search, create, move, copy, upload, download)
```

Each module exports its tool definitions (for `ListToolsRequestSchema`) and a handler function (for the `switch` in `CallToolRequestSchema`). `index.ts` imports and registers them.

## Scope

Mechanical refactor — no behavior changes. Pairs well with the lazy-service-initialization todo.

## Source

Identified during PR #12 code review.
