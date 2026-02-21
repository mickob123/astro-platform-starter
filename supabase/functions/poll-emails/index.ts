/**
 * Poll Gmail for new invoice emails — scalable, multi-tenant.
 *
 * Uses each customer's own Gmail OAuth tokens stored in email_connections.
 * Returns staged email data for n8n to process (no function-to-function calls).
 *
 * Tier 2 updates:
 *   - Accepts optional ?customer_id= to scope polling to one customer
 *   - Uses email_dedup table (with TTL) instead of processing_logs for dedup
 *   - Updates email_connections health fields
 *
 * Auth: API key (called by n8n schedule trigger)
 * Deploy: supabase functions deploy poll-emails --no-verify-jwt
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyApiKey, AuthError } from "../_shared/auth.ts";
import {
  type EmailConnection,
  serviceClient,
  ensureValidToken,
  fetchUnreadMessages,
  getMessageDetails,
  getHeader,
  findPdfAttachments,
  downloadAttachment,
  extractTextBody,
  uploadPdfToStorage,
  getDedupedMessageIds,
  markMessagePolled,
  backfillEmailAddress,
} from "../_shared/gmail-helpers.ts";

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    const { customer_id: callerCustomerId } = await verifyApiKey(req);

    const url = new URL(req.url);
    const forceReprocess = url.searchParams.get("force") === "true";
    const targetCustomerId = url.searchParams.get("customer_id") || null;

    const supabase = serviceClient();

    // --- Rate limiting: max 60 poll calls per customer per hour ---
    const RATE_LIMIT_MAX = 60;
    const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

    const { count: recentPolls, error: rlError } = await supabase
      .from("processing_logs")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", callerCustomerId)
      .eq("step", "poll-email-seen")
      .gte("created_at", windowStart);

    if (!rlError && recentPolls !== null && recentPolls >= RATE_LIMIT_MAX) {
      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded",
          detail: `Maximum ${RATE_LIMIT_MAX} poll cycles per hour.`,
          retry_after_seconds: 120,
        }),
        {
          status: 429,
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "Retry-After": "120",
          },
        },
      );
    }

    // Fetch connections — optionally scoped to a single customer
    let connQuery = supabase
      .from("email_connections")
      .select("id, customer_id, email_address, access_token, refresh_token, token_expires_at")
      .eq("is_active", true);

    if (targetCustomerId) {
      connQuery = connQuery.eq("customer_id", targetCustomerId);
    }

    const { data: connections, error: connError } = await connQuery;

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
        const accessToken = await ensureValidToken(conn, supabase);

        // Backfill missing email_address from Gmail profile
        await backfillEmailAddress(supabase, conn, accessToken);

        // Get deduped message IDs using email_dedup table (with TTL)
        const skipIds = forceReprocess
          ? new Set<string>()
          : await getDedupedMessageIds(supabase, conn.id);

        const messages = await fetchUnreadMessages(accessToken, 10);
        if (messages.length === 0) continue;

        // Filter out already-deduped messages
        const newMessages = messages.filter((m) => !skipIds.has(m.id));
        if (newMessages.length === 0) continue;

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
              attachment_text: null,
              pdf_storage_path: pdfStoragePath,
              pdf_filename: pdfFilename,
              metadata: {
                from,
                gmail_message_id: msg.id,
                source: "poll-emails",
                email_connection: conn.email_address,
              },
            });

            // Record in email_dedup table (with TTL)
            const markErr = await markMessagePolled(supabase, conn.customer_id, conn.id, msg.id);
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

        // Update connection health
        await supabase.from("email_connections").update({
          last_poll_at: new Date().toISOString(),
          last_poll_status: "success",
          consecutive_failures: 0,
        }).eq("id", conn.id);

      } catch (connErr) {
        console.error(`Failed to poll ${conn.email_address}:`, connErr);
        errors.push({
          email: conn.email_address,
          error: connErr instanceof Error ? connErr.message : "Unknown error",
        });

        // Update connection health — failure
        await supabase.from("email_connections").update({
          last_poll_at: new Date().toISOString(),
          last_poll_status: "error",
          last_poll_error: connErr instanceof Error ? connErr.message : "Unknown error",
        }).eq("id", conn.id);
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
