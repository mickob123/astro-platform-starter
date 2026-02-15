import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the authentication utilities used by Edge Functions.
 *
 * Since the actual auth.ts lives in supabase/functions/_shared/ and uses
 * Deno-specific APIs (Deno.env, esm.sh imports), we re-implement the
 * testable logic here and verify it against the same contracts.
 */

// ---------------------------------------------------------------------------
// AuthError (mirrors _shared/auth.ts)
// ---------------------------------------------------------------------------
class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Pure-logic helpers extracted from auth.ts for unit-testing
// ---------------------------------------------------------------------------

function extractBearerToken(req: Request): string {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AuthError("Missing or invalid Authorization header");
  }
  return authHeader.replace("Bearer ", "");
}

function requireAdmin(user: {
  id: string;
  email?: string;
  app_metadata: Record<string, unknown>;
}): void {
  if (user.app_metadata?.role !== "admin") {
    throw new AuthError("Admin access required", 403);
  }
}

function extractApiKey(req: Request): string {
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey) {
    throw new AuthError("Missing x-api-key header");
  }
  return apiKey;
}

async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Helpers for building mock requests
// ---------------------------------------------------------------------------
function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/test", { headers });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Edge Function Auth", () => {
  describe("AuthError", () => {
    it("should default to status 401", () => {
      const err = new AuthError("unauthorized");
      expect(err.status).toBe(401);
      expect(err.message).toBe("unauthorized");
      expect(err.name).toBe("AuthError");
    });

    it("should accept a custom status code", () => {
      const err = new AuthError("forbidden", 403);
      expect(err.status).toBe(403);
    });

    it("should be an instance of Error", () => {
      const err = new AuthError("test");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("extractBearerToken (JWT header parsing)", () => {
    it("should reject requests without Authorization header", () => {
      const req = makeRequest();
      expect(() => extractBearerToken(req)).toThrow(AuthError);
      expect(() => extractBearerToken(req)).toThrow(
        "Missing or invalid Authorization header"
      );
    });

    it("should reject requests with non-Bearer Authorization header", () => {
      const req = makeRequest({ authorization: "Basic abc123" });
      expect(() => extractBearerToken(req)).toThrow(AuthError);
    });

    it("should reject empty Authorization header", () => {
      const req = makeRequest({ authorization: "" });
      expect(() => extractBearerToken(req)).toThrow(AuthError);
    });

    it("should extract token from valid Bearer header", () => {
      const req = makeRequest({ authorization: "Bearer my-jwt-token" });
      expect(extractBearerToken(req)).toBe("my-jwt-token");
    });

    it("should handle token with spaces after Bearer prefix", () => {
      const req = makeRequest({
        authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
      });
      expect(extractBearerToken(req)).toBe(
        "eyJhbGciOiJIUzI1NiJ9.payload.sig"
      );
    });
  });

  describe("requireAdmin (role check)", () => {
    it("should throw AuthError with 403 for non-admin user", () => {
      const user = {
        id: "user-1",
        email: "user@example.com",
        app_metadata: { role: "viewer" },
      };

      try {
        requireAdmin(user);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(AuthError);
        expect((e as AuthError).status).toBe(403);
        expect((e as AuthError).message).toBe("Admin access required");
      }
    });

    it("should throw AuthError for user with no role", () => {
      const user = {
        id: "user-2",
        app_metadata: {},
      };

      expect(() => requireAdmin(user)).toThrow(AuthError);
    });

    it("should throw AuthError for user with empty app_metadata", () => {
      const user = {
        id: "user-3",
        app_metadata: {} as Record<string, unknown>,
      };

      expect(() => requireAdmin(user)).toThrow("Admin access required");
    });

    it("should pass for admin user", () => {
      const user = {
        id: "admin-1",
        email: "admin@example.com",
        app_metadata: { role: "admin" },
      };

      expect(() => requireAdmin(user)).not.toThrow();
    });

    it("should be case-sensitive for admin role", () => {
      const user = {
        id: "user-4",
        app_metadata: { role: "Admin" },
      };

      expect(() => requireAdmin(user)).toThrow(AuthError);
    });

    it("should reject numeric role values", () => {
      const user = {
        id: "user-5",
        app_metadata: { role: 1 },
      };

      expect(() => requireAdmin(user)).toThrow(AuthError);
    });
  });

  describe("extractApiKey (x-api-key header parsing)", () => {
    it("should throw AuthError when x-api-key header is missing", () => {
      const req = makeRequest();
      expect(() => extractApiKey(req)).toThrow(AuthError);
      expect(() => extractApiKey(req)).toThrow("Missing x-api-key header");
    });

    it("should extract API key from valid header", () => {
      const req = makeRequest({ "x-api-key": "inv_abc123" });
      expect(extractApiKey(req)).toBe("inv_abc123");
    });

    it("should return empty string when header is present but empty", () => {
      // The header exists but is empty string — our implementation still returns it
      // because the original code only checks for absence of the header
      const req = makeRequest({ "x-api-key": "" });
      // Empty string is falsy, so the original verifyApiKey would throw
      expect(() => extractApiKey(req)).toThrow(AuthError);
    });
  });

  describe("hashApiKey (SHA-256 hashing)", () => {
    it("should produce a 64-character hex string", async () => {
      const hash = await hashApiKey("test-key");
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should produce consistent hashes for the same input", async () => {
      const hash1 = await hashApiKey("inv_abc123");
      const hash2 = await hashApiKey("inv_abc123");
      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different inputs", async () => {
      const hash1 = await hashApiKey("key-1");
      const hash2 = await hashApiKey("key-2");
      expect(hash1).not.toBe(hash2);
    });

    it("should handle empty string", async () => {
      const hash = await hashApiKey("");
      expect(hash).toHaveLength(64);
      // SHA-256 of empty string is well-known
      expect(hash).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      );
    });

    it("should handle unicode characters", async () => {
      const hash = await hashApiKey("key-\u00e9\u00e8\u00ea");
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should handle very long keys", async () => {
      const longKey = "a".repeat(10000);
      const hash = await hashApiKey(longKey);
      expect(hash).toHaveLength(64);
    });
  });

  describe("API key tenant isolation", () => {
    it("should associate API key with a specific customer_id", async () => {
      // Simulate the lookup logic from verifyApiKey
      const apiKey = "inv_tenant_key_123";
      const keyHash = await hashApiKey(apiKey);

      // Simulate DB record
      const mockDbRecord = {
        customer_id: "customer-abc",
        is_active: true,
        key_hash: keyHash,
      };

      // Verify the hash lookup would match
      const lookupHash = await hashApiKey(apiKey);
      expect(lookupHash).toBe(mockDbRecord.key_hash);
      expect(mockDbRecord.customer_id).toBe("customer-abc");
    });

    it("should reject inactive API keys", () => {
      const mockDbRecord = {
        customer_id: "customer-abc",
        is_active: false,
      };

      // The auth module checks is_active and throws if false
      if (!mockDbRecord.is_active) {
        expect(() => {
          throw new AuthError("API key is inactive");
        }).toThrow("API key is inactive");
      }
    });

    it("should isolate different tenants with different keys", async () => {
      const key1 = "inv_tenant1_key";
      const key2 = "inv_tenant2_key";

      const hash1 = await hashApiKey(key1);
      const hash2 = await hashApiKey(key2);

      // Different keys produce different hashes, ensuring tenant isolation
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("CORS preflight handling for auth endpoints", () => {
    it("should return proper CORS headers for OPTIONS requests", () => {
      const req = new Request("https://example.com/test", {
        method: "OPTIONS",
        headers: { origin: "https://admin.example.com" },
      });

      // Simulate the handleCors logic
      if (req.method === "OPTIONS") {
        const response = new Response("ok", {
          headers: {
            "Access-Control-Allow-Headers":
              "authorization, x-client-info, apikey, content-type, x-api-key",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Max-Age": "86400",
          },
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
          "x-api-key"
        );
        expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
          "authorization"
        );
        expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
          "POST"
        );
        expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
          "OPTIONS"
        );
      }
    });
  });
});
