/**
 * Serve invoice PDF attachments via signed URL.
 *
 * GET ?invoice_id=uuid — returns a short-lived signed URL
 *
 * Auth: Supabase JWT + admin role (same as approve-invoice).
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyJwt, requireAdmin, AuthError } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
          headers: { ...headers, "Content-Type": "application/json" },
        },
      );
    }

    const url = new URL(req.url);
    const invoiceId = url.searchParams.get("invoice_id");

    if (!invoiceId || !UUID_RE.test(invoiceId)) {
      return new Response(
        JSON.stringify({ error: "invoice_id must be a valid UUID" }),
        {
          status: 400,
          headers: { ...headers, "Content-Type": "application/json" },
        },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: invoice, error: fetchError } = await supabase
      .from("invoices")
      .select("id, pdf_storage_path")
      .eq("id", invoiceId)
      .single();

    if (fetchError || !invoice) {
      return new Response(
        JSON.stringify({ error: "Invoice not found" }),
        {
          status: 404,
          headers: { ...headers, "Content-Type": "application/json" },
        },
      );
    }

    if (!invoice.pdf_storage_path) {
      return new Response(
        JSON.stringify({ error: "No PDF attachment for this invoice" }),
        {
          status: 404,
          headers: { ...headers, "Content-Type": "application/json" },
        },
      );
    }

    // Signed URL valid for 5 minutes
    const { data: signedUrlData, error: signedUrlError } =
      await supabase.storage
        .from("invoice-pdfs")
        .createSignedUrl(invoice.pdf_storage_path, 300);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      console.error("Signed URL error:", signedUrlError?.message);
      return new Response(
        JSON.stringify({ error: "Failed to generate PDF URL" }),
        {
          status: 500,
          headers: { ...headers, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        signed_url: signedUrlData.signedUrl,
        expires_in: 300,
      }),
      {
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(
        JSON.stringify({ error: error.message }),
        {
          status: error.status,
          headers: { ...headers, "Content-Type": "application/json" },
        },
      );
    }
    console.error("get-invoice-pdf error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve PDF" }),
      {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }
});
