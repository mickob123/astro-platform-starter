import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyInvoice,
  ClassifierInputSchema,
  ClassifierOutputSchema,
  type ClassifierInput,
  type ClassifierOutput,
} from "../modules/classifier";

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
                    is_invoice: true,
                    vendor_name: "Acme Corp",
                    confidence: 0.95,
                    signals: [
                      "invoice number present",
                      "total amount found",
                      "due date mentioned",
                    ],
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

describe("Invoice Classifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Input Schema Validation", () => {
    it("should validate correct input", () => {
      const input: ClassifierInput = {
        email_subject: "Invoice #12345 from Acme Corp",
        email_body: "Please find attached invoice for services rendered.",
        attachment_text: "Invoice #12345\nTotal: $1,000.00\nDue: 2024-01-15",
      };

      const result = ClassifierInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should accept null attachment_text", () => {
      const input: ClassifierInput = {
        email_subject: "Invoice",
        email_body: "Body text",
        attachment_text: null,
      };

      const result = ClassifierInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should reject missing required fields", () => {
      const input = {
        email_subject: "Invoice",
      };

      const result = ClassifierInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe("Output Schema Validation", () => {
    it("should validate correct output", () => {
      const output: ClassifierOutput = {
        is_invoice: true,
        vendor_name: "Acme Corp",
        confidence: 0.85,
        signals: ["invoice number present", "total amount found"],
      };

      const result = ClassifierOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it("should reject confidence outside 0-1 range", () => {
      const output = {
        is_invoice: true,
        vendor_name: "Acme Corp",
        confidence: 1.5,
        signals: [],
      };

      const result = ClassifierOutputSchema.safeParse(output);
      expect(result.success).toBe(false);
    });

    it("should accept null vendor_name", () => {
      const output: ClassifierOutput = {
        is_invoice: false,
        vendor_name: null,
        confidence: 0.1,
        signals: [],
      };

      const result = ClassifierOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe("classifyInvoice function", () => {
    it("should return classified invoice data", async () => {
      const input: ClassifierInput = {
        email_subject: "Invoice #12345",
        email_body: "Please pay the attached invoice.",
        attachment_text: "Invoice details...",
      };

      const result = await classifyInvoice(input);

      expect(result.is_invoice).toBe(true);
      expect(result.vendor_name).toBe("Acme Corp");
      expect(result.confidence).toBe(0.95);
      expect(result.signals).toHaveLength(3);
    });

    it("should throw on invalid input", async () => {
      const invalidInput = {
        email_subject: 123,
      };

      await expect(
        classifyInvoice(invalidInput as unknown as ClassifierInput)
      ).rejects.toThrow();
    });
  });
});
