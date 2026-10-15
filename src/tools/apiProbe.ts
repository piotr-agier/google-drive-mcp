// Classifies the outcome of one read-only probe request for authGetStatus'
// `checkApis`. Pure apart from runApiProbe's timer; the requests themselves are
// made by the handler in drive.ts.

export type ApiProbeStatus = 'enabled' | 'disabled' | 'unknown';

export interface ApiProbeResult {
  status: ApiProbeStatus;
  /** Where to enable the API, when Google said. Only set for `disabled`. */
  activationUrl?: string;
  /** Google's message (or the client's, for a network failure). Not set for `enabled`. */
  message?: string;
}

export const DEFAULT_API_PROBE_TIMEOUT_MS = 10_000;

interface GoogleErrorBody {
  code?: number;
  message?: string;
  errors?: Array<{ reason?: string }>;
  details?: Array<{
    '@type'?: string;
    reason?: string;
    metadata?: { activationUrl?: string };
    links?: Array<{ url?: string }>;
  }>;
}

const ACTIVATION_URL_IN_MESSAGE = /https:\/\/console\.(?:developers|cloud)\.google\.com\/apis\/[^\s"']+/;
const DISABLED_MESSAGE = /has not been used in project .* before or it is disabled/i;

function errorBody(err: unknown): GoogleErrorBody | undefined {
  let data = (err as { response?: { data?: unknown } })?.response?.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  const body = (data as { error?: unknown } | undefined)?.error;
  return body && typeof body === 'object' ? (body as GoogleErrorBody) : undefined;
}

function httpStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; response?: { status?: unknown } };
  for (const v of [e?.response?.status, e?.status]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function activationUrl(body: GoogleErrorBody): string | undefined {
  const details = body.details ?? [];
  const fromErrorInfo = details.find((d) => d.metadata?.activationUrl)?.metadata?.activationUrl;
  if (fromErrorInfo) return fromErrorInfo;
  const fromHelp = details
    .flatMap((d) => d.links ?? [])
    .map((l) => l.url)
    .find((u): u is string => !!u && ACTIVATION_URL_IN_MESSAGE.test(u));
  if (fromHelp) return fromHelp;
  return body.message?.match(ACTIVATION_URL_IN_MESSAGE)?.[0];
}

/**
 * A disabled API answers every method with a 403 whose body says so. That is
 * checked first, before anything is read from the status code, because a
 * missing scope is also a 403 and must not be mistaken for it. A 400 or 404
 * means the method itself answered (the probes ask for an id that does not
 * exist), so the API is enabled. Anything else, a missing scope or a network
 * failure included, is `unknown` and carries Google's message rather than a guess.
 */
export function classifyApiProbeError(err: unknown): ApiProbeResult {
  const body = errorBody(err);
  const message = body?.message ?? (err instanceof Error ? err.message : String(err));

  if (body) {
    const disabled =
      (body.details ?? []).some((d) => d.reason === 'SERVICE_DISABLED') ||
      (body.errors ?? []).some((e) => e.reason === 'accessNotConfigured') ||
      DISABLED_MESSAGE.test(body.message ?? '');
    if (disabled) {
      const url = activationUrl(body);
      return { status: 'disabled', message, ...(url ? { activationUrl: url } : {}) };
    }
  }

  const status = httpStatus(err);
  if (status === 400 || status === 404) return { status: 'enabled' };
  return { status: 'unknown', message };
}

/**
 * Runs one probe request. Resolving means the API answered; a throw is
 * classified. A request still pending after `timeoutMs` is aborted and reported
 * as unknown without waiting for it to settle, so one slow API cannot hold up
 * the whole status call.
 */
export async function runApiProbe(
  request: (signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number = DEFAULT_API_PROBE_TIMEOUT_MS,
): Promise<ApiProbeResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ApiProbeResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: 'unknown', message: `Probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
  });
  // Started inside a promise so a request that throws before it is sent (a
  // client that cannot be built) is classified like any other failure.
  const answered = Promise.resolve().then(() => request(controller.signal)).then(
    (): ApiProbeResult => ({ status: 'enabled' }),
    (err: unknown) => classifyApiProbeError(err),
  );
  try {
    return await Promise.race([answered, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
