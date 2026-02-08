import { describe, it, expect } from "vitest";
import {
  validateInvoice,
  ValidatorInputSchema,
  type ValidatorInput,
  type Invoice,
} from "../modules/validator";

describe("Invoice Validator - Edge Cases", () => {
  const baseInvoice: Invoice = {
    vendor_name: "Acme Corp",
    invoice_number: "INV-001",
    invoice_date: "2024-01-15",
    due_date: "2024-02-15",
    currency: "USD",
    line_items: [
      {
        description: "Service",
        quantity: 1,
        unit_price: 500,
        total: 500,
      },
    ],
    subtotal: 500,
    tax: 50,
    total: 550,
  };

  describe("Invoice with exactly 0 total", () => {
    it("should fail validation when total is exactly 0", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          subtotal: 0,
          tax: 0,
          total: 0,
          line_items: [],
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);
      expect(result.errors).toContain("total must be greater than 0");
    });
  });

  describe("Invoice with negative total", () => {
    it("should fail validation when total is negative", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          subtotal: -100,
          tax: 0,
          total: -100,
          line_items: [],
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);
      expect(result.errors).toContain("total must be greater than 0");
    });

    it("should fail validation when total is -0.01", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          subtotal: -0.01,
          tax: 0,
          total: -0.01,
          line_items: [],
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);
      expect(result.errors).toContain("total must be greater than 0");
    });
  });

  describe("Duplicate invoice number detection", () => {
    it("should detect duplicate when invoice_number matches an existing one", () => {
      const input: ValidatorInput = {
        invoice: baseInvoice,
        existing_invoice_numbers: ["INV-001"],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);
      expect(result.errors).toContain(
        'invoice_number "INV-001" already exists (duplicate)'
      );
    });

    it("should not flag as duplicate when invoice_number is not in the list", () => {
      const input: ValidatorInput = {
        invoice: baseInvoice,
        existing_invoice_numbers: ["INV-002", "INV-003"],
      };

      const result = validateInvoice(input);
      expect(result.errors).not.toContain(
        'invoice_number "INV-001" already exists (duplicate)'
      );
    });

    it("should handle case-sensitive duplicate detection", () => {
      const input: ValidatorInput = {
        invoice: { ...baseInvoice, invoice_number: "inv-001" },
        existing_invoice_numbers: ["INV-001"],
      };

      const result = validateInvoice(input);
      // The check uses exact string matching so different case is NOT a duplicate
      expect(
        result.errors.some((e) => e.includes("already exists (duplicate)"))
      ).toBe(false);
    });

    it("should detect duplicate among multiple existing numbers", () => {
      const input: ValidatorInput = {
        invoice: { ...baseInvoice, invoice_number: "INV-005" },
        existing_invoice_numbers: [
          "INV-001",
          "INV-002",
          "INV-003",
          "INV-004",
          "INV-005",
        ],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);
      expect(result.errors).toContain(
        'invoice_number "INV-005" already exists (duplicate)'
      );
    });

    it("should pass when existing list is empty", () => {
      const input: ValidatorInput = {
        invoice: baseInvoice,
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(
        result.errors.some((e) => e.includes("already exists (duplicate)"))
      ).toBe(false);
    });
  });

  describe("Currency code validation", () => {
    it("should pass with valid 3-character currency code", () => {
      const input: ValidatorInput = {
        invoice: { ...baseInvoice, currency: "EUR" },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(
        result.errors.some((e) => e.includes("currency"))
      ).toBe(false);
    });

    it("should fail with currency longer than 3 characters", () => {
      const input: ValidatorInput = {
        invoice: { ...baseInvoice, currency: "EURO" },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);
      expect(result.errors).toContain(
        "currency must be a valid ISO 4217 code (3 characters)"
      );
    });

    it("should fail with currency shorter than 3 characters", () => {
      const input: ValidatorInput = {
        invoice: { ...baseInvoice, currency: "US" },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);
      expect(result.errors).toContain(
        "currency must be a valid ISO 4217 code (3 characters)"
      );
    });

    it("should fail with empty currency string", () => {
      const input: ValidatorInput = {
        invoice: { ...baseInvoice, currency: "" },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);
      expect(result.errors).toContain("currency is required");
    });

    it("should fail with single character currency", () => {
      const input: ValidatorInput = {
        invoice: { ...baseInvoice, currency: "U" },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);
      expect(result.errors).toContain(
        "currency must be a valid ISO 4217 code (3 characters)"
      );
    });
  });

  describe("Math tolerance edge cases", () => {
    it("should pass when difference is exactly 0.01 (at tolerance boundary)", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          subtotal: 500,
          tax: 50,
          total: 550.01, // difference = 0.01, which equals MATH_TOLERANCE
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      // 0.01 is not > 0.01, so it should pass
      expect(
        result.errors.some((e) => e.includes("Math validation failed"))
      ).toBe(false);
    });

    it("should fail when difference is 0.02 (exceeds tolerance)", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          subtotal: 500,
          tax: 50,
          total: 550.02, // difference = 0.02, which is > 0.01
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes("Math validation failed"))
      ).toBe(true);
    });

    it("should pass when difference is exactly 0 (perfect match)", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          subtotal: 500,
          tax: 50,
          total: 550,
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(
        result.errors.some((e) => e.includes("Math validation failed"))
      ).toBe(false);
    });

    it("should pass when difference is 0.005 (within tolerance)", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          subtotal: 500,
          tax: 50.005,
          total: 550,
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(
        result.errors.some((e) => e.includes("Math validation failed"))
      ).toBe(false);
    });

    it("should fail when total is far from expected", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          subtotal: 500,
          tax: 50,
          total: 600,
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes("Math validation failed"))
      ).toBe(true);
    });

    it("should handle negative difference (total less than expected)", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          subtotal: 500,
          tax: 50,
          total: 549.98, // expected 550, difference = 0.02
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes("Math validation failed"))
      ).toBe(true);
    });
  });

  describe("Empty line items array", () => {
    it("should warn when line_items is empty", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          line_items: [],
          subtotal: 500,
          tax: 50,
          total: 550,
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.warnings).toContain("No line items present");
    });

    it("should not warn about line items total mismatch when line_items is empty", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          line_items: [],
          subtotal: 500,
          tax: 50,
          total: 550,
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(
        result.warnings.some((w) => w.includes("Line items total"))
      ).toBe(false);
    });
  });

  describe("Line items total mismatch", () => {
    it("should warn when line items total differs from subtotal by more than tolerance", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          line_items: [
            { description: "Service A", quantity: 1, unit_price: 300, total: 300 },
            { description: "Service B", quantity: 1, unit_price: 100, total: 100 },
          ],
          subtotal: 500,
          tax: 50,
          total: 550,
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(
        result.warnings.some((w) =>
          w.includes("Line items total (400.00) does not match subtotal")
        )
      ).toBe(true);
    });

    it("should not warn when line items total matches subtotal exactly", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          line_items: [
            { description: "Service A", quantity: 1, unit_price: 250, total: 250 },
            { description: "Service B", quantity: 1, unit_price: 250, total: 250 },
          ],
          subtotal: 500,
          tax: 50,
          total: 550,
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(
        result.warnings.some((w) => w.includes("Line items total"))
      ).toBe(false);
    });

    it("should not warn when line items total is within tolerance of subtotal", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          line_items: [
            { description: "Service", quantity: 1, unit_price: 500, total: 499.995 },
          ],
          subtotal: 500,
          tax: 50,
          total: 550,
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(
        result.warnings.some((w) => w.includes("Line items total"))
      ).toBe(false);
    });

    it("should warn with multiple line items where sum exceeds subtotal", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          line_items: [
            { description: "A", quantity: 1, unit_price: 200, total: 200 },
            { description: "B", quantity: 1, unit_price: 200, total: 200 },
            { description: "C", quantity: 1, unit_price: 200, total: 200 },
          ],
          subtotal: 500, // line items total = 600, subtotal = 500
          tax: 50,
          total: 550,
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(
        result.warnings.some((w) =>
          w.includes("Line items total (600.00) does not match subtotal")
        )
      ).toBe(true);
    });
  });

  describe("Missing optional fields", () => {
    it("should warn when due_date is null", () => {
      const input: ValidatorInput = {
        invoice: { ...baseInvoice, due_date: null },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(true);
      expect(result.warnings).toContain("due_date is not specified");
    });

    it("should warn when invoice_number is empty string", () => {
      const input: ValidatorInput = {
        invoice: { ...baseInvoice, invoice_number: "" },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.warnings).toContain("invoice_number is empty");
    });

    it("should warn when invoice_number is whitespace only", () => {
      const input: ValidatorInput = {
        invoice: { ...baseInvoice, invoice_number: "   " },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      // The check is: !invoice.invoice_number || invoice.invoice_number.trim() === ""
      expect(result.warnings).toContain("invoice_number is empty");
    });

    it("should handle null tax correctly in math validation", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          subtotal: 500,
          tax: null,
          total: 500,
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(true);
      expect(
        result.errors.some((e) => e.includes("Math validation failed"))
      ).toBe(false);
    });

    it("should fail math validation when null tax but total includes tax", () => {
      const input: ValidatorInput = {
        invoice: {
          ...baseInvoice,
          subtotal: 500,
          tax: null,
          total: 550, // With null tax, expected total = 500 + 0 = 500
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes("Math validation failed"))
      ).toBe(true);
    });
  });

  describe("Schema validation edge cases", () => {
    it("should reject input with missing invoice", () => {
      const result = ValidatorInputSchema.safeParse({
        existing_invoice_numbers: [],
      });
      expect(result.success).toBe(false);
    });

    it("should reject input with missing existing_invoice_numbers", () => {
      const result = ValidatorInputSchema.safeParse({
        invoice: baseInvoice,
      });
      expect(result.success).toBe(false);
    });

    it("should accept empty existing_invoice_numbers", () => {
      const result = ValidatorInputSchema.safeParse({
        invoice: baseInvoice,
        existing_invoice_numbers: [],
      });
      expect(result.success).toBe(true);
    });

    it("should reject when line_items contain invalid item (missing total)", () => {
      const result = ValidatorInputSchema.safeParse({
        invoice: {
          ...baseInvoice,
          line_items: [{ description: "Service", quantity: 1 }],
        },
        existing_invoice_numbers: [],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("Combined error scenarios", () => {
    it("should collect all errors when multiple validations fail simultaneously", () => {
      const input: ValidatorInput = {
        invoice: {
          vendor_name: "",
          invoice_number: "INV-001",
          invoice_date: "2024-01-15",
          due_date: null,
          currency: "TOOLONG",
          line_items: [],
          subtotal: 500,
          tax: 50,
          total: -1,
        },
        existing_invoice_numbers: ["INV-001"],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);

      // Should have errors for: vendor_name, currency, total, duplicate, math
      expect(result.errors).toContain("vendor_name is required");
      expect(result.errors).toContain(
        "currency must be a valid ISO 4217 code (3 characters)"
      );
      expect(result.errors).toContain("total must be greater than 0");
      expect(result.errors).toContain(
        'invoice_number "INV-001" already exists (duplicate)'
      );
    });

    it("should collect warnings alongside errors", () => {
      const input: ValidatorInput = {
        invoice: {
          vendor_name: "",
          invoice_number: "",
          invoice_date: "2024-01-15",
          due_date: null,
          currency: "USD",
          line_items: [],
          subtotal: 0,
          tax: null,
          total: 0,
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);
      expect(result.is_valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings).toContain("invoice_number is empty");
      expect(result.warnings).toContain("due_date is not specified");
      expect(result.warnings).toContain("No line items present");
    });
  });
});
