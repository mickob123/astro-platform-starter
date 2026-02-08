import { describe, it, expect } from "vitest";
import {
  buildQuickBooksPayload,
  QuickBooksInputSchema,
  type QuickBooksInput,
} from "../modules/quickbooks";

describe("QuickBooks Module", () => {
  const validInvoice = {
    vendor_name: "Acme Corp",
    invoice_number: "INV-001",
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
  };

  const validInput: QuickBooksInput = {
    invoice: validInvoice,
    vendor_id: "vendor-123",
  };

  describe("QuickBooksInputSchema Validation", () => {
    it("should validate correct input", () => {
      const result = QuickBooksInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it("should reject missing vendor_id", () => {
      const result = QuickBooksInputSchema.safeParse({
        invoice: validInvoice,
      });
      expect(result.success).toBe(false);
    });

    it("should reject missing invoice", () => {
      const result = QuickBooksInputSchema.safeParse({
        vendor_id: "vendor-123",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invoice missing required fields", () => {
      const result = QuickBooksInputSchema.safeParse({
        invoice: { vendor_name: "Test" },
        vendor_id: "vendor-123",
      });
      expect(result.success).toBe(false);
    });

    it("should accept invoice with null tax", () => {
      const result = QuickBooksInputSchema.safeParse({
        invoice: { ...validInvoice, tax: null, total: 1000 },
        vendor_id: "vendor-123",
      });
      expect(result.success).toBe(true);
    });

    it("should accept invoice with null due_date", () => {
      const result = QuickBooksInputSchema.safeParse({
        invoice: { ...validInvoice, due_date: null },
        vendor_id: "vendor-123",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("Payload structure (VendorRef, Line items, DocNumber)", () => {
    it("should set VendorRef value to vendor_id", () => {
      const result = buildQuickBooksPayload(validInput);
      expect(result.quickbooks_payload.VendorRef.value).toBe("vendor-123");
    });

    it("should set DocNumber to invoice_number", () => {
      const result = buildQuickBooksPayload(validInput);
      expect(result.quickbooks_payload.DocNumber).toBe("INV-001");
    });

    it("should set TxnDate to invoice_date", () => {
      const result = buildQuickBooksPayload(validInput);
      expect(result.quickbooks_payload.TxnDate).toBe("2024-01-15");
    });

    it("should set DueDate when due_date is provided", () => {
      const result = buildQuickBooksPayload(validInput);
      expect(result.quickbooks_payload.DueDate).toBe("2024-02-15");
    });

    it("should omit DueDate when due_date is null", () => {
      const result = buildQuickBooksPayload({
        invoice: { ...validInvoice, due_date: null },
        vendor_id: "vendor-123",
      });
      expect(result.quickbooks_payload.DueDate).toBeUndefined();
    });

    it("should set TotalAmt to invoice total", () => {
      const result = buildQuickBooksPayload(validInput);
      expect(result.quickbooks_payload.TotalAmt).toBe(1100);
    });

    it("should set CurrencyRef value to invoice currency", () => {
      const result = buildQuickBooksPayload(validInput);
      expect(result.quickbooks_payload.CurrencyRef.value).toBe("USD");
    });

    it("should include PrivateNote with invoice number", () => {
      const result = buildQuickBooksPayload(validInput);
      expect(result.quickbooks_payload.PrivateNote).toBe(
        "Imported from invoice: INV-001"
      );
    });
  });

  describe("Line item mapping", () => {
    it("should map each invoice line item to a QuickBooks line item", () => {
      const input: QuickBooksInput = {
        invoice: {
          ...validInvoice,
          line_items: [
            {
              description: "Service A",
              quantity: 5,
              unit_price: 100,
              total: 500,
            },
            {
              description: "Service B",
              quantity: 3,
              unit_price: 200,
              total: 600,
            },
          ],
          subtotal: 1100,
          tax: 100,
          total: 1200,
        },
        vendor_id: "vendor-123",
      };

      const result = buildQuickBooksPayload(input);
      // 2 line items + 1 tax line
      expect(result.quickbooks_payload.Line).toHaveLength(3);
    });

    it("should set correct Id, Amount, Description on each line item", () => {
      const result = buildQuickBooksPayload(validInput);
      const firstLine = result.quickbooks_payload.Line[0];

      expect(firstLine.Id).toBe("1");
      expect(firstLine.Amount).toBe(1000);
      expect(firstLine.Description).toBe("Consulting Services");
    });

    it("should set DetailType to AccountBasedExpenseLineDetail", () => {
      const result = buildQuickBooksPayload(validInput);
      const firstLine = result.quickbooks_payload.Line[0];
      expect(firstLine.DetailType).toBe("AccountBasedExpenseLineDetail");
    });

    it("should set BillableStatus to NotBillable", () => {
      const result = buildQuickBooksPayload(validInput);
      const firstLine = result.quickbooks_payload.Line[0];
      expect(
        firstLine.AccountBasedExpenseLineDetail.BillableStatus
      ).toBe("NotBillable");
    });

    it("should set TaxCodeRef to NON for regular line items", () => {
      const result = buildQuickBooksPayload(validInput);
      const firstLine = result.quickbooks_payload.Line[0];
      expect(
        firstLine.AccountBasedExpenseLineDetail.TaxCodeRef.value
      ).toBe("NON");
    });

    it("should assign sequential IDs to line items", () => {
      const input: QuickBooksInput = {
        invoice: {
          ...validInvoice,
          line_items: [
            { description: "A", quantity: 1, unit_price: 100, total: 100 },
            { description: "B", quantity: 1, unit_price: 200, total: 200 },
            { description: "C", quantity: 1, unit_price: 300, total: 300 },
          ],
          subtotal: 600,
          tax: 60,
          total: 660,
        },
        vendor_id: "vendor-123",
      };

      const result = buildQuickBooksPayload(input);
      const lines = result.quickbooks_payload.Line;
      expect(lines[0].Id).toBe("1");
      expect(lines[1].Id).toBe("2");
      expect(lines[2].Id).toBe("3");
      // Tax line
      expect(lines[3].Id).toBe("4");
    });
  });

  describe("Tax handling", () => {
    it("should add a tax line item when tax is positive", () => {
      const result = buildQuickBooksPayload(validInput);
      const lines = result.quickbooks_payload.Line;
      // 1 regular + 1 tax
      expect(lines).toHaveLength(2);

      const taxLine = lines[1];
      expect(taxLine.Amount).toBe(100);
      expect(taxLine.Description).toBe("Tax");
      expect(
        taxLine.AccountBasedExpenseLineDetail.TaxCodeRef.value
      ).toBe("TAX");
    });

    it("should not add a tax line item when tax is null", () => {
      const result = buildQuickBooksPayload({
        invoice: { ...validInvoice, tax: null, total: 1000 },
        vendor_id: "vendor-123",
      });
      const lines = result.quickbooks_payload.Line;
      // Only 1 regular line, no tax line
      expect(lines).toHaveLength(1);
    });

    it("should not add a tax line item when tax is zero", () => {
      const result = buildQuickBooksPayload({
        invoice: { ...validInvoice, tax: 0, total: 1000 },
        vendor_id: "vendor-123",
      });
      const lines = result.quickbooks_payload.Line;
      // Only 1 regular line, no tax line (0 is not > 0)
      expect(lines).toHaveLength(1);
    });

    it("should add tax line with correct amount for small tax", () => {
      const result = buildQuickBooksPayload({
        invoice: { ...validInvoice, tax: 0.5, total: 1000.5 },
        vendor_id: "vendor-123",
      });
      const lines = result.quickbooks_payload.Line;
      expect(lines).toHaveLength(2);
      expect(lines[1].Amount).toBe(0.5);
    });
  });

  describe("Currency ref", () => {
    it("should pass through USD currency", () => {
      const result = buildQuickBooksPayload(validInput);
      expect(result.quickbooks_payload.CurrencyRef.value).toBe("USD");
    });

    it("should pass through EUR currency", () => {
      const result = buildQuickBooksPayload({
        invoice: { ...validInvoice, currency: "EUR" },
        vendor_id: "vendor-123",
      });
      expect(result.quickbooks_payload.CurrencyRef.value).toBe("EUR");
    });

    it("should pass through GBP currency", () => {
      const result = buildQuickBooksPayload({
        invoice: { ...validInvoice, currency: "GBP" },
        vendor_id: "vendor-123",
      });
      expect(result.quickbooks_payload.CurrencyRef.value).toBe("GBP");
    });
  });

  describe("Input validation via buildQuickBooksPayload", () => {
    it("should throw on invalid input (missing fields)", () => {
      expect(() =>
        buildQuickBooksPayload({} as unknown as QuickBooksInput)
      ).toThrow();
    });
  });
});
