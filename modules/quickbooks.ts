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

export const QuickBooksInputSchema = z.object({
  invoice: InvoiceSchema,
  vendor_id: z.string(),
});

export const QuickBooksLineItemSchema = z.object({
  Id: z.string().optional(),
  DetailType: z.literal("AccountBasedExpenseLineDetail"),
  Amount: z.number(),
  Description: z.string().optional(),
  AccountBasedExpenseLineDetail: z.object({
    AccountRef: z.object({
      value: z.string(),
    }),
    BillableStatus: z.literal("NotBillable"),
    TaxCodeRef: z.object({
      value: z.string(),
    }),
  }),
});

export const QuickBooksPayloadSchema = z.object({
  VendorRef: z.object({
    value: z.string(),
  }),
  Line: z.array(QuickBooksLineItemSchema),
  DocNumber: z.string(),
  TxnDate: z.string(),
  DueDate: z.string().optional(),
  CurrencyRef: z.object({
    value: z.string(),
  }),
  PrivateNote: z.string().optional(),
  TotalAmt: z.number(),
});

export const QuickBooksOutputSchema = z.object({
  quickbooks_payload: QuickBooksPayloadSchema,
});

export type QuickBooksInput = z.infer<typeof QuickBooksInputSchema>;
export type QuickBooksOutput = z.infer<typeof QuickBooksOutputSchema>;
export type QuickBooksPayload = z.infer<typeof QuickBooksPayloadSchema>;

const DEFAULT_EXPENSE_ACCOUNT_ID = "1";
const DEFAULT_TAX_CODE_ID = "NON";

export function buildQuickBooksPayload(
  input: QuickBooksInput
): QuickBooksOutput {
  const validatedInput = QuickBooksInputSchema.parse(input);
  const { invoice, vendor_id } = validatedInput;

  const lineItems = invoice.line_items.map((item, index) => ({
    Id: String(index + 1),
    DetailType: "AccountBasedExpenseLineDetail" as const,
    Amount: item.total,
    Description: item.description,
    AccountBasedExpenseLineDetail: {
      AccountRef: {
        value: DEFAULT_EXPENSE_ACCOUNT_ID,
      },
      BillableStatus: "NotBillable" as const,
      TaxCodeRef: {
        value: DEFAULT_TAX_CODE_ID,
      },
    },
  }));

  if (invoice.tax !== null && invoice.tax > 0) {
    lineItems.push({
      Id: String(lineItems.length + 1),
      DetailType: "AccountBasedExpenseLineDetail" as const,
      Amount: invoice.tax,
      Description: "Tax",
      AccountBasedExpenseLineDetail: {
        AccountRef: {
          value: DEFAULT_EXPENSE_ACCOUNT_ID,
        },
        BillableStatus: "NotBillable" as const,
        TaxCodeRef: {
          value: "TAX",
        },
      },
    });
  }

  const payload: QuickBooksPayload = {
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

  return QuickBooksOutputSchema.parse({ quickbooks_payload: payload });
}
