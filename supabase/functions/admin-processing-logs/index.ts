/**
 * Admin endpoint for viewing processing logs.
 *
 * Supports filtering by status (error, success, started) and
 * pagination via limit/offset query params.
 *
 * Security: JWT + admin role auth
 *
 * GET /admin-processing-logs?status=error&limit=50&offset=0
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
    const status = url.searchParams.get("status");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
    const offset = parseInt(url.searchParams.get("offset") || "0");

    // Service role client to bypass RLS
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let query = supabase
      .from("processing_logs")
      .select("id, customer_id, status, step, error_message, duration_ms, invoice_id, created_at, input, output", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq("status", status);
    }

    const { data, error, count } = await query;

    if (error) {
      throw new Error(`Query failed: ${error.message}`);
    }

    // Summary stats
    const { data: stats } = await supabase
      .from("processing_logs")
      .select("status")
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    const summary = {
      last_24h: {
        total: stats?.length || 0,
        errors: stats?.filter((s: { status: string }) => s.status === "error").length || 0,
        success: stats?.filter((s: { status: string }) => s.status === "success").length || 0,
        started: stats?.filter((s: { status: string }) => s.status === "started").length || 0,
      },
    };

    return new Response(
      JSON.stringify({
        logs: data,
        total: count,
        limit,
        offset,
        summary,
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
    console.error("admin-processing-logs error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch processing logs" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
