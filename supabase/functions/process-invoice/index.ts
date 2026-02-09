/**
 * Unified invoice processing pipeline.
 *
 * One API call does everything:
 *   classify → extract → validate → save to DB → Slack notify
 *
 * Security:
 *   - API key auth with tenant isolation
 *   - All DB writes scoped to authenticated customer_id
 *
 * Reliability:
 *   - OpenAI calls wrapped in retry with exponential backoff
 *   - Processing log tracks every step (audit trail)
 *   - If a step fails mid-pipeline, the log records the failure point
 *     so invoices are never silently lost
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyApiKey, AuthError } from "../_shared/auth.ts";
import { withRetry } from "../_shared/retry.ts";
import OpenAI from "https://esm.sh/openai@4.52.0";

const CLASSIFY_PROMPT = `You are an invoice classification system. Analyze the provided email content and determine if it represents a real vendor invoice.

Respond with a JSON object containing:
- is_invoice: boolean - true if this is a legitimate vendor invoice
- vendor_name: string or null - the vendor/company name if identifiable
- confidence: number between 0 and 1 - your confidence in the classification
- signals: array of strings - detected indicators`;

const EXTRACT_PROMPT = `You are an invoice data extraction system. Extract structured data from the provided invoice document.

Respond with a JSON object containing exactly these fields:
- vendor_name: string
- invoice_number: string
- invoice_date: string (YYYY-MM-DD)
- due_date: string or null (YYYY-MM-DD)
- currency: string (ISO 4217)
- line_items: array of {description, quantity, unit_price, total}
- subtotal: number
- tax: number or null
- total: number

All dates YYYY-MM-DD. All monetary values as numbers. Missing optional fields must be null.`;

const MATH_TOLERANCE = 0.01;

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  let logId: string | null = null;
  let supabase: Awaited<ReturnType<typeof verifyApiKey>>["supabase"] | null = null;
  let customerId: string | null = null;
  const startTime = Date.now();

  try {
    // --- Auth ---
    const auth = await verifyApiKey(req);
    supabase = auth.supabase;
    customerId = auth.customer_id;

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { email_subject, email_body, attachment_text, metadata } = body;

    if (!email_subject || !email_body) {
      return new Response(
        JSON.stringify({ error: "email_subject and email_body are required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // Guard against oversized payloads that could cause excessive API costs
    const MAX_TEXT_LENGTH = 100_000; // ~100KB of text
    const totalLength = (email_subject?.length || 0) + (email_body?.length || 0) + (attachment_text?.length || 0);
    if (totalLength > MAX_TEXT_LENGTH) {
      return new Response(
        JSON.stringify({ error: `Request body text exceeds maximum allowed length of ${MAX_TEXT_LENGTH} characters` }),
        { status: 413, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Create processing log (audit trail) ---
    const { data: logData, error: logError } = await supabase
      .from("processing_logs")
      .insert({
        customer_id: customerId,
        status: "started",
        step: "classify",
        input: { email_subject, email_body, attachment_text: attachment_text || null },
      })
      .select("id")
      .single();

    if (logError) throw new Error(`Failed to create processing log: ${logError.message}`);
    logId = logData.id;

    // --- Step 1: Classify ---
    const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

    const userContent = `Email Subject: ${email_subject}\n\nEmail Body:\n${email_body}\n\n${
      attachment_text ? `Attachment Content:\n${attachment_text}` : "No attachment content available."
    }`;

    const classification = await withRetry(async () => {
      const response = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [
          { role: "system", content: CLASSIFY_PROMPT },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      });
      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("No response from OpenAI (classify)");
      return JSON.parse(content);
    });

    // Update log with classification result
    await supabase
      .from("processing_logs")
      .update({ output: { classification }, step: "classify_done" })
      .eq("id", logId);

    // If not an invoice, stop here
    if (!classification.is_invoice) {
      await supabase
        .from("processing_logs")
        .update({
          status: "success",
          step: "not_invoice",
          output: { classification, result: "skipped" },
          duration_ms: Date.now() - startTime,
        })
        .eq("id", logId);

      return new Response(
        JSON.stringify({
          status: "skipped",
          reason: "Not classified as an invoice",
          classification,
          log_id: logId,
        }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Step 2: Extract ---
    await supabase
      .from("processing_logs")
      .update({ step: "extract" })
      .eq("id", logId);

    const documentText = attachment_text || email_body;
    const extraction = await withRetry(async () => {
      const response = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [
          { role: "system", content: EXTRACT_PROMPT },
          { role: "user", content: documentText },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      });
      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("No response from OpenAI (extract)");
      return JSON.parse(content);
    });

    await supabase
      .from("processing_logs")
      .update({ output: { classification, extraction }, step: "extract_done" })
      .eq("id", logId);

    // --- Step 3: Validate ---
    await supabase
      .from("processing_logs")
      .update({ step: "validate" })
      .eq("id", logId);

    // Fetch existing invoice numbers for THIS customer only (tenant isolation)
    const { data: existingInvoices } = await supabase
      .from("invoices")
      .select("invoice_number")
      .eq("customer_id", customerId);

    const existingNumbers = (existingInvoices || []).map(
      (i: { invoice_number: string }) => i.invoice_number,
    );

    const validationResult = validateInvoice(extraction, existingNumbers);

    await supabase
      .from("processing_logs")
      .update({
        output: { classification, extraction, validation: validationResult },
        step: "validate_done",
      })
      .eq("id", logId);

    // --- Step 4: Save to database ---
    await supabase
      .from("processing_logs")
      .update({ step: "save" })
      .eq("id", logId);

    // Upsert vendor (normalized_name for deduplication)
    const vendorName = extraction.vendor_name || classification.vendor_name || "Unknown Vendor";
    const normalizedName = vendorName.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-");
    let vendorId: string | null = null;

    // Try upsert first
    const { data: vendorData, error: vendorError } = await supabase
      .from("vendors")
      .upsert(
        {
          customer_id: customerId,
          name: vendorName,
          normalized_name: normalizedName,
        },
        { onConflict: "customer_id,normalized_name" },
      )
      .select("id")
      .single();

    if (vendorError) {
      console.error("Vendor upsert failed, trying lookup:", vendorError.message);
      // Fallback: try to find existing vendor by normalized name
      const { data: existingVendor } = await supabase
        .from("vendors")
        .select("id")
        .eq("customer_id", customerId)
        .eq("normalized_name", normalizedName)
        .single();
      vendorId = existingVendor?.id || null;
    } else {
      vendorId = vendorData?.id || null;
    }

    // Insert invoice record — matches actual invoices table schema
    const { data: invoiceData, error: invoiceError } = await supabase
      .from("invoices")
      .insert({
        customer_id: customerId,
        vendor_id: vendorId,
        invoice_number: extraction.invoice_number,
        invoice_date: extraction.invoice_date,
        due_date: extraction.due_date,
        currency: extraction.currency,
        subtotal: extraction.subtotal,
        tax: extraction.tax,
        total: extraction.total,
        line_items: extraction.line_items,
        raw_text: documentText,
        confidence: classification.confidence,
        signals: classification.signals,
        is_valid: validationResult.is_valid,
        validation_errors: validationResult.errors,
        validation_warnings: validationResult.warnings,
        status: validationResult.is_valid ? "pending" : "flagged",
        source_email_subject: email_subject,
        source_email_from: metadata?.from || null,
      })
      .select("id")
      .single();

    if (invoiceError) throw new Error(`Failed to save invoice: ${invoiceError.message}`);

    await supabase
      .from("processing_logs")
      .update({ invoice_id: invoiceData.id, step: "save_done" })
      .eq("id", logId);

    // --- Step 5: Send Slack notification ---
    const slackWebhookUrl = Deno.env.get("SLACK_WEBHOOK_URL");
    if (slackWebhookUrl) {
      await supabase
        .from("processing_logs")
        .update({ step: "notify" })
        .eq("id", logId);

      const slackPayload = buildSlackBlocks({
        vendor: extraction.vendor_name,
        amount: extraction.total,
        currency: extraction.currency,
        due_date: extraction.due_date || "Not specified",
        invoice_number: extraction.invoice_number,
        confidence: classification.confidence,
        is_valid: validationResult.is_valid,
        errors: validationResult.errors,
        warnings: validationResult.warnings,
      });

      try {
        await withRetry(async () => {
          const slackResp = await fetch(slackWebhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(slackPayload),
          });
          if (!slackResp.ok) throw new Error(`Slack webhook returned ${slackResp.status}`);
        }, { maxRetries: 2 });
      } catch (slackError) {
        // Slack notification failure should not fail the whole pipeline
        console.error("Slack notification failed (non-fatal):", slackError);
      }
    }

    // --- Done ---
    await supabase
      .from("processing_logs")
      .update({
        status: "success",
        step: "done",
        duration_ms: Date.now() - startTime,
        output: { classification, extraction, validation: validationResult, invoice_id: invoiceData.id },
      })
      .eq("id", logId);

    return new Response(
      JSON.stringify({
        status: "completed",
        invoice_id: invoiceData.id,
        log_id: logId,
        classification,
        extraction,
        validation: validationResult,
      }),
      { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (error) {
    // Record failure in processing log so nothing is silently lost
    if (supabase && logId) {
      try {
        await supabase
          .from("processing_logs")
          .update({
            status: "error",
            error_message: error instanceof Error ? error.message : String(error),
            duration_ms: Date.now() - startTime,
          })
          .eq("id", logId);
      } catch {
        console.error("Failed to update processing log with error");
      }
    }

    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    console.error("process-invoice error:", error);
    return new Response(
      JSON.stringify({
        error: "Processing failed",
        log_id: logId,
      }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});

// --- Inline helpers ---

function validateInvoice(
  invoice: Record<string, unknown>,
  existingNumbers: string[],
): { is_valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!invoice.vendor_name || (invoice.vendor_name as string).trim() === "") {
    errors.push("vendor_name is required");
  }
  if (!invoice.currency || (invoice.currency as string).trim() === "") {
    errors.push("currency is required");
  } else if ((invoice.currency as string).length !== 3) {
    errors.push("currency must be a valid ISO 4217 code (3 characters)");
  }
  if ((invoice.total as number) <= 0) {
    errors.push("total must be greater than 0");
  }
  if (existingNumbers.includes(invoice.invoice_number as string)) {
    errors.push(`invoice_number "${invoice.invoice_number}" already exists (duplicate)`);
  }

  const taxAmount = (invoice.tax as number) ?? 0;
  const expectedTotal = (invoice.subtotal as number) + taxAmount;
  const difference = Math.abs(expectedTotal - (invoice.total as number));
  if (difference > MATH_TOLERANCE) {
    errors.push(
      `Math validation failed: subtotal (${invoice.subtotal}) + tax (${taxAmount}) = ${expectedTotal}, but total is ${invoice.total}`,
    );
  }

  if (!invoice.invoice_number || (invoice.invoice_number as string).trim() === "") {
    warnings.push("invoice_number is empty");
  }
  if (!invoice.due_date) {
    warnings.push("due_date is not specified");
  }
  const lineItems = (invoice.line_items as Array<{ total: number }>) || [];
  if (lineItems.length === 0) {
    warnings.push("No line items present");
  } else {
    const lineItemsTotal = lineItems.reduce((sum, item) => sum + item.total, 0);
    const lineItemsDiff = Math.abs(lineItemsTotal - (invoice.subtotal as number));
    if (lineItemsDiff > MATH_TOLERANCE) {
      warnings.push(
        `Line items total (${lineItemsTotal.toFixed(2)}) does not match subtotal (${invoice.subtotal})`,
      );
    }
  }

  return { is_valid: errors.length === 0, errors, warnings };
}

function buildSlackBlocks(data: {
  vendor: string;
  amount: number;
  currency: string;
  due_date: string;
  invoice_number: string;
  confidence: number;
  is_valid: boolean;
  errors: string[];
  warnings: string[];
}): { blocks: unknown[] } {
  const formattedAmount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: data.currency,
  }).format(data.amount);

  const pct = Math.round(data.confidence * 100);
  const emoji = data.confidence >= 0.9 ? ":white_check_mark:" : data.confidence >= 0.7 ? ":large_yellow_circle:" : ":warning:";
  const label = data.confidence >= 0.9 ? "High" : data.confidence >= 0.7 ? "Medium" : "Low";
  const statusEmoji = data.is_valid ? ":white_check_mark:" : ":x:";
  const statusLabel = data.is_valid ? "Valid — Pending Approval" : "Flagged — Needs Review";

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: ":page_facing_up: New Invoice Received", emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Vendor:*\n${data.vendor}` },
        { type: "mrkdwn", text: `*Invoice #:*\n${data.invoice_number}` },
        { type: "mrkdwn", text: `*Amount:*\n${formattedAmount}` },
        { type: "mrkdwn", text: `*Due Date:*\n${data.due_date}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `${emoji} *Confidence:* ${label} (${pct}%)\n${statusEmoji} *Status:* ${statusLabel}` },
    },
  ];

  if (data.errors.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Validation Errors:*\n${data.errors.map((e) => `• ${e}`).join("\n")}` },
    });
  }

  if (data.warnings.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Warnings:*\n${data.warnings.map((w) => `• ${w}`).join("\n")}` },
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
          value: data.invoice_number,
        },
        {
          type: "button",
          text: { type: "plain_text", text: ":triangular_flag_on_post: Flag for Review", emoji: true },
          style: "danger",
          action_id: "flag_invoice",
          value: data.invoice_number,
        },
      ],
    },
  );

  return { blocks };
}
