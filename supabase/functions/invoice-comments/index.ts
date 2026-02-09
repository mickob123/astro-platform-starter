/**
 * Invoice Comments: list and create comments on invoices.
 *
 * Auth: Supabase JWT (any authenticated user with matching customer_id).
 *
 * GET  ?invoice_id=uuid  — returns all comments for the invoice, ordered by created_at ASC
 * POST { invoice_id, content, mentioned_user_ids?, attachments? } — creates a new comment
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyJwt, AuthError } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    const { user } = await verifyJwt(req);

    // Use service role for all DB operations (RLS only allows service_role full access)
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Get the user's customer_id from JWT app_metadata
    const customerId = user.app_metadata?.customer_id as string | undefined;
    if (!customerId) {
      return new Response(
        JSON.stringify({ error: "User is not associated with a customer" }),
        { status: 403, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // GET — list comments for an invoice
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

      // Verify the invoice belongs to the user's customer
      const { data: invoice, error: invoiceError } = await supabase
        .from("invoices")
        .select("id, customer_id")
        .eq("id", invoiceId)
        .single();

      if (invoiceError || !invoice) {
        return new Response(
          JSON.stringify({ error: "Invoice not found" }),
          { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (invoice.customer_id !== customerId) {
        return new Response(
          JSON.stringify({ error: "Invoice not found" }),
          { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      const { data: comments, error: fetchError } = await supabase
        .from("invoice_comments")
        .select("*")
        .eq("invoice_id", invoiceId)
        .eq("customer_id", customerId)
        .order("created_at", { ascending: true });

      if (fetchError) throw new Error(`Failed to fetch comments: ${fetchError.message}`);

      return new Response(
        JSON.stringify({ comments }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // POST — create a new comment
    // ----------------------------------------------------------------
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { invoice_id, content, mentioned_user_ids, attachments } = body;

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

    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "content is required and must be a non-empty string" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Verify the invoice exists and belongs to the user's customer ---
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .select("id, customer_id")
      .eq("id", invoice_id)
      .single();

    if (invoiceError || !invoice) {
      return new Response(
        JSON.stringify({ error: "Invoice not found" }),
        { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (invoice.customer_id !== customerId) {
      return new Response(
        JSON.stringify({ error: "Invoice not found" }),
        { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Insert the comment ---
    const { data: comment, error: insertError } = await supabase
      .from("invoice_comments")
      .insert({
        invoice_id,
        customer_id: invoice.customer_id,
        user_id: user.id,
        user_email: user.email || "",
        user_name: user.app_metadata?.full_name || user.app_metadata?.name || null,
        content: content.trim(),
        mentioned_user_ids: mentioned_user_ids || [],
        attachments: attachments || [],
        is_system: false,
      })
      .select("*")
      .single();

    if (insertError) throw new Error(`Failed to create comment: ${insertError.message}`);

    return new Response(
      JSON.stringify({ comment }),
      { status: 201, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    console.error("invoice-comments error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to process request" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
