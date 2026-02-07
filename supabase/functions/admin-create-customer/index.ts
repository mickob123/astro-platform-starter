/**
 * Admin: Create a new customer with an API key.
 *
 * Auth: Supabase JWT + admin role check (double-layered with gateway JWT verification).
 * This function should be deployed WITHOUT --no-verify-jwt for defense-in-depth.
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyJwt, requireAdmin, AuthError } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    // Double auth: gateway JWT + function-level admin check
    const { user } = await verifyJwt(req);
    requireAdmin(user);

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { name, email, slack_webhook_url, accounting_system } = body;

    if (!name || !email) {
      return new Response(
        JSON.stringify({ error: "name and email are required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // Use service role for admin operations
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Create customer
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .insert({
        name,
        email,
        slack_webhook_url: slack_webhook_url || null,
        accounting_system: accounting_system || null,
        is_active: true,
      })
      .select("id, name, email")
      .single();

    if (customerError) {
      if (customerError.code === "23505") {
        return new Response(
          JSON.stringify({ error: "A customer with this email already exists" }),
          { status: 409, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Failed to create customer: ${customerError.message}`);
    }

    // Generate API key
    const rawKey = generateApiKey();
    const keyHash = await hashApiKey(rawKey);

    const { error: keyError } = await supabase.from("api_keys").insert({
      customer_id: customer.id,
      key_hash: keyHash,
      label: `Default key for ${name}`,
      is_active: true,
    });

    if (keyError) throw new Error(`Failed to create API key: ${keyError.message}`);

    return new Response(
      JSON.stringify({
        customer,
        api_key: rawKey,
        note: "Save this API key now — it cannot be retrieved later.",
      }),
      { status: 201, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    console.error("admin-create-customer error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to create customer" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `inv_${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
