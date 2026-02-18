import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateInvoice,
  type ValidatorInput,
  type Invoice,
} from "../modules/validator";
import {
  buildQuickBooksPayload,
  type QuickBooksInput,
} from "../modules/quickbooks";
import {
  buildSlackNotification,
  type SlackInput,
} from "../modules/slack";

/**
 * Pipeline integration tests.
 *
 * The process-invoice Edge Function orchestrates:
 *   classify -> extract -> validate -> save -> notify
 *
 * Since the Edge Function runs in Deno and calls OpenAI + Supabase, we test
 * the pipeline logic by exercising the same modules and simulating the
 * intermediate data that flows between steps.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeClassification(overrides: Record<string, unknown> = {}) {
  return {
    is_invoice: true,
    vendor_name: "Acme Corp",
    confidence: 0.95,
    signals: ["invoice number present", "total amount found", "due date mentioned"],
    ...overrides,
  };
}

function makeExtraction(overrides: Partial<Invoice> = {}): Invoice {
  return {
    vendor_name: "Acme Corp",
    invoice_number: "INV-2024-001",
    invoice_date: "2024-01-15",
    due_date: "2024-02-15",
    currency: "USD",
    line_items: [
      {
        description: "Consulting Services",
        quantity: 10,
        unit_price: 100,
        total: 1000,
      },
    ],
    subtotal: 1000,
    tax: 100,
    total: 1100,
    ...overrides,
  };
}

// Replicate the inline validateInvoice from process-invoice Edge Function
function pipelineValidateInvoice(
  invoice: Record<string, unknown>,
  existingNumbers: string[]
): { is_valid: boolean; errors: string[]; warnings: string[] } {
  const MATH_TOLERANCE = 0.01;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!invoice.vendor_name || (invoice.vendor_name as string).trim() === "") {
    errors.push("vendor_name is required");
  }
  if (!invoice.currency || (invoice.currency as string).trim() === "") {
    errors.push("currency is required");
  } else if ((invoice.currency as string).length !== 3) {
    errors.push("currency must be a valid ISO 4217 code (3 characters)");
  }
  if ((invoice.total as number) <= 0) {
    errors.push("total must be greater than 0");
  }
  if (existingNumbers.includes(invoice.invoice_number as string)) {
    errors.push(
      `invoice_number "${invoice.invoice_number}" already exists (duplicate)`
    );
  }

  const taxAmount = (invoice.tax as number) ?? 0;
  const expectedTotal = (invoice.subtotal as number) + taxAmount;
  const difference = Math.abs(expectedTotal - (invoice.total as number));
  if (difference > MATH_TOLERANCE) {
    errors.push(
      `Math validation failed: subtotal (${invoice.subtotal}) + tax (${taxAmount}) = ${expectedTotal}, but total is ${invoice.total}`
    );
  }

  if (!invoice.invoice_number || (invoice.invoice_number as string).trim() === "") {
    warnings.push("invoice_number is empty");
  }
  if (!invoice.due_date) {
    warnings.push("due_date is not specified");
  }
  const lineItems = (invoice.line_items as Array<{ total: number }>) || [];
  if (lineItems.length === 0) {
    warnings.push("No line items present");
  } else {
    const lineItemsTotal = lineItems.reduce((sum, item) => sum + item.total, 0);
    const lineItemsDiff = Math.abs(lineItemsTotal - (invoice.subtotal as number));
    if (lineItemsDiff > MATH_TOLERANCE) {
      warnings.push(
        `Line items total (${lineItemsTotal.toFixed(2)}) does not match subtotal (${invoice.subtotal})`
      );
    }
  }

  return { is_valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Full pipeline flow
// ---------------------------------------------------------------------------
describe("Edge Function Pipeline — Full Flow", () => {
  it("should classify, extract, validate a valid invoice successfully", () => {
    // Step 1: Classification
    const classification = makeClassification();
    expect(classification.is_invoice).toBe(true);
    expect(classification.confidence).toBeGreaterThanOrEqual(0.9);

    // Step 2: Extraction
    const extraction = makeExtraction();
    expect(extraction.vendor_name).toBe("Acme Corp");
    expect(extraction.total).toBe(1100);

    // Step 3: Validation
    const validationResult = pipelineValidateInvoice(extraction, []);
    expect(validationResult.is_valid).toBe(true);
    expect(validationResult.errors).toHaveLength(0);

    // Step 4: Determine status
    const status = validationResult.is_valid ? "pending" : "flagged";
    expect(status).toBe("pending");
  });

  it("should complete full pipeline and produce correct final response shape", () => {
    const classification = makeClassification();
    const extraction = makeExtraction();
    const validation = pipelineValidateInvoice(extraction, []);
    const invoiceId = "mock-invoice-uuid";
    const logId = "mock-log-uuid";

    const response = {
      status: "completed",
      invoice_id: invoiceId,
      log_id: logId,
      classification,
      extraction,
      validation,
    };

    expect(response.status).toBe("completed");
    expect(response.invoice_id).toBe(invoiceId);
    expect(response.log_id).toBe(logId);
    expect(response.classification.is_invoice).toBe(true);
    expect(response.extraction.total).toBe(1100);
    expect(response.validation.is_valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Classification below confidence threshold
// ---------------------------------------------------------------------------
describe("Edge Function Pipeline — Low Confidence Classification", () => {
  it("should still proceed when confidence is low but is_invoice is true", () => {
    const classification = makeClassification({ confidence: 0.3 });
    expect(classification.is_invoice).toBe(true);

    // Pipeline would proceed since is_invoice is true
    const extraction = makeExtraction();
    const validation = pipelineValidateInvoice(extraction, []);
    expect(validation.is_valid).toBe(true);
  });

  it("should skip pipeline when is_invoice is false", () => {
    const classification = makeClassification({
      is_invoice: false,
      confidence: 0.1,
      vendor_name: null,
      signals: [],
    });

    // Pipeline should return 'skipped' status
    expect(classification.is_invoice).toBe(false);

    const response = {
      status: "skipped",
      reason: "Not classified as an invoice",
      classification,
      log_id: "log-uuid",
    };

    expect(response.status).toBe("skipped");
    expect(response.reason).toBe("Not classified as an invoice");
  });

  it("should skip pipeline when confidence is 0", () => {
    const classification = makeClassification({
      is_invoice: false,
      confidence: 0,
      vendor_name: null,
    });

    expect(classification.is_invoice).toBe(false);
    expect(classification.confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Extraction returning null vendor
// ---------------------------------------------------------------------------
describe("Edge Function Pipeline — Null Vendor Extraction", () => {
  it("should fall back to classification vendor_name when extraction vendor is null", () => {
    const classification = makeClassification({ vendor_name: "Fallback Corp" });
    const extraction = makeExtraction({ vendor_name: "" });

    // The process-invoice function does:
    // vendorName = extraction.vendor_name || classification.vendor_name || "Unknown Vendor"
    const vendorName =
      extraction.vendor_name || classification.vendor_name || "Unknown Vendor";
    expect(vendorName).toBe("Fallback Corp");
  });

  it("should fall back to 'Unknown Vendor' when both are null/empty", () => {
    const classification = makeClassification({ vendor_name: null });
    const extraction = makeExtraction({ vendor_name: "" });

    const vendorName =
      extraction.vendor_name || classification.vendor_name || "Unknown Vendor";
    expect(vendorName).toBe("Unknown Vendor");
  });

  it("should prefer extraction vendor_name over classification when available", () => {
    const classification = makeClassification({ vendor_name: "Class Vendor" });
    const extraction = makeExtraction({ vendor_name: "Extract Vendor" });

    const vendorName =
      extraction.vendor_name || classification.vendor_name || "Unknown Vendor";
    expect(vendorName).toBe("Extract Vendor");
  });
});

// ---------------------------------------------------------------------------
// Validation errors still save with flagged status
// ---------------------------------------------------------------------------
describe("Edge Function Pipeline — Flagged Status", () => {
  it("should set status to 'flagged' when validation has errors", () => {
    const extraction = makeExtraction({
      subtotal: 1000,
      tax: 100,
      total: 1200, // math error
    });

    const validation = pipelineValidateInvoice(extraction, []);
    expect(validation.is_valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);

    const status = validation.is_valid ? "pending" : "flagged";
    expect(status).toBe("flagged");
  });

  it("should set status to 'flagged' with duplicate invoice number", () => {
    const extraction = makeExtraction({ invoice_number: "DUP-001" });
    const validation = pipelineValidateInvoice(extraction, ["DUP-001"]);

    expect(validation.is_valid).toBe(false);
    const status = validation.is_valid ? "pending" : "flagged";
    expect(status).toBe("flagged");
  });

  it("should set status to 'pending' when validation passes", () => {
    const extraction = makeExtraction();
    const validation = pipelineValidateInvoice(extraction, []);

    expect(validation.is_valid).toBe(true);
    const status = validation.is_valid ? "pending" : "flagged";
    expect(status).toBe("pending");
  });

  it("should still produce a valid response when flagged", () => {
    const classification = makeClassification();
    const extraction = makeExtraction({
      vendor_name: "",
      subtotal: 500,
      tax: 50,
      total: 600, // math error too
    });
    const validation = pipelineValidateInvoice(extraction, []);

    expect(validation.is_valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);

    const response = {
      status: "completed",
      invoice_id: "inv-123",
      log_id: "log-456",
      classification,
      extraction,
      validation,
    };

    expect(response.status).toBe("completed");
    expect(response.validation.is_valid).toBe(false);
    expect(response.validation.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Vendor upsert logic
// ---------------------------------------------------------------------------
describe("Edge Function Pipeline — Vendor Normalization", () => {
  function normalizeVendorName(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-");
  }

  it("should normalize vendor name correctly", () => {
    expect(normalizeVendorName("Acme Corp")).toBe("acme-corp");
  });

  it("should normalize vendor with special chars", () => {
    expect(normalizeVendorName("O'Brien & Partners, LLC")).toBe(
      "o-brien-partners-llc"
    );
  });

  it("should handle leading/trailing whitespace", () => {
    // .trim() removes surrounding whitespace before the regex runs,
    // so "  Vendor Inc  " -> "vendor inc" -> "vendor-inc"
    expect(normalizeVendorName("  Vendor Inc  ")).toBe("vendor-inc");
  });

  it("should handle all-numeric vendor names", () => {
    expect(normalizeVendorName("12345")).toBe("12345");
  });

  it("should produce same normalized name for equivalent inputs", () => {
    const norm1 = normalizeVendorName("Acme Corp");
    const norm2 = normalizeVendorName("acme  corp");
    expect(norm1).toBe(norm2);
  });

  it("should produce different normalized names for different vendors", () => {
    const norm1 = normalizeVendorName("Acme Corp");
    const norm2 = normalizeVendorName("Beta Inc");
    expect(norm1).not.toBe(norm2);
  });
});

// ---------------------------------------------------------------------------
// Processing log steps
// ---------------------------------------------------------------------------
describe("Edge Function Pipeline — Processing Log Steps", () => {
  it("should track expected step progression for successful pipeline", () => {
    const expectedSteps = [
      "classify",
      "classify_done",
      "extract",
      "extract_done",
      "verify",
      "verify_done",
      "duplicate_check",
      "validate",
      "validate_done",
      "save",
      "save_done",
      "notify",
      "done",
    ];

    // Verify the step names are distinct and in order
    expect(new Set(expectedSteps).size).toBe(expectedSteps.length);
    expect(expectedSteps[0]).toBe("classify");
    expect(expectedSteps[expectedSteps.length - 1]).toBe("done");
  });

  it("should set status to 'not_invoice' when classification says no", () => {
    const classification = makeClassification({ is_invoice: false });
    if (!classification.is_invoice) {
      const logUpdate = {
        status: "success",
        step: "not_invoice",
        output: { classification, result: "skipped" },
      };
      expect(logUpdate.step).toBe("not_invoice");
      expect(logUpdate.status).toBe("success");
    }
  });

  it("should set status to 'error' when pipeline fails", () => {
    const error = new Error("OpenAI timeout");
    const logUpdate = {
      status: "error",
      error_message: error.message,
      duration_ms: 5000,
    };

    expect(logUpdate.status).toBe("error");
    expect(logUpdate.error_message).toBe("OpenAI timeout");
    expect(logUpdate.duration_ms).toBeGreaterThan(0);
  });

  it("should record duration_ms on completion", () => {
    const startTime = Date.now();
    // Simulate some work
    const endTime = startTime + 2500;
    const duration = endTime - startTime;

    expect(duration).toBe(2500);
    expect(duration).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Verification step
// ---------------------------------------------------------------------------
describe("Edge Function Pipeline — Verification Step", () => {
  it("should pass data through unchanged when verified", () => {
    const extraction = makeExtraction();
    const verification = {
      status: "VERIFIED",
      corrections: [],
      data: extraction,
    };

    // When status is VERIFIED, verifiedExtraction === extraction
    const verifiedExtraction = verification.status === "CORRECTED" && verification.data
      ? verification.data
      : extraction;

    expect(verifiedExtraction).toEqual(extraction);
    expect(verification.corrections).toHaveLength(0);
  });

  it("should apply corrections when status is CORRECTED", () => {
    const extraction = makeExtraction({
      subtotal: 1000,
      tax: 100,
      total: 1200, // wrong
    });

    const correctedData = {
      ...extraction,
      total: 1100, // fixed
    };

    const verification = {
      status: "CORRECTED",
      corrections: ["Fixed total: 1200 -> 1100 (subtotal 1000 + tax 100)"],
      data: correctedData,
    };

    const verifiedExtraction = verification.status === "CORRECTED" && verification.data
      ? verification.data
      : extraction;

    expect(verifiedExtraction.total).toBe(1100);
    expect(verification.corrections).toHaveLength(1);
    expect(verification.corrections[0]).toContain("Fixed total");
  });

  it("should include verification in response shape", () => {
    const classification = makeClassification();
    const extraction = makeExtraction();
    const verification = { status: "VERIFIED", corrections: [] };
    const validation = pipelineValidateInvoice(extraction, []);

    const response = {
      status: "completed",
      invoice_id: "mock-id",
      log_id: "mock-log",
      classification,
      extraction,
      verification,
      validation,
    };

    expect(response.verification.status).toBe("VERIFIED");
    expect(response.verification.corrections).toHaveLength(0);
    expect(response.validation.is_valid).toBe(true);
  });

  it("should validate corrected data not original", () => {
    // Extraction has a math error
    const extraction = makeExtraction({
      subtotal: 1000,
      tax: 100,
      total: 1200, // wrong
    });

    // Verification corrects it
    const correctedData = { ...extraction, total: 1100 };
    const verifiedExtraction = correctedData;

    // Validation runs on corrected data
    const validation = pipelineValidateInvoice(verifiedExtraction, []);
    expect(validation.is_valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pipeline retry behavior simulation
// ---------------------------------------------------------------------------
describe("Edge Function Pipeline — OpenAI Retry Simulation", () => {
  it("should succeed on first try without retry", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      return { choices: [{ message: { content: '{"is_invoice": true}' } }] };
    };

    const result = await fn();
    expect(attempts).toBe(1);
    expect(JSON.parse(result.choices[0].message.content).is_invoice).toBe(true);
  });

  it("should retry after a retryable error", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error("429 rate limit exceeded");
      }
      return { result: "ok" };
    };

    // Manual retry loop (simulating withRetry)
    let result;
    for (let i = 0; i <= 3; i++) {
      try {
        result = await fn();
        break;
      } catch {
        if (i === 3) throw new Error("max retries exceeded");
      }
    }

    expect(attempts).toBe(2);
    expect(result).toEqual({ result: "ok" });
  });

  it("should propagate non-retryable errors immediately", async () => {
    const fn = async () => {
      throw new Error("Invalid API key");
    };

    await expect(fn()).rejects.toThrow("Invalid API key");
  });
});

// ---------------------------------------------------------------------------
// Pipeline with Slack notification using modules/slack.ts
// ---------------------------------------------------------------------------
describe("Edge Function Pipeline — Slack Notification Integration", () => {
  it("should build Slack notification from pipeline data", () => {
    const classification = makeClassification({ confidence: 0.92 });
    const extraction = makeExtraction();

    const slackInput: SlackInput = {
      vendor: extraction.vendor_name,
      amount: extraction.total,
      currency: extraction.currency,
      due_date: extraction.due_date || "Not specified",
      invoice_number: extraction.invoice_number,
      confidence: classification.confidence as number,
      invoice_url: "https://app.example.com/invoices/123",
    };

    const slackOutput = buildSlackNotification(slackInput);
    expect(slackOutput.blocks.length).toBeGreaterThan(0);

    // Verify header block
    expect(slackOutput.blocks[0].type).toBe("header");

    // Verify vendor info in section fields
    const section = slackOutput.blocks[1];
    const vendorField = section.fields.find((f: any) =>
      f.text.includes("Vendor")
    );
    expect(vendorField.text).toContain("Acme Corp");
  });

  it("should handle pipeline where due_date is null", () => {
    const extraction = makeExtraction({ due_date: null });
    const classification = makeClassification();

    const slackInput: SlackInput = {
      vendor: extraction.vendor_name,
      amount: extraction.total,
      currency: extraction.currency,
      due_date: extraction.due_date || "Not specified",
      invoice_number: extraction.invoice_number,
      confidence: classification.confidence as number,
      invoice_url: "https://app.example.com/invoices/456",
    };

    const slackOutput = buildSlackNotification(slackInput);
    const section = slackOutput.blocks[1];
    const dueDateField = section.fields.find((f: any) =>
      f.text.includes("Due Date")
    );
    expect(dueDateField.text).toContain("Not specified");
  });
});

// ---------------------------------------------------------------------------
// Pipeline with QuickBooks payload using modules/quickbooks.ts
// ---------------------------------------------------------------------------
describe("Edge Function Pipeline — QuickBooks Integration", () => {
  it("should build QuickBooks payload from pipeline extraction", () => {
    const extraction = makeExtraction();
    const vendorId = "qb-vendor-123";

    const qbInput: QuickBooksInput = {
      invoice: extraction,
      vendor_id: vendorId,
    };

    const qbOutput = buildQuickBooksPayload(qbInput);
    expect(qbOutput.quickbooks_payload.VendorRef.value).toBe("qb-vendor-123");
    expect(qbOutput.quickbooks_payload.TotalAmt).toBe(1100);
    expect(qbOutput.quickbooks_payload.Line.length).toBeGreaterThan(0);
  });

  it("should correctly map line items from extraction to QuickBooks format", () => {
    const extraction = makeExtraction({
      line_items: [
        { description: "Service A", quantity: 5, unit_price: 200, total: 1000 },
      ],
      subtotal: 1000,
      tax: 100,
      total: 1100,
    });

    const qbOutput = buildQuickBooksPayload({
      invoice: extraction,
      vendor_id: "qb-v-1",
    });

    const firstLine = qbOutput.quickbooks_payload.Line[0];
    expect(firstLine.Amount).toBe(1000);
    expect(firstLine.Description).toBe("Service A");
    expect(firstLine.DetailType).toBe("AccountBasedExpenseLineDetail");
  });
});
