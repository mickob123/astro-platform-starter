import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyApiKey, AuthError } from "../_shared/auth.ts";
import { withRetry } from "../_shared/retry.ts";
import OpenAI from "https://esm.sh/openai@4.52.0";

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

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    const { customer_id } = await verifyApiKey(req);

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { document_text } = body;

    if (!document_text) {
      return new Response(
        JSON.stringify({ error: "document_text is required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // Guard against oversized payloads that could cause excessive API costs
    const MAX_TEXT_LENGTH = 100_000; // ~100KB of text
    if (typeof document_text !== "string" || document_text.length > MAX_TEXT_LENGTH) {
      return new Response(
        JSON.stringify({ error: `document_text must be a string of at most ${MAX_TEXT_LENGTH} characters` }),
        { status: 413, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

    const result = await withRetry(async () => {
      const response = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: document_text },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("No response content from OpenAI");
      return JSON.parse(content);
    });

    return new Response(
      JSON.stringify({ ...result, customer_id }),
      { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    console.error("extract-invoice error:", error);
    return new Response(
      JSON.stringify({ error: "Extraction failed" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
