/**
 * Admin: Analytics data for charts and dashboards.
 *
 * Auth: Supabase JWT + admin role check.
 *
 * GET ?date_from=<iso>&date_to=<iso>
 *
 * Returns:
 *   volume_by_day:         Array of { date, count } for invoice volume over time
 *   spend_by_vendor:       Array of { vendor_name, total_amount } top 10 vendors by spend
 *   status_breakdown:      Array of { status, count }
 *   avg_confidence:        number
 *   avg_processing_time_ms: number (from processing_logs)
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyJwt, requireAdmin, AuthError } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    const { user } = await verifyJwt(req);
    requireAdmin(user);

    if (req.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const dateFrom = url.searchParams.get("date_from");
    const dateTo = url.searchParams.get("date_to");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // --- Fetch all invoices in range (with vendor join) ---
    let invoiceQuery = supabase
      .from("invoices")
      .select("id, total, status, confidence, created_at, vendor_id, vendors(name)");

    if (dateFrom) {
      invoiceQuery = invoiceQuery.gte("created_at", dateFrom);
    }
    if (dateTo) {
      invoiceQuery = invoiceQuery.lte("created_at", dateTo);
    }

    // --- Fetch processing logs in range ---
    let logsQuery = supabase
      .from("processing_logs")
      .select("id, duration_ms");

    if (dateFrom) {
      logsQuery = logsQuery.gte("created_at", dateFrom);
    }
    if (dateTo) {
      logsQuery = logsQuery.lte("created_at", dateTo);
    }

    const [invoicesResult, logsResult] = await Promise.all([
      invoiceQuery,
      logsQuery,
    ]);

    if (invoicesResult.error) {
      throw new Error(`Failed to fetch invoices: ${invoicesResult.error.message}`);
    }
    if (logsResult.error) {
      throw new Error(`Failed to fetch processing logs: ${logsResult.error.message}`);
    }

    const allInvoices = invoicesResult.data || [];
    const allLogs = logsResult.data || [];

    // --- volume_by_day: group invoices by date ---
    const volumeMap = new Map<string, number>();
    for (const inv of allInvoices) {
      const date = (inv.created_at || "").substring(0, 10); // YYYY-MM-DD
      if (date) {
        volumeMap.set(date, (volumeMap.get(date) || 0) + 1);
      }
    }
    const volumeByDay = Array.from(volumeMap.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // --- spend_by_vendor: top 10 vendors by total spend ---
    const vendorSpendMap = new Map<string, number>();
    for (const inv of allInvoices) {
      const vendorName =
        (inv.vendors as { name?: string } | null)?.name || "Unknown";
      vendorSpendMap.set(
        vendorName,
        (vendorSpendMap.get(vendorName) || 0) + (inv.total || 0),
      );
    }
    const spendByVendor = Array.from(vendorSpendMap.entries())
      .map(([vendor_name, total_amount]) => ({ vendor_name, total_amount }))
      .sort((a, b) => b.total_amount - a.total_amount)
      .slice(0, 10);

    // --- status_breakdown: count per status ---
    const statusMap = new Map<string, number>();
    for (const inv of allInvoices) {
      const status = inv.status || "unknown";
      statusMap.set(status, (statusMap.get(status) || 0) + 1);
    }
    const statusBreakdown = Array.from(statusMap.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

    // --- avg_confidence ---
    const invoicesWithConfidence = allInvoices.filter(
      (inv) => inv.confidence != null,
    );
    const avgConfidence =
      invoicesWithConfidence.length > 0
        ? invoicesWithConfidence.reduce(
            (sum, inv) => sum + (inv.confidence || 0),
            0,
          ) / invoicesWithConfidence.length
        : 0;

    // --- avg_processing_time_ms (from processing_logs.duration_ms) ---
    const logsWithDuration = allLogs.filter(
      (log) => log.duration_ms != null,
    );
    const avgProcessingTimeMs =
      logsWithDuration.length > 0
        ? logsWithDuration.reduce(
            (sum, log) => sum + (log.duration_ms || 0),
            0,
          ) / logsWithDuration.length
        : 0;

    return new Response(
      JSON.stringify({
        volume_by_day: volumeByDay,
        spend_by_vendor: spendByVendor,
        status_breakdown: statusBreakdown,
        avg_confidence: Math.round(avgConfidence * 1000) / 1000,
        avg_processing_time_ms: Math.round(avgProcessingTimeMs),
      }),
      { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    console.error("admin-get-analytics error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to load analytics" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
