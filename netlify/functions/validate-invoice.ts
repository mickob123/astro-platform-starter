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
  existing_invoice_numbers: z.array(z.string()),
});

const OutputSchema = z.object({
  is_valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});

const TOLERANCE = 0.01;

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
    const { invoice, existing_invoice_numbers } = input;

    const errors: string[] = [];
    const warnings: string[] = [];

    // Required field validations
    if (!invoice.vendor_name || invoice.vendor_name.trim() === "") {
      errors.push("vendor_name is required");
    }

    if (!invoice.currency || invoice.currency.trim() === "") {
      errors.push("currency is required");
    }

    // Total must be positive
    if (invoice.total <= 0) {
      errors.push("total must be greater than 0");
    }

    // Duplicate check
    if (
      invoice.invoice_number &&
      existing_invoice_numbers.includes(invoice.invoice_number)
    ) {
      errors.push(
        `invoice_number "${invoice.invoice_number}" already exists (duplicate)`
      );
    }

    // Math validation: subtotal + tax = total (±tolerance)
    const tax = invoice.tax ?? 0;
    const calculatedTotal = invoice.subtotal + tax;
    if (Math.abs(calculatedTotal - invoice.total) > TOLERANCE) {
      errors.push(
        `Math validation failed: subtotal (${invoice.subtotal}) + tax (${tax}) = ${calculatedTotal}, but total is ${invoice.total}`
      );
    }

    // Warnings
    if (!invoice.due_date) {
      warnings.push("due_date is not specified");
    }

    if (!invoice.invoice_number || invoice.invoice_number.trim() === "") {
      warnings.push("invoice_number is empty");
    }

    if (invoice.line_items.length === 0) {
      warnings.push("No line items present");
    }

    // Line items total vs subtotal check
    if (invoice.line_items.length > 0) {
      const lineItemsTotal = invoice.line_items.reduce(
        (sum, item) => sum + item.total,
        0
      );
      if (Math.abs(lineItemsTotal - invoice.subtotal) > TOLERANCE) {
        warnings.push(
          `Line items total (${lineItemsTotal.toFixed(2)}) does not match subtotal (${invoice.subtotal.toFixed(2)})`
        );
      }
    }

    const output = OutputSchema.parse({
      is_valid: errors.length === 0,
      errors,
      warnings,
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(output),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      statusCode: 400,
      body: JSON.stringify({ error: message }),
    };
  }
};
