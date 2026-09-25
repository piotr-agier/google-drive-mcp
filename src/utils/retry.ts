// Retry/timeout helpers. The implementation lives in ./retry.core.js (plain JS)
// so standalone Node scripts can reuse it without a build step; this module is the
// typed entry point the app imports. See ./retry.core.js for the policy details.
export { TimeoutError, withRetry } from './retry.core.js';

// An upload's promise settles only after the body has been transferred, so a
// deadline here bounds the transfer rather than the wait for a response. The
// legitimate duration scales with payload size and the caller's link, so this
// is set well above any plausible upload while still bounding a true stall.
export const UPLOAD_TIMEOUT_MS = 30 * 60_000;
