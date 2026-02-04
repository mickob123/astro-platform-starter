import { z } from "zod";
import OpenAI from "openai";

export const LineItemSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unit_price: z.number().nullable(),
  total: z.number(),
});

export const ExtractorInputSchema = z.object({
  document_text: z.string(),
});

export const ExtractorOutputSchema = z.object({
  vendor_name: z.string(),
  invoice_number: z.string(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  currency: z.string().length(3),
  line_items: z.array(LineItemSchema),
  subtotal: z.number(),
  tax: z.number().nullable(),
  total: z.number(),
});

export type LineItem = z.infer<typeof LineItemSchema>;
export type ExtractorInput = z.infer<typeof ExtractorInputSchema>;
export type ExtractorOutput = z.infer<typeof ExtractorOutputSchema>;

const SYSTEM_PROMPT = `You are an invoice data extraction system. Extract structured data from the provided invoice document.

Respond with a JSON object containing exactly these fields:
- vendor_name: string - the vendor/seller company name
- invoice_number: string - the invoice reference number
- invoice_date: string - date in YYYY-MM-DD format
- due_date: string or null - payment due date in YYYY-MM-DD format, null if not specified
- currency: string - ISO 4217 currency code (e.g., "USD", "EUR", "GBP")
- line_items: array of objects, each containing:
  - description: string - item description
  - quantity: number or null - quantity if specified
  - unit_price: number or null - unit price if specified
  - total: number - line item total
- subtotal: number - sum before tax
- tax: number or null - tax amount, null if not applicable
- total: number - final total amount

Rules:
- All dates must be in YYYY-MM-DD format
- All monetary values must be numbers (not strings)
- Currency must be a valid ISO 4217 code
- Missing optional fields must be null, not omitted
- If a date cannot be determined, make a reasonable inference from context`;

export async function extractInvoiceData(
  input: ExtractorInput
): Promise<ExtractorOutput> {
  const validatedInput = ExtractorInputSchema.parse(input);

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const response = await openai.chat.completions.create({
    model: "gpt-4-turbo-preview",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: validatedInput.document_text },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No response content from OpenAI");
  }

  const parsed = JSON.parse(content);
  return ExtractorOutputSchema.parse(parsed);
}
