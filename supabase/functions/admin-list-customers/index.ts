/**
 * Admin: List customers with pagination.
 *
 * Auth: Supabase JWT + admin role check.
 * Deploy WITHOUT --no-verify-jwt.
 *
 * Query params:
 *   page (default: 1)
 *   limit (default: 25, max: 100)
 *   search (optional, filters by name or email)
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
    const search = url.searchParams.get("search") || "";

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const offset = (page - 1) * limit;

    let query = supabase
      .from("customers")
      .select("id, name, email, is_active, accounting_platform, created_at", { count: "exact" });

    if (search) {
      // Sanitize search input: remove characters that could manipulate PostgREST filter syntax
      // Commas, parens, dots, backslashes, and SQL wildcards can be used for filter injection
      const sanitized = search.replace(/[%_(),.\\*]/g, "");
      if (sanitized.length > 0) {
        query = query.or(`name.ilike.%${sanitized}%,email.ilike.%${sanitized}%`);
      }
    }

    const { data, count, error } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(`Failed to list customers: ${error.message}`);

    return new Response(
      JSON.stringify({
        customers: data,
        pagination: {
          page,
          limit,
          total: count,
          total_pages: Math.ceil((count || 0) / limit),
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
    console.error("admin-list-customers error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to list customers" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
