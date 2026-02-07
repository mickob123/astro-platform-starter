/**
 * Authentication utilities for Supabase Edge Functions.
 *
 * Two auth modes:
 *   1. JWT auth — for admin dashboard (Supabase Auth users)
 *   2. API key auth — for external callers (n8n, webhooks)
 *
 * Tenant isolation: every DB query must be scoped to the authenticated
 * customer_id. The auth functions return the customer context so callers
 * can enforce this.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

interface JwtAuthResult {
  user: { id: string; email?: string; app_metadata: Record<string, unknown> };
  supabase: SupabaseClient;
}

interface ApiKeyAuthResult {
  customer_id: string;
  supabase: SupabaseClient;
}

/**
 * Verify a Supabase JWT from the Authorization header.
 * Returns the authenticated user and a Supabase client scoped to that user.
 */
export async function verifyJwt(req: Request): Promise<JwtAuthResult> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AuthError("Missing or invalid Authorization header");
  }

  const token = authHeader.replace("Bearer ", "");
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new AuthError("Invalid or expired token");
  }

  return { user: user as JwtAuthResult["user"], supabase };
}

/**
 * Require the authenticated user to have admin role.
 * Checks app_metadata.role === "admin".
 */
export function requireAdmin(user: JwtAuthResult["user"]): void {
  if (user.app_metadata?.role !== "admin") {
    throw new AuthError("Admin access required", 403);
  }
}

/**
 * Verify an API key from the x-api-key header.
 * Looks up the key in the api_keys table and returns the associated customer_id.
 * Uses the service role key so RLS is bypassed for the lookup itself.
 */
export async function verifyApiKey(req: Request): Promise<ApiKeyAuthResult> {
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey) {
    throw new AuthError("Missing x-api-key header");
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data, error } = await supabase
    .from("api_keys")
    .select("customer_id, is_active")
    .eq("key_hash", await hashApiKey(apiKey))
    .single();

  if (error || !data) {
    throw new AuthError("Invalid API key");
  }

  if (!data.is_active) {
    throw new AuthError("API key is inactive");
  }

  return { customer_id: data.customer_id, supabase };
}

/**
 * SHA-256 hash of an API key for safe storage/lookup.
 * API keys are never stored in plaintext.
 */
async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
