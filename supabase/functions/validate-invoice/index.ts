import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyApiKey, AuthError } from "../_shared/auth.ts";

const MATH_TOLERANCE = 0.01;

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    const { customer_id, supabase } = await verifyApiKey(req);

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { invoice } = body;

    if (!invoice) {
      return new Response(
        JSON.stringify({ error: "invoice object is required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // Fetch existing invoice numbers for THIS customer only (tenant isolation)
    const { data: existingInvoices } = await supabase
      .from("invoices")
      .select("invoice_number")
      .eq("customer_id", customer_id);

    const existingNumbers = (existingInvoices || []).map(
      (i: { invoice_number: string }) => i.invoice_number,
    );

    const errors: string[] = [];
    const warnings: string[] = [];

    // Required field checks
    if (!invoice.vendor_name || invoice.vendor_name.trim() === "") {
      errors.push("vendor_name is required");
    }
    if (!invoice.currency || invoice.currency.trim() === "") {
      errors.push("currency is required");
    } else if (invoice.currency.length !== 3) {
      errors.push("currency must be a valid ISO 4217 code (3 characters)");
    }
    if (invoice.total <= 0) {
      errors.push("total must be greater than 0");
    }

    // Duplicate check — scoped to this customer
    if (existingNumbers.includes(invoice.invoice_number)) {
      errors.push(
        `invoice_number "${invoice.invoice_number}" already exists (duplicate)`,
      );
    }

    // Math validation
    const taxAmount = invoice.tax ?? 0;
    const expectedTotal = invoice.subtotal + taxAmount;
    const difference = Math.abs(expectedTotal - invoice.total);
    if (difference > MATH_TOLERANCE) {
      errors.push(
        `Math validation failed: subtotal (${invoice.subtotal}) + tax (${taxAmount}) = ${expectedTotal}, but total is ${invoice.total} (difference: ${difference.toFixed(2)})`,
      );
    }

    // Warnings
    if (!invoice.invoice_number || invoice.invoice_number.trim() === "") {
      warnings.push("invoice_number is empty");
    }
    if (!invoice.due_date) {
      warnings.push("due_date is not specified");
    }
    if (!invoice.line_items || invoice.line_items.length === 0) {
      warnings.push("No line items present");
    }

    // Line items total check
    if (invoice.line_items && invoice.line_items.length > 0) {
      const lineItemsTotal = invoice.line_items.reduce(
        (sum: number, item: { total: number }) => sum + item.total,
        0,
      );
      const lineItemsDiffSubtotal = Math.abs(lineItemsTotal - invoice.subtotal);
      const lineItemsDiffTotal = Math.abs(lineItemsTotal - invoice.total);
      if (lineItemsDiffSubtotal > MATH_TOLERANCE && lineItemsDiffTotal > MATH_TOLERANCE) {
        warnings.push(
          `Line items total (${lineItemsTotal.toFixed(2)}) does not match subtotal (${invoice.subtotal}) or total (${invoice.total})`,
        );
      }
    }

    return new Response(
      JSON.stringify({
        is_valid: errors.length === 0,
        errors,
        warnings,
        customer_id,
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
    console.error("validate-invoice error:", error);
    return new Response(
      JSON.stringify({ error: "Validation failed" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
