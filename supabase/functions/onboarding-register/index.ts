/**
 * Onboarding: Register a new user + customer.
 *
 * This function MUST be deployed with --no-verify-jwt because the caller
 * is not yet authenticated.
 *
 * Flow:
 *   1. Create a Supabase Auth user (email + password)
 *   2. Create a customer record linked to that user
 *   3. Generate a default API key for the customer
 *   4. Set app_metadata on the auth user (role, customer_id)
 *   5. Return customer_id + API key (shown once, never stored in plaintext)
 *
 * POST body: { email, password, company_name }
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { email, password, company_name } = body;

    // --- Rate limiting: max 5 registrations globally per hour ---
    // No auth available, so we cap total registrations to prevent spam.
    const rlSupabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const { count: recentRegistrations, error: rlError } = await rlSupabase
      .from("customers")
      .select("id", { count: "exact", head: true })
      .gte("created_at", windowStart);

    if (!rlError && recentRegistrations !== null && recentRegistrations >= 5) {
      return new Response(
        JSON.stringify({ error: "Too many registrations. Please try again later.", retry_after_seconds: 600 }),
        { status: 429, headers: { ...headers, "Content-Type": "application/json", "Retry-After": "600" } },
      );
    }

    if (!email || !password || !company_name) {
      return new Response(
        JSON.stringify({ error: "email, password, and company_name are required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (password.length < 8) {
      return new Response(
        JSON.stringify({ error: "Password must be at least 8 characters" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // --- Check if email already exists in customers ---
    const { data: existingCustomer } = await supabase
      .from("customers")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existingCustomer) {
      return new Response(
        JSON.stringify({ error: "An account with this email already exists" }),
        { status: 409, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Create auth user ---
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // skip email verification for now
    });

    if (authError) {
      console.error("Auth user creation failed:", authError.message);

      if (authError.message.includes("already been registered")) {
        return new Response(
          JSON.stringify({ error: "An account with this email already exists" }),
          { status: 409, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ error: "Failed to create account" }),
        { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    const userId = authData.user.id;

    // --- Create customer record ---
    const slug = company_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .insert({
        name: company_name,
        slug,
        email,
        is_active: true,
        auth_user_id: userId,
        onboarding_step: "company_details",
      })
      .select("id")
      .single();

    if (customerError) {
      // Rollback: delete the auth user
      await supabase.auth.admin.deleteUser(userId);

      console.error("Customer creation failed:", customerError.message);
      return new Response(
        JSON.stringify({ error: "Failed to create customer" }),
        { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Set app_metadata on auth user (role + customer_id) ---
    const { error: metadataError } = await supabase.auth.admin.updateUserById(userId, {
      app_metadata: {
        role: "admin",
        customer_id: customer.id,
      },
    });

    if (metadataError) {
      console.error("Failed to set app_metadata:", metadataError.message);
      // Non-fatal: user can still log in, we can fix metadata later
    }

    // --- Generate API key ---
    const rawKey = generateApiKey();
    const keyHash = await hashApiKey(rawKey);

    const { error: keyError } = await supabase.from("api_keys").insert({
      customer_id: customer.id,
      key_hash: keyHash,
      name: `Default key for ${company_name}`,
      is_active: true,
    });

    if (keyError) {
      console.error("API key creation failed:", keyError.message);
      // Non-fatal: customer exists, key can be created later
    }

    return new Response(
      JSON.stringify({
        customer_id: customer.id,
        api_key: rawKey,
      }),
      { status: 201, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("onboarding-register error:", error);
    return new Response(
      JSON.stringify({ error: "Registration failed" }),
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
