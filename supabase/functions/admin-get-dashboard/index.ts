/**
 * Admin: Dashboard data with pagination.
 *
 * Auth: Supabase JWT + admin role check.
 * Deploy WITHOUT --no-verify-jwt.
 *
 * Returns summary stats + paginated recent invoices.
 *
 * Query params:
 *   page (default: 1)
 *   limit (default: 25, max: 100)
 *   customer_id (optional, filter to specific customer)
 *   status (optional: pending_approval, approved, flagged, rejected)
 *   date_from (optional, ISO date string to filter invoices created on or after)
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
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "25", 10)));
    const customerFilter = url.searchParams.get("customer_id");
    const statusFilter = url.searchParams.get("status");
    const dateFrom = url.searchParams.get("date_from");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // --- Summary stats ---
    let summaryQuery = supabase.from("invoices").select("id, total, status");
    if (dateFrom) {
      summaryQuery = summaryQuery.gte("created_at", dateFrom);
    }
    const [invoicesResult, logsResult] = await Promise.all([
      summaryQuery,
      supabase.from("processing_logs").select("id, status", { count: "exact", head: false }),
    ]);

    const allInvoices = invoicesResult.data || [];
    const totalInvoices = allInvoices.length;
    const needsReview = allInvoices.filter(
      (inv: { status?: string }) => inv.status === "pending" || inv.status === "flagged",
    ).length;
    const approvedCount = allInvoices.filter(
      (inv: { status?: string }) => inv.status === "approved",
    ).length;
    const amountAwaitingApproval = allInvoices
      .filter((inv: { status?: string }) => inv.status === "pending" || inv.status === "flagged")
      .reduce((sum: number, inv: { total?: number }) => sum + (inv.total || 0), 0);
    const amountApproved = allInvoices
      .filter((inv: { status?: string }) => inv.status === "approved")
      .reduce((sum: number, inv: { total?: number }) => sum + (inv.total || 0), 0);
    const failedLogs = (logsResult.data || []).filter(
      (log: { status?: string }) => log.status === "error",
    ).length;

    // --- Paginated invoices ---
    const offset = (page - 1) * limit;
    let invoiceQuery = supabase
      .from("invoices")
      .select(
        "id, customer_id, vendor_id, invoice_number, invoice_date, due_date, currency, total, status, is_valid, confidence, created_at, vendors(name)",
        { count: "exact" },
      );

    if (customerFilter) {
      invoiceQuery = invoiceQuery.eq("customer_id", customerFilter);
    }
    if (statusFilter) {
      invoiceQuery = invoiceQuery.eq("status", statusFilter);
    }
    if (dateFrom) {
      invoiceQuery = invoiceQuery.gte("created_at", dateFrom);
    }

    const { data: invoices, count: invoiceCount, error: invoiceError } = await invoiceQuery
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (invoiceError) throw new Error(`Failed to fetch invoices: ${invoiceError.message}`);

    return new Response(
      JSON.stringify({
        summary: {
          total_invoices: totalInvoices,
          needs_review: needsReview,
          approved: approvedCount,
          amount_awaiting_approval: amountAwaitingApproval,
          amount_approved: amountApproved,
          failed_processing: failedLogs,
        },
        invoices,
        pagination: {
          page,
          limit,
          total: invoiceCount,
          total_pages: Math.ceil((invoiceCount || 0) / limit),
        },
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
    console.error("admin-get-dashboard error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to load dashboard" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
