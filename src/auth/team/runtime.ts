// ---------------------------------------------------------------------------
// Team-mode runtime assembly: config → store + Google IdP client + provider +
// callback handler, plus the periodic sweeper that bounds store growth.
// Tests inject an in-memory store and a fake IdP through `overrides`.
// ---------------------------------------------------------------------------

import type { RequestHandler } from 'express';
import { loadWebCredentials } from '../client.js';
import { makeGoogleCallbackHandler } from './callback.js';
import type { TeamConfig } from './config.js';
import { FileTeamStore } from './fileStore.js';
import { GoogleIdp, GoogleIdpClient } from './googleIdp.js';
import { InMemoryTeamStore } from './memoryStore.js';
import { TeamOAuthProvider } from './provider.js';
import type { TeamStore } from './types.js';

const SWEEP_INTERVAL_MS = 60 * 1000;

export interface TeamRuntime {
  config: TeamConfig;
  store: TeamStore;
  idp: GoogleIdp;
  provider: TeamOAuthProvider;
  callbackHandler: RequestHandler;
  /** Stops the background sweep timer (tests, shutdown). */
  stop(): void;
}

export interface TeamRuntimeOverrides {
  store?: TeamStore;
  idp?: GoogleIdp;
  /** Called after a user (re-)authorizes; the dispatch layer hooks per-user
   * client-cache eviction here. */
  onUserAuthorized?: (sub: string) => void;
}

export async function createTeamRuntime(
  config: TeamConfig,
  overrides: TeamRuntimeOverrides = {},
): Promise<TeamRuntime> {
  const store =
    overrides.store ??
    (config.store === 'file' ? new FileTeamStore(config.storePath) : new InMemoryTeamStore());
  await store.init();

  let idp = overrides.idp;
  if (!idp) {
    const credentials = await loadWebCredentials(config.googleRedirectUri);
    idp = new GoogleIdpClient({
      clientId: credentials.client_id,
      clientSecret: credentials.client_secret,
      redirectUri: config.googleRedirectUri,
      scopes: config.googleScopes,
      hdHint: config.allowedDomains.length === 1 ? config.allowedDomains[0] : undefined,
    });
  }

  const provider = new TeamOAuthProvider({ store, idp, config });
  const callbackHandler = makeGoogleCallbackHandler({
    store,
    idp,
    config,
    onUserAuthorized: overrides.onUserAuthorized,
  });

  const sweeper = setInterval(() => {
    store.sweepExpired().catch((err) => {
      console.error(`[team-auth] Store sweep failed: ${(err as Error).message}`);
    });
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  return {
    config,
    store,
    idp,
    provider,
    callbackHandler,
    stop: () => clearInterval(sweeper),
  };
}
