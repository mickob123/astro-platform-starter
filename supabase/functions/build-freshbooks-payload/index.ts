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
    const { invoice, vendor_id, account_id, expense_category_id } = input;

    const categoryId = expense_category_id || "1";

    await logProcessingStep(customerId, null, "freshbooks_payload", "started", input, null, null, null);

    const lines = invoice.line_items.map((item) => ({
      category_id: categoryId,
      description: item.description,
      amount: {
        amount: item.total.toFixed(2),
        code: invoice.currency,
      },
      quantity: item.quantity ?? 1,
      unit_cost: {
        amount: (item.unit_price ?? item.total).toFixed(2),
        code: invoice.currency,
      },
    }));

    const payload = {
      expense: {
        vendorid: vendor_id,
        vendor: invoice.vendor_name,
        date: invoice.invoice_date,
        currency_code: invoice.currency,
        categoryid: categoryId,
        notes: `Invoice: ${invoice.invoice_number}`,
        lines: lines,
        amount: {
          amount: invoice.total.toFixed(2),
          code: invoice.currency,
        },
        taxAmount1: invoice.tax !== null ? {
          amount: invoice.tax.toFixed(2),
          code: invoice.currency,
        } : null,
        include_receipt: false,
        status: 0,
        account_id: account_id || null,
      },
    };

    const result = { freshbooks_payload: payload };

    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "freshbooks_payload", "success", input, result, null, duration);

    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "freshbooks_payload", "error", null, null, message, duration);
    return errorResponse(message);
  }
});
