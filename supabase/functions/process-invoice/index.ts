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
 *
 * PDF support:
 *   - Accepts PDF via pdf_storage_path (Supabase Storage path, preferred for large files)
 *   - Also accepts base64-encoded PDF via attachment_base64 (fallback)
 *   - If pdf_storage_path is provided, downloads from storage, converts to base64,
 *     then deletes the temp file after download
 *   - PRIMARY: sends PDF base64 to GPT-4o vision API for visual extraction
 *     (handles all PDF types reliably — scanned, complex layouts, etc.)
 *   - FALLBACK: text-based DecompressionStream extraction for when
 *     vision is unavailable or attachment_base64 is missing
 *   - Also accepts pre-extracted text via attachment_text
 *   - Falls back to email_body if all extraction methods fail
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyApiKey, AuthError } from "../_shared/auth.ts";
import { withRetry } from "../_shared/retry.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4.52.0";

/**
 * Inflate a raw deflate/zlib compressed buffer using
 * the web-standard DecompressionStream API (native Deno).
 */
async function inflateBytes(
  data: Uint8Array,
): Promise<Uint8Array | null> {
  // Try 'deflate' (zlib-wrapped, RFC 1950) first —
  // this is what most PDF FlateDecode uses
  for (const fmt of ["deflate", "raw"] as const) {
    try {
      const ds = new DecompressionStream(fmt as string);
      const writer = ds.writable.getWriter();
      writer.write(data);
      writer.close();
      const reader = ds.readable.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const total = chunks.reduce(
        (s, c) => s + c.length, 0,
      );
      const result = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        result.set(c, off);
        off += c.length;
      }
      return result;
    } catch {
      continue; // try next format
    }
  }
  return null;
}

/**
 * Extract readable text from a PDF binary buffer.
 * Uses DecompressionStream to inflate FlateDecode streams,
 * then extracts text from PDF Tj/TJ text operators.
 */
async function extractTextFromPdf(
  pdfBytes: Uint8Array,
): Promise<string> {
  const decoder = new TextDecoder("latin1");
  const raw = decoder.decode(pdfBytes);
  const allText: string[] = [];

  // Find all stream/endstream blocks
  const streamRe =
    /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let sm;

  while ((sm = streamRe.exec(raw)) !== null) {
    const streamData = sm[1];
    const streamBytes = new Uint8Array(
      streamData.length,
    );
    for (let i = 0; i < streamData.length; i++) {
      streamBytes[i] = streamData.charCodeAt(i);
    }

    // Try to decompress (most PDF streams use Flate)
    let decoded: string;
    const inflated = await inflateBytes(streamBytes);
    if (inflated && inflated.length > 0) {
      decoded = new TextDecoder("latin1").decode(
        inflated,
      );
    } else {
      decoded = streamData;
    }

    // Extract text from PDF text operators:
    // (text) Tj  — single string show
    const tjRe = /\(([^)]*)\)\s*Tj/g;
    let m;
    while ((m = tjRe.exec(decoded)) !== null) {
      allText.push(m[1]);
    }

    // [(text)(text)] TJ — array show
    const tjArrRe = /\[([^\]]+)\]\s*TJ/gi;
    while ((m = tjArrRe.exec(decoded)) !== null) {
      const inner = m[1];
      const partRe = /\(([^)]*)\)/g;
      let p;
      while ((p = partRe.exec(inner)) !== null) {
        allText.push(p[1]);
      }
    }
  }

  // Clean up PDF escape sequences
  let text = allText.join(" ");
  text = text.replace(/\\n/g, "\n");
  text = text.replace(/\\r/g, "\r");
  text = text.replace(/\\t/g, "\t");
  text = text.replace(/\\\(/g, "(");
  text = text.replace(/\\\)/g, ")");
  text = text.replace(/\\\\/g, "\\");
  text = text.replace(/\s+/g, " ");
  return text.trim();
}

/**
 * Run a promise with a timeout. Returns null on timeout.
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((res) => setTimeout(() => res(null), ms)),
  ]);
}

/**
 * Decode base64 PDF and extract text.
 * Has a 8-second timeout to avoid hanging the function.
 */
async function pdfBase64ToText(
  base64Data: string,
): Promise<string> {
  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  const result = await withTimeout(
    extractTextFromPdf(bytes),
    8000,
  );
  return result || "";
}

/**
 * Convert a Uint8Array to base64 using chunked approach
 * to avoid stack overflow on large files.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

const CLASSIFY_PROMPT = `You are an invoice classification system. Analyze the provided email content and any attached document image to determine if it represents a real vendor invoice.

If a document image is attached, use it as the PRIMARY source for classification — it contains the actual invoice PDF rendered visually.

Respond with a JSON object containing:
- is_invoice: boolean - true if this is a legitimate vendor invoice
- vendor_name: string or null - the vendor/company name if identifiable
- confidence: number between 0 and 1 - your confidence in the classification
- signals: array of strings - detected indicators`;

const EXTRACT_PROMPT = `You are an invoice data extraction system. Extract structured data from the provided invoice document.

If a document image is attached, use it as the PRIMARY source for extraction — it contains the actual invoice PDF rendered visually. Read all values directly from the document image. The email text is secondary context only.

Respond with a JSON object containing exactly these fields:
- vendor_name: string
- invoice_number: string
- invoice_date: string (YYYY-MM-DD)
- due_date: string or null (YYYY-MM-DD)
- currency: string (ISO 4217)
- line_items: array of {description, quantity, unit_price, total}
- subtotal: number (sum of line item totals BEFORE tax)
- tax: number or null (GST/VAT amount, 0 if no tax)
- total: number (final amount = subtotal + tax)

CRITICAL RULES:
- total MUST equal subtotal + tax. Verify this before responding.
- If the invoice shows a "total" or "amount due", use that as the total and work backwards to find subtotal and tax.
- If tax is included in prices, set tax to the tax amount and subtotal to (total - tax).
- All dates YYYY-MM-DD. All monetary values as numbers (no currency symbols).
- Missing optional fields must be null.`;

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
    const { email_subject, email_body, attachment_text, attachment_base64: rawAttachmentBase64, pdf_storage_path, metadata } = body;

    // --- Resolve attachment_base64: from storage path or direct ---
    let attachment_base64 = rawAttachmentBase64 || null;

    if (pdf_storage_path && typeof pdf_storage_path === "string" && pdf_storage_path.length > 0) {
      console.log(`Downloading PDF from storage: ${pdf_storage_path}`);
      try {
        const adminSupabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );

        const { data: fileData, error: downloadError } = await adminSupabase.storage
          .from("invoice-pdfs")
          .download(pdf_storage_path);

        if (downloadError) {
          console.error(`Storage download failed: ${downloadError.message}`);
        } else if (fileData) {
          const arrayBuffer = await fileData.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          attachment_base64 = uint8ArrayToBase64(bytes);
          console.log(`PDF downloaded from storage: ${bytes.length} bytes -> ${attachment_base64.length} chars base64`);

          // Clean up temp file from storage
          const { error: deleteError } = await adminSupabase.storage
            .from("invoice-pdfs")
            .remove([pdf_storage_path]);
          if (deleteError) {
            console.warn(`Failed to delete temp storage file ${pdf_storage_path}: ${deleteError.message}`);
          } else {
            console.log(`Temp storage file deleted: ${pdf_storage_path}`);
          }
        }
      } catch (storageErr) {
        console.error("Storage download error (falling back to other methods):", storageErr);
      }
    }

    if (!email_subject || !email_body) {
      return new Response(
        JSON.stringify({ error: "email_subject and email_body are required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Prepare PDF attachment for processing ---
    // PRIMARY: If attachment_base64 is available, send it to GPT-4o vision
    // FALLBACK: Text extraction via DecompressionStream (unreliable for complex PDFs)
    let resolvedAttachmentText = attachment_text || null;

    // Validate and prepare PDF base64 for vision API
    const hasPdfForVision = !!(
      attachment_base64 &&
      typeof attachment_base64 === "string" &&
      attachment_base64.length > 0 &&
      attachment_base64.length <= 14_000_000
    );

    // Truncate base64 for vision API if needed (limit ~5MB to control API costs)
    // 5MB binary = ~6.67MB base64
    const MAX_BASE64_FOR_VISION = 7_000_000;
    const pdfBase64ForVision = hasPdfForVision
      ? (attachment_base64.length <= MAX_BASE64_FOR_VISION
          ? attachment_base64
          : attachment_base64.substring(0, MAX_BASE64_FOR_VISION))
      : null;

    if (hasPdfForVision) {
      console.log(`PDF available for GPT-4o vision: ${attachment_base64.length} chars base64`);
      if (attachment_base64.length > MAX_BASE64_FOR_VISION) {
        console.log(`Truncated to ${MAX_BASE64_FOR_VISION} chars for vision API`);
      }
    }

    // Fallback text extraction (used when vision is not available)
    if (!resolvedAttachmentText && attachment_base64 && !hasPdfForVision) {
      // PDF too large for vision — try text extraction as last resort
      console.warn("attachment_base64 too large for vision API, skipping");
    } else if (!resolvedAttachmentText && attachment_base64 && hasPdfForVision) {
      // Also extract text as supplementary context (non-blocking)
      try {
        console.log("Extracting PDF text as fallback context...");
        const extracted = await pdfBase64ToText(attachment_base64);
        if (extracted && extracted.length > 20) {
          resolvedAttachmentText = extracted;
          console.log(`PDF fallback text extracted: ${extracted.length} chars`);
        } else {
          console.warn("PDF text extraction returned minimal text (vision will be primary)");
        }
      } catch (pdfErr) {
        console.warn("PDF text extraction failed (vision will be primary):", pdfErr);
      }
    } else if (resolvedAttachmentText) {
      console.log(`Using pre-extracted text: ${resolvedAttachmentText.length} chars`);
    }

    // Guard against oversized payloads that could cause excessive API costs
    const MAX_TEXT_LENGTH = 100_000; // ~100KB of text
    const totalLength = (email_subject?.length || 0) + (email_body?.length || 0) + (resolvedAttachmentText?.length || 0);
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
        input: {
          email_subject,
          email_body,
          attachment_text: resolvedAttachmentText || null,
          had_pdf_attachment: !!attachment_base64,
          pdf_source: pdf_storage_path ? "storage" : (rawAttachmentBase64 ? "base64" : "none"),
        },
      })
      .select("id")
      .single();

    if (logError) throw new Error(`Failed to create processing log: ${logError.message}`);
    logId = logData.id;

    // --- Step 1: Classify ---
    const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

    // Build classify messages: use vision when PDF is available
    const classifyTextContent = `Email Subject: ${email_subject}\n\nEmail Body:\n${email_body}\n\n${
      resolvedAttachmentText ? `Attachment Text (fallback):\n${resolvedAttachmentText}` : "No attachment text available."
    }`;

    // deno-lint-ignore no-explicit-any
    let classifyUserMessage: any;
    if (pdfBase64ForVision) {
      console.log("Classify step: using GPT-4o vision with PDF image");
      classifyUserMessage = {
        role: "user",
        content: [
          { type: "text", text: `${classifyTextContent}\n\nThe attached document image is the actual invoice PDF. Use it as primary source.` },
          {
            type: "image_url",
            image_url: {
              url: `data:application/pdf;base64,${pdfBase64ForVision}`,
              detail: "high",
            },
          },
        ],
      };
    } else {
      classifyUserMessage = { role: "user", content: classifyTextContent };
    }

    const classification = await withRetry(async () => {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: CLASSIFY_PROMPT },
          classifyUserMessage,
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

    // Build extraction context: always include subject
    // for maximum context even if PDF extraction failed
    const documentText = resolvedAttachmentText || email_body;
    const extractionTextContent = [
      `Email Subject: ${email_subject}`,
      `\nDocument Content:\n${documentText}`,
    ].join("\n");

    // Build extract messages: use vision when PDF is available (primary path)
    // deno-lint-ignore no-explicit-any
    let extractUserMessage: any;
    if (pdfBase64ForVision) {
      console.log("Extract step: using GPT-4o vision with PDF image (primary)");
      extractUserMessage = {
        role: "user",
        content: [
          {
            type: "text",
            text: `Email Subject: ${email_subject}\n\nExtract invoice data from the attached PDF document image. The image below is the actual invoice — read all values directly from it.\n\n${
              resolvedAttachmentText
                ? `Supplementary text (for reference only, prefer the image):\n${resolvedAttachmentText}`
                : "No supplementary text available."
            }`,
          },
          {
            type: "image_url",
            image_url: {
              url: `data:application/pdf;base64,${pdfBase64ForVision}`,
              detail: "high",
            },
          },
        ],
      };
    } else {
      extractUserMessage = { role: "user", content: extractionTextContent };
    }

    const extraction = await withRetry(async () => {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: EXTRACT_PROMPT },
          extractUserMessage,
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

    // --- Step 2b: Duplicate check ---
    await supabase
      .from("processing_logs")
      .update({ step: "duplicate_check" })
      .eq("id", logId);

    const duplicateResult = await checkDuplicate(supabase, customerId!, extraction);

    if (duplicateResult.is_duplicate && duplicateResult.confidence >= 1.0) {
      // Definite duplicate — skip processing entirely
      await supabase
        .from("processing_logs")
        .update({
          status: "success",
          step: "duplicate_skipped",
          output: { classification, extraction, duplicate: duplicateResult, result: "duplicate" },
          duration_ms: Date.now() - startTime,
        })
        .eq("id", logId);

      return new Response(
        JSON.stringify({
          status: "duplicate",
          reason: duplicateResult.reason,
          confidence: duplicateResult.confidence,
          matches: duplicateResult.matches,
          log_id: logId,
        }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

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

    // If high-confidence fuzzy duplicate, add warning (but don't block)
    if (duplicateResult.is_duplicate && duplicateResult.confidence >= 0.8) {
      validationResult.warnings.push(
        `Potential duplicate detected (${Math.round(duplicateResult.confidence * 100)}% confidence): ${duplicateResult.reason}`,
      );
    }

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

    // --- Step 4b: Upload PDF to Storage ---
    let pdfStoragePath: string | null = null;

    if (attachment_base64 &&
        typeof attachment_base64 === "string" &&
        attachment_base64.length <= 14_000_000) {
      try {
        const binaryStr = atob(attachment_base64);
        const pdfBytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          pdfBytes[i] = binaryStr.charCodeAt(i);
        }

        pdfStoragePath = `${customerId}/${invoiceData.id}.pdf`;

        const { error: uploadError } = await supabase.storage
          .from("invoice-pdfs")
          .upload(pdfStoragePath, pdfBytes.buffer, {
            contentType: "application/pdf",
            cacheControl: "31536000",
            upsert: false,
          });

        if (uploadError) {
          console.error("PDF upload failed:", uploadError.message);
          pdfStoragePath = null;
        } else {
          await supabase
            .from("invoices")
            .update({ pdf_storage_path: pdfStoragePath })
            .eq("id", invoiceData.id);
          console.log(`PDF uploaded: ${pdfStoragePath}`);
        }
      } catch (pdfUploadErr) {
        console.error("PDF upload error (non-fatal):", pdfUploadErr);
        pdfStoragePath = null;
      }
    }

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
        output: { classification, extraction, validation: validationResult, invoice_id: invoiceData.id, pdf_storage_path: pdfStoragePath },
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
    const lineItemsDiffSubtotal = Math.abs(lineItemsTotal - (invoice.subtotal as number));
    const lineItemsDiffTotal = Math.abs(lineItemsTotal - (invoice.total as number));
    if (lineItemsDiffSubtotal > MATH_TOLERANCE && lineItemsDiffTotal > MATH_TOLERANCE) {
      warnings.push(
        `Line items total (${lineItemsTotal.toFixed(2)}) does not match subtotal (${invoice.subtotal}) or total (${invoice.total})`,
      );
    }
  }

  return { is_valid: errors.length === 0, errors, warnings };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function checkDuplicate(
  supabase: ReturnType<typeof import("https://esm.sh/@supabase/supabase-js@2").createClient>,
  customerId: string,
  extraction: Record<string, unknown>,
): Promise<{ is_duplicate: boolean; confidence: number; matches: Array<{ id: string; confidence: number; reason: string }>; reason: string }> {
  const matches: Array<{ id: string; confidence: number; reason: string }> = [];
  const invoiceNumber = extraction.invoice_number as string | undefined;
  const total = extraction.total as number;
  const invoiceDate = extraction.invoice_date as string | undefined;
  const vendorName = extraction.vendor_name as string | undefined;

  // Resolve vendor_id
  let vendorId: string | null = null;
  if (vendorName) {
    const normalizedName = vendorName.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-");
    const { data: vendorData } = await supabase
      .from("vendors")
      .select("id")
      .eq("customer_id", customerId)
      .eq("normalized_name", normalizedName)
      .single();
    vendorId = vendorData?.id || null;
  }

  // Check 1: Exact invoice_number match
  if (invoiceNumber && invoiceNumber.trim() !== "") {
    let query = supabase
      .from("invoices")
      .select("id, invoice_number, total, invoice_date, vendor_id")
      .eq("customer_id", customerId)
      .eq("invoice_number", invoiceNumber);
    if (vendorId) query = query.eq("vendor_id", vendorId);

    const { data: exactMatches } = await query;
    if (exactMatches && exactMatches.length > 0) {
      for (const inv of exactMatches) {
        matches.push({
          id: inv.id,
          confidence: 1.0,
          reason: vendorId ? "Exact invoice number match from same vendor" : "Exact invoice number match",
        });
      }
    }
  }

  // Fuzzy checks require vendor_id and invoice_date
  if (vendorId && invoiceDate) {
    const invoiceDateMs = new Date(invoiceDate).getTime();
    const windowStart = new Date(invoiceDateMs - 30 * MS_PER_DAY).toISOString().split("T")[0];
    const windowEnd = new Date(invoiceDateMs + 30 * MS_PER_DAY).toISOString().split("T")[0];

    const { data: candidates } = await supabase
      .from("invoices")
      .select("id, invoice_number, total, invoice_date, vendor_id")
      .eq("customer_id", customerId)
      .eq("vendor_id", vendorId)
      .gte("invoice_date", windowStart)
      .lte("invoice_date", windowEnd);

    if (candidates) {
      for (const inv of candidates) {
        if (matches.some((m) => m.id === inv.id)) continue;
        const candidateDateMs = new Date(inv.invoice_date).getTime();
        const daysDiff = Math.abs(invoiceDateMs - candidateDateMs) / MS_PER_DAY;
        const amountDiffPct = inv.total > 0 ? Math.abs(inv.total - total) / inv.total : (total === 0 ? 0 : 1);

        if (inv.total === total && daysDiff === 0) {
          matches.push({ id: inv.id, confidence: 0.95, reason: "Same vendor, same total, and same invoice date" });
        } else if (inv.total === total && daysDiff <= 7) {
          matches.push({ id: inv.id, confidence: 0.80, reason: `Same vendor and total, dates ${daysDiff.toFixed(0)} days apart` });
        } else if (amountDiffPct <= 0.01 && daysDiff <= 30) {
          matches.push({ id: inv.id, confidence: 0.60, reason: `Same vendor, total within 1%, dates ${daysDiff.toFixed(0)} days apart` });
        }
      }
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  const highestConfidence = matches.length > 0 ? matches[0].confidence : 0;

  return {
    is_duplicate: highestConfidence >= 0.6,
    confidence: highestConfidence,
    matches,
    reason: matches.length === 0
      ? "No duplicate matches found"
      : matches.length === 1
        ? matches[0].reason
        : `${matches.length} potential matches found. Strongest: ${matches[0].reason}`,
  };
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
