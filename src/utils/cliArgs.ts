// cliArgs.ts
export interface RuntimeConfig {
  apiTimeout: number;
  retryMax: number;
  retryBaseDelay: number;
}

const DEFAULTS: RuntimeConfig = {
  apiTimeout: 120_000,
  retryMax: 3,
  retryBaseDelay: 1_000,
};

function parseIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadRuntimeConfig(argv: string[] = process.argv.slice(2)): RuntimeConfig {
  const cfg: RuntimeConfig = { ...DEFAULTS };

  // Env vars fallback
  cfg.apiTimeout = parseIntOr(process.env.GOOGLE_DRIVE_MCP_API_TIMEOUT, cfg.apiTimeout);
  cfg.retryMax = parseIntOr(process.env.GOOGLE_DRIVE_MCP_RETRY_MAX, cfg.retryMax);
  cfg.retryBaseDelay = parseIntOr(process.env.GOOGLE_DRIVE_MCP_RETRY_BASE_DELAY, cfg.retryBaseDelay);

  // CLI args override (format: --key=value)
  for (const arg of argv) {
    if (arg.startsWith('--api-timeout=')) {
      cfg.apiTimeout = parseIntOr(arg.split('=')[1], cfg.apiTimeout);
    } else if (arg.startsWith('--retry-max=')) {
      cfg.retryMax = parseIntOr(arg.split('=')[1], cfg.retryMax);
    } else if (arg.startsWith('--retry-base-delay=')) {
      cfg.retryBaseDelay = parseIntOr(arg.split('=')[1], cfg.retryBaseDelay);
    }
  }

  return cfg;
}
