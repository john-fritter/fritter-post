/**
 * Shared exponential-backoff utility for LLM calls.
 *
 * Retries two classes of failure, both of which mean "ask again", not "the
 * model answered": rate limits (429/503) and transport failures where the
 * connection died mid-flight.
 *
 * Detects both from the error message (since callLLM re-throws as a plain
 * Error). Honors "Retry-After: N" if the message includes it; otherwise uses
 * exponential backoff with ±25% jitter.
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

/**
 * A connection that died mid-request. Not retried until run #50, when the
 * thread pass lost its single call to `Stream broke at 311715ms after 0 bytes
 * — ... : terminated` and the whole pass produced zero threads. The paper then
 * carried three separate wildfire rows in the top ten, which is precisely the
 * repetition threading exists to remove.
 *
 * A dropped socket says nothing about the request, so re-sending it is correct.
 * That makes this different from a timeout, which is deliberately NOT retried:
 * a call that ran to the configured ceiling was probably going to do it again,
 * and the budget lesson from run #40 was to bound those rather than repeat them.
 */
function isTransientTransportError(msg: string): boolean {
  return (
    /stream broke/i.test(msg) ||
    /\b(ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN)\b/.test(msg) ||
    /socket hang ?up|premature close|connection (reset|closed)|fetch failed/i.test(msg)
  );
}

function isRetryable(msg: string): boolean {
  return isRateLimitError(msg) || isTransientTransportError(msg);
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
      if (!isRetryable(msg) || attempt >= maxAttempts - 1) throw err;

      const retryAfterMs = parseRetryAfterMs(msg);
      const expDelay = Math.min(baseMs * 2 ** attempt, MAX_BACKOFF_MS);
      const jitter = expDelay * (Math.random() * 0.25);
      const delay = (retryAfterMs ?? expDelay) + jitter;

      const kind = isRateLimitError(msg) ? "429/503" : "transport";
      console.warn(
        `[${label}] ${kind} attempt ${attempt + 1}/${maxAttempts}: retrying in ${Math.round(delay)}ms`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
