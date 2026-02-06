import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

interface CreateCustomerInput {
  name: string;
  email: string;
  accounting_platform: "quickbooks" | "xero" | "freshbooks" | "wave" | null;
  slack_webhook_url?: string;
  slack_channel?: string;
}

function generateApiKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "inv_";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: CreateCustomerInput = await req.json();

    // Validate required fields
    if (!body.name || body.name.trim() === "") {
      return new Response(
        JSON.stringify({ error: "Company name is required" }),
        { status: 400, headers: corsHeaders }
      );
    }

    if (!body.email || !body.email.includes("@")) {
      return new Response(
        JSON.stringify({ error: "Valid email is required" }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Generate unique slug
    let slug = generateSlug(body.name);
    let slugSuffix = 0;
    let slugExists = true;

    while (slugExists) {
      const checkSlug = slugSuffix === 0 ? slug : `${slug}-${slugSuffix}`;
      const { data: existing } = await supabase
        .from("customers")
        .select("id")
        .eq("slug", checkSlug)
        .single();

      if (!existing) {
        slug = checkSlug;
        slugExists = false;
      } else {
        slugSuffix++;
      }
    }

    // Create customer
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .insert({
        name: body.name.trim(),
        slug,
        email: body.email.trim().toLowerCase(),
        accounting_platform: body.accounting_platform || null,
        slack_webhook_url: body.slack_webhook_url || null,
        slack_channel: body.slack_channel || null,
        is_active: true,
        settings: {},
      })
      .select()
      .single();

    if (customerError) {
      return new Response(
        JSON.stringify({ error: customerError.message }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Generate API key
    const apiKey = generateApiKey();
    const keyHash = await hashApiKey(apiKey);

    const { error: keyError } = await supabase.from("api_keys").insert({
      customer_id: customer.id,
      key_hash: keyHash,
      name: "Default API Key",
      is_active: true,
    });

    if (keyError) {
      // Rollback customer creation
      await supabase.from("customers").delete().eq("id", customer.id);
      return new Response(
        JSON.stringify({ error: "Failed to create API key" }),
        { status: 500, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        customer: {
          id: customer.id,
          name: customer.name,
          slug: customer.slug,
          email: customer.email,
          accounting_platform: customer.accounting_platform,
        },
        api_key: apiKey,
        message: "Customer created successfully. Save the API key - it won't be shown again!",
      }),
      { status: 201, headers: corsHeaders }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: corsHeaders }
    );
  }
});
