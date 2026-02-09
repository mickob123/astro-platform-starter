import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the CORS configuration from _shared/cors.ts.
 *
 * Since cors.ts uses Deno.env, we re-implement the same logic here
 * to test it in a Node/Vitest environment.
 */

// ---------------------------------------------------------------------------
// Re-implemented CORS utilities (mirrors _shared/cors.ts)
// ---------------------------------------------------------------------------

function getCorsHeaders(
  req: Request,
  allowedOrigins: string[]
): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const isAllowed = allowedOrigins.includes(origin);

  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-api-key",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

function handleCors(
  req: Request,
  allowedOrigins: string[]
): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: getCorsHeaders(req, allowedOrigins) });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeRequest(
  method: string = "GET",
  headers: Record<string, string> = {}
): Request {
  return new Request("https://api.example.com/test", {
    method,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CORS — getCorsHeaders", () => {
  const allowedOrigins = [
    "https://admin.example.com",
    "https://n8n.example.com",
  ];

  describe("Allowed origin", () => {
    it("should return the origin in Access-Control-Allow-Origin for allowed origins", () => {
      const req = makeRequest("GET", {
        origin: "https://admin.example.com",
      });

      const headers = getCorsHeaders(req, allowedOrigins);
      expect(headers["Access-Control-Allow-Origin"]).toBe(
        "https://admin.example.com"
      );
    });

    it("should return correct origin for second allowed origin", () => {
      const req = makeRequest("GET", {
        origin: "https://n8n.example.com",
      });

      const headers = getCorsHeaders(req, allowedOrigins);
      expect(headers["Access-Control-Allow-Origin"]).toBe(
        "https://n8n.example.com"
      );
    });

    it("should include required headers in Allow-Headers", () => {
      const req = makeRequest("GET", {
        origin: "https://admin.example.com",
      });

      const headers = getCorsHeaders(req, allowedOrigins);
      expect(headers["Access-Control-Allow-Headers"]).toContain("authorization");
      expect(headers["Access-Control-Allow-Headers"]).toContain("content-type");
      expect(headers["Access-Control-Allow-Headers"]).toContain("x-api-key");
      expect(headers["Access-Control-Allow-Headers"]).toContain("apikey");
      expect(headers["Access-Control-Allow-Headers"]).toContain(
        "x-client-info"
      );
    });

    it("should include POST, GET, OPTIONS in Allow-Methods", () => {
      const req = makeRequest("GET", {
        origin: "https://admin.example.com",
      });

      const headers = getCorsHeaders(req, allowedOrigins);
      expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
      expect(headers["Access-Control-Allow-Methods"]).toContain("GET");
      expect(headers["Access-Control-Allow-Methods"]).toContain("OPTIONS");
    });

    it("should set Max-Age to 86400 (24 hours)", () => {
      const req = makeRequest("GET", {
        origin: "https://admin.example.com",
      });

      const headers = getCorsHeaders(req, allowedOrigins);
      expect(headers["Access-Control-Max-Age"]).toBe("86400");
    });
  });

  describe("Disallowed origin", () => {
    it("should return empty Access-Control-Allow-Origin for disallowed origin", () => {
      const req = makeRequest("GET", {
        origin: "https://evil.example.com",
      });

      const headers = getCorsHeaders(req, allowedOrigins);
      expect(headers["Access-Control-Allow-Origin"]).toBe("");
    });

    it("should return empty for origin with matching domain but different protocol", () => {
      const req = makeRequest("GET", {
        origin: "http://admin.example.com",
      });

      const headers = getCorsHeaders(req, allowedOrigins);
      expect(headers["Access-Control-Allow-Origin"]).toBe("");
    });

    it("should return empty for origin with extra path component", () => {
      // Note: Origin header never includes a path, but testing defensive behavior
      const req = makeRequest("GET", {
        origin: "https://admin.example.com/extra",
      });

      const headers = getCorsHeaders(req, allowedOrigins);
      expect(headers["Access-Control-Allow-Origin"]).toBe("");
    });

    it("should return empty for subdomain of allowed origin", () => {
      const req = makeRequest("GET", {
        origin: "https://sub.admin.example.com",
      });

      const headers = getCorsHeaders(req, allowedOrigins);
      expect(headers["Access-Control-Allow-Origin"]).toBe("");
    });

    it("should still include other CORS headers even for disallowed origin", () => {
      const req = makeRequest("GET", {
        origin: "https://evil.example.com",
      });

      const headers = getCorsHeaders(req, allowedOrigins);
      // Even though origin is rejected, the other headers are still sent
      expect(headers["Access-Control-Allow-Headers"]).toBeDefined();
      expect(headers["Access-Control-Allow-Methods"]).toBeDefined();
      expect(headers["Access-Control-Max-Age"]).toBeDefined();
    });
  });

  describe("Missing origin header", () => {
    it("should return empty Access-Control-Allow-Origin when origin is missing", () => {
      const req = makeRequest("GET");

      const headers = getCorsHeaders(req, allowedOrigins);
      expect(headers["Access-Control-Allow-Origin"]).toBe("");
    });

    it("should still return other CORS headers when origin is missing", () => {
      const req = makeRequest("GET");

      const headers = getCorsHeaders(req, allowedOrigins);
      expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
      expect(headers["Access-Control-Max-Age"]).toBe("86400");
    });
  });

  describe("Empty allowed origins list", () => {
    it("should reject all origins when allowed list is empty", () => {
      const req = makeRequest("GET", {
        origin: "https://admin.example.com",
      });

      const headers = getCorsHeaders(req, []);
      expect(headers["Access-Control-Allow-Origin"]).toBe("");
    });
  });
});

describe("CORS — handleCors (OPTIONS preflight)", () => {
  const allowedOrigins = ["https://admin.example.com"];

  it("should return a Response for OPTIONS requests", () => {
    const req = makeRequest("OPTIONS", {
      origin: "https://admin.example.com",
    });

    const response = handleCors(req, allowedOrigins);
    expect(response).not.toBeNull();
    expect(response).toBeInstanceOf(Response);
  });

  it("should return 200 status for OPTIONS requests", async () => {
    const req = makeRequest("OPTIONS", {
      origin: "https://admin.example.com",
    });

    const response = handleCors(req, allowedOrigins);
    expect(response!.status).toBe(200);
  });

  it("should return 'ok' body for OPTIONS requests", async () => {
    const req = makeRequest("OPTIONS", {
      origin: "https://admin.example.com",
    });

    const response = handleCors(req, allowedOrigins);
    const body = await response!.text();
    expect(body).toBe("ok");
  });

  it("should include CORS headers in OPTIONS response", () => {
    const req = makeRequest("OPTIONS", {
      origin: "https://admin.example.com",
    });

    const response = handleCors(req, allowedOrigins);
    expect(response!.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://admin.example.com"
    );
    expect(response!.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST"
    );
    expect(response!.headers.get("Access-Control-Allow-Headers")).toContain(
      "authorization"
    );
  });

  it("should return null for non-OPTIONS requests (GET)", () => {
    const req = makeRequest("GET", {
      origin: "https://admin.example.com",
    });

    const response = handleCors(req, allowedOrigins);
    expect(response).toBeNull();
  });

  it("should return null for non-OPTIONS requests (POST)", () => {
    const req = makeRequest("POST", {
      origin: "https://admin.example.com",
    });

    const response = handleCors(req, allowedOrigins);
    expect(response).toBeNull();
  });

  it("should return null for non-OPTIONS requests (PUT)", () => {
    const req = makeRequest("PUT", {
      origin: "https://admin.example.com",
    });

    const response = handleCors(req, allowedOrigins);
    expect(response).toBeNull();
  });

  it("should handle OPTIONS with disallowed origin", () => {
    const req = makeRequest("OPTIONS", {
      origin: "https://evil.example.com",
    });

    const response = handleCors(req, allowedOrigins);
    expect(response).not.toBeNull();
    expect(response!.headers.get("Access-Control-Allow-Origin")).toBe("");
  });

  it("should handle OPTIONS without origin header", () => {
    const req = makeRequest("OPTIONS");

    const response = handleCors(req, allowedOrigins);
    expect(response).not.toBeNull();
    expect(response!.headers.get("Access-Control-Allow-Origin")).toBe("");
  });
});

describe("CORS — Allowed Origins Parsing", () => {
  // Simulates how cors.ts parses the ALLOWED_ORIGINS env variable
  function parseAllowedOrigins(envValue: string): string[] {
    return envValue
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
  }

  it("should parse comma-separated origins", () => {
    const result = parseAllowedOrigins(
      "https://admin.example.com,https://n8n.example.com"
    );
    expect(result).toEqual([
      "https://admin.example.com",
      "https://n8n.example.com",
    ]);
  });

  it("should trim whitespace around origins", () => {
    const result = parseAllowedOrigins(
      "  https://admin.example.com , https://n8n.example.com  "
    );
    expect(result).toEqual([
      "https://admin.example.com",
      "https://n8n.example.com",
    ]);
  });

  it("should filter out empty entries", () => {
    const result = parseAllowedOrigins(
      "https://admin.example.com,,https://n8n.example.com,"
    );
    expect(result).toEqual([
      "https://admin.example.com",
      "https://n8n.example.com",
    ]);
  });

  it("should return empty array for empty string", () => {
    const result = parseAllowedOrigins("");
    expect(result).toEqual([]);
  });

  it("should return empty array for whitespace-only string", () => {
    const result = parseAllowedOrigins("   ");
    expect(result).toEqual([]);
  });

  it("should handle single origin", () => {
    const result = parseAllowedOrigins("https://admin.example.com");
    expect(result).toEqual(["https://admin.example.com"]);
  });
});
