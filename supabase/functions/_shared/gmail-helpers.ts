/**
 * Shared Gmail API helpers used by poll-emails and poll-customer.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_API = "https://www.googleapis.com/gmail/v1/users/me";

export interface EmailConnection {
  id: string;
  customer_id: string;
  email_address: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string | null;
}

export function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

/**
 * Ensure the OAuth access token is valid; refresh if expiring within 2 min.
 */
export async function ensureValidToken(
  conn: EmailConnection,
  supabase?: ReturnType<typeof createClient>,
): Promise<string> {
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

  const db = supabase || serviceClient();
  await db
    .from("email_connections")
    .update({ access_token: newAccessToken, token_expires_at: newExpiresAt })
    .eq("id", conn.id);

  return newAccessToken;
}

/**
 * Fetch unread messages with attachments from Gmail.
 */
export async function fetchUnreadMessages(
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

/**
 * Get full message details from Gmail.
 */
export async function getMessageDetails(
  accessToken: string,
  messageId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${GMAIL_API}/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail get message failed: ${res.status}`);
  return await res.json();
}

/**
 * Extract a header value from a Gmail message.
 */
export function getHeader(message: Record<string, unknown>, name: string): string {
  const payload = message.payload as Record<string, unknown>;
  const headers = (payload?.headers || []) as Array<{ name: string; value: string }>;
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header?.value || "";
}

/**
 * Find PDF attachments in a Gmail message's MIME parts tree.
 */
export function findPdfAttachments(
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

/**
 * Download a Gmail attachment and return base64-encoded data.
 */
export async function downloadAttachment(
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

/**
 * Extract the plain text body from a Gmail message.
 */
export function extractTextBody(message: Record<string, unknown>): string {
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
 * Upload a PDF to Supabase Storage and return the path.
 */
export async function uploadPdfToStorage(
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

// ─── email_dedup helpers ───────────────────────────────────────────

/**
 * Get gmail_message_ids that should be skipped (already processed or currently being polled).
 * Respects TTL: expired 'polled' entries are NOT in the skip set (allowing re-poll).
 */
export async function getDedupedMessageIds(
  supabase: ReturnType<typeof createClient>,
  connectionId: string,
): Promise<Set<string>> {
  // Skip messages that are: processed, or currently polled and not expired
  const { data } = await supabase
    .from("email_dedup")
    .select("gmail_message_id, status, expires_at")
    .eq("connection_id", connectionId);

  const ids = new Set<string>();
  if (data) {
    const now = Date.now();
    for (const row of data) {
      if (row.status === "processed") {
        ids.add(row.gmail_message_id);
      } else if (row.status === "polled" || row.status === "processing") {
        // Only skip if not expired
        if (row.expires_at && new Date(row.expires_at).getTime() > now) {
          ids.add(row.gmail_message_id);
        }
      }
      // 'failed' and 'dead_letter' are NOT skipped — they can be retried
    }
  }
  return ids;
}

/**
 * Mark a Gmail message as polled in email_dedup (upsert).
 * For retries, increments attempt_count and resets expires_at.
 */
export async function markMessagePolled(
  supabase: ReturnType<typeof createClient>,
  customerId: string,
  connectionId: string,
  gmailMessageId: string,
): Promise<string | null> {
  // Check if an existing entry exists (for retry tracking)
  const { data: existing } = await supabase
    .from("email_dedup")
    .select("id, attempt_count, status")
    .eq("connection_id", connectionId)
    .eq("gmail_message_id", gmailMessageId)
    .maybeSingle();

  if (existing && (existing.status === "failed" || existing.status === "dead_letter")) {
    // Retry: increment attempt count, reset status
    const { error } = await supabase
      .from("email_dedup")
      .update({
        status: "polled",
        attempt_count: existing.attempt_count + 1,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        last_error: null,
      })
      .eq("id", existing.id);
    if (error) return error.message;
    return null;
  }

  if (existing) {
    // Already exists and not failed — just refresh the expiry
    const { error } = await supabase
      .from("email_dedup")
      .update({
        status: "polled",
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      })
      .eq("id", existing.id);
    if (error) return error.message;
    return null;
  }

  // New entry
  const { error } = await supabase.from("email_dedup").insert({
    customer_id: customerId,
    connection_id: connectionId,
    gmail_message_id: gmailMessageId,
    status: "polled",
    attempt_count: 1,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
  if (error) return error.message;
  return null;
}

/**
 * Backfill email_address from Gmail profile if missing.
 */
export async function backfillEmailAddress(
  supabase: ReturnType<typeof createClient>,
  conn: EmailConnection,
  accessToken: string,
): Promise<void> {
  if (conn.email_address) return;
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
