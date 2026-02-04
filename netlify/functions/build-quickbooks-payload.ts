import type { Handler } from "@netlify/functions";
import { z } from "zod";

const LineItemSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unit_price: z.number().nullable(),
  total: z.number(),
});

const InvoiceSchema = z.object({
  vendor_name: z.string(),
  invoice_number: z.string(),
  invoice_date: z.string(),
  due_date: z.string().nullable(),
  currency: z.string(),
  line_items: z.array(LineItemSchema),
  subtotal: z.number(),
  tax: z.number().nullable(),
  total: z.number(),
});

const InputSchema = z.object({
  invoice: InvoiceSchema,
  vendor_id: z.string(),
});

const DEFAULT_EXPENSE_ACCOUNT_ID = "1";
const DEFAULT_TAX_CODE_ID = "NON";

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const input = InputSchema.parse(body);
    const { invoice, vendor_id } = input;

    const lineItems = invoice.line_items.map((item, index) => ({
      Id: String(index + 1),
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: item.total,
      Description: item.description,
      AccountBasedExpenseLineDetail: {
        AccountRef: {
          value: DEFAULT_EXPENSE_ACCOUNT_ID,
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
            value: DEFAULT_EXPENSE_ACCOUNT_ID,
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

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quickbooks_payload: payload }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      statusCode: 400,
      body: JSON.stringify({ error: message }),
    };
  }
};
