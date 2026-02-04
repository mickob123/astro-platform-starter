import { describe, it, expect } from "vitest";
import {
  validateInvoice,
  ValidatorInputSchema,
  type ValidatorInput,
  type Invoice,
} from "../modules/validator";

describe("Invoice Validator", () => {
  const validInvoice: Invoice = {
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

  describe("Input Schema Validation", () => {
    it("should validate correct input", () => {
      const input: ValidatorInput = {
        invoice: validInvoice,
        existing_invoice_numbers: [],
      };

      const result = ValidatorInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  describe("validateInvoice function", () => {
    it("should return valid for correct invoice", () => {
      const input: ValidatorInput = {
        invoice: validInvoice,
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);

      expect(result.is_valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should fail when vendor_name is empty", () => {
      const input: ValidatorInput = {
        invoice: { ...validInvoice, vendor_name: "" },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);

      expect(result.is_valid).toBe(false);
      expect(result.errors).toContain("vendor_name is required");
    });

    it("should fail when currency is missing", () => {
      const input: ValidatorInput = {
        invoice: { ...validInvoice, currency: "" },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);

      expect(result.is_valid).toBe(false);
      expect(result.errors).toContain("currency is required");
    });

    it("should fail when total is zero or negative", () => {
      const input: ValidatorInput = {
        invoice: { ...validInvoice, total: 0 },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);

      expect(result.is_valid).toBe(false);
      expect(result.errors).toContain("total must be greater than 0");
    });

    it("should fail when invoice number is duplicate", () => {
      const input: ValidatorInput = {
        invoice: validInvoice,
        existing_invoice_numbers: ["INV-001", "INV-002"],
      };

      const result = validateInvoice(input);

      expect(result.is_valid).toBe(false);
      expect(result.errors).toContain(
        'invoice_number "INV-001" already exists (duplicate)'
      );
    });

    it("should fail when math does not add up", () => {
      const input: ValidatorInput = {
        invoice: {
          ...validInvoice,
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

    it("should allow small rounding differences within tolerance", () => {
      const input: ValidatorInput = {
        invoice: {
          ...validInvoice,
          subtotal: 500,
          tax: 50.005,
          total: 550,
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);

      expect(result.is_valid).toBe(true);
    });

    it("should warn when due_date is missing", () => {
      const input: ValidatorInput = {
        invoice: { ...validInvoice, due_date: null },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);

      expect(result.is_valid).toBe(true);
      expect(result.warnings).toContain("due_date is not specified");
    });

    it("should warn when invoice_number is empty", () => {
      const input: ValidatorInput = {
        invoice: { ...validInvoice, invoice_number: "" },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);

      expect(result.warnings).toContain("invoice_number is empty");
    });

    it("should warn when no line items present", () => {
      const input: ValidatorInput = {
        invoice: {
          ...validInvoice,
          line_items: [],
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);

      expect(result.warnings).toContain("No line items present");
    });

    it("should warn when line items total does not match subtotal", () => {
      const input: ValidatorInput = {
        invoice: {
          ...validInvoice,
          line_items: [
            {
              description: "Service",
              quantity: 1,
              unit_price: 400,
              total: 400,
            },
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

    it("should handle null tax correctly", () => {
      const input: ValidatorInput = {
        invoice: {
          ...validInvoice,
          subtotal: 500,
          tax: null,
          total: 500,
        },
        existing_invoice_numbers: [],
      };

      const result = validateInvoice(input);

      expect(result.is_valid).toBe(true);
    });

    it("should return multiple errors when multiple validations fail", () => {
      const input: ValidatorInput = {
        invoice: {
          vendor_name: "",
          invoice_number: "INV-001",
          invoice_date: "2024-01-15",
          due_date: null,
          currency: "",
          line_items: [],
          subtotal: 500,
          tax: 50,
          total: 0,
        },
        existing_invoice_numbers: ["INV-001"],
      };

      const result = validateInvoice(input);

      expect(result.is_valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });
});
