// Shared test helper for temporarily mutating process.env.
import { allAuthModeOverrideEnvVars } from '../../src/auth/externalAuth.js';

/** Temporarily set (undefined = unset) env vars; returns restore() to revert. */
export function setEnv(vars: Record<string, string | undefined>): { restore: () => void } {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return {
    restore() {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/**
 * Unsets every env var that forces a non-OAuth auth mode, so a test needing
 * the local OAuth path does not depend on the shell it happens to run in.
 *
 * The list comes from `allAuthModeOverrideEnvVars()` rather than being spelled
 * out here, so a variable added to that map later is cleared in every test that
 * uses this helper instead of failing a handful of them from the environment.
 *
 * `extra` is applied after the clearing, for tests that then want one set.
 */
export function clearAuthModeOverrides(
  extra: Record<string, string | undefined> = {},
): { restore: () => void } {
  const vars: Record<string, string | undefined> = {};
  for (const name of allAuthModeOverrideEnvVars()) vars[name] = undefined;
  return setEnv({ ...vars, ...extra });
}
