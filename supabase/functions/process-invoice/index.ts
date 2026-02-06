import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import {
  logProcessingStep,
  getExistingInvoiceNumbers,
  findOrCreateVendor,
  createInvoice,
  updateInvoice,
  getSupabaseClient,
} from "../_shared/db.ts";

interface ProcessInput {
  customer_id: string;
  email_subject: string;
  email_body: string;
  attachment_text: string | null;
  source_email_id?: string;
  source_email_from?: string;
}

const CLASSIFIER_PROMPT = `You are an invoice classification system. Analyze the provided email and determine if it contains or represents a real vendor invoice.

Return a JSON object with:
- is_invoice: boolean - true if this is a legitimate invoice
- vendor_name: string or null - the vendor/company name if identifiable
- confidence: number between 0 and 1 - how confident you are
- signals: array of strings - indicators you detected

Only classify as an invoice if it's a real bill/invoice from a vendor. Exclude marketing emails, receipts, quotes, order confirmations.`;

const EXTRACTOR_PROMPT = `Extract structured invoice data. Return JSON with:
- vendor_name: string
- invoice_number: string
- invoice_date: YYYY-MM-DD
- due_date: YYYY-MM-DD or null
- currency: ISO 4217 code
- line_items: array of {description, quantity, unit_price, total}
- subtotal: number
- tax: number or null
- total: number

All monetary values must be numbers. Missing fields should be null.`;

async function callOpenAI(systemPrompt: string, userContent: string) {
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) throw new Error("OPENAI_API_KEY not configured");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
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
  return JSON.parse(data.choices[0].message.content);
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const startTime = Date.now();

  try {
    const body: ProcessInput = await req.json();
    const { customer_id, email_subject, email_body, attachment_text, source_email_id, source_email_from } = body;

    if (!customer_id) throw new Error("customer_id is required");

    // Step 1: Classify
    await logProcessingStep(customer_id, null, "process_start", "started", body, null, null, null);

    const classifyContent = `Email Subject: ${email_subject}\n\nEmail Body:\n${email_body}\n\n${attachment_text ? `Attachment:\n${attachment_text}` : ""}`;
    const classification = await callOpenAI(CLASSIFIER_PROMPT, classifyContent);

    if (!classification.is_invoice) {
      await logProcessingStep(customer_id, null, "process_complete", "success", body, { skipped: true, reason: "not_invoice" }, null, Date.now() - startTime);
      return jsonResponse({
        success: true,
        skipped: true,
        reason: "Not classified as an invoice",
        classification,
      });
    }

    // Step 2: Extract
    const documentText = `${email_subject}\n\n${email_body}\n\n${attachment_text || ""}`;
    const extracted = await callOpenAI(EXTRACTOR_PROMPT, documentText);

    // Step 3: Validate
    const existingNumbers = await getExistingInvoiceNumbers(customer_id);
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!extracted.vendor_name) errors.push("vendor_name is required");
    if (!extracted.currency) errors.push("currency is required");
    if (extracted.total <= 0) errors.push("total must be greater than 0");
    if (extracted.invoice_number && existingNumbers.includes(extracted.invoice_number)) {
      errors.push(`Duplicate invoice number: ${extracted.invoice_number}`);
    }

    const tax = extracted.tax ?? 0;
    if (Math.abs((extracted.subtotal + tax) - extracted.total) > 0.01) {
      errors.push("Math validation failed");
    }

    if (!extracted.due_date) warnings.push("due_date not specified");
    if (!extracted.invoice_number) warnings.push("invoice_number is empty");

    const isValid = errors.length === 0;

    // Step 4: Find or create vendor
    const vendor = await findOrCreateVendor(customer_id, extracted.vendor_name || classification.vendor_name || "Unknown");

    // Step 5: Create invoice record
    const invoice = await createInvoice(customer_id, {
      source_email_id,
      source_email_subject: email_subject,
      source_email_from,
      vendor_id: vendor.id,
      invoice_number: extracted.invoice_number,
      invoice_date: extracted.invoice_date,
      due_date: extracted.due_date,
      currency: extracted.currency,
      subtotal: extracted.subtotal,
      tax: extracted.tax,
      total: extracted.total,
      line_items: extracted.line_items,
      raw_text: documentText,
      confidence: classification.confidence,
      signals: classification.signals,
      is_valid: isValid,
      validation_errors: errors,
      validation_warnings: warnings,
      status: isValid ? "pending" : "flagged",
    });

    // Step 6: Build Slack notification
    const supabase = getSupabaseClient();
    const { data: customer } = await supabase
      .from("customers")
      .select("slack_webhook_url, slack_channel, settings")
      .eq("id", customer_id)
      .single();

    let slackSent = false;
    if (customer?.slack_webhook_url) {
      const slackBlocks = buildSlackBlocks({
        vendor: extracted.vendor_name,
        amount: extracted.total,
        currency: extracted.currency,
        due_date: extracted.due_date || "Not specified",
        invoice_number: extracted.invoice_number,
        confidence: classification.confidence,
        invoice_id: invoice.id,
        is_valid: isValid,
        errors,
        warnings,
      });

      try {
        await fetch(customer.slack_webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: customer.slack_channel,
            blocks: slackBlocks,
          }),
        });
        slackSent = true;
      } catch (e) {
        console.error("Slack notification failed:", e);
      }
    }

    const duration = Date.now() - startTime;
    await logProcessingStep(customer_id, invoice.id, "process_complete", "success", body, { invoice_id: invoice.id }, null, duration);

    return jsonResponse({
      success: true,
      invoice_id: invoice.id,
      classification,
      extracted,
      validation: { is_valid: isValid, errors, warnings },
      vendor,
      slack_sent: slackSent,
      accounting_vendor_id: vendor.accounting_vendor_id,
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await logProcessingStep("system", null, "process_error", "error", null, null, message, Date.now() - startTime);
    return errorResponse(message, 500);
  }
});

function buildSlackBlocks(input: {
  vendor: string;
  amount: number;
  currency: string;
  due_date: string;
  invoice_number: string;
  confidence: number;
  invoice_id: string;
  is_valid: boolean;
  errors: string[];
  warnings: string[];
}) {
  const confidencePercent = Math.round(input.confidence * 100);
  const emoji = input.confidence >= 0.9 ? ":white_check_mark:" : input.confidence >= 0.7 ? ":large_yellow_circle:" : ":warning:";
  const statusEmoji = input.is_valid ? ":white_check_mark:" : ":x:";

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: ":page_facing_up: New Invoice Received", emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Vendor:*\n${input.vendor}` },
        { type: "mrkdwn", text: `*Amount:*\n${input.currency} ${input.amount.toFixed(2)}` },
        { type: "mrkdwn", text: `*Invoice #:*\n${input.invoice_number}` },
        { type: "mrkdwn", text: `*Due Date:*\n${input.due_date}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `${emoji} *Confidence:* ${confidencePercent}% | ${statusEmoji} *Valid:* ${input.is_valid ? "Yes" : "No"}` },
    },
  ];

  if (input.errors.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:x: *Errors:*\n${input.errors.map(e => `• ${e}`).join("\n")}` },
    });
  }

  if (input.warnings.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:warning: *Warnings:*\n${input.warnings.map(w => `• ${w}`).join("\n")}` },
    });
  }

  blocks.push(
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: ":white_check_mark: Approve", emoji: true },
          style: "primary",
          action_id: "approve_invoice",
          value: input.invoice_id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: ":flag-red: Flag", emoji: true },
          style: "danger",
          action_id: "flag_invoice",
          value: input.invoice_id,
        },
      ],
    }
  );

  return blocks;
}
