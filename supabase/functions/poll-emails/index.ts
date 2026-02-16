/**
 * Poll Gmail for new invoice emails — scalable, multi-tenant.
 *
 * Uses each customer's own Gmail OAuth tokens stored in email_connections.
 * Returns staged email data for n8n to process (no function-to-function calls).
 *
 * Flow:
 *   1. Fetch all active email_connections
 *   2. For each, poll Gmail for unread messages with attachments
 *   3. Download PDF attachments → upload to Supabase Storage
 *   4. Return array of emails with storage paths for n8n to process
 *   5. Mark emails as read so they aren't re-processed
 *
 * Auth: API key (called by n8n schedule trigger)
 * Deploy: supabase functions deploy poll-emails --no-verify-jwt
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyApiKey, AuthError } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://www.googleapis.com/gmail/v1/users/me";

interface EmailConnection {
  id: string;
  customer_id: string;
  email_address: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string | null;
}

function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

async function ensureValidToken(conn: EmailConnection): Promise<string> {
  if (conn.token_expires_at) {
    const expiresAt = new Date(conn.token_expires_at).getTime();
    if (expiresAt - Date.now() > 120_000) {
      return conn.access_token;
    }
  }

  if (!conn.refresh_token) {
    throw new Error(`No refresh token for ${conn.email_address}`);
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID/SECRET not configured");
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: conn.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Token refresh failed for ${conn.email_address}:`, err);
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const tokens = await res.json();
  const newAccessToken = tokens.access_token;
  const newExpiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  const supabase = serviceClient();
  await supabase
    .from("email_connections")
    .update({ access_token: newAccessToken, token_expires_at: newExpiresAt })
    .eq("id", conn.id);

  return newAccessToken;
}

async function fetchUnreadMessages(
  accessToken: string,
  maxResults = 5,
): Promise<Array<{ id: string; threadId: string }>> {
  const query = encodeURIComponent("is:unread has:attachment");
  const url = `${GMAIL_API}/messages?q=${query}&maxResults=${maxResults}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail list failed (${res.status}): ${err}`);
  }
  const data = await res.json();
  return data.messages || [];
}

async function getMessageDetails(
  accessToken: string,
  messageId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${GMAIL_API}/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail get message failed: ${res.status}`);
  return await res.json();
}

function getHeader(message: Record<string, unknown>, name: string): string {
  const payload = message.payload as Record<string, unknown>;
  const headers = (payload?.headers || []) as Array<{ name: string; value: string }>;
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header?.value || "";
}

function findPdfAttachments(
  message: Record<string, unknown>,
): Array<{ attachmentId: string; filename: string; partId: string }> {
  const attachments: Array<{ attachmentId: string; filename: string; partId: string }> = [];
  const payload = message.payload as Record<string, unknown>;
  function walkParts(parts: unknown[]) {
    for (const part of parts) {
      const p = part as Record<string, unknown>;
      const mimeType = (p.mimeType as string) || "";
      const filename = (p.filename as string) || "";
      const body = p.body as Record<string, unknown>;
      if (
        (mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) &&
        body?.attachmentId
      ) {
        attachments.push({
          attachmentId: body.attachmentId as string,
          filename,
          partId: (p.partId as string) || "",
        });
      }
      if (p.parts) walkParts(p.parts as unknown[]);
    }
  }
  if (payload?.parts) walkParts(payload.parts as unknown[]);
  return attachments;
}

async function downloadAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<string> {
  const res = await fetch(
    `${GMAIL_API}/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`Gmail attachment download failed: ${res.status}`);
  const data = await res.json();
  const urlSafeBase64 = data.data as string;
  return urlSafeBase64.replace(/-/g, "+").replace(/_/g, "/");
}

function extractTextBody(message: Record<string, unknown>): string {
  const payload = message.payload as Record<string, unknown>;
  function findTextPart(parts: unknown[]): string {
    for (const part of parts) {
      const p = part as Record<string, unknown>;
      const mimeType = (p.mimeType as string) || "";
      const body = p.body as Record<string, unknown>;
      if (mimeType === "text/plain" && body?.data) {
        const b64 = (body.data as string).replace(/-/g, "+").replace(/_/g, "/");
        try { return atob(b64); } catch { return ""; }
      }
      if (p.parts) {
        const result = findTextPart(p.parts as unknown[]);
        if (result) return result;
      }
    }
    return "";
  }
  if (payload?.parts) return findTextPart(payload.parts as unknown[]);
  const body = payload?.body as Record<string, unknown>;
  if (body?.data) {
    const b64 = (body.data as string).replace(/-/g, "+").replace(/_/g, "/");
    try { return atob(b64); } catch { return ""; }
  }
  return "";
}

/**
 * Track processed Gmail message IDs in the processing_logs table
 * to avoid re-processing (since we only have gmail.readonly scope).
 */
async function getProcessedMessageIds(
  supabase: ReturnType<typeof createClient>,
  connectionId: string,
): Promise<Set<string>> {
  const { data } = await supabase
    .from("processing_logs")
    .select("input")
    .eq("step", "poll-email-seen")
    .eq("status", "success")
    .contains("input", { connection_id: connectionId });

  const ids = new Set<string>();
  if (data) {
    for (const row of data) {
      const gmailId = (row.input as Record<string, unknown>)?.gmail_message_id;
      if (typeof gmailId === "string") ids.add(gmailId);
    }
  }
  return ids;
}

async function markMessageProcessed(
  supabase: ReturnType<typeof createClient>,
  customerId: string,
  connectionId: string,
  gmailMessageId: string,
): Promise<string | null> {
  const { error } = await supabase.from("processing_logs").insert({
    customer_id: customerId,
    status: "success",
    step: "poll-email-seen",
    input: {
      gmail_message_id: gmailMessageId,
      connection_id: connectionId,
    },
  });
  if (error) {
    console.error(`markMessageProcessed failed for ${gmailMessageId}: ${error.message}`);
    return error.message;
  }
  return null;
}

/**
 * Upload PDF to Supabase Storage and return the path.
 */
async function uploadPdfToStorage(
  customerId: string,
  base64Data: string,
  filename: string,
): Promise<string | null> {
  try {
    const supabase = serviceClient();
    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `temp/${customerId}/${Date.now()}_${safeName}`;
    const { error } = await supabase.storage
      .from("invoice-pdfs")
      .upload(storagePath, bytes.buffer, {
        contentType: "application/pdf",
        cacheControl: "300",
        upsert: false,
      });
    if (error) {
      console.error(`PDF upload failed: ${error.message}`);
      return null;
    }
    console.log(`PDF uploaded: ${storagePath} (${bytes.length} bytes)`);
    return storagePath;
  } catch (err) {
    console.error("PDF storage upload error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    await verifyApiKey(req);

    const supabase = serviceClient();

    const { data: connections, error: connError } = await supabase
      .from("email_connections")
      .select("id, customer_id, email_address, access_token, refresh_token, token_expires_at")
      .eq("is_active", true);

    if (connError) throw new Error(`Failed to fetch email connections: ${connError.message}`);

    if (!connections || connections.length === 0) {
      return new Response(
        JSON.stringify({ status: "ok", emails: [], message: "No active email connections" }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // Collect all emails ready for processing
    const emails: Array<Record<string, unknown>> = [];
    const errors: Array<Record<string, unknown>> = [];

    for (const conn of connections as EmailConnection[]) {
      try {
        const accessToken = await ensureValidToken(conn);

        // Backfill missing email_address from Gmail profile
        if (!conn.email_address) {
          try {
            const profileRes = await fetch(`${GMAIL_API}/profile`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (profileRes.ok) {
              const profile = await profileRes.json();
              if (profile.emailAddress) {
                await supabase.from("email_connections")
                  .update({ email_address: profile.emailAddress })
                  .eq("id", conn.id);
                conn.email_address = profile.emailAddress;
                console.log(`Backfilled email_address: ${profile.emailAddress}`);
              }
            }
          } catch (e) {
            console.warn("Failed to backfill email_address:", e);
          }
        }

        // Get already-processed message IDs for this connection (dedup)
        const processedIds = await getProcessedMessageIds(supabase, conn.id);

        const messages = await fetchUnreadMessages(accessToken, 10);

        if (messages.length === 0) continue;

        // Filter out already-processed messages
        const newMessages = messages.filter((m) => !processedIds.has(m.id));
        if (newMessages.length === 0) {
          console.log(`${conn.email_address}: ${messages.length} unread, all already processed`);
          continue;
        }

        console.log(`${conn.email_address}: ${newMessages.length} new of ${messages.length} unread`);

        for (const msg of newMessages) {
          try {
            const message = await getMessageDetails(accessToken, msg.id);
            const subject = getHeader(message, "Subject");
            const from = getHeader(message, "From");
            const textBody = extractTextBody(message);
            const pdfs = findPdfAttachments(message);

            let pdfStoragePath: string | null = null;
            let pdfFilename: string | null = null;
            const attachmentText: string | null = null;

            if (pdfs.length > 0) {
              const pdf = pdfs[0];
              pdfFilename = pdf.filename;
              const base64 = await downloadAttachment(accessToken, msg.id, pdf.attachmentId);
              pdfStoragePath = await uploadPdfToStorage(conn.customer_id, base64, pdf.filename);
            }

            // Add to output array for n8n to process
            emails.push({
              customer_id: conn.customer_id,
              email_subject: subject,
              email_body: textBody || "(no body)",
              attachment_text: attachmentText,
              pdf_storage_path: pdfStoragePath,
              pdf_filename: pdfFilename,
              metadata: {
                from,
                gmail_message_id: msg.id,
                source: "poll-emails",
                email_connection: conn.email_address,
              },
            });

            // Record this message as processed (dedup for next poll)
            const markErr = await markMessageProcessed(supabase, conn.customer_id, conn.id, msg.id);
            if (markErr) {
              errors.push({
                gmail_message_id: msg.id,
                email: conn.email_address,
                error: `dedup insert failed: ${markErr}`,
              });
            }
          } catch (msgErr) {
            console.error(`Failed to process message ${msg.id}:`, msgErr);
            errors.push({
              gmail_message_id: msg.id,
              email: conn.email_address,
              error: msgErr instanceof Error ? msgErr.message : "Unknown error",
            });
          }
        }
      } catch (connErr) {
        console.error(`Failed to poll ${conn.email_address}:`, connErr);
        errors.push({
          email: conn.email_address,
          error: connErr instanceof Error ? connErr.message : "Unknown error",
        });
      }
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        emails,
        errors: errors.length > 0 ? errors : undefined,
        count: emails.length,
      }),
      { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: error.status, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }
    console.error("poll-emails error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
