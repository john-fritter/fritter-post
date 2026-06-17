/**
 * Shared 429/503 exponential-backoff utility for LLM calls.
 *
 * Detects rate-limit and service-unavailable responses from the error message
 * (since callLLM re-throws as a plain Error). Honors "Retry-After: N" if the
 * message includes it; otherwise uses exponential backoff with ±25% jitter.
 *
 * Consistent with the no-SDK-retry policy (maxRetries: 0 in callLLM): retry
 * logic lives here in application code, not in the HTTP layer.
 */

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_MS = 2000;
const MAX_BACKOFF_MS = 64_000;

function isRateLimitError(msg: string): boolean {
  return (
    /\b(429|503)\b/.test(msg) ||
    /rate.?limit|too many requests|service unavailable/i.test(msg)
  );
}

function parseRetryAfterMs(msg: string): number | null {
  const m = msg.match(/retry[- ]?after[: ]+(\d+)/i);
  return m ? parseInt(m[1]!, 10) * 1000 : null;
}

export interface BackoffConfig {
  retry_max_attempts?: number;
  retry_base_ms?: number;
}

export async function callWithBackoff<T>(
  fn: () => Promise<T>,
  config: BackoffConfig = {},
  label = "llm",
): Promise<T> {
  const maxAttempts = config.retry_max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseMs = config.retry_base_ms ?? DEFAULT_BASE_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRateLimitError(msg) || attempt >= maxAttempts - 1) throw err;

      const retryAfterMs = parseRetryAfterMs(msg);
      const expDelay = Math.min(baseMs * 2 ** attempt, MAX_BACKOFF_MS);
      const jitter = expDelay * (Math.random() * 0.25);
      const delay = (retryAfterMs ?? expDelay) + jitter;

      console.warn(
        `[${label}] 429/503 attempt ${attempt + 1}/${maxAttempts}: retrying in ${Math.round(delay)}ms`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
