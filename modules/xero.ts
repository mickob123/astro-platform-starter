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

export const XeroInputSchema = z.object({
  invoice: InvoiceSchema,
  contact_id: z.string(),
  account_code: z.string().optional().default("200"),
  tax_type: z.string().optional().default("NONE"),
});

export const XeroLineItemSchema = z.object({
  Description: z.string(),
  Quantity: z.number(),
  UnitAmount: z.number(),
  AccountCode: z.string(),
  TaxType: z.string(),
  LineAmount: z.number(),
});

export const XeroPayloadSchema = z.object({
  Type: z.literal("ACCPAY"),
  Contact: z.object({
    ContactID: z.string(),
  }),
  Date: z.string(),
  DueDate: z.string().optional(),
  LineAmountTypes: z.enum(["Exclusive", "Inclusive", "NoTax"]),
  InvoiceNumber: z.string(),
  Reference: z.string().optional(),
  CurrencyCode: z.string(),
  Status: z.enum(["DRAFT", "SUBMITTED", "AUTHORISED"]),
  LineItems: z.array(XeroLineItemSchema),
  SubTotal: z.number(),
  TotalTax: z.number(),
  Total: z.number(),
});

export const XeroOutputSchema = z.object({
  xero_payload: XeroPayloadSchema,
});

export type XeroInput = z.infer<typeof XeroInputSchema>;
export type XeroOutput = z.infer<typeof XeroOutputSchema>;
export type XeroPayload = z.infer<typeof XeroPayloadSchema>;

export function buildXeroPayload(input: XeroInput): XeroOutput {
  const validatedInput = XeroInputSchema.parse(input);
  const { invoice, contact_id, account_code, tax_type } = validatedInput;

  const lineItems = invoice.line_items.map((item) => ({
    Description: item.description,
    Quantity: item.quantity ?? 1,
    UnitAmount: item.unit_price ?? item.total,
    AccountCode: account_code,
    TaxType: tax_type,
    LineAmount: item.total,
  }));

  const payload: XeroPayload = {
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

  return XeroOutputSchema.parse({ xero_payload: payload });
}
