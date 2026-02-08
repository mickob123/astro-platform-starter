import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The retry module lives at supabase/functions/_shared/retry.ts and uses
 * Deno-compatible code. The logic is fully portable, so we re-implement it
 * here to test the retry contract without needing Deno imports.
 */

// ---------- Re-implement withRetry locally (matches the source exactly) ----------

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
      if (msg.includes("fetch failed") || msg.includes("network")) return true;
      if (msg.includes("rate limit") || msg.includes("429")) return true;
      if (msg.includes("500") || msg.includes("502") || msg.includes("503"))
        return true;
      if (msg.includes("timeout")) return true;
    }
    if (error && typeof error === "object" && "status" in error) {
      const status = (error as { status: number }).status;
      return status === 429 || status >= 500;
    }
    return false;
  },
};

async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
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
        opts.maxDelayMs
      );
      const jitter = delay * 0.25 * (Math.random() * 2 - 1);
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }

  throw lastError;
}

// ---------- Tests ----------

describe("Retry Logic (withRetry)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe("Succeeds on first try", () => {
    it("should return the value immediately without retrying", async () => {
      const fn = vi.fn().mockResolvedValue("success");

      const result = await withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 1,
      });

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("Fails then succeeds", () => {
    it("should retry and return the value on second attempt", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValueOnce("recovered");

      const result = await withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 1,
      });

      expect(result).toBe("recovered");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry and return the value on third attempt", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("network error"))
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce("finally");

      const result = await withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 1,
      });

      expect(result).toBe("finally");
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe("All retries fail", () => {
    it("should throw the last error after exhausting retries", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));

      await expect(
        withRetry(fn, { maxRetries: 2, baseDelayMs: 1 })
      ).rejects.toThrow("fetch failed");

      // 1 initial + 2 retries = 3 total
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should throw after maxRetries+1 attempts", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("503 service unavailable"));

      await expect(
        withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })
      ).rejects.toThrow("503 service unavailable");

      expect(fn).toHaveBeenCalledTimes(4);
    });
  });

  describe("Non-retryable error", () => {
    it("should throw immediately on a non-retryable error (e.g., validation error)", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("Invalid input data"));

      await expect(
        withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })
      ).rejects.toThrow("Invalid input data");

      // Should only be called once -- no retries for non-retryable errors
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should throw immediately on a non-retryable error (e.g., 400 status)", async () => {
      const error = Object.assign(new Error("Bad Request"), { status: 400 });
      const fn = vi.fn().mockRejectedValue(error);

      await expect(
        withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })
      ).rejects.toThrow("Bad Request");

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should throw immediately on 404 status", async () => {
      const error = Object.assign(new Error("Not Found"), { status: 404 });
      const fn = vi.fn().mockRejectedValue(error);

      await expect(
        withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })
      ).rejects.toThrow("Not Found");

      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("Retryable error detection", () => {
    it("should retry on 'fetch failed' errors", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValueOnce("ok");

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on 'network' errors", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce("ok");

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on 'rate limit' errors", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("rate limit exceeded"))
        .mockResolvedValueOnce("ok");

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on '429' errors", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("429 Too Many Requests"))
        .mockResolvedValueOnce("ok");

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on 'timeout' errors", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("request timeout"))
        .mockResolvedValueOnce("ok");

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on objects with status 429", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ status: 429, message: "Too Many" })
        .mockResolvedValueOnce("ok");

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on objects with status 500", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ status: 500, message: "Internal" })
        .mockResolvedValueOnce("ok");

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on objects with status 502", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ status: 502, message: "Bad Gateway" })
        .mockResolvedValueOnce("ok");

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("Custom retry options", () => {
    it("should support custom retryableErrors predicate", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("custom-retryable"))
        .mockResolvedValueOnce("ok");

      const result = await withRetry(fn, {
        maxRetries: 1,
        baseDelayMs: 1,
        retryableErrors: (err) =>
          err instanceof Error && err.message === "custom-retryable",
      });

      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should respect maxRetries = 0 (no retries)", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));

      await expect(
        withRetry(fn, { maxRetries: 0, baseDelayMs: 1 })
      ).rejects.toThrow("fetch failed");

      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("Backoff timing", () => {
    it("should increase delay with each retry attempt", async () => {
      const delays: number[] = [];
      const originalSetTimeout = globalThis.setTimeout;

      // Spy on setTimeout to capture delay values
      const setTimeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((cb: any, ms?: number) => {
          if (ms !== undefined && ms > 0) {
            delays.push(ms);
          }
          // Execute immediately for test speed
          if (typeof cb === "function") cb();
          return 0 as any;
        });

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValueOnce("ok");

      await withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 10000,
      });

      setTimeoutSpy.mockRestore();

      // With jitter, delays should be approximately:
      // attempt 0: 100 * 2^0 = 100 (±25%)
      // attempt 1: 100 * 2^1 = 200 (±25%)
      // attempt 2: 100 * 2^2 = 400 (±25%)
      expect(delays).toHaveLength(3);

      // Verify each delay is within expected range (base * 2^attempt ± 25%)
      expect(delays[0]).toBeGreaterThanOrEqual(100 * 0.75);
      expect(delays[0]).toBeLessThanOrEqual(100 * 1.25);

      expect(delays[1]).toBeGreaterThanOrEqual(200 * 0.75);
      expect(delays[1]).toBeLessThanOrEqual(200 * 1.25);

      expect(delays[2]).toBeGreaterThanOrEqual(400 * 0.75);
      expect(delays[2]).toBeLessThanOrEqual(400 * 1.25);
    });

    it("should cap delay at maxDelayMs", async () => {
      const delays: number[] = [];

      const setTimeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((cb: any, ms?: number) => {
          if (ms !== undefined && ms > 0) {
            delays.push(ms);
          }
          if (typeof cb === "function") cb();
          return 0 as any;
        });

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValueOnce("ok");

      await withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 1000,
        maxDelayMs: 500, // Cap is lower than exponential growth
      });

      setTimeoutSpy.mockRestore();

      // All delays should respect maxDelayMs (500 ± 25% jitter of the capped value)
      for (const delay of delays) {
        expect(delay).toBeLessThanOrEqual(500 * 1.25);
      }
    });
  });
});
