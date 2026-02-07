import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyApiKey, AuthError } from "../_shared/auth.ts";
import { withRetry } from "../_shared/retry.ts";
import OpenAI from "https://esm.sh/openai@4.52.0";

const SYSTEM_PROMPT = `You are an invoice classification system. Analyze the provided email content and determine if it represents a real vendor invoice.

Respond with a JSON object containing:
- is_invoice: boolean - true if this is a legitimate vendor invoice
- vendor_name: string or null - the vendor/company name if identifiable
- confidence: number between 0 and 1 - your confidence in the classification
- signals: array of strings - detected indicators (e.g., "invoice number present", "total amount found", "due date mentioned", "line items detected", "tax information present")

Only classify as an invoice if there are clear indicators such as:
- Invoice number or reference
- Itemized charges or totals
- Payment terms or due dates
- Vendor/seller information
- Bill-to or payment instructions`;

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    // Auth: require valid API key
    const { customer_id } = await verifyApiKey(req);

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { email_subject, email_body, attachment_text } = body;

    if (!email_subject || !email_body) {
      return new Response(
        JSON.stringify({ error: "email_subject and email_body are required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

    const userContent = `Email Subject: ${email_subject}\n\nEmail Body:\n${email_body}\n\n${
      attachment_text
        ? `Attachment Content:\n${attachment_text}`
        : "No attachment content available."
    }`;

    const result = await withRetry(async () => {
      const response = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
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
    console.error("classify-invoice error:", error);
    return new Response(
      JSON.stringify({ error: "Classification failed" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
