import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { validateClassifierInput, ClassifierOutput } from "../_shared/schemas.ts";
import { logProcessingStep } from "../_shared/db.ts";

const SYSTEM_PROMPT = `You are an invoice classification system. Analyze the provided email and determine if it contains or represents a real vendor invoice.

Return a JSON object with:
- is_invoice: boolean - true if this is a legitimate invoice
- vendor_name: string or null - the vendor/company name if identifiable
- confidence: number between 0 and 1 - how confident you are
- signals: array of strings - indicators you detected (e.g., "invoice number present", "total amount found", "due date mentioned", "line items detected")

Only classify as an invoice if it's a real bill/invoice from a vendor for goods or services. Exclude:
- Marketing emails
- Receipts (already paid)
- Quotes/estimates
- Order confirmations without billing`;

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const startTime = Date.now();
  const customerId = req.headers.get("x-customer-id") || "system";

  try {
    const body = await req.json();
    const input = validateClassifierInput(body);

    await logProcessingStep(customerId, null, "classify", "started", input, null, null, null);

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      throw new Error("OPENAI_API_KEY not configured");
    }

    const userContent = `Email Subject: ${input.email_subject}

Email Body:
${input.email_body}

${input.attachment_text ? `Attachment Content:\n${input.attachment_text}` : "No attachment text available."}`;

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
          { role: "user", content: userContent },
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
    const result: ClassifierOutput = JSON.parse(data.choices[0].message.content);

    if (typeof result.confidence !== "number" || result.confidence < 0 || result.confidence > 1) {
      result.confidence = Math.max(0, Math.min(1, result.confidence || 0));
    }

    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "classify", "success", input, result, null, duration);

    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "classify", "error", null, null, message, duration);
    return errorResponse(message);
  }
});
