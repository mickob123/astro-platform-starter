import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { validateExtractorInput, ExtractedInvoice } from "../_shared/schemas.ts";
import { logProcessingStep } from "../_shared/db.ts";

const SYSTEM_PROMPT = `You are an invoice data extraction system. Extract structured data from the provided invoice text.

Return a JSON object with exactly these fields:
- vendor_name: string - the company/vendor name
- invoice_number: string - the invoice/bill number
- invoice_date: string - date in YYYY-MM-DD format
- due_date: string or null - due date in YYYY-MM-DD format, null if not found
- currency: string - ISO 4217 currency code (e.g., "USD", "EUR", "GBP")
- line_items: array of objects with:
  - description: string
  - quantity: number or null
  - unit_price: number or null
  - total: number
- subtotal: number - sum before tax
- tax: number or null - tax amount, null if not specified
- total: number - final total amount

Rules:
- All monetary values must be numbers, not strings
- Missing fields should be null, never omit them
- Dates must be ISO formatted (YYYY-MM-DD)
- If you can't determine the currency, default to "USD"
- Extract as many line items as present`;

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const startTime = Date.now();
  const customerId = req.headers.get("x-customer-id") || "system";

  try {
    const body = await req.json();
    const input = validateExtractorInput(body);

    await logProcessingStep(customerId, null, "extract", "started", input, null, null, null);

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      throw new Error("OPENAI_API_KEY not configured");
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: input.document_text },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${error}`);
    }

    const data = await response.json();
    const result: ExtractedInvoice = JSON.parse(data.choices[0].message.content);

    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "extract", "success", input, result, null, duration);

    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "extract", "error", null, null, message, duration);
    return errorResponse(message);
  }
});
