/**
 * Retry wrapper with exponential backoff.
 * Use for external API calls (OpenAI, Slack webhooks, etc.)
 * so a transient failure does not lose an invoice.
 */

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableErrors?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableErrors: (error: unknown) => {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      // Retry on network errors, rate limits, and server errors
      if (msg.includes("fetch failed") || msg.includes("network")) return true;
      if (msg.includes("rate limit") || msg.includes("429")) return true;
      if (msg.includes("500") || msg.includes("502") || msg.includes("503")) return true;
      if (msg.includes("timeout")) return true;
    }
    // Retry on Response objects with retryable status codes
    if (error && typeof error === "object" && "status" in error) {
      const status = (error as { status: number }).status;
      return status === 429 || status >= 500;
    }
    return false;
  },
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === opts.maxRetries) break;
      if (!opts.retryableErrors(error)) break;

      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt),
        opts.maxDelayMs,
      );
      // Add jitter: ±25%
      const jitter = delay * 0.25 * (Math.random() * 2 - 1);
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }

  throw lastError;
}
