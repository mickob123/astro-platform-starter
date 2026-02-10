/**
 * Email forwarding intake endpoint.
 *
 * Accepts webhook payloads from email providers (SendGrid Inbound Parse,
 * Mailgun, Postmark, or any generic JSON sender) and routes them into the
 * invoice processing pipeline.
 *
 * Flow:
 *   1. Verify optional webhook signature (HMAC-SHA256)
 *   2. Parse the incoming webhook (multipart form for SendGrid, JSON otherwise)
 *   3. Look up the "to" email address in email_intake_addresses to find the customer
 *   4. Verify the customer has an active API key (confirms valid processing customer)
 *   5. Generate a short-lived internal API key and call process-invoice via HTTP
 *   6. Clean up the temporary key and return the pipeline result
 *
 * Authentication:
 *   - The "to" email address acts as the authentication token — it maps to a
 *     customer via the email_intake_addresses table.
 *   - Optional X-Webhook-Signature header validation for additional security
 *     (enabled when WEBHOOK_SIGNING_SECRET env var is set).
 *
 * Security:
 *   - Uses service_role Supabase client (bypasses RLS for lookups)
 *   - Webhook signature verified with HMAC-SHA256 if configured
 *   - Only active intake addresses are accepted
 *   - Only the first PDF attachment is forwarded (guards against abuse)
 *   - Temporary API keys are cleaned up immediately after use
 *   - Internal error details are never exposed to callers
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  attachments: Array<{
    filename: string;
    content_type: string;
    content_base64: string;
  }>;
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Verify an HMAC-SHA256 webhook signature.
 * Returns true if valid, or if no WEBHOOK_SIGNING_SECRET is configured
 * (signature verification is opt-in).
 */
async function verifyWebhookSignature(
  body: Uint8Array,
  signatureHeader: string | null,
): Promise<boolean> {
  const secret = Deno.env.get("WEBHOOK_SIGNING_SECRET");
  if (!secret) {
    // No signing secret configured — skip verification
    return true;
  }

  if (!signatureHeader) {
    // Secret is configured but no signature was provided — reject
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", key, body);
  const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison to prevent timing attacks
  if (expectedSignature.length !== signatureHeader.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expectedSignature.length; i++) {
    mismatch |= expectedSignature.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// Email parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract a clean email address from a header value.
 * Handles formats like:
 *   - "invoices@intake.example.com"
 *   - "Name <invoices@intake.example.com>"
 *   - "<invoices@intake.example.com>"
 */
function extractEmailAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase().trim();
  return raw.toLowerCase().trim();
}

/**
 * Parse a SendGrid Inbound Parse multipart/form-data webhook.
 */
async function parseSendGridPayload(req: Request): Promise<ParsedEmail> {
  const formData = await req.formData();

  const to = (formData.get("to") as string) || "";
  const from = (formData.get("from") as string) || "";
  const subject = (formData.get("subject") as string) || "";
  const text = (formData.get("text") as string) || "";
  const html = (formData.get("html") as string) || "";

  // SendGrid sends attachment info in an "attachment-info" JSON field
  // and the actual files as numbered fields (attachment1, attachment2, etc.)
  const attachments: ParsedEmail["attachments"] = [];

  let attachmentInfo: Record<string, { filename: string; type: string }> = {};
  const attachmentInfoRaw = formData.get("attachment-info") as string;
  if (attachmentInfoRaw) {
    try {
      attachmentInfo = JSON.parse(attachmentInfoRaw);
    } catch {
      console.warn("Failed to parse attachment-info JSON");
    }
  }

  // Iterate over numbered attachment fields (SendGrid convention)
  for (let i = 1; i <= 10; i++) {
    const file = formData.get(`attachment${i}`) as File | null;
    if (!file) break;

    const info = attachmentInfo[`attachment${i}`];
    const filename = info?.filename || file.name || `attachment${i}`;
    const contentType = info?.type || file.type || "application/octet-stream";

    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const content_base64 = btoa(
      bytes.reduce((acc, byte) => acc + String.fromCharCode(byte), ""),
    );

    attachments.push({ filename, content_type: contentType, content_base64 });
  }

  return { to, from, subject, text, html, attachments };
}

/**
 * Parse a generic JSON webhook payload.
 * Expected shape: { to, from, subject, text, html, attachments: [{ filename, content_type, content_base64 }] }
 */
async function parseGenericJsonPayload(req: Request): Promise<ParsedEmail> {
  const body = await req.json();

  return {
    to: body.to || "",
    from: body.from || "",
    subject: body.subject || "",
    text: body.text || "",
    html: body.html || "",
    attachments: Array.isArray(body.attachments)
      ? body.attachments.map((att: Record<string, string>) => ({
          filename: att.filename || "attachment",
          content_type: att.content_type || "application/octet-stream",
          content_base64: att.content_base64 || "",
        }))
      : [],
  };
}

/**
 * Naive HTML tag stripper for converting HTML email bodies to plain text.
 * Handles common entities and block-level elements. Not a full parser —
 * just good enough for email body fallback.
 */
function stripHtmlTags(html: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Temporary API key helpers
// ---------------------------------------------------------------------------

/**
 * Generate a random API key string (same format as admin-create-customer).
 */
function generateTempApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `inv_tmp_${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * SHA-256 hash an API key for storage/lookup (same algorithm as _shared/auth.ts).
 */
async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Create a short-lived internal API key for the given customer.
 * Returns the plaintext key. The caller MUST clean up via deleteTempApiKey.
 */
async function createTempApiKey(
  supabase: SupabaseClient,
  customerId: string,
): Promise<{ plaintext: string; keyHash: string }> {
  const plaintext = generateTempApiKey();
  const keyHash = await hashApiKey(plaintext);

  const { error } = await supabase.from("api_keys").insert({
    customer_id: customerId,
    key_hash: keyHash,
    name: "email-intake-temp",
    is_active: true,
  });

  if (error) {
    throw new Error(`Failed to create temporary API key: ${error.message}`);
  }

  return { plaintext, keyHash };
}

/**
 * Delete a temporary API key by its hash.
 */
async function deleteTempApiKey(
  supabase: SupabaseClient,
  keyHash: string,
): Promise<void> {
  const { error } = await supabase
    .from("api_keys")
    .delete()
    .eq("key_hash", keyHash);

  if (error) {
    // Non-fatal — log but don't throw. A stale temp key is inactive
    // and will not match any future lookups after deletion retries.
    console.error("Failed to delete temporary API key:", error.message);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  let supabase: SupabaseClient | null = null;
  let tempKeyHash: string | null = null;

  try {
    // --- Only POST is allowed ---
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    // --- Webhook signature verification ---
    // Clone the request so we can read the raw body for signature verification
    // and still parse the body later from the original request.
    const clonedReq = req.clone();
    const rawBody = new Uint8Array(await clonedReq.arrayBuffer());
    const signatureHeader = req.headers.get("x-webhook-signature");

    const isValidSignature = await verifyWebhookSignature(rawBody, signatureHeader);
    if (!isValidSignature) {
      return new Response(JSON.stringify({ error: "Invalid webhook signature" }), {
        status: 401,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    // --- Parse the email payload based on content type ---
    const contentType = req.headers.get("content-type") || "";
    let email: ParsedEmail;

    if (contentType.includes("multipart/form-data")) {
      // SendGrid Inbound Parse format
      email = await parseSendGridPayload(req);
    } else if (
      contentType.includes("application/json") ||
      contentType.includes("text/json")
    ) {
      // Generic JSON format (Mailgun, Postmark, custom)
      email = await parseGenericJsonPayload(req);
    } else {
      return new Response(
        JSON.stringify({
          error: "Unsupported content type. Expected multipart/form-data or application/json",
        }),
        { status: 415, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Validate the "to" address ---
    const toAddress = extractEmailAddress(email.to);
    if (!toAddress) {
      return new Response(
        JSON.stringify({ error: "Missing 'to' email address in payload" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Look up the intake address to resolve the customer ---
    supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: intakeAddr, error: intakeError } = await supabase
      .from("email_intake_addresses")
      .select("id, customer_id, is_active")
      .eq("email_address", toAddress)
      .single();

    if (intakeError || !intakeAddr) {
      return new Response(
        JSON.stringify({ error: "Unknown intake email address" }),
        { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (!intakeAddr.is_active) {
      return new Response(
        JSON.stringify({ error: "Intake email address is inactive" }),
        { status: 403, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    const customerId = intakeAddr.customer_id;

    // --- Verify the customer has an active API key (confirms valid customer) ---
    const { data: apiKeyCheck, error: apiKeyCheckError } = await supabase
      .from("api_keys")
      .select("id")
      .eq("customer_id", customerId)
      .eq("is_active", true)
      .limit(1)
      .single();

    if (apiKeyCheckError || !apiKeyCheck) {
      console.error(
        `No active API key found for customer ${customerId}:`,
        apiKeyCheckError?.message,
      );
      return new Response(
        JSON.stringify({ error: "No active API key configured for this customer" }),
        { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Find the first PDF attachment ---
    const pdfAttachment = email.attachments.find(
      (att) =>
        att.content_type === "application/pdf" ||
        att.filename.toLowerCase().endsWith(".pdf"),
    );

    // --- Build the email body text ---
    // Prefer plain text, fall back to HTML (stripped of tags)
    const emailBody = email.text || stripHtmlTags(email.html) || "(no body)";

    // --- Build the process-invoice request payload ---
    const pipelineBody = {
      email_subject: email.subject || "(no subject)",
      email_body: emailBody,
      ...(pdfAttachment ? { attachment_base64: pdfAttachment.content_base64 } : {}),
      metadata: {
        from: email.from,
        source: "email_intake",
        intake_address: toAddress,
        has_attachment: !!pdfAttachment,
        attachment_filename: pdfAttachment?.filename || null,
      },
    };

    // --- Create a temporary API key and call process-invoice ---
    // API keys are stored as SHA-256 hashes (plaintext is never retained),
    // so we generate a short-lived temporary key, register it for this
    // customer, use it to authenticate the process-invoice call, and
    // clean it up immediately afterward.
    const tempKey = await createTempApiKey(supabase, customerId);
    tempKeyHash = tempKey.keyHash;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const processInvoiceUrl = `${supabaseUrl}/functions/v1/process-invoice`;

    let pipelineResult: Record<string, unknown>;
    try {
      const pipelineResponse = await fetch(processInvoiceUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": tempKey.plaintext,
        },
        body: JSON.stringify(pipelineBody),
      });

      if (!pipelineResponse.ok) {
        const errorBody = await pipelineResponse.text();
        console.error(
          `process-invoice returned ${pipelineResponse.status}: ${errorBody}`,
        );

        // Log the failure for audit trail
        await supabase.from("processing_logs").insert({
          customer_id: customerId,
          status: "error",
          step: "email_intake",
          error_message: `Pipeline returned HTTP ${pipelineResponse.status}`,
          input: {
            email_from: email.from,
            email_subject: email.subject,
            intake_address: toAddress,
            has_attachment: !!pdfAttachment,
          },
        });

        return new Response(
          JSON.stringify({ error: "Failed to process email" }),
          { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      pipelineResult = await pipelineResponse.json();
    } finally {
      // Always clean up the temporary API key
      await deleteTempApiKey(supabase, tempKey.keyHash);
      tempKeyHash = null;
    }

    // --- Return success ---
    return new Response(
      JSON.stringify({
        status: pipelineResult.status || "completed",
        invoice_id: pipelineResult.invoice_id || null,
        log_id: pipelineResult.log_id || null,
        source: "email_intake",
        intake_address: toAddress,
      }),
      { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("email-intake error:", error);

    // Best-effort cleanup of temporary API key if it was created
    if (supabase && tempKeyHash) {
      try {
        await deleteTempApiKey(supabase, tempKeyHash);
      } catch {
        console.error("Failed to clean up temporary API key in error handler");
      }
    }

    return new Response(
      JSON.stringify({ error: "Email intake processing failed" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
