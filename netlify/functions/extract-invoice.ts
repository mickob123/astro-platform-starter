import type { Handler } from "@netlify/functions";
import { z } from "zod";
import OpenAI from "openai";

const InputSchema = z.object({
  document_text: z.string(),
});

const LineItemSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unit_price: z.number().nullable(),
  total: z.number(),
});

const OutputSchema = z.object({
  vendor_name: z.string(),
  invoice_number: z.string(),
  invoice_date: z.string(),
  due_date: z.string().nullable(),
  currency: z.string(),
  line_items: z.array(LineItemSchema),
  subtotal: z.number(),
  tax: z.number().nullable(),
  total: z.number(),
});

const SYSTEM_PROMPT = `You are an invoice data extraction expert. Extract structured data from the provided invoice text.

You must respond with a JSON object containing these exact fields:
- vendor_name: string - the vendor/supplier company name
- invoice_number: string - the invoice number/reference
- invoice_date: string - date in YYYY-MM-DD format
- due_date: string or null - due date in YYYY-MM-DD format, null if not found
- currency: string - ISO 4217 currency code (e.g., "USD", "EUR", "GBP")
- line_items: array of objects with:
  - description: string
  - quantity: number or null
  - unit_price: number or null
  - total: number
- subtotal: number - sum before tax
- tax: number or null - tax amount, null if not applicable
- total: number - final total amount

Rules:
- All monetary values must be numbers, not strings
- Dates must be ISO formatted (YYYY-MM-DD)
- Missing fields must be null, never omitted
- Infer currency from symbols ($=USD, €=EUR, £=GBP) if not explicit
- If line items aren't clear, create a single line item with the total`;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const input = InputSchema.parse(body);

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: input.document_text },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No response from OpenAI");
    }

    const parsed = JSON.parse(content);
    const output = OutputSchema.parse(parsed);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(output),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      statusCode: 400,
      body: JSON.stringify({ error: message }),
    };
  }
};
