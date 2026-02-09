/**
 * Admin: Approve/reject invoices and fetch full invoice details.
 *
 * Auth: Supabase JWT + admin role check.
 * Deploy WITHOUT --no-verify-jwt.
 *
 * GET  ?invoice_id=uuid  — returns full invoice record
 * POST { invoice_id, action: "approve" | "reject" } — updates status + logs action
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyJwt, requireAdmin, AuthError } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    const { user } = await verifyJwt(req);
    requireAdmin(user);

    // Use service role for all DB operations (RLS only allows service_role)
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ----------------------------------------------------------------
    // GET — fetch full invoice record
    // ----------------------------------------------------------------
    if (req.method === "GET") {
      const url = new URL(req.url);
      const invoiceId = url.searchParams.get("invoice_id");

      if (!invoiceId) {
        return new Response(
          JSON.stringify({ error: "invoice_id query parameter is required" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (!UUID_RE.test(invoiceId)) {
        return new Response(
          JSON.stringify({ error: "invoice_id must be a valid UUID" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      const { data: invoice, error: fetchError } = await supabase
        .from("invoices")
        .select("*, vendors(name)")
        .eq("id", invoiceId)
        .single();

      if (fetchError || !invoice) {
        return new Response(
          JSON.stringify({ error: "Invoice not found" }),
          { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ invoice }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // POST — approve or reject invoice
    // ----------------------------------------------------------------
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { invoice_id, action } = body;

    // --- Validation ---
    if (!invoice_id) {
      return new Response(
        JSON.stringify({ error: "invoice_id is required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (!UUID_RE.test(invoice_id)) {
      return new Response(
        JSON.stringify({ error: "invoice_id must be a valid UUID" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (!action || !["approve", "reject"].includes(action)) {
      return new Response(
        JSON.stringify({ error: 'action must be "approve" or "reject"' }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Fetch current invoice to verify it exists ---
    const { data: existing, error: existingError } = await supabase
      .from("invoices")
      .select("id, customer_id")
      .eq("id", invoice_id)
      .single();

    if (existingError || !existing) {
      return new Response(
        JSON.stringify({ error: "Invoice not found" }),
        { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Update invoice status ---
    const newStatus = action === "approve" ? "approved" : "rejected";

    const { data: updated, error: updateError } = await supabase
      .from("invoices")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", invoice_id)
      .select("*")
      .single();

    if (updateError) throw new Error(`Failed to update invoice: ${updateError.message}`);

    // --- Log the action to processing_logs ---
    await supabase.from("processing_logs").insert({
      customer_id: existing.customer_id,
      invoice_id: invoice_id,
      step: `admin_${action}`,
      status: "success",
      input: { action, admin_user_id: user.id, admin_email: user.email },
    });

    return new Response(
      JSON.stringify({ invoice: updated }),
      { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    console.error("approve-invoice error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to process action" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
