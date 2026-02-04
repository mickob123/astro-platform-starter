import type { Handler } from "@netlify/functions";
import { z } from "zod";
import OpenAI from "openai";

const InputSchema = z.object({
  email_subject: z.string(),
  email_body: z.string(),
  attachment_text: z.string().nullable(),
});

const OutputSchema = z.object({
  is_invoice: z.boolean(),
  vendor_name: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  signals: z.array(z.string()),
});

const SYSTEM_PROMPT = `You are an invoice classification expert. Analyze the provided email content and determine if it represents a real vendor invoice.

You must respond with a JSON object containing:
- is_invoice: boolean - true if this is a legitimate vendor invoice
- vendor_name: string or null - the vendor/company name if identifiable
- confidence: number between 0 and 1 - your confidence level
- signals: array of strings - indicators you detected (e.g., "invoice number present", "total amount found", "due date mentioned", "payment terms included")

Look for these indicators:
- Invoice number or reference
- Total amount / balance due
- Due date or payment terms
- Itemized charges
- Vendor details (address, tax ID)
- Professional invoice formatting

Be skeptical of:
- Marketing emails mentioning prices
- Receipts (past payments) vs invoices (payment requests)
- Quotes or estimates
- Spam or phishing attempts`;

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

    const userContent = `Email Subject: ${input.email_subject}

Email Body:
${input.email_body}

${input.attachment_text ? `Attachment Content:\n${input.attachment_text}` : "No attachment text provided."}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
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
