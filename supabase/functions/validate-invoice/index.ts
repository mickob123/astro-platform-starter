import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { validateValidatorInput, ValidatorOutput } from "../_shared/schemas.ts";
import { logProcessingStep } from "../_shared/db.ts";

const TOLERANCE = 0.01;

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const startTime = Date.now();
  const customerId = req.headers.get("x-customer-id") || "system";

  try {
    const body = await req.json();
    const input = validateValidatorInput(body);
    const { invoice, existing_invoice_numbers } = input;

    await logProcessingStep(customerId, null, "validate", "started", input, null, null, null);

    const errors: string[] = [];
    const warnings: string[] = [];

    // Required field checks
    if (!invoice.vendor_name || invoice.vendor_name.trim() === "") {
      errors.push("vendor_name is required");
    }

    if (!invoice.currency || invoice.currency.trim() === "") {
      errors.push("currency is required");
    }

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

    // Math validation: subtotal + tax = total (within tolerance)
    const tax = invoice.tax ?? 0;
    const expectedTotal = invoice.subtotal + tax;
    const difference = Math.abs(expectedTotal - invoice.total);

    if (difference > TOLERANCE) {
      errors.push(
        `Math validation failed: subtotal (${invoice.subtotal}) + tax (${tax}) = ${expectedTotal}, but total is ${invoice.total}`
      );
    }

    // Warnings
    if (!invoice.due_date) {
      warnings.push("due_date is not specified");
    }

    if (!invoice.invoice_number || invoice.invoice_number.trim() === "") {
      warnings.push("invoice_number is empty");
    }

    if (!invoice.line_items || invoice.line_items.length === 0) {
      warnings.push("No line items present");
    } else {
      const lineItemsTotal = invoice.line_items.reduce(
        (sum, item) => sum + item.total,
        0
      );
      const lineItemsDiff = Math.abs(lineItemsTotal - invoice.subtotal);
      if (lineItemsDiff > TOLERANCE) {
        warnings.push(
          `Line items total (${lineItemsTotal.toFixed(2)}) does not match subtotal (${invoice.subtotal.toFixed(2)})`
        );
      }
    }

    const result: ValidatorOutput = {
      is_valid: errors.length === 0,
      errors,
      warnings,
    };

    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "validate", "success", input, result, null, duration);

    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "validate", "error", null, null, message, duration);
    return errorResponse(message);
  }
});
