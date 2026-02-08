import { describe, it, expect, vi } from "vitest";

/**
 * The auth module lives at supabase/functions/_shared/auth.ts and relies on
 * Deno-specific imports (esm.sh URLs) and Deno.env. We cannot import it
 * directly in a Node/Vitest environment. Instead we test the portable logic:
 *   - AuthError class behavior
 *   - SHA-256 hashing consistency (via crypto.subtle which Node 20+ supports)
 */

// ---------- Re-implement AuthError locally to test its contract ----------
class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

// ---------- Re-implement hashApiKey locally to test its contract ----------
async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("Auth Utilities", () => {
  describe("AuthError class", () => {
    it("should default to status 401", () => {
      const error = new AuthError("Unauthorized");
      expect(error.status).toBe(401);
      expect(error.message).toBe("Unauthorized");
      expect(error.name).toBe("AuthError");
    });

    it("should accept a custom status code", () => {
      const error = new AuthError("Forbidden", 403);
      expect(error.status).toBe(403);
      expect(error.message).toBe("Forbidden");
    });

    it("should be an instance of Error", () => {
      const error = new AuthError("test");
      expect(error).toBeInstanceOf(Error);
    });

    it("should have correct name property", () => {
      const error = new AuthError("test");
      expect(error.name).toBe("AuthError");
    });

    it("should use 401 for missing token errors", () => {
      const error = new AuthError("Missing or invalid Authorization header");
      expect(error.status).toBe(401);
    });

    it("should use 403 for admin required errors", () => {
      const error = new AuthError("Admin access required", 403);
      expect(error.status).toBe(403);
    });

    it("should preserve the error message", () => {
      const msg = "API key is inactive";
      const error = new AuthError(msg);
      expect(error.message).toBe(msg);
    });

    it("should have a stack trace", () => {
      const error = new AuthError("test");
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain("AuthError");
    });
  });

  describe("SHA-256 hashing (hashApiKey)", () => {
    it("should produce a consistent hash for the same input", async () => {
      const hash1 = await hashApiKey("my-secret-key");
      const hash2 = await hashApiKey("my-secret-key");
      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different inputs", async () => {
      const hash1 = await hashApiKey("key-one");
      const hash2 = await hashApiKey("key-two");
      expect(hash1).not.toBe(hash2);
    });

    it("should return a 64-character hex string (SHA-256 = 256 bits = 64 hex chars)", async () => {
      const hash = await hashApiKey("test-key");
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should produce the known SHA-256 hash for an empty string", async () => {
      const hash = await hashApiKey("");
      // SHA-256 of empty string is well-known
      expect(hash).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      );
    });

    it("should handle special characters", async () => {
      const hash = await hashApiKey("key!@#$%^&*()");
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should handle unicode characters", async () => {
      const hash = await hashApiKey("clave-secreta-");
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should produce different hashes for keys differing by one character", async () => {
      const hash1 = await hashApiKey("abc");
      const hash2 = await hashApiKey("abd");
      expect(hash1).not.toBe(hash2);
    });
  });
});
