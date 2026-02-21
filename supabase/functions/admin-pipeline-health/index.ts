/**
 * Admin Pipeline Health — dashboard data endpoint.
 *
 * GET:  Overview stats, per-customer health, recent alerts
 * GET ?view=dead_letter&customer_id=X: Dead letter items
 * POST { action: "acknowledge_alert", alert_id }: Acknowledge alert
 *
 * Auth: JWT + admin role
 * Deploy: supabase functions deploy admin-pipeline-health --no-verify-jwt
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
    const { user } = await verifyJwt(req);
    requireAdmin(user);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const url = new URL(req.url);

    // ─── POST: Actions ──────────────────────────────────────────────
    if (req.method === "POST") {
      const body = await req.json();

      if (body.action === "acknowledge_alert") {
        const { error } = await supabase
          .from("pipeline_alerts")
          .update({
            acknowledged: true,
            acknowledged_by: user.id,
            acknowledged_at: new Date().toISOString(),
          })
          .eq("id", body.alert_id);

        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }

      return json({ error: "Unknown action" }, 400);
    }

    // ─── GET: Dead letter view ──────────────────────────────────────
    const view = url.searchParams.get("view");
    if (view === "dead_letter") {
      const customerId = url.searchParams.get("customer_id");
      let query = supabase
        .from("email_dedup")
        .select("id, customer_id, connection_id, gmail_message_id, attempt_count, last_error, created_at, updated_at, email_connections(email_address)")
        .eq("status", "dead_letter")
        .order("updated_at", { ascending: false })
        .limit(100);

      if (customerId) {
        query = query.eq("customer_id", customerId);
      }

      const { data, error } = await query;
      if (error) return json({ error: error.message }, 500);
      return json({ dead_letter_items: data, count: data?.length || 0 });
    }

    // ─── GET: Overview ──────────────────────────────────────────────

    // Get customers with active email connections
    const { data: customers } = await supabase
      .from("customers")
      .select("id, name, last_successful_poll, last_successful_process, pipeline_status, pipeline_status_updated_at");

    const { data: activeConns } = await supabase
      .from("email_connections")
      .select("id, customer_id, email_address, last_poll_at, last_poll_status, consecutive_failures, last_poll_error")
      .eq("is_active", true);

    const activeCustomerIds = new Set((activeConns || []).map((c: { customer_id: string }) => c.customer_id));

    // Dead letter counts per customer
    const { data: dlEntries } = await supabase
      .from("email_dedup")
      .select("customer_id")
      .eq("status", "dead_letter");
    const dlMap = new Map<string, number>();
    for (const dl of dlEntries || []) {
      dlMap.set(dl.customer_id, (dlMap.get(dl.customer_id) || 0) + 1);
    }

    // Queue depth (polled but not yet processed) per customer
    const { data: queueEntries } = await supabase
      .from("email_dedup")
      .select("customer_id")
      .in("status", ["polled", "processing"]);
    const queueMap = new Map<string, number>();
    for (const q of queueEntries || []) {
      queueMap.set(q.customer_id, (queueMap.get(q.customer_id) || 0) + 1);
    }

    // Error counts (24h) from processing_logs
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: errorLogs } = await supabase
      .from("processing_logs")
      .select("customer_id")
      .eq("status", "error")
      .gte("created_at", oneDayAgo);
    const errorMap = new Map<string, number>();
    for (const e of errorLogs || []) {
      if (e.customer_id) errorMap.set(e.customer_id, (errorMap.get(e.customer_id) || 0) + 1);
    }

    // Build customer health list
    let healthy = 0, degraded = 0, down = 0, totalDl = 0;
    const customerHealth = [];
    for (const cust of customers || []) {
      if (!activeCustomerIds.has(cust.id)) continue;

      const custConns = (activeConns || []).filter((c: { customer_id: string }) => c.customer_id === cust.id);
      const dlCount = dlMap.get(cust.id) || 0;
      const queueDepth = queueMap.get(cust.id) || 0;
      const errors24h = errorMap.get(cust.id) || 0;
      totalDl += dlCount;

      if (cust.pipeline_status === "healthy") healthy++;
      else if (cust.pipeline_status === "degraded") degraded++;
      else if (cust.pipeline_status === "down") down++;

      customerHealth.push({
        id: cust.id,
        name: cust.name,
        pipeline_status: cust.pipeline_status || "unknown",
        last_poll_at: cust.last_successful_poll,
        last_process_at: cust.last_successful_process,
        error_count_24h: errors24h,
        queue_depth: queueDepth,
        dead_letter_count: dlCount,
        connections: custConns.map((c: Record<string, unknown>) => ({
          email: c.email_address,
          last_poll_at: c.last_poll_at,
          last_poll_status: c.last_poll_status,
          consecutive_failures: c.consecutive_failures,
          last_poll_error: c.last_poll_error,
        })),
      });
    }

    // Recent alerts (last 50, unacknowledged first)
    const { data: recentAlerts } = await supabase
      .from("pipeline_alerts")
      .select("id, customer_id, alert_type, severity, message, metadata, acknowledged, created_at, customers(name)")
      .order("acknowledged", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(50);

    return json({
      overview: {
        total_customers: customerHealth.length,
        healthy,
        degraded,
        down,
        total_dead_letter: totalDl,
        total_queue_depth: Array.from(queueMap.values()).reduce((a, b) => a + b, 0),
      },
      customers: customerHealth,
      recent_alerts: (recentAlerts || []).map((a: Record<string, unknown>) => ({
        ...a,
        customer_name: (a.customers as Record<string, unknown>)?.name || null,
        customers: undefined,
      })),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return json({ error: error.message }, error.status);
    }
    console.error("admin-pipeline-health error:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
