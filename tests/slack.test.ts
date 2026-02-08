import { describe, it, expect } from "vitest";
import {
  buildSlackNotification,
  SlackInputSchema,
  type SlackInput,
} from "../modules/slack";

describe("Slack Module", () => {
  const validInput: SlackInput = {
    vendor: "Acme Corp",
    amount: 1500.5,
    currency: "USD",
    due_date: "2024-02-15",
    invoice_number: "INV-001",
    confidence: 0.95,
    invoice_url: "https://example.com/invoice/001",
  };

  describe("SlackInputSchema Validation", () => {
    it("should validate correct input", () => {
      const result = SlackInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it("should reject missing vendor", () => {
      const { vendor, ...rest } = validInput;
      const result = SlackInputSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("should reject missing amount", () => {
      const { amount, ...rest } = validInput;
      const result = SlackInputSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("should reject missing currency", () => {
      const { currency, ...rest } = validInput;
      const result = SlackInputSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("should reject missing invoice_url", () => {
      const { invoice_url, ...rest } = validInput;
      const result = SlackInputSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("should reject confidence below 0", () => {
      const result = SlackInputSchema.safeParse({
        ...validInput,
        confidence: -0.1,
      });
      expect(result.success).toBe(false);
    });

    it("should reject confidence above 1", () => {
      const result = SlackInputSchema.safeParse({
        ...validInput,
        confidence: 1.1,
      });
      expect(result.success).toBe(false);
    });

    it("should accept confidence at boundary 0", () => {
      const result = SlackInputSchema.safeParse({
        ...validInput,
        confidence: 0,
      });
      expect(result.success).toBe(true);
    });

    it("should accept confidence at boundary 1", () => {
      const result = SlackInputSchema.safeParse({
        ...validInput,
        confidence: 1,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("buildSlackNotification output structure", () => {
    it("should return an object with blocks array", () => {
      const result = buildSlackNotification(validInput);
      expect(result).toHaveProperty("blocks");
      expect(Array.isArray(result.blocks)).toBe(true);
    });

    it("should contain a header block as first element", () => {
      const result = buildSlackNotification(validInput);
      expect(result.blocks[0].type).toBe("header");
      expect(result.blocks[0].text.text).toContain("New Invoice Received");
    });

    it("should contain a section with vendor, invoice number, amount, and due date fields", () => {
      const result = buildSlackNotification(validInput);
      const fieldsSection = result.blocks[1];
      expect(fieldsSection.type).toBe("section");
      expect(fieldsSection.fields).toHaveLength(4);

      const fieldTexts = fieldsSection.fields.map(
        (f: { text: string }) => f.text
      );
      expect(fieldTexts.some((t: string) => t.includes("Acme Corp"))).toBe(
        true
      );
      expect(fieldTexts.some((t: string) => t.includes("INV-001"))).toBe(true);
      expect(fieldTexts.some((t: string) => t.includes("$1,500.50"))).toBe(
        true
      );
      expect(fieldTexts.some((t: string) => t.includes("2024-02-15"))).toBe(
        true
      );
    });

    it("should contain a confidence section with a View Invoice button", () => {
      const result = buildSlackNotification(validInput);
      const confidenceSection = result.blocks[2];
      expect(confidenceSection.type).toBe("section");
      expect(confidenceSection.accessory.type).toBe("button");
      expect(confidenceSection.accessory.url).toBe(
        "https://example.com/invoice/001"
      );
      expect(confidenceSection.accessory.action_id).toBe("view_invoice");
    });

    it("should contain a divider block", () => {
      const result = buildSlackNotification(validInput);
      expect(result.blocks[3].type).toBe("divider");
    });

    it("should contain actions with Approve and Flag buttons", () => {
      const result = buildSlackNotification(validInput);
      const actionsBlock = result.blocks[4];
      expect(actionsBlock.type).toBe("actions");
      expect(actionsBlock.elements).toHaveLength(2);
      expect(actionsBlock.elements[0].action_id).toBe("approve_invoice");
      expect(actionsBlock.elements[0].style).toBe("primary");
      expect(actionsBlock.elements[1].action_id).toBe("flag_invoice");
      expect(actionsBlock.elements[1].style).toBe("danger");
    });

    it("should pass the invoice_number as button values", () => {
      const result = buildSlackNotification(validInput);
      const actionsBlock = result.blocks[4];
      expect(actionsBlock.elements[0].value).toBe("INV-001");
      expect(actionsBlock.elements[1].value).toBe("INV-001");
    });
  });

  describe("Confidence level emoji mapping", () => {
    it("should show check mark emoji for confidence >= 0.9", () => {
      const result = buildSlackNotification({ ...validInput, confidence: 0.95 });
      const confidenceText = result.blocks[2].text.text;
      expect(confidenceText).toContain(":white_check_mark:");
      expect(confidenceText).toContain("High");
      expect(confidenceText).toContain("95%");
    });

    it("should show check mark emoji for confidence exactly 0.9", () => {
      const result = buildSlackNotification({ ...validInput, confidence: 0.9 });
      const confidenceText = result.blocks[2].text.text;
      expect(confidenceText).toContain(":white_check_mark:");
      expect(confidenceText).toContain("High");
    });

    it("should show yellow circle emoji for confidence >= 0.7 and < 0.9", () => {
      const result = buildSlackNotification({ ...validInput, confidence: 0.75 });
      const confidenceText = result.blocks[2].text.text;
      expect(confidenceText).toContain(":large_yellow_circle:");
      expect(confidenceText).toContain("Medium");
      expect(confidenceText).toContain("75%");
    });

    it("should show yellow circle emoji for confidence exactly 0.7", () => {
      const result = buildSlackNotification({ ...validInput, confidence: 0.7 });
      const confidenceText = result.blocks[2].text.text;
      expect(confidenceText).toContain(":large_yellow_circle:");
      expect(confidenceText).toContain("Medium");
    });

    it("should show warning emoji for confidence < 0.7", () => {
      const result = buildSlackNotification({ ...validInput, confidence: 0.5 });
      const confidenceText = result.blocks[2].text.text;
      expect(confidenceText).toContain(":warning:");
      expect(confidenceText).toContain("Low");
      expect(confidenceText).toContain("50%");
    });

    it("should show warning emoji for very low confidence", () => {
      const result = buildSlackNotification({ ...validInput, confidence: 0.1 });
      const confidenceText = result.blocks[2].text.text;
      expect(confidenceText).toContain(":warning:");
      expect(confidenceText).toContain("Low");
      expect(confidenceText).toContain("10%");
    });
  });

  describe("Currency formatting", () => {
    it("should format USD amounts correctly", () => {
      const result = buildSlackNotification(validInput);
      const fieldTexts = result.blocks[1].fields.map(
        (f: { text: string }) => f.text
      );
      const amountField = fieldTexts.find((t: string) =>
        t.includes("Amount")
      );
      expect(amountField).toContain("$1,500.50");
    });

    it("should format EUR amounts correctly", () => {
      const result = buildSlackNotification({
        ...validInput,
        currency: "EUR",
        amount: 2000,
      });
      const fieldTexts = result.blocks[1].fields.map(
        (f: { text: string }) => f.text
      );
      const amountField = fieldTexts.find((t: string) =>
        t.includes("Amount")
      );
      // Intl.NumberFormat with en-US locale formats EUR with the EUR symbol
      expect(amountField).toContain("2,000.00");
    });

    it("should format zero amount", () => {
      const result = buildSlackNotification({ ...validInput, amount: 0 });
      const fieldTexts = result.blocks[1].fields.map(
        (f: { text: string }) => f.text
      );
      const amountField = fieldTexts.find((t: string) =>
        t.includes("Amount")
      );
      expect(amountField).toContain("$0.00");
    });

    it("should format large amounts with commas", () => {
      const result = buildSlackNotification({
        ...validInput,
        amount: 1234567.89,
      });
      const fieldTexts = result.blocks[1].fields.map(
        (f: { text: string }) => f.text
      );
      const amountField = fieldTexts.find((t: string) =>
        t.includes("Amount")
      );
      expect(amountField).toContain("$1,234,567.89");
    });
  });

  describe("Input validation via buildSlackNotification", () => {
    it("should throw on invalid input (missing fields)", () => {
      expect(() =>
        buildSlackNotification({} as unknown as SlackInput)
      ).toThrow();
    });

    it("should throw when confidence is out of range", () => {
      expect(() =>
        buildSlackNotification({ ...validInput, confidence: 2 })
      ).toThrow();
    });
  });
});
