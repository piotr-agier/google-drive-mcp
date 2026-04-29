import { RuntimeConfig } from './cliArgs.js';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN']);

function isRetryable(err: any): boolean {
  if (!err) return false;
  if (RETRYABLE_STATUS.has(err.code) || RETRYABLE_STATUS.has(err.status)) return true;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('rate limit')) return true;
  return false;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  cfg: RuntimeConfig,
  opLabel = 'operation'
): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= cfg.retryMax; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === cfg.retryMax) throw err;
      const delay = cfg.retryBaseDelay * Math.pow(2, attempt);
      console.error(`[${opLabel}] retry ${attempt + 1}/${cfg.retryMax} after ${delay}ms:`, (err as any).message);
      await sleep(delay);
    }
  }
  throw lastErr;
}
