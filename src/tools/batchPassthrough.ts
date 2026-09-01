// Raw batchUpdate passthrough (docs/sheets/slides): validation + lean replies.
//
// Design mirrors Google's own managed MCP servers (docsmcp/sheetsmcp/slidesmcp
// expose essentially read + raw batchUpdate): don't wrap every request type —
// forward the native request array and let the API's atomicity do the work.
// Guardrails: a per-call cap, an optional request-type allowlist, and replies
// summarized compactly (never an echo of the requests or the document).

export interface BatchGuardConfig {
  max: number;
  allowlist?: Set<string>;
}

export function batchGuardConfigFromEnv(): BatchGuardConfig {
  const rawMax = process.env.GOOGLE_DRIVE_MCP_BATCH_MAX;
  const parsed = rawMax ? parseInt(rawMax, 10) : NaN;
  const max = Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
  const rawAllow = process.env.GOOGLE_DRIVE_MCP_BATCH_ALLOWLIST?.trim();
  const allowlist = rawAllow
    ? new Set(rawAllow.split(',').map((s) => s.trim()).filter(Boolean))
    : undefined;
  return { max, allowlist };
}

/**
 * Validate a raw batchUpdate request array: plain objects, exactly one
 * request-type key each, within the cap, and (when configured) allowlisted.
 * Returns null when valid, else a human-readable refusal.
 */
export function validateBatchRequests(requests: unknown, config: BatchGuardConfig): string | null {
  if (!Array.isArray(requests) || requests.length === 0) {
    return 'requests must be a non-empty array of batchUpdate request objects.';
  }
  if (requests.length > config.max) {
    return `requests has ${requests.length} entries — the per-call cap is ${config.max} (set GOOGLE_DRIVE_MCP_BATCH_MAX to change).`;
  }
  for (let i = 0; i < requests.length; i++) {
    const entry = requests[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return `requests[${i}] is not an object.`;
    }
    const keys = Object.keys(entry as Record<string, unknown>);
    if (keys.length !== 1) {
      return `requests[${i}] must have exactly one request-type key (has: ${keys.join(', ') || 'none'}).`;
    }
    if (config.allowlist && !config.allowlist.has(keys[0])) {
      return `requests[${i}] type '${keys[0]}' is not in the configured allowlist (GOOGLE_DRIVE_MCP_BATCH_ALLOWLIST).`;
    }
  }
  return null;
}

/** Count request types for the confirmation line, e.g. "3× insertText, 1× updateParagraphStyle". */
export function summarizeRequestTypes(requests: Array<Record<string, unknown>>): string {
  const counts = new Map<string, number>();
  for (const r of requests) {
    const k = Object.keys(r)[0];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => `${n}× ${k}`).join(', ');
}

/**
 * Lean reply summary: most replies are empty objects; surface only the
 * non-empty ones (reply ids like objectId/replyId are what callers need).
 */
export function summarizeBatchReplies(replies: unknown[] | undefined): string {
  if (!replies || replies.length === 0) return 'no reply payloads';
  const nonEmpty: string[] = [];
  for (let i = 0; i < replies.length; i++) {
    const r = replies[i];
    if (r && typeof r === 'object' && Object.keys(r as object).length > 0) {
      let rendered = JSON.stringify(r);
      if (rendered.length > 400) rendered = rendered.slice(0, 400) + '…';
      nonEmpty.push(`[${i}] ${rendered}`);
    }
  }
  return nonEmpty.length === 0
    ? `${replies.length} replies, all empty (success)`
    : `${replies.length} replies; non-empty: ${nonEmpty.join(' ')}`;
}
