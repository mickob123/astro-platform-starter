/**
 * Pipeline Health Check — proactive monitoring.
 *
 * Called by n8n every 15 minutes. Checks:
 * 1. Stale polls (customer not polled in 30+ min)
 * 2. Orphaned dedup entries (polled but expired without processing)
 * 3. Error rate (> 50% in last hour)
 * 4. Connection health (consecutive failures > 5)
 * 5. Dead letter accumulation (> 10 per customer)
 *
 * Actions: update pipeline_status, create alerts, send Slack.
 *
 * Auth: Service role key via x-api-key
 * Deploy: supabase functions deploy pipeline-health-check --no-verify-jwt
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body, null, 2), {
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

    const now = new Date();
    const alerts: Array<{ customer_id: string | null; alert_type: string; severity: string; message: string; metadata?: Record<string, unknown> }> = [];
    const checks = {
      customers_checked: 0,
      healthy: 0,
      degraded: 0,
      down: 0,
      orphaned_emails_reset: 0,
      dead_letter_promoted: 0,
      dead_letter_total: 0,
    };

    // ─── Check 1: Handle orphaned dedup entries ─────────────────────
    // Entries that were polled but expired without processing
    const { data: orphaned } = await supabase
      .from("email_dedup")
      .select("id, customer_id, attempt_count, max_attempts")
      .eq("status", "polled")
      .lt("expires_at", now.toISOString());

    if (orphaned && orphaned.length > 0) {
      for (const entry of orphaned) {
        if (entry.attempt_count >= entry.max_attempts) {
          // Promote to dead letter
          await supabase
            .from("email_dedup")
            .update({
              status: "dead_letter",
              last_error: "Timed out waiting for processing (max attempts exceeded)",
            })
            .eq("id", entry.id);
          checks.dead_letter_promoted++;
        } else {
          // Mark as failed so it can be re-polled
          await supabase
            .from("email_dedup")
            .update({
              status: "failed",
              last_error: "Timed out waiting for processing",
            })
            .eq("id", entry.id);
          checks.orphaned_emails_reset++;
        }
      }

      if (checks.orphaned_emails_reset > 0) {
        alerts.push({
          customer_id: null,
          alert_type: "orphaned_emails",
          severity: "warning",
          message: `${checks.orphaned_emails_reset} orphaned email(s) reset for retry, ${checks.dead_letter_promoted} promoted to dead letter`,
          metadata: { orphaned_count: orphaned.length },
        });
      }
    }

    // ─── Check 2: Per-customer health ──────────────────────────────
    const { data: customers } = await supabase
      .from("customers")
      .select("id, name, last_successful_poll, last_successful_process, pipeline_status");

    // Get customers with active connections
    const { data: activeConns } = await supabase
      .from("email_connections")
      .select("customer_id")
      .eq("is_active", true);
    const activeCustomerIds = new Set((activeConns || []).map((c: { customer_id: string }) => c.customer_id));

    // Get dead letter counts per customer
    const { data: deadLetterCounts } = await supabase
      .from("email_dedup")
      .select("customer_id")
      .eq("status", "dead_letter");
    const dlMap = new Map<string, number>();
    for (const dl of deadLetterCounts || []) {
      dlMap.set(dl.customer_id, (dlMap.get(dl.customer_id) || 0) + 1);
    }

    for (const cust of customers || []) {
      if (!activeCustomerIds.has(cust.id)) continue; // Skip customers without email connections
      checks.customers_checked++;

      let newStatus = "healthy";
      const lastPoll = cust.last_successful_poll ? new Date(cust.last_successful_poll) : null;
      const minutesSincePoll = lastPoll ? (now.getTime() - lastPoll.getTime()) / 60_000 : Infinity;
      const dlCount = dlMap.get(cust.id) || 0;
      checks.dead_letter_total += dlCount;

      // Stale poll check
      if (minutesSincePoll > 120) {
        newStatus = "down";
        if (cust.pipeline_status !== "down") {
          alerts.push({
            customer_id: cust.id,
            alert_type: "pipeline_down",
            severity: "critical",
            message: `${cust.name}: No successful poll in ${Math.round(minutesSincePoll)} minutes`,
            metadata: { last_poll: cust.last_successful_poll, minutes_since: Math.round(minutesSincePoll) },
          });
        }
      } else if (minutesSincePoll > 30) {
        newStatus = "degraded";
        if (cust.pipeline_status === "healthy" || cust.pipeline_status === "unknown") {
          alerts.push({
            customer_id: cust.id,
            alert_type: "poll_failure",
            severity: "warning",
            message: `${cust.name}: No successful poll in ${Math.round(minutesSincePoll)} minutes`,
            metadata: { last_poll: cust.last_successful_poll },
          });
        }
      }

      // Dead letter accumulation
      if (dlCount > 10) {
        alerts.push({
          customer_id: cust.id,
          alert_type: "dead_letter_threshold",
          severity: "warning",
          message: `${cust.name}: ${dlCount} dead letter items awaiting review`,
          metadata: { dead_letter_count: dlCount },
        });
      }

      // Recovery detection
      if (newStatus === "healthy" && (cust.pipeline_status === "down" || cust.pipeline_status === "degraded")) {
        alerts.push({
          customer_id: cust.id,
          alert_type: "pipeline_recovered",
          severity: "info",
          message: `${cust.name}: Pipeline recovered (was ${cust.pipeline_status})`,
        });
      }

      // Update status
      if (newStatus !== cust.pipeline_status) {
        await supabase
          .from("customers")
          .update({
            pipeline_status: newStatus,
            pipeline_status_updated_at: now.toISOString(),
          })
          .eq("id", cust.id);
      }

      if (newStatus === "healthy") checks.healthy++;
      else if (newStatus === "degraded") checks.degraded++;
      else if (newStatus === "down") checks.down++;
    }

    // ─── Check 3: Connection health ─────────────────────────────────
    const { data: failedConns } = await supabase
      .from("email_connections")
      .select("id, customer_id, email_address, consecutive_failures, last_poll_error")
      .eq("is_active", true)
      .gt("consecutive_failures", 5);

    for (const conn of failedConns || []) {
      alerts.push({
        customer_id: conn.customer_id,
        alert_type: "connection_expired",
        severity: "critical",
        message: `${conn.email_address}: ${conn.consecutive_failures} consecutive failures — ${conn.last_poll_error || "unknown error"}`,
        metadata: { connection_id: conn.id, failures: conn.consecutive_failures },
      });
    }

    // ─── Check 4: Error rate in last hour ───────────────────────────
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const { count: totalLogs } = await supabase
      .from("processing_logs")
      .select("id", { count: "exact", head: true })
      .gte("created_at", oneHourAgo);

    const { count: errorLogs } = await supabase
      .from("processing_logs")
      .select("id", { count: "exact", head: true })
      .eq("status", "error")
      .gte("created_at", oneHourAgo);

    if (totalLogs && totalLogs > 5 && errorLogs && errorLogs / totalLogs > 0.5) {
      alerts.push({
        customer_id: null,
        alert_type: "high_error_rate",
        severity: "critical",
        message: `High error rate: ${errorLogs}/${totalLogs} (${Math.round(errorLogs / totalLogs * 100)}%) in the last hour`,
        metadata: { total: totalLogs, errors: errorLogs, rate: errorLogs / totalLogs },
      });
    }

    // ─── Insert alerts ──────────────────────────────────────────────
    if (alerts.length > 0) {
      await supabase.from("pipeline_alerts").insert(alerts);
    }

    // ─── Send Slack notification for critical/warning alerts ────────
    let slackSent = false;
    const slackUrl = Deno.env.get("SLACK_WEBHOOK_URL");
    const importantAlerts = alerts.filter((a) => a.severity !== "info");
    if (slackUrl && importantAlerts.length > 0) {
      try {
        const blocks = [
          {
            type: "header",
            text: { type: "plain_text", text: `Pipeline Health Alert (${importantAlerts.length} issue${importantAlerts.length > 1 ? "s" : ""})` },
          },
          ...importantAlerts.map((a) => ({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${a.severity === "critical" ? ":red_circle:" : ":warning:"} *${a.alert_type}*\n${a.message}`,
            },
          })),
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `Healthy: ${checks.healthy} | Degraded: ${checks.degraded} | Down: ${checks.down} | Dead letter: ${checks.dead_letter_total}` }],
          },
        ];

        const slackResp = await fetch(slackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blocks }),
        });
        slackSent = slackResp.ok;
      } catch (e) {
        console.error("Slack notification failed:", e);
      }
    }

    return json({
      status: "ok",
      checks,
      alerts_generated: alerts.length,
      slack_sent: slackSent,
    });
  } catch (error) {
    console.error("pipeline-health-check error:", error);
    return json({ error: error instanceof Error ? error.message : "Internal error" }, 500);
  }
});
