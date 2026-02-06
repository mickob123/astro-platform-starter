import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { validateAccountingInput } from "../_shared/schemas.ts";
import { logProcessingStep } from "../_shared/db.ts";

const DEFAULT_EXPENSE_ACCOUNT_ID = "1";
const DEFAULT_TAX_CODE_ID = "NON";

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const startTime = Date.now();
  const customerId = req.headers.get("x-customer-id") || "system";

  try {
    const body = await req.json();
    const input = validateAccountingInput(body);
    const { invoice, vendor_id, account_code } = input;

    await logProcessingStep(customerId, null, "quickbooks_payload", "started", input, null, null, null);

    const expenseAccountId = account_code || DEFAULT_EXPENSE_ACCOUNT_ID;

    const lineItems = invoice.line_items.map((item, index) => ({
      Id: String(index + 1),
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: item.total,
      Description: item.description,
      AccountBasedExpenseLineDetail: {
        AccountRef: {
          value: expenseAccountId,
        },
        BillableStatus: "NotBillable",
        TaxCodeRef: {
          value: DEFAULT_TAX_CODE_ID,
        },
      },
    }));

    if (invoice.tax !== null && invoice.tax > 0) {
      lineItems.push({
        Id: String(lineItems.length + 1),
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: invoice.tax,
        Description: "Tax",
        AccountBasedExpenseLineDetail: {
          AccountRef: {
            value: expenseAccountId,
          },
          BillableStatus: "NotBillable",
          TaxCodeRef: {
            value: "TAX",
          },
        },
      });
    }

    const payload: Record<string, unknown> = {
      VendorRef: {
        value: vendor_id,
      },
      Line: lineItems,
      DocNumber: invoice.invoice_number,
      TxnDate: invoice.invoice_date,
      CurrencyRef: {
        value: invoice.currency,
      },
      TotalAmt: invoice.total,
      PrivateNote: `Imported from invoice: ${invoice.invoice_number}`,
    };

    if (invoice.due_date) {
      payload.DueDate = invoice.due_date;
    }

    const result = { quickbooks_payload: payload };

    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "quickbooks_payload", "success", input, result, null, duration);

    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "quickbooks_payload", "error", null, null, message, duration);
    return errorResponse(message);
  }
});
