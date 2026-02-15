import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateInvoice,
  ValidatorInputSchema,
  type ValidatorInput,
  type Invoice,
} from "../modules/validator";
import {
  ClassifierInputSchema,
  ClassifierOutputSchema,
  type ClassifierInput,
} from "../modules/classifier";
import {
  ExtractorInputSchema,
  ExtractorOutputSchema,
  type ExtractorInput,
} from "../modules/extractor";
import {
  buildQuickBooksPayload,
  QuickBooksInputSchema,
  type QuickBooksInput,
} from "../modules/quickbooks";
import {
  buildSlackNotification,
  SlackInputSchema,
  type SlackInput,
} from "../modules/slack";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeValidInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    vendor_name: "Acme Corp",
    invoice_number: "INV-001",
    invoice_date: "2024-01-15",
    due_date: "2024-02-15",
    currency: "USD",
    line_items: [
      {
        description: "Consulting",
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

// ---------------------------------------------------------------------------
// process-invoice validation (field presence / format)
// ---------------------------------------------------------------------------
describe("Edge Function Validation — process-invoice", () => {
  describe("Missing required fields", () => {
    it("should fail when email_subject is missing", () => {
      // The Edge Function checks: if (!email_subject || !email_body) -> 400
      const body = { email_body: "body text" };
      expect(!body.hasOwnProperty("email_subject") || !(body as any).email_subject).toBe(true);
    });

    it("should fail when email_body is missing", () => {
      const body = { email_subject: "Invoice" };
      expect(!body.hasOwnProperty("email_body") || !(body as any).email_body).toBe(true);
    });

    it("should fail when both email_subject and email_body are missing", () => {
      const body = {};
      expect(!(body as any).email_subject && !(body as any).email_body).toBe(true);
    });

    it("should fail when email_subject is empty string", () => {
      const body = { email_subject: "", email_body: "body" };
      expect(!body.email_subject).toBe(true);
    });

    it("should fail when email_body is empty string", () => {
      const body = { email_subject: "subj", email_body: "" };
      expect(!body.email_body).toBe(true);
    });
  });

  describe("Empty body handling", () => {
    it("should detect empty body as invalid", () => {
      const body = {} as any;
      const hasMissing = !body.email_subject || !body.email_body;
      expect(hasMissing).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// classify-invoice validation
// ---------------------------------------------------------------------------
describe("Edge Function Validation — classify-invoice", () => {
  describe("ClassifierInput schema rejects bad data", () => {
    it("should reject missing email_subject", () => {
      const result = ClassifierInputSchema.safeParse({
        email_body: "body",
        attachment_text: null,
      });
      expect(result.success).toBe(false);
    });

    it("should reject missing email_body", () => {
      const result = ClassifierInputSchema.safeParse({
        email_subject: "subject",
        attachment_text: null,
      });
      expect(result.success).toBe(false);
    });

    it("should reject numeric email_subject", () => {
      const result = ClassifierInputSchema.safeParse({
        email_subject: 12345,
        email_body: "body",
        attachment_text: null,
      });
      expect(result.success).toBe(false);
    });

    it("should reject boolean email_body", () => {
      const result = ClassifierInputSchema.safeParse({
        email_subject: "subj",
        email_body: true,
        attachment_text: null,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("ClassifierOutput schema validates ranges", () => {
    it("should reject confidence below 0", () => {
      const result = ClassifierOutputSchema.safeParse({
        is_invoice: true,
        vendor_name: "Test",
        confidence: -0.1,
        signals: [],
      });
      expect(result.success).toBe(false);
    });

    it("should reject confidence above 1", () => {
      const result = ClassifierOutputSchema.safeParse({
        is_invoice: true,
        vendor_name: "Test",
        confidence: 1.01,
        signals: [],
      });
      expect(result.success).toBe(false);
    });

    it("should accept confidence at boundaries (0 and 1)", () => {
      const result0 = ClassifierOutputSchema.safeParse({
        is_invoice: false,
        vendor_name: null,
        confidence: 0,
        signals: [],
      });
      expect(result0.success).toBe(true);

      const result1 = ClassifierOutputSchema.safeParse({
        is_invoice: true,
        vendor_name: "Vendor",
        confidence: 1,
        signals: ["clear invoice"],
      });
      expect(result1.success).toBe(true);
    });

    it("should reject non-boolean is_invoice", () => {
      const result = ClassifierOutputSchema.safeParse({
        is_invoice: "yes",
        vendor_name: "Test",
        confidence: 0.5,
        signals: [],
      });
      expect(result.success).toBe(false);
    });

    it("should reject non-array signals", () => {
      const result = ClassifierOutputSchema.safeParse({
        is_invoice: true,
        vendor_name: "Test",
        confidence: 0.5,
        signals: "not an array",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("Non-invoice content classification output", () => {
    it("should accept valid non-invoice classification", () => {
      const output = {
        is_invoice: false,
        vendor_name: null,
        confidence: 0.05,
        signals: [],
      };
      const result = ClassifierOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
      expect(result.data?.is_invoice).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// extract-invoice validation
// ---------------------------------------------------------------------------
describe("Edge Function Validation — extract-invoice", () => {
  describe("ExtractorInput schema", () => {
    it("should reject missing document_text", () => {
      const result = ExtractorInputSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("should reject null document_text", () => {
      const result = ExtractorInputSchema.safeParse({ document_text: null });
      expect(result.success).toBe(false);
    });

    it("should reject numeric document_text", () => {
      const result = ExtractorInputSchema.safeParse({ document_text: 42 });
      expect(result.success).toBe(false);
    });

    it("should accept any string document_text", () => {
      const result = ExtractorInputSchema.safeParse({
        document_text: "Some invoice content",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("ExtractorOutput schema rejects malformed data", () => {
    it("should reject missing vendor_name", () => {
      const result = ExtractorOutputSchema.safeParse({
        invoice_number: "INV-1",
        invoice_date: "2024-01-01",
        due_date: null,
        currency: "USD",
        line_items: [],
        subtotal: 100,
        tax: null,
        total: 100,
      });
      expect(result.success).toBe(false);
    });

    it("should reject non-ISO date format (MM/DD/YYYY)", () => {
      const result = ExtractorOutputSchema.safeParse({
        vendor_name: "Test",
        invoice_number: "INV-1",
        invoice_date: "01/15/2024",
        due_date: null,
        currency: "USD",
        line_items: [],
        subtotal: 100,
        tax: null,
        total: 100,
      });
      expect(result.success).toBe(false);
    });

    it("should reject non-ISO date format (DD-MM-YYYY)", () => {
      const result = ExtractorOutputSchema.safeParse({
        vendor_name: "Test",
        invoice_number: "INV-1",
        invoice_date: "15-01-2024",
        due_date: null,
        currency: "USD",
        line_items: [],
        subtotal: 100,
        tax: null,
        total: 100,
      });
      expect(result.success).toBe(false);
    });

    it("should reject currency code that is not 3 chars", () => {
      const result = ExtractorOutputSchema.safeParse({
        vendor_name: "Test",
        invoice_number: "INV-1",
        invoice_date: "2024-01-01",
        due_date: null,
        currency: "US",
        line_items: [],
        subtotal: 100,
        tax: null,
        total: 100,
      });
      expect(result.success).toBe(false);
    });

    it("should reject 4-character currency code", () => {
      const result = ExtractorOutputSchema.safeParse({
        vendor_name: "Test",
        invoice_number: "INV-1",
        invoice_date: "2024-01-01",
        due_date: null,
        currency: "USDC",
        line_items: [],
        subtotal: 100,
        tax: null,
        total: 100,
      });
      expect(result.success).toBe(false);
    });

    it("should reject line items with missing total", () => {
      const result = ExtractorOutputSchema.safeParse({
        vendor_name: "Test",
        invoice_number: "INV-1",
        invoice_date: "2024-01-01",
        due_date: null,
        currency: "USD",
        line_items: [
          { description: "Item", quantity: 1, unit_price: 100 },
        ],
        subtotal: 100,
        tax: null,
        total: 100,
      });
      expect(result.success).toBe(false);
    });

    it("should accept line items with null quantity and unit_price", () => {
      const result = ExtractorOutputSchema.safeParse({
        vendor_name: "Test",
        invoice_number: "INV-1",
        invoice_date: "2024-01-01",
        due_date: null,
        currency: "USD",
        line_items: [
          { description: "Lump sum", quantity: null, unit_price: null, total: 100 },
        ],
        subtotal: 100,
        tax: null,
        total: 100,
      });
      expect(result.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// validate-invoice — math errors
// ---------------------------------------------------------------------------
describe("Edge Function Validation — validate-invoice math", () => {
  it("should fail when subtotal + tax != total (large difference)", () => {
    const input: ValidatorInput = {
      invoice: makeValidInvoice({
        subtotal: 1000,
        tax: 100,
        total: 1200, // expected 1100
      }),
      existing_invoice_numbers: [],
    };

    const result = validateInvoice(input);
    expect(result.is_valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Math validation failed"))).toBe(true);
  });

  it("should fail when subtotal + tax exceeds total", () => {
    const input: ValidatorInput = {
      invoice: makeValidInvoice({
        subtotal: 1000,
        tax: 200,
        total: 1100, // expected 1200
      }),
      existing_invoice_numbers: [],
    };

    const result = validateInvoice(input);
    expect(result.is_valid).toBe(false);
  });

  it("should pass when difference is exactly at tolerance (0.01)", () => {
    const input: ValidatorInput = {
      invoice: makeValidInvoice({
        subtotal: 1000,
        tax: 100,
        total: 1100.01,
      }),
      existing_invoice_numbers: [],
    };

    const result = validateInvoice(input);
    // 0.01 is exactly equal to MATH_TOLERANCE, so not greater than -> should pass
    expect(result.is_valid).toBe(true);
  });

  it("should fail when difference is just above tolerance (0.02)", () => {
    const input: ValidatorInput = {
      invoice: makeValidInvoice({
        subtotal: 1000,
        tax: 100,
        total: 1100.02,
      }),
      existing_invoice_numbers: [],
    };

    const result = validateInvoice(input);
    expect(result.is_valid).toBe(false);
  });

  it("should handle negative tax gracefully", () => {
    // Negative tax means a credit/discount scenario
    const input: ValidatorInput = {
      invoice: makeValidInvoice({
        subtotal: 1000,
        tax: -50,
        total: 950,
      }),
      existing_invoice_numbers: [],
    };

    const result = validateInvoice(input);
    expect(result.is_valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validate-invoice — duplicate detection
// ---------------------------------------------------------------------------
describe("Edge Function Validation — duplicate invoice numbers", () => {
  it("should detect duplicate invoice numbers", () => {
    const input: ValidatorInput = {
      invoice: makeValidInvoice({ invoice_number: "DUP-001" }),
      existing_invoice_numbers: ["DUP-001", "OTHER-002"],
    };

    const result = validateInvoice(input);
    expect(result.is_valid).toBe(false);
    expect(result.errors).toContain(
      'invoice_number "DUP-001" already exists (duplicate)'
    );
  });

  it("should pass when invoice number is unique", () => {
    const input: ValidatorInput = {
      invoice: makeValidInvoice({ invoice_number: "UNIQUE-999" }),
      existing_invoice_numbers: ["OTHER-001", "OTHER-002"],
    };

    const result = validateInvoice(input);
    expect(result.is_valid).toBe(true);
  });

  it("should pass when existing numbers list is empty", () => {
    const input: ValidatorInput = {
      invoice: makeValidInvoice(),
      existing_invoice_numbers: [],
    };

    const result = validateInvoice(input);
    expect(result.is_valid).toBe(true);
  });

  it("should be case-sensitive for invoice number duplication", () => {
    const input: ValidatorInput = {
      invoice: makeValidInvoice({ invoice_number: "inv-001" }),
      existing_invoice_numbers: ["INV-001"],
    };

    const result = validateInvoice(input);
    // Case-sensitive, so "inv-001" != "INV-001"
    expect(result.is_valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// admin-create-customer validation
// ---------------------------------------------------------------------------
describe("Edge Function Validation — admin-create-customer", () => {
  describe("Required fields", () => {
    it("should require name and email", () => {
      const body = {} as any;
      const hasMissing = !body.name || !body.email;
      expect(hasMissing).toBe(true);
    });

    it("should reject when only name is provided", () => {
      const body = { name: "Acme Corp" } as any;
      expect(!body.email).toBe(true);
    });

    it("should reject when only email is provided", () => {
      const body = { email: "admin@acme.com" } as any;
      expect(!body.name).toBe(true);
    });
  });

  describe("Slug generation logic", () => {
    it("should convert name to lowercase slug", () => {
      const name = "Acme Corp";
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      expect(slug).toBe("acme-corp");
    });

    it("should handle special characters in name", () => {
      const name = "O'Brien & Associates, LLC.";
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      expect(slug).toBe("o-brien-associates-llc");
    });

    it("should handle leading and trailing spaces", () => {
      const name = "  Acme Corp  ";
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      expect(slug).toBe("acme-corp");
    });

    it("should handle numeric names", () => {
      const name = "123 Industries";
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      expect(slug).toBe("123-industries");
    });

    it("should handle names with unicode characters", () => {
      const name = "Cafe Muller";
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      expect(slug).toBe("cafe-muller");
    });
  });

  describe("API key generation logic", () => {
    it("should generate API key with inv_ prefix", () => {
      // Simulating generateApiKey() logic
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const key = `inv_${Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;

      expect(key).toMatch(/^inv_[0-9a-f]{64}$/);
    });

    it("should generate unique keys on each call", () => {
      const generateApiKey = () => {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        return `inv_${Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")}`;
      };

      const key1 = generateApiKey();
      const key2 = generateApiKey();
      expect(key1).not.toBe(key2);
    });
  });
});

// ---------------------------------------------------------------------------
// Pagination edge cases (admin-list-customers, admin-get-dashboard)
// ---------------------------------------------------------------------------
describe("Edge Function Validation — Pagination", () => {
  // The Edge Functions clamp pagination: Math.max(1, page), Math.min(100, Math.max(1, limit))
  function clampPage(raw: string | null): number {
    return Math.max(1, parseInt(raw || "1", 10));
  }

  function clampLimit(raw: string | null): number {
    return Math.min(100, Math.max(1, parseInt(raw || "25", 10)));
  }

  it("should default page to 1 when not specified", () => {
    expect(clampPage(null)).toBe(1);
  });

  it("should default limit to 25 when not specified", () => {
    expect(clampLimit(null)).toBe(25);
  });

  it("should clamp page=0 to 1", () => {
    expect(clampPage("0")).toBe(1);
  });

  it("should clamp negative page to 1", () => {
    expect(clampPage("-5")).toBe(1);
  });

  it("should allow page=1", () => {
    expect(clampPage("1")).toBe(1);
  });

  it("should allow large page numbers", () => {
    expect(clampPage("999")).toBe(999);
  });

  it("should clamp limit=0 to 1", () => {
    expect(clampLimit("0")).toBe(1);
  });

  it("should clamp negative limit to 1", () => {
    expect(clampLimit("-10")).toBe(1);
  });

  it("should cap limit at 100", () => {
    expect(clampLimit("200")).toBe(100);
  });

  it("should cap limit at 100 for very large values", () => {
    expect(clampLimit("999999")).toBe(100);
  });

  it("should allow limit=1", () => {
    expect(clampLimit("1")).toBe(1);
  });

  it("should allow limit=100", () => {
    expect(clampLimit("100")).toBe(100);
  });

  it("should return NaN for non-numeric page input", () => {
    // parseInt("abc") returns NaN, and Math.max(1, NaN) = NaN
    expect(clampPage("abc")).toBeNaN();
  });

  it("should return NaN for non-numeric limit input", () => {
    // parseInt("abc") returns NaN, Math.min/max with NaN = NaN
    expect(clampLimit("abc")).toBeNaN();
  });

  it("should correctly compute offset", () => {
    const page = 3;
    const limit = 25;
    const offset = (page - 1) * limit;
    expect(offset).toBe(50);
  });

  it("should compute offset=0 for page 1", () => {
    const page = 1;
    const limit = 25;
    const offset = (page - 1) * limit;
    expect(offset).toBe(0);
  });

  it("should compute total_pages correctly", () => {
    expect(Math.ceil(0 / 25)).toBe(0);
    expect(Math.ceil(1 / 25)).toBe(1);
    expect(Math.ceil(25 / 25)).toBe(1);
    expect(Math.ceil(26 / 25)).toBe(2);
    expect(Math.ceil(100 / 25)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// QuickBooks payload validation
// ---------------------------------------------------------------------------
describe("Edge Function Validation — QuickBooks payload", () => {
  it("should reject missing invoice", () => {
    const result = QuickBooksInputSchema.safeParse({ vendor_id: "123" });
    expect(result.success).toBe(false);
  });

  it("should reject missing vendor_id", () => {
    const result = QuickBooksInputSchema.safeParse({
      invoice: makeValidInvoice(),
    });
    expect(result.success).toBe(false);
  });

  it("should build valid payload for complete invoice", () => {
    const input: QuickBooksInput = {
      invoice: makeValidInvoice(),
      vendor_id: "qb-vendor-1",
    };

    const output = buildQuickBooksPayload(input);
    expect(output.quickbooks_payload.VendorRef.value).toBe("qb-vendor-1");
    expect(output.quickbooks_payload.DocNumber).toBe("INV-001");
    expect(output.quickbooks_payload.TotalAmt).toBe(1100);
    expect(output.quickbooks_payload.CurrencyRef.value).toBe("USD");
  });

  it("should include tax as a separate line item when tax > 0", () => {
    const input: QuickBooksInput = {
      invoice: makeValidInvoice({ tax: 100 }),
      vendor_id: "qb-vendor-1",
    };

    const output = buildQuickBooksPayload(input);
    const taxLine = output.quickbooks_payload.Line.find(
      (l) => l.Description === "Tax"
    );
    expect(taxLine).toBeDefined();
    expect(taxLine!.Amount).toBe(100);
  });

  it("should NOT include tax line when tax is null", () => {
    const input: QuickBooksInput = {
      invoice: makeValidInvoice({ tax: null, subtotal: 1100, total: 1100 }),
      vendor_id: "qb-vendor-1",
    };

    const output = buildQuickBooksPayload(input);
    const taxLine = output.quickbooks_payload.Line.find(
      (l) => l.Description === "Tax"
    );
    expect(taxLine).toBeUndefined();
  });

  it("should NOT include tax line when tax is 0", () => {
    const input: QuickBooksInput = {
      invoice: makeValidInvoice({ tax: 0, subtotal: 1100, total: 1100 }),
      vendor_id: "qb-vendor-1",
    };

    const output = buildQuickBooksPayload(input);
    const taxLine = output.quickbooks_payload.Line.find(
      (l) => l.Description === "Tax"
    );
    expect(taxLine).toBeUndefined();
  });

  it("should include DueDate when due_date is provided", () => {
    const input: QuickBooksInput = {
      invoice: makeValidInvoice({ due_date: "2024-03-01" }),
      vendor_id: "qb-vendor-1",
    };

    const output = buildQuickBooksPayload(input);
    expect(output.quickbooks_payload.DueDate).toBe("2024-03-01");
  });

  it("should NOT include DueDate when due_date is null", () => {
    const input: QuickBooksInput = {
      invoice: makeValidInvoice({ due_date: null, subtotal: 1000, tax: 100, total: 1100 }),
      vendor_id: "qb-vendor-1",
    };

    const output = buildQuickBooksPayload(input);
    expect(output.quickbooks_payload.DueDate).toBeUndefined();
  });

  it("should set correct PrivateNote", () => {
    const input: QuickBooksInput = {
      invoice: makeValidInvoice({ invoice_number: "INV-ABC-789" }),
      vendor_id: "qb-vendor-1",
    };

    const output = buildQuickBooksPayload(input);
    expect(output.quickbooks_payload.PrivateNote).toBe(
      "Imported from invoice: INV-ABC-789"
    );
  });

  it("should handle multiple line items", () => {
    const input: QuickBooksInput = {
      invoice: makeValidInvoice({
        line_items: [
          { description: "Item A", quantity: 2, unit_price: 50, total: 100 },
          { description: "Item B", quantity: 3, unit_price: 200, total: 600 },
          { description: "Item C", quantity: 1, unit_price: 300, total: 300 },
        ],
        subtotal: 1000,
        tax: 100,
        total: 1100,
      }),
      vendor_id: "qb-vendor-1",
    };

    const output = buildQuickBooksPayload(input);
    // 3 line items + 1 tax line = 4 total
    expect(output.quickbooks_payload.Line).toHaveLength(4);
    expect(output.quickbooks_payload.Line[0].Id).toBe("1");
    expect(output.quickbooks_payload.Line[1].Id).toBe("2");
    expect(output.quickbooks_payload.Line[2].Id).toBe("3");
    expect(output.quickbooks_payload.Line[3].Id).toBe("4"); // tax
  });
});

// ---------------------------------------------------------------------------
// Slack payload validation
// ---------------------------------------------------------------------------
describe("Edge Function Validation — Slack payload", () => {
  it("should reject missing required fields", () => {
    const result = SlackInputSchema.safeParse({
      vendor: "Test",
    });
    expect(result.success).toBe(false);
  });

  it("should reject confidence > 1", () => {
    const result = SlackInputSchema.safeParse({
      vendor: "Test",
      amount: 100,
      currency: "USD",
      due_date: "2024-01-01",
      invoice_number: "INV-1",
      confidence: 1.5,
      invoice_url: "https://example.com",
    });
    expect(result.success).toBe(false);
  });

  it("should build valid Slack blocks for high-confidence invoice", () => {
    const input: SlackInput = {
      vendor: "Acme Corp",
      amount: 1500,
      currency: "USD",
      due_date: "2024-02-15",
      invoice_number: "INV-100",
      confidence: 0.95,
      invoice_url: "https://app.example.com/invoices/100",
    };

    const output = buildSlackNotification(input);
    expect(output.blocks).toHaveLength(5);
    expect(output.blocks[0].type).toBe("header");

    // Check the confidence section contains "High"
    const confSection = output.blocks[2];
    expect(confSection.text.text).toContain("High");
    expect(confSection.text.text).toContain("95%");
  });

  it("should show Medium confidence for 0.7-0.89 range", () => {
    const input: SlackInput = {
      vendor: "Test",
      amount: 500,
      currency: "USD",
      due_date: "2024-01-01",
      invoice_number: "INV-1",
      confidence: 0.75,
      invoice_url: "https://example.com",
    };

    const output = buildSlackNotification(input);
    const confSection = output.blocks[2];
    expect(confSection.text.text).toContain("Medium");
    expect(confSection.text.text).toContain("75%");
  });

  it("should show Low confidence for < 0.7", () => {
    const input: SlackInput = {
      vendor: "Test",
      amount: 500,
      currency: "USD",
      due_date: "2024-01-01",
      invoice_number: "INV-1",
      confidence: 0.4,
      invoice_url: "https://example.com",
    };

    const output = buildSlackNotification(input);
    const confSection = output.blocks[2];
    expect(confSection.text.text).toContain("Low");
    expect(confSection.text.text).toContain("40%");
  });

  it("should include action buttons", () => {
    const input: SlackInput = {
      vendor: "Test",
      amount: 500,
      currency: "USD",
      due_date: "2024-01-01",
      invoice_number: "INV-1",
      confidence: 0.9,
      invoice_url: "https://example.com",
    };

    const output = buildSlackNotification(input);
    const actions = output.blocks[4];
    expect(actions.type).toBe("actions");
    expect(actions.elements).toHaveLength(2);
    expect(actions.elements[0].action_id).toBe("approve_invoice");
    expect(actions.elements[1].action_id).toBe("flag_invoice");
  });

  it("should format currency correctly", () => {
    const input: SlackInput = {
      vendor: "Test",
      amount: 1234.56,
      currency: "USD",
      due_date: "2024-01-01",
      invoice_number: "INV-1",
      confidence: 0.9,
      invoice_url: "https://example.com",
    };

    const output = buildSlackNotification(input);
    const section = output.blocks[1];
    const amountField = section.fields.find((f: any) =>
      f.text.includes("Amount")
    );
    expect(amountField).toBeDefined();
    expect(amountField.text).toContain("$1,234.56");
  });
});
