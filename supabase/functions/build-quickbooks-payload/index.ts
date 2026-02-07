import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyApiKey, AuthError } from "../_shared/auth.ts";

const DEFAULT_EXPENSE_ACCOUNT_ID = "1";
const DEFAULT_TAX_CODE_ID = "NON";

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    await verifyApiKey(req);

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { invoice, vendor_id } = body;

    if (!invoice || !vendor_id) {
      return new Response(
        JSON.stringify({ error: "invoice and vendor_id are required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    const lineItems = (invoice.line_items || []).map(
      (item: { total: number; description: string }, index: number) => ({
        Id: String(index + 1),
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: item.total,
        Description: item.description,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: DEFAULT_EXPENSE_ACCOUNT_ID },
          BillableStatus: "NotBillable",
          TaxCodeRef: { value: DEFAULT_TAX_CODE_ID },
        },
      }),
    );

    if (invoice.tax !== null && invoice.tax > 0) {
      lineItems.push({
        Id: String(lineItems.length + 1),
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: invoice.tax,
        Description: "Tax",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: DEFAULT_EXPENSE_ACCOUNT_ID },
          BillableStatus: "NotBillable",
          TaxCodeRef: { value: "TAX" },
        },
      });
    }

    const payload: Record<string, unknown> = {
      VendorRef: { value: vendor_id },
      Line: lineItems,
      DocNumber: invoice.invoice_number,
      TxnDate: invoice.invoice_date,
      CurrencyRef: { value: invoice.currency },
      TotalAmt: invoice.total,
      PrivateNote: `Imported from invoice: ${invoice.invoice_number}`,
    };

    if (invoice.due_date) {
      payload.DueDate = invoice.due_date;
    }

    return new Response(
      JSON.stringify({ quickbooks_payload: payload }),
      { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    console.error("build-quickbooks-payload error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to build QuickBooks payload" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
