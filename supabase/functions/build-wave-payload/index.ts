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
    const { invoice, vendor_id, business_id, account_id } = input;

    if (!business_id) {
      throw new Error("business_id is required for Wave");
    }
    if (!account_id) {
      throw new Error("account_id is required for Wave");
    }

    await logProcessingStep(customerId, null, "wave_payload", "started", input, null, null, null);

    const items = invoice.line_items.map((item) => ({
      accountId: account_id,
      description: item.description,
      quantity: item.quantity ?? 1,
      unitPrice: (item.unit_price ?? item.total).toFixed(2),
      totalAmount: item.total.toFixed(2),
    }));

    if (invoice.tax !== null && invoice.tax > 0) {
      items.push({
        accountId: account_id,
        description: "Tax",
        quantity: 1,
        unitPrice: invoice.tax.toFixed(2),
        totalAmount: invoice.tax.toFixed(2),
      });
    }

    const payload: Record<string, unknown> = {
      input: {
        businessId: business_id,
        vendorId: vendor_id,
        billNumber: invoice.invoice_number,
        billDate: invoice.invoice_date,
        currency: invoice.currency,
        memo: `Imported from invoice: ${invoice.invoice_number}`,
        status: "SAVED",
        items: items,
      },
    };

    if (invoice.due_date) {
      (payload.input as Record<string, unknown>).dueDate = invoice.due_date;
    }

    const result = { wave_payload: payload };

    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "wave_payload", "success", input, result, null, duration);

    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "wave_payload", "error", null, null, message, duration);
    return errorResponse(message);
  }
});
