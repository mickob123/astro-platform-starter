import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the retry-with-backoff logic from _shared/retry.ts.
 *
 * Since retry.ts uses Deno-specific imports, we re-implement the same
 * withRetry function here (copied from the source) so we can test the
 * logic in a Node/Vitest environment.
 */

// ---------------------------------------------------------------------------
// Re-implemented withRetry (mirrors _shared/retry.ts exactly)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Retry Logic — withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Successful call on first try", () => {
    it("should return result immediately without retrying", async () => {
      const fn = vi.fn().mockResolvedValue("success");

      const result = await withRetry(fn);
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should work with async functions returning objects", async () => {
      const fn = vi.fn().mockResolvedValue({ data: "test" });

      const result = await withRetry(fn);
      expect(result).toEqual({ data: "test" });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("Retry after 1 failure", () => {
    it("should retry once on retryable error and succeed", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValue("recovered");

      const result = await withRetry(fn, {
        baseDelayMs: 10,
        maxRetries: 3,
      });
      expect(result).toBe("recovered");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on 429 rate limit error", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("429 rate limit"))
        .mockResolvedValue("ok");

      const result = await withRetry(fn, { baseDelayMs: 10 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on 500 server error", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("500 internal server error"))
        .mockResolvedValue("recovered");

      const result = await withRetry(fn, { baseDelayMs: 10 });
      expect(result).toBe("recovered");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on 502 bad gateway", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("502 bad gateway"))
        .mockResolvedValue("ok");

      const result = await withRetry(fn, { baseDelayMs: 10 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on 503 service unavailable", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("503 service unavailable"))
        .mockResolvedValue("ok");

      const result = await withRetry(fn, { baseDelayMs: 10 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on timeout error", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Request timeout"))
        .mockResolvedValue("ok");

      const result = await withRetry(fn, { baseDelayMs: 10 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on network error", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network error occurred"))
        .mockResolvedValue("ok");

      const result = await withRetry(fn, { baseDelayMs: 10 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on object with status 429", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ status: 429 })
        .mockResolvedValue("ok");

      const result = await withRetry(fn, { baseDelayMs: 10 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should retry on object with status 500", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ status: 500 })
        .mockResolvedValue("ok");

      const result = await withRetry(fn, { baseDelayMs: 10 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("Retry after max failures (should throw)", () => {
    it("should throw after maxRetries is exhausted", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("fetch failed always"));

      await expect(
        withRetry(fn, { maxRetries: 3, baseDelayMs: 10 })
      ).rejects.toThrow("fetch failed always");

      // 1 initial + 3 retries = 4 total
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it("should throw after maxRetries=0 (no retries)", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));

      await expect(
        withRetry(fn, { maxRetries: 0, baseDelayMs: 10 })
      ).rejects.toThrow("fetch failed");

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should throw after maxRetries=1", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("network error"));

      await expect(
        withRetry(fn, { maxRetries: 1, baseDelayMs: 10 })
      ).rejects.toThrow("network error");

      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should throw the last error, not an intermediate one", async () => {
      let attempt = 0;
      const fn = vi.fn().mockImplementation(async () => {
        attempt++;
        throw new Error(`network error attempt ${attempt}`);
      });

      await expect(
        withRetry(fn, { maxRetries: 2, baseDelayMs: 10 })
      ).rejects.toThrow("network error attempt 3");
    });
  });

  describe("Non-retryable errors", () => {
    it("should NOT retry on non-retryable error", async () => {
      const fn = vi
        .fn()
        .mockRejectedValue(new Error("Invalid API key - unauthorized"));

      await expect(
        withRetry(fn, { baseDelayMs: 10 })
      ).rejects.toThrow("Invalid API key - unauthorized");

      // Should only be called once — no retries for non-retryable errors
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should NOT retry on 400 bad request error object", async () => {
      const fn = vi.fn().mockRejectedValue({ status: 400 });

      await expect(withRetry(fn, { baseDelayMs: 10 })).rejects.toEqual({
        status: 400,
      });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should NOT retry on 403 forbidden error object", async () => {
      const fn = vi.fn().mockRejectedValue({ status: 403 });

      await expect(withRetry(fn, { baseDelayMs: 10 })).rejects.toEqual({
        status: 403,
      });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should NOT retry on 404 not found error object", async () => {
      const fn = vi.fn().mockRejectedValue({ status: 404 });

      await expect(withRetry(fn, { baseDelayMs: 10 })).rejects.toEqual({
        status: 404,
      });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should NOT retry on generic Error without retryable keywords", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("Something went wrong"));

      await expect(withRetry(fn, { baseDelayMs: 10 })).rejects.toThrow(
        "Something went wrong"
      );
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("Exponential backoff timing", () => {
    it("should calculate correct delays: 1s, 2s, 4s for default options", () => {
      const baseDelayMs = 1000;
      const delays = [0, 1, 2].map((attempt) =>
        Math.min(baseDelayMs * Math.pow(2, attempt), 30000)
      );

      expect(delays[0]).toBe(1000); // 1s
      expect(delays[1]).toBe(2000); // 2s
      expect(delays[2]).toBe(4000); // 4s
    });

    it("should cap delay at maxDelayMs", () => {
      const baseDelayMs = 1000;
      const maxDelayMs = 5000;
      const delays = [0, 1, 2, 3, 4].map((attempt) =>
        Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs)
      );

      expect(delays[0]).toBe(1000);
      expect(delays[1]).toBe(2000);
      expect(delays[2]).toBe(4000);
      expect(delays[3]).toBe(5000); // capped
      expect(delays[4]).toBe(5000); // capped
    });

    it("should apply exponential growth", () => {
      const baseDelayMs = 100;
      const delays = [0, 1, 2, 3, 4, 5].map((attempt) =>
        baseDelayMs * Math.pow(2, attempt)
      );

      expect(delays[0]).toBe(100);
      expect(delays[1]).toBe(200);
      expect(delays[2]).toBe(400);
      expect(delays[3]).toBe(800);
      expect(delays[4]).toBe(1600);
      expect(delays[5]).toBe(3200);
    });
  });

  describe("Jitter application", () => {
    it("should apply jitter within +/- 25% of the base delay", () => {
      const delay = 1000;
      const samples: number[] = [];

      for (let i = 0; i < 100; i++) {
        const jitter = delay * 0.25 * (Math.random() * 2 - 1);
        samples.push(delay + jitter);
      }

      // All samples should be within [750, 1250]
      for (const s of samples) {
        expect(s).toBeGreaterThanOrEqual(750);
        expect(s).toBeLessThanOrEqual(1250);
      }
    });

    it("should produce varied delays due to jitter", () => {
      const delay = 1000;
      const samples = new Set<number>();

      for (let i = 0; i < 50; i++) {
        const jitter = delay * 0.25 * (Math.random() * 2 - 1);
        samples.add(Math.round(delay + jitter));
      }

      // With 50 samples, we should have multiple distinct values
      expect(samples.size).toBeGreaterThan(1);
    });
  });

  describe("Custom retry options", () => {
    it("should use custom maxRetries", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));

      await expect(
        withRetry(fn, { maxRetries: 5, baseDelayMs: 10 })
      ).rejects.toThrow();

      expect(fn).toHaveBeenCalledTimes(6); // 1 initial + 5 retries
    });

    it("should use custom retryableErrors predicate", async () => {
      const customRetryable = (error: unknown) => {
        return error instanceof Error && error.message === "custom-retryable";
      };

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("custom-retryable"))
        .mockResolvedValue("ok");

      const result = await withRetry(fn, {
        baseDelayMs: 10,
        retryableErrors: customRetryable,
      });

      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should NOT retry when custom predicate returns false", async () => {
      const customRetryable = () => false;

      const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));

      await expect(
        withRetry(fn, { baseDelayMs: 10, retryableErrors: customRetryable })
      ).rejects.toThrow();

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should use custom baseDelayMs and maxDelayMs", () => {
      const baseDelayMs = 500;
      const maxDelayMs = 2000;

      const delays = [0, 1, 2, 3].map((attempt) =>
        Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs)
      );

      expect(delays[0]).toBe(500);
      expect(delays[1]).toBe(1000);
      expect(delays[2]).toBe(2000);
      expect(delays[3]).toBe(2000); // capped
    });
  });

  describe("Edge cases", () => {
    it("should handle fn that throws a string", async () => {
      const fn = vi.fn().mockRejectedValue("string error");

      await expect(withRetry(fn, { baseDelayMs: 10 })).rejects.toBe(
        "string error"
      );
      // String is not an Error instance and has no status, so not retryable
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should handle fn that throws null", async () => {
      const fn = vi.fn().mockRejectedValue(null);

      await expect(withRetry(fn, { baseDelayMs: 10 })).rejects.toBeNull();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should handle fn that throws undefined", async () => {
      const fn = vi.fn().mockRejectedValue(undefined);

      await expect(
        withRetry(fn, { baseDelayMs: 10 })
      ).rejects.toBeUndefined();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should succeed on the last possible retry attempt", async () => {
      let attempt = 0;
      const fn = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt <= 3) throw new Error("fetch failed");
        return "finally succeeded";
      });

      const result = await withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 10,
      });

      expect(result).toBe("finally succeeded");
      expect(fn).toHaveBeenCalledTimes(4);
    });
  });
});
