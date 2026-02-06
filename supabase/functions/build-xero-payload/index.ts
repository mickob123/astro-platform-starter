import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { validateAccountingInput } from "../_shared/schemas.ts";
import { logProcessingStep } from "../_shared/db.ts";

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const startTime = Date.now();
  const customerId = req.headers.get("x-customer-id") || "system";

  try {
    const body = await req.json();
    const input = validateAccountingInput(body);
    const { invoice, contact_id, account_code, tax_type } = input;

    // Xero uses contact_id, fall back to vendor_id
    const xeroContactId = contact_id || input.vendor_id;
    const xeroAccountCode = account_code || "200";
    const xeroTaxType = tax_type || "NONE";

    await logProcessingStep(customerId, null, "xero_payload", "started", input, null, null, null);

    const lineItems = invoice.line_items.map((item) => ({
      Description: item.description,
      Quantity: item.quantity ?? 1,
      UnitAmount: item.unit_price ?? item.total,
      AccountCode: xeroAccountCode,
      TaxType: xeroTaxType,
      LineAmount: item.total,
    }));

    const payload: Record<string, unknown> = {
      Type: "ACCPAY",
      Contact: {
        ContactID: xeroContactId,
      },
      Date: invoice.invoice_date,
      LineAmountTypes: invoice.tax !== null ? "Exclusive" : "NoTax",
      InvoiceNumber: invoice.invoice_number,
      Reference: `Imported: ${invoice.invoice_number}`,
      CurrencyCode: invoice.currency,
      Status: "DRAFT",
      LineItems: lineItems,
      SubTotal: invoice.subtotal,
      TotalTax: invoice.tax ?? 0,
      Total: invoice.total,
    };

    if (invoice.due_date) {
      payload.DueDate = invoice.due_date;
    }

    const result = { xero_payload: payload };

    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "xero_payload", "success", input, result, null, duration);

    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "xero_payload", "error", null, null, message, duration);
    return errorResponse(message);
  }
});
