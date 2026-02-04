import { z } from "zod";

export const LineItemSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unit_price: z.number().nullable(),
  total: z.number(),
});

export const InvoiceSchema = z.object({
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

export const FreshBooksInputSchema = z.object({
  invoice: InvoiceSchema,
  account_id: z.string(),
  vendor_id: z.string(),
  expense_category_id: z.string().optional().default("1"),
});

export const FreshBooksLineItemSchema = z.object({
  category_id: z.string(),
  description: z.string(),
  amount: z.object({
    amount: z.string(),
    code: z.string(),
  }),
  quantity: z.number(),
  unit_cost: z.object({
    amount: z.string(),
    code: z.string(),
  }),
});

export const FreshBooksPayloadSchema = z.object({
  expense: z.object({
    vendorid: z.string(),
    vendor: z.string(),
    date: z.string(),
    currency_code: z.string(),
    categoryid: z.string(),
    notes: z.string(),
    lines: z.array(FreshBooksLineItemSchema),
    amount: z.object({
      amount: z.string(),
      code: z.string(),
    }),
    taxAmount1: z.object({
      amount: z.string(),
      code: z.string(),
    }).nullable(),
    include_receipt: z.boolean(),
    status: z.number(),
  }),
});

export const FreshBooksOutputSchema = z.object({
  freshbooks_payload: FreshBooksPayloadSchema,
});

export type FreshBooksInput = z.infer<typeof FreshBooksInputSchema>;
export type FreshBooksOutput = z.infer<typeof FreshBooksOutputSchema>;
export type FreshBooksPayload = z.infer<typeof FreshBooksPayloadSchema>;

export function buildFreshBooksPayload(input: FreshBooksInput): FreshBooksOutput {
  const validatedInput = FreshBooksInputSchema.parse(input);
  const { invoice, vendor_id, expense_category_id } = validatedInput;

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

  const payload: FreshBooksPayload = {
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

  return FreshBooksOutputSchema.parse({ freshbooks_payload: payload });
}
