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

export const ValidatorInputSchema = z.object({
  invoice: InvoiceSchema,
  existing_invoice_numbers: z.array(z.string()),
});

export const ValidatorOutputSchema = z.object({
  is_valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type Invoice = z.infer<typeof InvoiceSchema>;
export type ValidatorInput = z.infer<typeof ValidatorInputSchema>;
export type ValidatorOutput = z.infer<typeof ValidatorOutputSchema>;

const MATH_TOLERANCE = 0.01;

export function validateInvoice(input: ValidatorInput): ValidatorOutput {
  const validatedInput = ValidatorInputSchema.parse(input);
  const { invoice, existing_invoice_numbers } = validatedInput;

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!invoice.vendor_name || invoice.vendor_name.trim() === "") {
    errors.push("vendor_name is required");
  }

  if (!invoice.currency || invoice.currency.trim() === "") {
    errors.push("currency is required");
  } else if (invoice.currency.length !== 3) {
    errors.push("currency must be a valid ISO 4217 code (3 characters)");
  }

  if (invoice.total <= 0) {
    errors.push("total must be greater than 0");
  }

  if (existing_invoice_numbers.includes(invoice.invoice_number)) {
    errors.push(
      `invoice_number "${invoice.invoice_number}" already exists (duplicate)`
    );
  }

  const taxAmount = invoice.tax ?? 0;
  const expectedTotal = invoice.subtotal + taxAmount;
  const difference = Math.abs(expectedTotal - invoice.total);

  if (difference > MATH_TOLERANCE) {
    errors.push(
      `Math validation failed: subtotal (${invoice.subtotal}) + tax (${taxAmount}) = ${expectedTotal}, but total is ${invoice.total} (difference: ${difference.toFixed(2)})`
    );
  }

  if (!invoice.invoice_number || invoice.invoice_number.trim() === "") {
    warnings.push("invoice_number is empty");
  }

  if (!invoice.due_date) {
    warnings.push("due_date is not specified");
  }

  if (invoice.line_items.length === 0) {
    warnings.push("No line items present");
  }

  const lineItemsTotal = invoice.line_items.reduce(
    (sum, item) => sum + item.total,
    0
  );
  const lineItemsDiffSubtotal = Math.abs(lineItemsTotal - invoice.subtotal);
  const lineItemsDiffTotal = Math.abs(lineItemsTotal - invoice.total);
  // Accept if line items match subtotal (tax-exclusive) OR total (GST-inclusive pricing)
  if (
    invoice.line_items.length > 0 &&
    lineItemsDiffSubtotal > MATH_TOLERANCE &&
    lineItemsDiffTotal > MATH_TOLERANCE
  ) {
    warnings.push(
      `Line items total (${lineItemsTotal.toFixed(2)}) does not match subtotal (${invoice.subtotal}) or total (${invoice.total})`
    );
  }

  return {
    is_valid: errors.length === 0,
    errors,
    warnings,
  };
}
