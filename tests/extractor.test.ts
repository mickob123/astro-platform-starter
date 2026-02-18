import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractInvoiceData,
  ExtractorInputSchema,
  ExtractorOutputSchema,
  type ExtractorInput,
  type ExtractorOutput,
} from "../modules/extractor";

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    vendor_name: "Acme Corp",
                    invoice_number: "INV-2024-001",
                    invoice_date: "2024-01-01",
                    due_date: "2024-01-31",
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
                    vendor_email: null,
                    vendor_phone: null,
                    vendor_address_line1: null,
                    vendor_address_line2: null,
                    vendor_city: null,
                    vendor_state: null,
                    vendor_postal_code: null,
                    vendor_country: null,
                    vendor_website: null,
                    vendor_tax_id: null,
                  }),
                },
              },
            ],
          }),
        },
      },
    })),
  };
});

describe("Invoice Extractor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Input Schema Validation", () => {
    it("should validate correct input", () => {
      const input: ExtractorInput = {
        document_text: "Invoice content here...",
      };

      const result = ExtractorInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should reject missing document_text", () => {
      const input = {};

      const result = ExtractorInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe("Output Schema Validation", () => {
    it("should validate correct output", () => {
      const output: ExtractorOutput = {
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

      const result = ExtractorOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it("should accept null for optional fields", () => {
      const output: ExtractorOutput = {
        vendor_name: "Acme Corp",
        invoice_number: "INV-001",
        invoice_date: "2024-01-15",
        due_date: null,
        currency: "USD",
        line_items: [
          {
            description: "Service",
            quantity: null,
            unit_price: null,
            total: 500,
          },
        ],
        subtotal: 500,
        tax: null,
        total: 500,
      };

      const result = ExtractorOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it("should accept vendor contact fields as null", () => {
      const output = {
        vendor_name: "Acme Corp",
        invoice_number: "INV-001",
        invoice_date: "2024-01-15",
        due_date: null,
        currency: "USD",
        line_items: [{ description: "Service", quantity: 1, unit_price: 500, total: 500 }],
        subtotal: 500,
        tax: null,
        total: 500,
        vendor_email: null,
        vendor_phone: null,
        vendor_address_line1: null,
        vendor_address_line2: null,
        vendor_city: null,
        vendor_state: null,
        vendor_postal_code: null,
        vendor_country: null,
        vendor_website: null,
        vendor_tax_id: null,
      };

      const result = ExtractorOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it("should accept vendor contact fields with values", () => {
      const output = {
        vendor_name: "AusGrid Energy",
        invoice_number: "INV-002",
        invoice_date: "2024-03-01",
        due_date: "2024-03-31",
        currency: "AUD",
        line_items: [{ description: "Electricity", quantity: null, unit_price: null, total: 250 }],
        subtotal: 250,
        tax: 25,
        total: 275,
        vendor_email: "billing@ausgrid.com.au",
        vendor_phone: "13 13 46",
        vendor_address_line1: "Level 22, 1 Market St",
        vendor_address_line2: null,
        vendor_city: "Sydney",
        vendor_state: "NSW",
        vendor_postal_code: "2000",
        vendor_country: "Australia",
        vendor_website: "https://www.ausgrid.com.au",
        vendor_tax_id: "ABN: 67 095 226 465",
      };

      const result = ExtractorOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it("should accept when vendor contact fields are omitted", () => {
      const output = {
        vendor_name: "Acme Corp",
        invoice_number: "INV-001",
        invoice_date: "2024-01-15",
        due_date: null,
        currency: "USD",
        line_items: [{ description: "Service", quantity: 1, unit_price: 500, total: 500 }],
        subtotal: 500,
        tax: null,
        total: 500,
        // vendor contact fields intentionally omitted
      };

      const result = ExtractorOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it("should reject invalid date format", () => {
      const output = {
        vendor_name: "Acme Corp",
        invoice_number: "INV-001",
        invoice_date: "01/15/2024",
        due_date: null,
        currency: "USD",
        line_items: [],
        subtotal: 500,
        tax: null,
        total: 500,
      };

      const result = ExtractorOutputSchema.safeParse(output);
      expect(result.success).toBe(false);
    });

    it("should reject invalid currency code", () => {
      const output = {
        vendor_name: "Acme Corp",
        invoice_number: "INV-001",
        invoice_date: "2024-01-15",
        due_date: null,
        currency: "DOLLAR",
        line_items: [],
        subtotal: 500,
        tax: null,
        total: 500,
      };

      const result = ExtractorOutputSchema.safeParse(output);
      expect(result.success).toBe(false);
    });
  });

  describe("extractInvoiceData function", () => {
    it("should return extracted invoice data", async () => {
      const input: ExtractorInput = {
        document_text: `
          INVOICE
          Acme Corp
          Invoice #: INV-2024-001
          Date: January 1, 2024
          Due: January 31, 2024

          Consulting Services - 10 hours @ $100/hr = $1,000

          Subtotal: $1,000
          Tax: $100
          Total: $1,100
        `,
      };

      const result = await extractInvoiceData(input);

      expect(result.vendor_name).toBe("Acme Corp");
      expect(result.invoice_number).toBe("INV-2024-001");
      expect(result.total).toBe(1100);
      expect(result.line_items).toHaveLength(1);
    });

    it("should throw on invalid input", async () => {
      const invalidInput = {};

      await expect(
        extractInvoiceData(invalidInput as unknown as ExtractorInput)
      ).rejects.toThrow();
    });
  });
});
