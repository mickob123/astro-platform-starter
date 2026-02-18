/**
 * Shared invoice processing pipeline handler.
 *
 * Exported as a function so it can be:
 * 1. Wrapped with Deno.serve() in process-invoice/index.ts (HTTP endpoint)
 * 2. Called directly from poll-emails/index.ts (no HTTP roundtrip)
 *
 * The handler accepts a standard Request and returns a standard Response.
 */

import { getCorsHeaders, handleCors } from "./cors.ts";
import { verifyApiKey, AuthError } from "./auth.ts";
import { withRetry } from "./retry.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4.52.0";

// ---------------------------------------------------------------------------
// PDF helpers
// ---------------------------------------------------------------------------

async function inflateBytes(data: Uint8Array): Promise<Uint8Array | null> {
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
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const result = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        result.set(c, off);
        off += c.length;
      }
      return result;
    } catch {
      continue;
    }
  }
  return null;
}

async function extractTextFromPdf(pdfBytes: Uint8Array): Promise<string> {
  const decoder = new TextDecoder("latin1");
  const raw = decoder.decode(pdfBytes);
  const allText: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let sm;
  while ((sm = streamRe.exec(raw)) !== null) {
    const streamData = sm[1];
    const streamBytes = new Uint8Array(streamData.length);
    for (let i = 0; i < streamData.length; i++) {
      streamBytes[i] = streamData.charCodeAt(i);
    }
    let decoded: string;
    const inflated = await inflateBytes(streamBytes);
    if (inflated && inflated.length > 0) {
      decoded = new TextDecoder("latin1").decode(inflated);
    } else {
      decoded = streamData;
    }
    const tjRe = /\(([^)]*)\)\s*Tj/g;
    let m;
    while ((m = tjRe.exec(decoded)) !== null) {
      allText.push(m[1]);
    }
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
  let text = allText.join(" ");
  text = text.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  text = text.replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
  text = text.replace(/\s+/g, " ");
  return text.trim();
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), ms))]);
}

async function pdfBase64ToText(base64Data: string): Promise<string> {
  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  const result = await withTimeout(extractTextFromPdf(bytes), 8000);
  return result || "";
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Use Deno's standard base64 encoding for efficiency
  // Build base64 from the standard alphabet without O(n²) string concat
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const len = bytes.length;
  const parts: string[] = [];
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    parts.push(
      CHARS[b0 >> 2] +
      CHARS[((b0 & 3) << 4) | (b1 >> 4)] +
      (i + 1 < len ? CHARS[((b1 & 15) << 2) | (b2 >> 6)] : "=") +
      (i + 2 < len ? CHARS[b2 & 63] : "=")
    );
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Vendor name normalization
// ---------------------------------------------------------------------------

/** Common business suffixes to strip for vendor matching */
const BUSINESS_SUFFIXES = /\b(pty\.?\s*ltd\.?|ltd\.?|limited|inc\.?|incorporated|llc\.?|l\.l\.c\.?|corp\.?|corporation|plc\.?|co\.?\b(?!\S))\b/gi;

function normalizeVendorName(name: string): string {
  return name
    .replace(BUSINESS_SUFFIXES, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const CLASSIFY_PROMPT = `You are a financial document classification system. Analyze the provided email content and any attached document image to determine what type of financial document this is.

If a document image is attached, use it as the PRIMARY source for classification — it contains the actual document rendered visually.

IMPORTANT: When a PDF attachment is present but cannot be read (text-only mode), classify based on available signals. If the email subject or body explicitly mentions "invoice", "tax invoice", or "bill" AND a PDF is attached, classify appropriately with moderate confidence (0.6-0.8). Do NOT reject an email just because attachment text is unavailable — the attachment itself is evidence.

Document types:
- "invoice" = A vendor bill or tax invoice for goods/services you owe money for (accounts payable). Has an amount due, payment terms, due date.
- "expense" = A receipt, payment confirmation, subscription charge, credit card statement, proof of payment for something already paid, automatic payment reminder, direct debit notification, or dunning notice. Shows amount paid/due, transaction date, or payment schedule. Payment reminders and automated billing notifications ARE expenses — they indicate recurring charges being auto-debited.
- "other" = Not a financial document (marketing emails, newsletters, calendar invitations, general correspondence, spam). Must contain NO financial amounts or payment references.

Respond with a JSON object containing:
- is_invoice: boolean - true if this is an invoice OR expense (any financial document worth processing)
- document_type: string - one of "invoice", "expense", or "other"
- vendor_name: string or null - the vendor/company name if identifiable
- confidence: number between 0 and 1 - your confidence in the classification
- signals: array of strings - detected indicators`;

const EXTRACT_PROMPT = `You are a financial document data extraction system. Extract structured data from the provided document (invoice, receipt, or expense).

If a document image is attached, use it as the PRIMARY source for extraction — it contains the actual document rendered visually. Read all values directly from the document image. The email text is secondary context only.

This document may be an invoice (amount owed) or an expense/receipt (amount already paid). Extract the same fields regardless — use invoice_date for the transaction/payment date, and due_date for the payment due date (null for receipts/expenses that are already paid).

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
- vendor_email: string or null (vendor's email address if shown on invoice)
- vendor_phone: string or null (vendor's phone number if shown)
- vendor_address_line1: string or null (street address line 1)
- vendor_address_line2: string or null (suite, unit, building — null if not present)
- vendor_city: string or null
- vendor_state: string or null (state, province, or territory)
- vendor_postal_code: string or null
- vendor_country: string or null (full country name or ISO code)
- vendor_website: string or null (vendor's website URL if shown)
- vendor_tax_id: string or null (ABN, EIN, VAT, GST number — include label prefix e.g. "ABN: 12 345 678 901")

CRITICAL RULES:
- total MUST equal subtotal + tax. Verify this before responding.
- If the invoice shows a "total" or "amount due", use that as the total and work backwards to find subtotal and tax.
- If tax is included in prices, set tax to the tax amount and subtotal to (total - tax).
- All dates YYYY-MM-DD. All monetary values as numbers (no currency symbols).
- Missing optional fields must be null.
- Extract vendor contact details from the invoice header/footer area. These are OPTIONAL — set to null if not visible on the document.
- For vendor_tax_id, include the tax ID type prefix (e.g., "ABN: 12 345 678 901", "GST: 123456789").`;

const VERIFY_PROMPT = `You are a senior audit manager performing a final verification of extracted invoice data against the original document text.

You will receive:
1. The extracted invoice data as JSON
2. The original document text for cross-referencing

Your job is to:
1. Verify all required fields are captured (leave blank if not found in document)
2. Check mathematical accuracy: line items should sum to subtotal, subtotal + tax should equal total
3. Verify date formats are consistent (YYYY-MM-DD)
4. Verify currency code is valid ISO 4217
5. Verify vendor information is complete where visible in the document
6. Check for obvious OCR errors or inconsistencies between extracted data and source text

If you find errors or missing data, extract the correct information from the document text.
If extraction is perfect, confirm with status "VERIFIED".

Respond with a JSON object containing:
- status: "VERIFIED" if no corrections needed, "CORRECTED" if you made changes
- corrections: array of strings describing each correction made (empty array if VERIFIED)
- data: the complete invoice data object (corrected if needed, unchanged if verified)

The "data" object must contain ALL fields: vendor_name, invoice_number, invoice_date, due_date, currency, line_items, subtotal, tax, total, vendor_email, vendor_phone, vendor_address_line1, vendor_address_line2, vendor_city, vendor_state, vendor_postal_code, vendor_country, vendor_website, vendor_tax_id.

IMPORTANT: Only correct clear errors. Do not change values that are merely unusual but potentially valid. Mathematical corrections take precedence — if subtotal + tax != total, recalculate to make them consistent.`;

const MATH_TOLERANCE = 0.01;

// ---------------------------------------------------------------------------
// Validation & duplicate check
// ---------------------------------------------------------------------------

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
  // deno-lint-ignore no-explicit-any
  supabase: any,
  customerId: string,
  extraction: Record<string, unknown>,
): Promise<{ is_duplicate: boolean; confidence: number; matches: Array<{ id: string; confidence: number; reason: string }>; reason: string }> {
  const matches: Array<{ id: string; confidence: number; reason: string }> = [];
  const invoiceNumber = extraction.invoice_number as string | undefined;
  const total = extraction.total as number;
  const invoiceDate = extraction.invoice_date as string | undefined;
  const vendorName = extraction.vendor_name as string | undefined;

  let vendorId: string | null = null;
  if (vendorName) {
    const normalizedName = normalizeVendorName(vendorName);
    const { data: vendorData } = await supabase
      .from("vendors")
      .select("id")
      .eq("customer_id", customerId)
      .eq("normalized_name", normalizedName)
      .single();
    vendorId = vendorData?.id || null;
  }

  if (invoiceNumber && invoiceNumber.trim() !== "") {
    let query = supabase
      .from("invoices")
      .select("id, invoice_number, total, invoice_date, vendor_id")
      .eq("customer_id", customerId)
      .eq("invoice_number", invoiceNumber)
      .neq("status", "deleted");
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

  if (vendorId && invoiceDate) {
    const invoiceDateMs = new Date(invoiceDate).getTime();
    const windowStart = new Date(invoiceDateMs - 30 * MS_PER_DAY).toISOString().split("T")[0];
    const windowEnd = new Date(invoiceDateMs + 30 * MS_PER_DAY).toISOString().split("T")[0];
    const { data: candidates } = await supabase
      .from("invoices")
      .select("id, invoice_number, total, invoice_date, vendor_id")
      .eq("customer_id", customerId)
      .eq("vendor_id", vendorId)
      .neq("status", "deleted")
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

// ---------------------------------------------------------------------------
// Slack notification
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main handler (exported)
// ---------------------------------------------------------------------------

export async function handleProcessInvoice(req: Request): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  let logId: string | null = null;
  // deno-lint-ignore no-explicit-any
  let supabase: any = null;
  let customerId: string | null = null;
  const startTime = Date.now();

  try {
    // --- Auth ---
    // Support two auth modes:
    // 1. API key (x-api-key header) — for external callers (n8n, webhooks)
    // 2. Internal service call — x-api-key matches SUPABASE_SERVICE_ROLE_KEY
    //    with customer_id in the request body (for poll-emails function)
    const apiKeyHeader = req.headers.get("x-api-key");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (apiKeyHeader && serviceRoleKey && apiKeyHeader === serviceRoleKey) {
      supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        serviceRoleKey,
      );
    } else {
      const auth = await verifyApiKey(req);
      supabase = auth.supabase;
      customerId = auth.customer_id;
    }

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { email_subject, email_body, attachment_text, attachment_base64: rawAttachmentBase64, pdf_storage_path, skip_vision } = body;
    // metadata can arrive as object or as JSON string (metadata_json) from n8n keypair body
    let metadata = body.metadata;
    if (!metadata && body.metadata_json) {
      try { metadata = JSON.parse(body.metadata_json); } catch { metadata = {}; }
    }

    // Allow body.customer_id to set or override customer_id.
    // n8n is a trusted caller that routes emails from multiple customers,
    // so body.customer_id takes precedence when provided.
    if (body.customer_id) {
      customerId = body.customer_id;
    }
    if (!customerId) {
      return new Response(
        JSON.stringify({ error: "customer_id is required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Resolve attachment_base64: from storage path or direct ---
    let attachment_base64 = rawAttachmentBase64 || null;

    // Download PDF from storage when available (for both vision and text extraction)
    if (pdf_storage_path && typeof pdf_storage_path === "string" && pdf_storage_path.length > 0) {
      console.log(`Downloading PDF from storage: ${pdf_storage_path} (skip_vision=${skip_vision})`);
      const MAX_PDF_BYTES = 10_000_000; // 10MB max PDF size
      const DOWNLOAD_TIMEOUT_MS = 30_000; // 30s timeout for download

      try {
        const adminSupabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );

        // Download with timeout to prevent gateway 502
        const downloadPromise = adminSupabase.storage
          .from("invoice-pdfs")
          .download(pdf_storage_path);

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("PDF download timed out")), DOWNLOAD_TIMEOUT_MS)
        );

        const { data: fileData, error: downloadError } = await Promise.race([
          downloadPromise,
          timeoutPromise,
        ]) as Awaited<typeof downloadPromise>;

        if (downloadError) {
          console.error(`Storage download failed: ${downloadError.message}`);
        } else if (fileData) {
          const arrayBuffer = await fileData.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);

          if (bytes.length > MAX_PDF_BYTES) {
            console.warn(`PDF too large (${bytes.length} bytes > ${MAX_PDF_BYTES}), skipping`);
          } else {
            attachment_base64 = uint8ArrayToBase64(bytes);
            console.log(`PDF downloaded from storage: ${bytes.length} bytes -> ${attachment_base64.length} chars base64`);
          }
        }
      } catch (storageErr) {
        const errMsg = storageErr instanceof Error ? storageErr.message : String(storageErr);
        console.error(`Storage download error (falling back to text-only): ${errMsg}`);
      }
    }

    if (!email_subject || !email_body) {
      return new Response(
        JSON.stringify({ error: "email_subject and email_body are required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Prepare PDF attachment for processing ---
    let resolvedAttachmentText = attachment_text || null;

    const hasPdfForVision = !skip_vision && !!(
      attachment_base64 &&
      typeof attachment_base64 === "string" &&
      attachment_base64.length > 0 &&
      attachment_base64.length <= 14_000_000
    );

    const MAX_BASE64_FOR_VISION = 7_000_000;
    const pdfBase64ForVision = hasPdfForVision
      ? (attachment_base64!.length <= MAX_BASE64_FOR_VISION
          ? attachment_base64
          : attachment_base64!.substring(0, MAX_BASE64_FOR_VISION))
      : null;

    if (hasPdfForVision) {
      console.log(`PDF available for GPT-4o vision: ${attachment_base64!.length} chars base64`);
      if (attachment_base64!.length > MAX_BASE64_FOR_VISION) {
        console.log(`Truncated to ${MAX_BASE64_FOR_VISION} chars for vision API`);
      }
    }

    // Extract text from PDF when available (regardless of skip_vision)
    if (!resolvedAttachmentText && attachment_base64) {
      try {
        console.log(`Extracting PDF text (skip_vision=${skip_vision})...`);
        const extracted = await pdfBase64ToText(attachment_base64);
        if (extracted && extracted.length > 20) {
          resolvedAttachmentText = extracted;
          console.log(`PDF text extracted: ${extracted.length} chars`);
        } else {
          console.warn("PDF text extraction returned minimal text");
        }
      } catch (pdfErr) {
        console.warn("PDF text extraction failed:", pdfErr);
      }
    } else if (resolvedAttachmentText) {
      console.log(`Using pre-extracted text: ${resolvedAttachmentText.length} chars`);
    }

    const MAX_TEXT_LENGTH = 100_000;
    const totalLength = (email_subject?.length || 0) + (email_body?.length || 0) + (resolvedAttachmentText?.length || 0);
    if (totalLength > MAX_TEXT_LENGTH) {
      return new Response(
        JSON.stringify({ error: `Request body text exceeds maximum allowed length of ${MAX_TEXT_LENGTH} characters` }),
        { status: 413, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Create processing log ---
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

    const hasPdfAttachment = !!(pdf_storage_path || rawAttachmentBase64 || body.pdf_filename);
    const classifyTextContent = `Email Subject: ${email_subject}\n\nEmail Body:\n${email_body}\n\n${
      resolvedAttachmentText
        ? `Attachment Text (fallback):\n${resolvedAttachmentText}`
        : hasPdfAttachment
          ? "A PDF attachment is present but its text content is not available for analysis. Classify based on email subject, body, and the presence of the PDF attachment."
          : "No attachment text available."
    }`;

    // deno-lint-ignore no-explicit-any
    let classifyUserMessage: any;
    if (pdfBase64ForVision) {
      console.log("Classify step: using GPT-4o with PDF file attachment");
      classifyUserMessage = {
        role: "user",
        content: [
          { type: "text", text: `${classifyTextContent}\n\nThe attached PDF is the actual invoice document. Use it as primary source.` },
          {
            type: "file",
            file: {
              filename: "invoice.pdf",
              file_data: `data:application/pdf;base64,${pdfBase64ForVision}`,
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

    await supabase
      .from("processing_logs")
      .update({ output: { classification }, step: "classify_done" })
      .eq("id", logId);

    // Determine document type (backward compat: default to invoice if field missing)
    const documentType: string = classification.document_type === "expense"
      ? "expense"
      : classification.document_type === "invoice"
        ? "invoice"
        : classification.is_invoice ? "invoice" : "other";

    if (documentType === "other") {
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
          reason: "Not classified as an invoice or expense",
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

    const documentText = resolvedAttachmentText || email_body;
    const extractionTextContent = [
      `Email Subject: ${email_subject}`,
      `\nDocument Content:\n${documentText}`,
    ].join("\n");

    // deno-lint-ignore no-explicit-any
    let extractUserMessage: any;
    if (pdfBase64ForVision) {
      console.log("Extract step: using GPT-4o with PDF file attachment (primary)");
      extractUserMessage = {
        role: "user",
        content: [
          {
            type: "text",
            text: `Email Subject: ${email_subject}\n\nExtract invoice data from the attached PDF document. The PDF is the actual invoice — read all values directly from it.\n\n${
              resolvedAttachmentText
                ? `Supplementary text (for reference only, prefer the PDF):\n${resolvedAttachmentText}`
                : "No supplementary text available."
            }`,
          },
          {
            type: "file",
            file: {
              filename: "invoice.pdf",
              file_data: `data:application/pdf;base64,${pdfBase64ForVision}`,
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

    // --- Step 2a: Verify extraction ---
    await supabase
      .from("processing_logs")
      .update({ step: "verify" })
      .eq("id", logId);

    const verifyInput = [
      `EXTRACTED DATA:\n${JSON.stringify(extraction, null, 2)}`,
      `\nORIGINAL DOCUMENT TEXT:\n${documentText}`,
    ].join("\n");

    const verification = await withRetry(async () => {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: VERIFY_PROMPT },
          { role: "user", content: verifyInput },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 4000,
      });
      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("No response from OpenAI (verify)");
      return JSON.parse(content);
    });

    // Apply corrections if any
    let verifiedExtraction = extraction;
    if (verification.status === "CORRECTED" && verification.data) {
      verifiedExtraction = verification.data;
      console.log(`Verification corrected ${verification.corrections?.length || 0} issues:`,
        verification.corrections);
    }

    await supabase
      .from("processing_logs")
      .update({
        output: {
          classification,
          extraction_raw: extraction,
          verification: { status: verification.status, corrections: verification.corrections || [] },
          extraction: verifiedExtraction,
        },
        step: "verify_done",
      })
      .eq("id", logId);

    // --- Step 2b: Duplicate check ---
    await supabase
      .from("processing_logs")
      .update({ step: "duplicate_check" })
      .eq("id", logId);

    const duplicateResult = await checkDuplicate(supabase, customerId!, verifiedExtraction);

    if (duplicateResult.is_duplicate && duplicateResult.confidence >= 1.0) {
      await supabase
        .from("processing_logs")
        .update({
          status: "success",
          step: "duplicate_skipped",
          output: { classification, extraction: verifiedExtraction, duplicate: duplicateResult, result: "duplicate" },
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

    const { data: existingInvoices } = await supabase
      .from("invoices")
      .select("invoice_number")
      .eq("customer_id", customerId);

    const existingNumbers = (existingInvoices || []).map(
      (i: { invoice_number: string }) => i.invoice_number,
    );

    const validationResult = validateInvoice(verifiedExtraction, existingNumbers);

    if (duplicateResult.is_duplicate && duplicateResult.confidence >= 0.8) {
      validationResult.warnings.push(
        `Potential duplicate detected (${Math.round(duplicateResult.confidence * 100)}% confidence): ${duplicateResult.reason}`,
      );
    }

    await supabase
      .from("processing_logs")
      .update({
        output: { classification, extraction: verifiedExtraction, validation: validationResult },
        step: "validate_done",
      })
      .eq("id", logId);

    // --- Step 4: Save to database ---
    await supabase
      .from("processing_logs")
      .update({ step: "save" })
      .eq("id", logId);

    const vendorName = verifiedExtraction.vendor_name || classification.vendor_name || "Unknown Vendor";
    const normalizedName = normalizeVendorName(vendorName);
    let vendorId: string | null = null;

    // Build vendor upsert payload with contact fields (only non-null values)
    // deno-lint-ignore no-explicit-any
    const vendorUpsertPayload: Record<string, any> = {
      customer_id: customerId,
      name: vendorName,
      normalized_name: normalizedName,
    };
    const contactFieldMap: Record<string, string> = {
      vendor_email: "email",
      vendor_phone: "phone",
      vendor_address_line1: "address_line1",
      vendor_address_line2: "address_line2",
      vendor_city: "city",
      vendor_state: "state",
      vendor_postal_code: "postal_code",
      vendor_country: "country",
      vendor_website: "website",
      vendor_tax_id: "tax_id",
    };
    for (const [extractKey, dbCol] of Object.entries(contactFieldMap)) {
      const val = (verifiedExtraction as Record<string, unknown>)[extractKey];
      if (val !== null && val !== undefined && val !== "") {
        vendorUpsertPayload[dbCol] = val;
      }
    }

    const { data: vendorData, error: vendorError } = await supabase
      .from("vendors")
      .upsert(vendorUpsertPayload, { onConflict: "customer_id,normalized_name" })
      .select("id")
      .single();

    if (vendorError) {
      console.error("Vendor upsert failed, trying lookup:", vendorError.message);
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

    const { data: invoiceData, error: invoiceError } = await supabase
      .from("invoices")
      .insert({
        customer_id: customerId,
        vendor_id: vendorId,
        document_type: documentType,
        invoice_number: verifiedExtraction.invoice_number,
        invoice_date: verifiedExtraction.invoice_date,
        due_date: verifiedExtraction.due_date,
        currency: verifiedExtraction.currency,
        subtotal: verifiedExtraction.subtotal,
        tax: verifiedExtraction.tax,
        total: verifiedExtraction.total,
        line_items: verifiedExtraction.line_items,
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
    } else if (pdf_storage_path && typeof pdf_storage_path === "string" && pdf_storage_path.length > 0) {
      // PDF was already uploaded by poll-emails to temp storage — move to permanent path
      try {
        const permanentPath = `${customerId}/${invoiceData.id}.pdf`;
        const { error: moveError } = await supabase.storage
          .from("invoice-pdfs")
          .move(pdf_storage_path, permanentPath);

        if (moveError) {
          console.error("PDF move failed:", moveError.message);
          // Fall back: keep the temp path as-is
          pdfStoragePath = pdf_storage_path;
        } else {
          pdfStoragePath = permanentPath;
          console.log(`PDF moved: ${pdf_storage_path} -> ${permanentPath}`);
        }

        await supabase
          .from("invoices")
          .update({ pdf_storage_path: pdfStoragePath })
          .eq("id", invoiceData.id);
      } catch (pdfMoveErr) {
        console.error("PDF move error (non-fatal):", pdfMoveErr);
        // Still save the temp path so the PDF is accessible
        pdfStoragePath = pdf_storage_path;
        await supabase
          .from("invoices")
          .update({ pdf_storage_path: pdfStoragePath })
          .eq("id", invoiceData.id);
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
        vendor: verifiedExtraction.vendor_name,
        amount: verifiedExtraction.total,
        currency: verifiedExtraction.currency,
        due_date: verifiedExtraction.due_date || "Not specified",
        invoice_number: verifiedExtraction.invoice_number,
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
        output: { classification, extraction: verifiedExtraction, verification: { status: verification.status, corrections: verification.corrections || [] }, validation: validationResult, invoice_id: invoiceData.id, pdf_storage_path: pdfStoragePath },
      })
      .eq("id", logId);

    return new Response(
      JSON.stringify({
        status: "completed",
        invoice_id: invoiceData.id,
        log_id: logId,
        classification,
        extraction: verifiedExtraction,
        verification: { status: verification.status, corrections: verification.corrections || [] },
        validation: validationResult,
      }),
      { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (error) {
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
}
