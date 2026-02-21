/**
 * Admin: Platform-level management for super-admins.
 *
 * Auth: Supabase JWT + admin role check.
 * Deploy with --no-verify-jwt.
 *
 * GET ?view=overview    — All customers with invoice/user counts
 * GET ?view=customer&id=xxx — Single customer detail (members, invoices, API keys)
 * GET ?view=stats       — Platform-wide totals
 * GET ?view=users       — All users across all organizations
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

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const url = new URL(req.url);
    const view = url.searchParams.get("view") || "overview";

    // ----------------------------------------------------------------
    // VIEW: overview — Customers with invoice counts and user counts
    // ----------------------------------------------------------------
    if (view === "overview") {
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10)));
      const search = url.searchParams.get("search") || "";
      const offset = (page - 1) * limit;

      // Get customers
      let customerQuery = supabase
        .from("customers")
        .select("id, name, email, is_active, accounting_platform, created_at", { count: "exact" });

      if (search) {
        const sanitized = search.replace(/[%_(),.\\*]/g, "");
        if (sanitized.length > 0) {
          customerQuery = customerQuery.or(`name.ilike.%${sanitized}%,email.ilike.%${sanitized}%`);
        }
      }

      const { data: customers, count, error: custError } = await customerQuery
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (custError) throw new Error(`Failed to list customers: ${custError.message}`);

      // Get invoice counts per customer
      const customerIds = (customers || []).map((c: any) => c.id);

      let enrichedCustomers = customers || [];

      if (customerIds.length > 0) {
        // Get invoice stats per customer
        const { data: invoiceStats } = await supabase
          .from("invoices")
          .select("customer_id, id, total, status")
          .in("customer_id", customerIds)
          .neq("status", "deleted");

        // Get user counts per customer
        const { data: { users: allUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });

        // Aggregate stats
        const statsMap: Record<string, { invoice_count: number; total_amount: number; user_count: number; last_invoice_at: string | null }> = {};

        for (const cid of customerIds) {
          const custInvoices = (invoiceStats || []).filter((i: any) => i.customer_id === cid);
          const custUsers = (allUsers || []).filter((u: any) => u.app_metadata?.customer_id === cid);

          statsMap[cid] = {
            invoice_count: custInvoices.length,
            total_amount: custInvoices.reduce((sum: number, i: any) => sum + (i.total || 0), 0),
            user_count: custUsers.length,
            last_invoice_at: null,
          };
        }

        enrichedCustomers = (customers || []).map((c: any) => ({
          ...c,
          ...statsMap[c.id],
        }));
      }

      return new Response(
        JSON.stringify({
          customers: enrichedCustomers,
          pagination: {
            page,
            limit,
            total: count,
            total_pages: Math.ceil((count || 0) / limit),
          },
        }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // VIEW: customer — Single customer detail
    // ----------------------------------------------------------------
    if (view === "customer") {
      const customerId = url.searchParams.get("id");
      if (!customerId) {
        return new Response(JSON.stringify({ error: "id parameter required" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      // Get customer
      const { data: customer, error: custError } = await supabase
        .from("customers")
        .select("*")
        .eq("id", customerId)
        .single();

      if (custError || !customer) {
        return new Response(JSON.stringify({ error: "Customer not found" }), {
          status: 404, headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      // Get team members
      const { data: { users: allUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      const members = (allUsers || [])
        .filter((u: any) => u.app_metadata?.customer_id === customerId)
        .map((u: any) => ({
          id: u.id,
          email: u.email,
          role: u.app_metadata?.role || "viewer",
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at,
        }));

      // Get recent invoices
      const { data: invoices, count: invoiceCount } = await supabase
        .from("invoices")
        .select("id, invoice_number, invoice_date, total, status, confidence, document_type, created_at, vendors(name)", { count: "exact" })
        .eq("customer_id", customerId)
        .neq("status", "deleted")
        .order("created_at", { ascending: false })
        .limit(20);

      // Get API keys (hash only, never expose raw keys)
      const { data: apiKeys } = await supabase
        .from("api_keys")
        .select("id, name, is_active, created_at")
        .eq("customer_id", customerId);

      // Invoice summary stats
      const { data: allInvoices } = await supabase
        .from("invoices")
        .select("total, status")
        .eq("customer_id", customerId)
        .neq("status", "deleted");

      const stats = {
        total_invoices: (allInvoices || []).length,
        total_amount: (allInvoices || []).reduce((s: number, i: any) => s + (i.total || 0), 0),
        pending: (allInvoices || []).filter((i: any) => i.status === "pending" || i.status === "flagged").length,
        approved: (allInvoices || []).filter((i: any) => i.status === "approved" || i.status === "synced").length,
        errors: (allInvoices || []).filter((i: any) => i.status === "error").length,
      };

      return new Response(
        JSON.stringify({ customer, members, invoices, invoice_count: invoiceCount, api_keys: apiKeys, stats }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // VIEW: stats — Platform-wide totals
    // ----------------------------------------------------------------
    if (view === "stats") {
      const { count: customerCount } = await supabase
        .from("customers")
        .select("id", { count: "exact", head: true });

      const { data: allInvoices } = await supabase
        .from("invoices")
        .select("total, status, created_at")
        .neq("status", "deleted");

      const { data: { users: allUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });

      const invoices = allInvoices || [];
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const recentInvoices = invoices.filter((i: any) => i.created_at >= thirtyDaysAgo);

      return new Response(
        JSON.stringify({
          total_customers: customerCount || 0,
          total_users: (allUsers || []).length,
          total_invoices: invoices.length,
          total_amount: invoices.reduce((s: number, i: any) => s + (i.total || 0), 0),
          invoices_last_30_days: recentInvoices.length,
          amount_last_30_days: recentInvoices.reduce((s: number, i: any) => s + (i.total || 0), 0),
          by_status: {
            pending: invoices.filter((i: any) => i.status === "pending" || i.status === "flagged").length,
            approved: invoices.filter((i: any) => i.status === "approved" || i.status === "synced").length,
            errors: invoices.filter((i: any) => i.status === "error").length,
          },
        }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // VIEW: users — All users across all organizations
    // ----------------------------------------------------------------
    if (view === "users") {
      const { data: { users: allUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });

      // Get customer names for display
      const { data: customers } = await supabase
        .from("customers")
        .select("id, name");

      const customerMap: Record<string, string> = {};
      for (const c of (customers || [])) {
        customerMap[c.id] = c.name;
      }

      const enrichedUsers = (allUsers || []).map((u: any) => ({
        id: u.id,
        email: u.email,
        role: u.app_metadata?.role || "viewer",
        customer_id: u.app_metadata?.customer_id || null,
        customer_name: u.app_metadata?.customer_id ? (customerMap[u.app_metadata.customer_id] || "Unknown") : "Unassigned",
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
      }));

      return new Response(
        JSON.stringify({ users: enrichedUsers }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: "Invalid view parameter" }), {
      status: 400,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    console.error("admin-platform error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
