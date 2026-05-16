// cliArgs.ts
export interface RuntimeConfig {
  apiTimeout: number;
  retryMax: number;
  retryBaseDelay: number;
  disableResources: boolean;
}

const DEFAULTS: RuntimeConfig = {
  apiTimeout: 120_000,
  retryMax: 3,
  retryBaseDelay: 1_000,
  disableResources: false,
};

function parseIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  // Allow 0: retryMax=0 disables retries, apiTimeout=0 disables the timeout.
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseBoolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return fallback;
}

export function loadRuntimeConfig(argv: string[] = process.argv.slice(2)): RuntimeConfig {
  const cfg: RuntimeConfig = { ...DEFAULTS };

  // Env vars fallback
  cfg.apiTimeout = parseIntOr(process.env.GOOGLE_DRIVE_MCP_API_TIMEOUT, cfg.apiTimeout);
  cfg.retryMax = parseIntOr(process.env.GOOGLE_DRIVE_MCP_RETRY_MAX, cfg.retryMax);
  cfg.retryBaseDelay = parseIntOr(process.env.GOOGLE_DRIVE_MCP_RETRY_BASE_DELAY, cfg.retryBaseDelay);
  cfg.disableResources = parseBoolEnv(process.env.GOOGLE_DRIVE_MCP_DISABLE_RESOURCES, cfg.disableResources);

  // CLI args override (numeric flags: --key=value; boolean flags: presence)
  for (const arg of argv) {
    if (arg.startsWith('--api-timeout=')) {
      cfg.apiTimeout = parseIntOr(arg.split('=')[1], cfg.apiTimeout);
    } else if (arg.startsWith('--retry-max=')) {
      cfg.retryMax = parseIntOr(arg.split('=')[1], cfg.retryMax);
    } else if (arg.startsWith('--retry-base-delay=')) {
      cfg.retryBaseDelay = parseIntOr(arg.split('=')[1], cfg.retryBaseDelay);
    } else if (arg === '--no-resources') {
      cfg.disableResources = true;
    }
  }

  return cfg;
}
