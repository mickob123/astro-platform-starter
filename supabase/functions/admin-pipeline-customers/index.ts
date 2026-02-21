/**
 * Return the list of customers with active email connections.
 * Called by the n8n orchestrator every 2 minutes to get the poll list.
 *
 * Auth: Service role key via x-api-key
 * Deploy: supabase functions deploy admin-pipeline-customers --no-verify-jwt
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...headers, "Content-Type": "application/json" },
    });

  try {
    // Auth: accept service role key OR valid API key
    const apiKey = req.headers.get("x-api-key") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceRoleKey,
    );
    if (!apiKey) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (apiKey !== serviceRoleKey) {
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(apiKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
      const { data: keyRecord } = await supabase
        .from("api_keys")
        .select("id, is_active")
        .eq("key_hash", keyHash)
        .eq("is_active", true)
        .maybeSingle();
      if (!keyRecord) {
        return json({ error: "Invalid API key" }, 401);
      }
    }

    // Get customers with active email connections
    const { data: connections, error } = await supabase
      .from("email_connections")
      .select("customer_id, customers(id, name)")
      .eq("is_active", true);

    if (error) {
      return json({ error: `Query failed: ${error.message}` }, 500);
    }

    // Group by customer and count connections
    const customerMap = new Map<string, { id: string; name: string; connection_count: number }>();
    for (const conn of connections || []) {
      const cust = conn.customers as unknown as { id: string; name: string } | null;
      if (!cust) continue;
      const existing = customerMap.get(cust.id);
      if (existing) {
        existing.connection_count++;
      } else {
        customerMap.set(cust.id, {
          id: cust.id,
          name: cust.name || "Unknown",
          connection_count: 1,
        });
      }
    }

    return json({
      customers: Array.from(customerMap.values()),
      count: customerMap.size,
    });
  } catch (error) {
    console.error("admin-pipeline-customers error:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
