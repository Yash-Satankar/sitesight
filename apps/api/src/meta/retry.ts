// Retry with exponential backoff + jitter on 408/409/429/5xx and network errors.
// Same policy as the OpenAI SDK's built-in retries that spark.ts relies on (maxRetries 4 in client.ts),
// for calls that don't go through the SDK's retrying methods.

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
}

const RETRYABLE_STATUS = new Set([408, 409, 429]);

export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === "number") return RETRYABLE_STATUS.has(status) || status >= 500;
  // No status → network-level failure (reset, timeout, DNS).
  const name = (err as { name?: string } | null)?.name ?? "";
  return /APIConnectionError|APIConnectionTimeoutError|FetchError|AbortError|TypeError/.test(name);
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { maxRetries = 4, baseDelayMs = 500, maxDelayMs = 8000, label = "request" } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxRetries || !isRetryable(err)) throw err;
      const retryAfter = retryAfterMs(err);
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      const delay = retryAfter ?? backoff;
      console.warn(`[retry] ${label} failed (${(err as Error).message}); retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)} ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function retryAfterMs(err: unknown): number | null {
  const headers = (err as { headers?: Headers | Record<string, string> } | null)?.headers;
  if (!headers) return null;
  const v = headers instanceof Headers ? headers.get("retry-after") : headers["retry-after"];
  if (!v) return null;
  const secs = Number(v);
  return Number.isFinite(secs) ? Math.min(secs * 1000, 30_000) : null;
}
