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
  account_id: z.string(),
  vendor_id: z.string(),
  expense_category_id: z.string().optional().default("1"),
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
    const { invoice, vendor_id, expense_category_id } = input;

    const lines = invoice.line_items.map((item) => ({
      category_id: expense_category_id,
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
        categoryid: expense_category_id,
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
      },
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshbooks_payload: payload }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      statusCode: 400,
      body: JSON.stringify({ error: message }),
    };
  }
};
