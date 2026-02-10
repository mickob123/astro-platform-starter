/**
 * Admin: Vendor list with invoice stats.
 *
 * Auth: JWT + admin role.
 * Uses service_role to bypass RLS.
 *
 * Query params:
 *   search  - filter by vendor name (optional)
 *   page    - page number (default 1)
 *   limit   - per page (default 25, max 100)
 *   sort    - name|spend|invoices|latest (default name)
 *   order   - asc|desc (default asc)
 */

import {
  getCorsHeaders,
  handleCors,
} from "../_shared/cors.ts";
import {
  verifyJwt,
  requireAdmin,
  AuthError,
} from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    const { user } = await verifyJwt(req);
    requireAdmin(user);

    if (req.method !== "GET") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        {
          status: 405,
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const url = new URL(req.url);
    const search = (
      url.searchParams.get("search") || ""
    ).trim();
    const page = Math.max(
      1,
      parseInt(url.searchParams.get("page") || "1", 10),
    );
    const limit = Math.min(
      100,
      Math.max(
        1,
        parseInt(
          url.searchParams.get("limit") || "25",
          10,
        ),
      ),
    );
    const sort = url.searchParams.get("sort") || "name";
    const order = url.searchParams.get("order") || "asc";

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Fetch vendors with invoice relationship
    let query = supabase
      .from("vendors")
      .select(
        "id, name, normalized_name, created_at, " +
          "invoices(id, total, status, created_at)",
        { count: "exact" },
      );

    if (search) {
      query = query.ilike("name", `%${search}%`);
    }

    // Fetch all matching vendors (we sort after
    // aggregation since sort may be by computed field)
    const {
      data: vendors,
      count: totalCount,
      error: vendorError,
    } = await query;

    if (vendorError) {
      throw new Error(
        `Failed to fetch vendors: ${vendorError.message}`,
      );
    }

    // Aggregate invoice stats per vendor
    interface InvoiceRow {
      id: string;
      total: number | null;
      status: string;
      created_at: string;
    }

    const enriched = (vendors || []).map(
      (v: {
        id: string;
        name: string;
        normalized_name: string | null;
        created_at: string;
        invoices: InvoiceRow[];
      }) => {
        const invs = v.invoices || [];
        const totalSpend = invs.reduce(
          (s, i) => s + (i.total || 0),
          0,
        );
        const pending = invs.filter(
          (i) =>
            i.status === "pending" ||
            i.status === "flagged",
        ).length;
        const approved = invs.filter(
          (i) =>
            i.status === "approved" ||
            i.status === "synced",
        ).length;
        const rejected = invs.filter(
          (i) =>
            i.status === "rejected" ||
            i.status === "error",
        ).length;

        let latestDate: string | null = null;
        if (invs.length > 0) {
          const sorted = [...invs].sort(
            (a, b) =>
              new Date(b.created_at).getTime() -
              new Date(a.created_at).getTime(),
          );
          latestDate = sorted[0].created_at;
        }

        return {
          id: v.id,
          name: v.name,
          created_at: v.created_at,
          invoice_count: invs.length,
          total_spend: totalSpend,
          latest_invoice: latestDate,
          pending,
          approved,
          rejected,
        };
      },
    );

    // Sort by requested field
    const asc = order === "asc" ? 1 : -1;
    enriched.sort((a, b) => {
      switch (sort) {
        case "spend":
          return (a.total_spend - b.total_spend) * asc;
        case "invoices":
          return (
            (a.invoice_count - b.invoice_count) * asc
          );
        case "latest":
          return (
            ((a.latest_invoice || "").localeCompare(
              b.latest_invoice || "",
            )) * asc
          );
        default:
          return a.name.localeCompare(b.name) * asc;
      }
    });

    // Paginate
    const offset = (page - 1) * limit;
    const paged = enriched.slice(offset, offset + limit);
    const total = enriched.length;

    return new Response(
      JSON.stringify({
        vendors: paged,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit),
        },
      }),
      {
        status: 200,
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(
        JSON.stringify({ error: error.message }),
        {
          status: error.status,
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
        },
      );
    }
    console.error("admin-vendors error:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to load vendors",
      }),
      {
        status: 500,
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
      },
    );
  }
});
