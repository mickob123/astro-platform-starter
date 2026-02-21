/**
 * Poll a SINGLE customer's Gmail connections for new invoice emails.
 *
 * Called by the n8n orchestrator workflow — one call per customer.
 * Uses email_dedup table for dedup with TTL (replaces processing_logs dedup).
 *
 * Auth: Service role key via x-api-key (trusted caller pattern)
 * Deploy: supabase functions deploy poll-customer --no-verify-jwt
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
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
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...headers, "Content-Type": "application/json" },
    });

  try {
    // ─── Auth: accept service role key OR valid API key ────────────
    const apiKey = req.headers.get("x-api-key") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!apiKey) {
      return json({ error: "Unauthorized — x-api-key header required" }, 401);
    }
    // Accept service role key directly, or verify against api_keys table
    if (apiKey !== serviceRoleKey) {
      const supabaseAuth = serviceClient();
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(apiKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
      const { data: keyRecord } = await supabaseAuth
        .from("api_keys")
        .select("id, is_active")
        .eq("key_hash", keyHash)
        .eq("is_active", true)
        .maybeSingle();
      if (!keyRecord) {
        return json({ error: "Invalid API key" }, 401);
      }
    }

    // ─── Parse customer_id ──────────────────────────────────────────
    const url = new URL(req.url);
    let customerId = url.searchParams.get("customer_id");
    if (!customerId && req.method === "POST") {
      try {
        const body = await req.json();
        customerId = body.customer_id;
      } catch { /* no body */ }
    }
    if (!customerId) {
      return json({ error: "customer_id is required" }, 400);
    }

    const forceReprocess = url.searchParams.get("force") === "true";
    const supabase = serviceClient();

    // ─── Fetch this customer's active email connections ─────────────
    const { data: connections, error: connError } = await supabase
      .from("email_connections")
      .select("id, customer_id, email_address, access_token, refresh_token, token_expires_at")
      .eq("customer_id", customerId)
      .eq("is_active", true);

    if (connError) {
      return json({ error: `Failed to fetch connections: ${connError.message}` }, 500);
    }
    if (!connections || connections.length === 0) {
      return json({ status: "ok", emails: [], count: 0, message: "No active connections" });
    }

    // ─── Poll each connection ───────────────────────────────────────
    const emails: Array<Record<string, unknown>> = [];
    const errors: Array<Record<string, unknown>> = [];
    let retryCount = 0;

    for (const conn of connections as EmailConnection[]) {
      try {
        const accessToken = await ensureValidToken(conn, supabase);

        // Backfill email if missing
        await backfillEmailAddress(supabase, conn, accessToken);

        // Get deduped message IDs (respects TTL)
        const skipIds = forceReprocess
          ? new Set<string>()
          : await getDedupedMessageIds(supabase, conn.id);

        const messages = await fetchUnreadMessages(accessToken, 10);
        if (messages.length === 0) {
          // Update connection health — successful poll, no new emails
          await supabase.from("email_connections").update({
            last_poll_at: new Date().toISOString(),
            last_poll_status: "success",
            consecutive_failures: 0,
          }).eq("id", conn.id);
          continue;
        }

        // Filter out already-deduped messages
        const newMessages = messages.filter((m) => !skipIds.has(m.id));
        if (newMessages.length === 0) {
          await supabase.from("email_connections").update({
            last_poll_at: new Date().toISOString(),
            last_poll_status: "success",
            consecutive_failures: 0,
          }).eq("id", conn.id);
          continue;
        }

        // Check if any are retries (failed entries being re-polled)
        const { data: failedEntries } = await supabase
          .from("email_dedup")
          .select("gmail_message_id")
          .eq("connection_id", conn.id)
          .in("status", ["failed"]);
        const failedIds = new Set((failedEntries || []).map((e: { gmail_message_id: string }) => e.gmail_message_id));

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
                source: "poll-customer",
                email_connection: conn.email_address,
              },
            });

            // Mark as polled in email_dedup (with TTL)
            const markErr = await markMessagePolled(supabase, customerId, conn.id, msg.id);
            if (markErr) {
              errors.push({
                gmail_message_id: msg.id,
                email: conn.email_address,
                error: `dedup insert failed: ${markErr}`,
              });
            }

            if (failedIds.has(msg.id)) retryCount++;
          } catch (msgErr) {
            console.error(`Failed to process message ${msg.id}:`, msgErr);
            errors.push({
              gmail_message_id: msg.id,
              email: conn.email_address,
              error: msgErr instanceof Error ? msgErr.message : "Unknown error",
            });
          }
        }

        // Update connection health — success
        await supabase.from("email_connections").update({
          last_poll_at: new Date().toISOString(),
          last_poll_status: "success",
          consecutive_failures: 0,
        }).eq("id", conn.id);

      } catch (connErr) {
        console.error(`Failed to poll ${conn.email_address}:`, connErr);
        const errMsg = connErr instanceof Error ? connErr.message : "Unknown error";
        errors.push({ email: conn.email_address, error: errMsg });

        // Update connection health — failure
        await supabase.from("email_connections").update({
          last_poll_at: new Date().toISOString(),
          last_poll_status: "error",
          poll_error_count: (conn as unknown as Record<string, number>).poll_error_count + 1 || 1,
          consecutive_failures: (conn as unknown as Record<string, number>).consecutive_failures + 1 || 1,
          last_poll_error: errMsg,
        }).eq("id", conn.id);
      }
    }

    // Update customer-level health on success
    if (emails.length > 0 || errors.length === 0) {
      await supabase.from("customers").update({
        last_successful_poll: new Date().toISOString(),
        pipeline_status: "healthy",
        pipeline_status_updated_at: new Date().toISOString(),
      }).eq("id", customerId);
    }

    return json({
      status: "ok",
      customer_id: customerId,
      emails,
      errors: errors.length > 0 ? errors : undefined,
      count: emails.length,
      retries: retryCount,
    });
  } catch (error) {
    console.error("poll-customer error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Internal server error" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
