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
  contact_id: z.string(),
  account_code: z.string().optional().default("200"),
  tax_type: z.string().optional().default("NONE"),
});

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
    const { invoice, contact_id, account_code, tax_type } = input;

    const lineItems = invoice.line_items.map((item) => ({
      Description: item.description,
      Quantity: item.quantity ?? 1,
      UnitAmount: item.unit_price ?? item.total,
      AccountCode: account_code,
      TaxType: tax_type,
      LineAmount: item.total,
    }));

    const payload: Record<string, unknown> = {
      Type: "ACCPAY",
      Contact: {
        ContactID: contact_id,
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

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xero_payload: payload }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      statusCode: 400,
      body: JSON.stringify({ error: message }),
    };
  }
};
