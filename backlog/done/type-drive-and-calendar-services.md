# Type drive and calendar service variables

**File:** `src/index.ts`, lines 22 and 25
**Severity:** Medium

## Problem

Both module-level service variables are typed as `any`:

```ts
let drive: any = null;
let calendar: any = null;
```

Every `drive.files.list(...)`, `calendar.events.insert(...)`, etc. has zero type checking — wrong field names, missing required params, and typos in response access all compile silently.

## Fix

Use the proper types from googleapis:

```ts
import type { drive_v3, calendar_v3 } from 'googleapis';

let drive: drive_v3.Drive | null = null;
let calendar: calendar_v3.Calendar | null = null;
```

This will surface compile-time errors for incorrect API usage. Pairs well with the lazy-service-initialization and split-index-into-modules todos.

## Source

Identified during PR #12 code review.
