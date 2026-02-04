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
  business_id: z.string(),
  vendor_id: z.string(),
  account_id: z.string(),
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
    const { invoice, business_id, vendor_id, account_id } = input;

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

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wave_payload: payload }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      statusCode: 400,
      body: JSON.stringify({ error: message }),
    };
  }
};
