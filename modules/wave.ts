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

export const WaveInputSchema = z.object({
  invoice: InvoiceSchema,
  business_id: z.string(),
  vendor_id: z.string(),
  account_id: z.string(),
});

export const WaveLineItemSchema = z.object({
  accountId: z.string(),
  description: z.string(),
  quantity: z.number(),
  unitPrice: z.string(),
  totalAmount: z.string(),
});

export const WavePayloadSchema = z.object({
  input: z.object({
    businessId: z.string(),
    vendorId: z.string(),
    billNumber: z.string(),
    billDate: z.string(),
    dueDate: z.string().optional(),
    currency: z.string(),
    memo: z.string().optional(),
    status: z.enum(["SAVED", "PAID", "PARTIAL", "OVERDUE", "UNPAID"]),
    items: z.array(WaveLineItemSchema),
  }),
});

export const WaveOutputSchema = z.object({
  wave_payload: WavePayloadSchema,
});

export type WaveInput = z.infer<typeof WaveInputSchema>;
export type WaveOutput = z.infer<typeof WaveOutputSchema>;
export type WavePayload = z.infer<typeof WavePayloadSchema>;

export function buildWavePayload(input: WaveInput): WaveOutput {
  const validatedInput = WaveInputSchema.parse(input);
  const { invoice, business_id, vendor_id, account_id } = validatedInput;

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

  const payload: WavePayload = {
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
    payload.input.dueDate = invoice.due_date;
  }

  return WaveOutputSchema.parse({ wave_payload: payload });
}
