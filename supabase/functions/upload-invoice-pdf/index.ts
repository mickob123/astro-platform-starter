/**
 * Lightweight PDF upload endpoint.
 *
 * Accepts raw binary PDF body (not JSON) to avoid Edge Function
 * size limits when processing large PDFs.
 *
 * Called by n8n AFTER process-invoice succeeds, so the invoice
 * record already exists in the DB.
 *
 * Query params: ?invoice_id=<uuid>
 * Headers: x-api-key (same customer API key as process-invoice)
 * Body: raw PDF bytes (Content-Type: application/pdf)
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyApiKey, AuthError } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

Deno.serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }

  try {
    // --- Auth ---
    const { customer_id: customerId } = await verifyApiKey(req);

    // --- Rate limiting: max 60 uploads per customer per hour ---
    const rlSupabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const RATE_LIMIT_MAX = 60;
    const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const { count: recentUploads, error: rlError } = await rlSupabase
      .from("processing_logs")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customerId)
      .eq("step", "pdf_upload")
      .gte("created_at", windowStart);

    if (!rlError && recentUploads !== null && recentUploads >= RATE_LIMIT_MAX) {
      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded",
          detail: `Maximum ${RATE_LIMIT_MAX} uploads per hour.`,
          retry_after_seconds: 300,
        }),
        {
          status: 429,
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "Retry-After": "300",
          },
        },
      );
    }

    // --- Params ---
    const url = new URL(req.url);
    const invoiceId = url.searchParams.get("invoice_id");
    if (!invoiceId) {
      return new Response(
        JSON.stringify({ error: "invoice_id query param required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Read binary body ---
    const pdfBytes = new Uint8Array(await req.arrayBuffer());
    if (pdfBytes.length === 0) {
      return new Response(
        JSON.stringify({ error: "Empty body" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }
    if (pdfBytes.length > 10_000_000) {
      return new Response(
        JSON.stringify({ error: "PDF too large (max 10MB)" }),
        { status: 413, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Supabase client (service role) ---
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // --- Verify invoice belongs to customer ---
    const { data: invoice, error: lookupErr } = await supabase
      .from("invoices")
      .select("id")
      .eq("id", invoiceId)
      .eq("customer_id", customerId)
      .single();

    if (lookupErr || !invoice) {
      return new Response(
        JSON.stringify({ error: "Invoice not found" }),
        { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Upload to Storage ---
    const storagePath = `${customerId}/${invoiceId}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from("invoice-pdfs")
      .upload(storagePath, pdfBytes.buffer, {
        contentType: "application/pdf",
        cacheControl: "31536000",
        upsert: true,
      });

    if (uploadError) {
      console.error("Storage upload failed:", uploadError.message);
      // Log failure for monitoring
      await supabase.from("processing_logs").insert({
        customer_id: customerId,
        invoice_id: invoiceId,
        status: "error",
        step: "pdf_upload",
        error_message: `PDF upload failed: ${uploadError.message}`,
        input: { storage_path: storagePath, size_bytes: pdfBytes.length },
      }).then(({ error: logErr }) => {
        if (logErr) console.error("Failed to log upload error:", logErr.message);
      });
      return new Response(
        JSON.stringify({ error: "Upload failed" }),
        { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Update invoice record ---
    await supabase
      .from("invoices")
      .update({ pdf_storage_path: storagePath })
      .eq("id", invoiceId);

    console.log(`PDF uploaded: ${storagePath} (${pdfBytes.length} bytes)`);

    return new Response(
      JSON.stringify({ success: true, pdf_storage_path: storagePath }),
      { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: err.status, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }
    console.error("upload-invoice-pdf error:", err);
    // Best-effort log to processing_logs for monitoring
    try {
      const logSupabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      await logSupabase.from("processing_logs").insert({
        status: "error",
        step: "pdf_upload",
        error_message: `upload-invoice-pdf error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } catch { /* ignore logging failures */ }
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
