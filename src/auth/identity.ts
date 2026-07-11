// ---------------------------------------------------------------------------
// Live identity verification
// ---------------------------------------------------------------------------
//
// Nothing else in the server ever asks Google "who am I?". Without that, an
// auth-mode/config mismatch (e.g. GOOGLE_APPLICATION_CREDENTIALS silently
// forcing an empty service account over the user's tokens.json — see issue
// #137) is invisible: every Drive call returns empty with no error. This
// helper resolves the identity the live Drive client is actually acting as.

import type { drive_v3 } from 'googleapis';

/** The account the live Drive client is actually authenticated as. */
export interface EffectiveIdentity {
  emailAddress: string | null;
  displayName: string | null;
  /** Bytes of Drive storage used, as reported by the API (string per Drive API). */
  storageUsage: string | null;
  /** Storage limit in bytes, or null for unlimited / pooled-quota accounts. */
  storageLimit: string | null;
  /** Present only when the identity lookup failed; the message is itself diagnostic. */
  error?: string;
}

/**
 * Ask the Drive API which account the current client is acting as, via
 * `about.get`. Requires only a `drive`/`drive.readonly` scope, both of which
 * are in DEFAULT_SCOPES. Never throws — a failure is returned as `{ error }`
 * so callers (e.g. authGetStatus) can surface it without crashing.
 */
export async function getEffectiveIdentity(drive: drive_v3.Drive): Promise<EffectiveIdentity> {
  try {
    const res = await drive.about.get({
      fields: 'user(displayName,emailAddress),storageQuota(limit,usage)',
    });
    const user = res.data.user;
    const quota = res.data.storageQuota;
    return {
      emailAddress: user?.emailAddress ?? null,
      displayName: user?.displayName ?? null,
      storageUsage: quota?.usage ?? null,
      storageLimit: quota?.limit ?? null,
    };
  } catch (e: unknown) {
    return {
      emailAddress: null,
      displayName: null,
      storageUsage: null,
      storageLimit: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
