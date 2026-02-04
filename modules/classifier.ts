import { z } from "zod";
import OpenAI from "openai";

export const ClassifierInputSchema = z.object({
  email_subject: z.string(),
  email_body: z.string(),
  attachment_text: z.string().nullable(),
});

export const ClassifierOutputSchema = z.object({
  is_invoice: z.boolean(),
  vendor_name: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  signals: z.array(z.string()),
});

export type ClassifierInput = z.infer<typeof ClassifierInputSchema>;
export type ClassifierOutput = z.infer<typeof ClassifierOutputSchema>;

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

export async function classifyInvoice(
  input: ClassifierInput
): Promise<ClassifierOutput> {
  const validatedInput = ClassifierInputSchema.parse(input);

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const userContent = `Email Subject: ${validatedInput.email_subject}

Email Body:
${validatedInput.email_body}

${validatedInput.attachment_text ? `Attachment Content:\n${validatedInput.attachment_text}` : "No attachment content available."}`;

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
  if (!content) {
    throw new Error("No response content from OpenAI");
  }

  const parsed = JSON.parse(content);
  return ClassifierOutputSchema.parse(parsed);
}
