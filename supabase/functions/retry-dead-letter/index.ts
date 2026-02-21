/**
 * Retry dead letter items — admin endpoint.
 *
 * POST { action: "retry", dedup_ids: ["id1", "id2"] }
 * POST { action: "retry_all", customer_id: "..." }
 *
 * Resets dead letter entries to 'polled' status with fresh TTL.
 * The next orchestrator poll cycle will pick them up.
 *
 * Auth: JWT + admin role
 * Deploy: supabase functions deploy retry-dead-letter --no-verify-jwt
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyJwt, requireAdmin, AuthError } from "../_shared/auth.ts";
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
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const { user } = await verifyJwt(req);
    requireAdmin(user);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json();
    const freshExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const resetData = {
      status: "polled",
      attempt_count: 1,
      expires_at: freshExpiry,
      last_error: null,
    };

    if (body.action === "retry" && Array.isArray(body.dedup_ids) && body.dedup_ids.length > 0) {
      if (body.dedup_ids.length > 100) {
        return json({ error: "Maximum 100 items per retry" }, 400);
      }

      const { count, error } = await supabase
        .from("email_dedup")
        .update(resetData, { count: "exact" })
        .in("id", body.dedup_ids)
        .in("status", ["dead_letter", "failed"]);

      if (error) return json({ error: error.message }, 500);
      return json({ success: true, retried: count });
    }

    if (body.action === "retry_all" && body.customer_id) {
      const { count, error } = await supabase
        .from("email_dedup")
        .update(resetData, { count: "exact" })
        .eq("customer_id", body.customer_id)
        .eq("status", "dead_letter");

      if (error) return json({ error: error.message }, 500);
      return json({ success: true, retried: count, customer_id: body.customer_id });
    }

    return json({ error: "Invalid action. Use 'retry' with dedup_ids or 'retry_all' with customer_id" }, 400);
  } catch (error) {
    if (error instanceof AuthError) {
      return json({ error: error.message }, error.status);
    }
    console.error("retry-dead-letter error:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
