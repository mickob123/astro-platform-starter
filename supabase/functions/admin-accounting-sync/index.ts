/**
 * Admin: Accounting system sync — connect, disconnect, and sync invoices
 * to external accounting providers (QuickBooks, Xero, MYOB).
 *
 * Auth: Supabase JWT + admin role check.
 * Deploy WITHOUT --no-verify-jwt.
 *
 * GET                                           — returns current accounting connection
 * POST { action: "connect", provider, auth_code } — exchange OAuth code, save connection
 * POST { action: "sync", invoice_ids }            — sync invoices to accounting system
 * POST { action: "disconnect" }                   — deactivate the connection
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyJwt, requireAdmin, AuthError } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_PROVIDERS = ["quickbooks", "xero", "myob"] as const;
type Provider = (typeof VALID_PROVIDERS)[number];

const VALID_ACTIONS = ["connect", "sync", "disconnect"] as const;
type SyncAction = (typeof VALID_ACTIONS)[number];

const MAX_SYNC_BATCH = 50;

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    const { user } = await verifyJwt(req);
    requireAdmin(user);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Resolve the admin user's customer_id from their JWT app_metadata
    const customerId = user.app_metadata?.customer_id as string | undefined;
    if (!customerId) {
      return new Response(
        JSON.stringify({ error: "No customer_id found in user metadata" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // GET — return current accounting connection(s) for this customer
    // ----------------------------------------------------------------
    if (req.method === "GET") {
      const { data: connections, error: fetchError } = await supabase
        .from("accounting_connections")
        .select("id, provider, company_id, company_name, is_active, last_synced_at, created_at, updated_at")
        .eq("customer_id", customerId)
        .eq("is_active", true);

      if (fetchError) {
        throw new Error(`Failed to fetch connections: ${fetchError.message}`);
      }

      return new Response(
        JSON.stringify({ connections: connections || [] }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // POST — connect / sync / disconnect
    // ----------------------------------------------------------------
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { action } = body as { action: string };

    if (!action || !VALID_ACTIONS.includes(action as SyncAction)) {
      return new Response(
        JSON.stringify({
          error: `action must be one of: ${VALID_ACTIONS.join(", ")}`,
        }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ==============================================================
    // ACTION: connect
    // ==============================================================
    if (action === "connect") {
      const { provider, auth_code } = body as {
        provider: string;
        auth_code: string;
      };

      if (!provider || !VALID_PROVIDERS.includes(provider as Provider)) {
        return new Response(
          JSON.stringify({
            error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}`,
          }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (!auth_code || typeof auth_code !== "string" || auth_code.trim() === "") {
        return new Response(
          JSON.stringify({ error: "auth_code is required" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // TODO: Exchange the OAuth authorization code for access & refresh tokens.
      // The implementation depends on the provider:
      //
      // QuickBooks:
      //   POST https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
      //   Body: grant_type=authorization_code&code={auth_code}&redirect_uri={redirect_uri}
      //   Headers: Authorization: Basic base64(client_id:client_secret)
      //
      // Xero:
      //   POST https://identity.xero.com/connect/token
      //   Body: grant_type=authorization_code&code={auth_code}&redirect_uri={redirect_uri}
      //   Headers: Authorization: Basic base64(client_id:client_secret)
      //
      // MYOB:
      //   POST https://secure.myob.com/oauth2/v1/authorize
      //   Body: grant_type=authorization_code&code={auth_code}&redirect_uri={redirect_uri}
      //
      // For now, we store placeholder values. Replace with real OAuth exchange.
      const tokenResponse = {
        access_token: `placeholder_access_token_${provider}_${Date.now()}`,
        refresh_token: `placeholder_refresh_token_${provider}_${Date.now()}`,
        expires_in: 3600,
        company_id: null as string | null,
        company_name: null as string | null,
      };

      // TODO: After obtaining real tokens, fetch the company info:
      // QuickBooks: GET /v3/company/{realmId}/companyinfo/{realmId}
      // Xero: GET https://api.xero.com/connections (returns tenant list)
      // MYOB: GET https://api.myob.com/accountright/ (returns company files)

      // Deactivate any existing active connection for this provider
      await supabase
        .from("accounting_connections")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("customer_id", customerId)
        .eq("provider", provider)
        .eq("is_active", true);

      // Insert the new connection
      const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString();

      const { data: connection, error: insertError } = await supabase
        .from("accounting_connections")
        .insert({
          customer_id: customerId,
          provider,
          access_token: tokenResponse.access_token,
          refresh_token: tokenResponse.refresh_token,
          token_expires_at: expiresAt,
          company_id: tokenResponse.company_id,
          company_name: tokenResponse.company_name,
          is_active: true,
        })
        .select("id, provider, company_id, company_name, is_active, created_at")
        .single();

      if (insertError) {
        throw new Error(`Failed to save connection: ${insertError.message}`);
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: `Connected to ${provider}`,
          connection,
        }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ==============================================================
    // ACTION: disconnect
    // ==============================================================
    if (action === "disconnect") {
      const { provider } = body as { provider?: string };

      // Build the query — optionally scoped to a specific provider
      let query = supabase
        .from("accounting_connections")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("customer_id", customerId)
        .eq("is_active", true);

      if (provider && VALID_PROVIDERS.includes(provider as Provider)) {
        query = query.eq("provider", provider);
      }

      const { error: disconnectError, count } = await query.select("id");

      if (disconnectError) {
        throw new Error(`Failed to disconnect: ${disconnectError.message}`);
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: provider
            ? `Disconnected from ${provider}`
            : "All accounting connections deactivated",
        }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ==============================================================
    // ACTION: sync
    // ==============================================================
    if (action === "sync") {
      const { invoice_ids } = body as { invoice_ids: string[] };

      if (!Array.isArray(invoice_ids) || invoice_ids.length === 0) {
        return new Response(
          JSON.stringify({ error: "invoice_ids must be a non-empty array" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (invoice_ids.length > MAX_SYNC_BATCH) {
        return new Response(
          JSON.stringify({
            error: `Maximum sync batch size is ${MAX_SYNC_BATCH} invoices`,
          }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      const invalidIds = invoice_ids.filter((id) => !UUID_RE.test(id));
      if (invalidIds.length > 0) {
        return new Response(
          JSON.stringify({
            error: "All invoice_ids must be valid UUIDs",
            invalid_ids: invalidIds,
          }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Verify there is an active accounting connection
      const { data: activeConnection, error: connError } = await supabase
        .from("accounting_connections")
        .select("id, provider, access_token, refresh_token, token_expires_at, company_id")
        .eq("customer_id", customerId)
        .eq("is_active", true)
        .limit(1)
        .single();

      if (connError || !activeConnection) {
        return new Response(
          JSON.stringify({
            error: "No active accounting connection found. Please connect an accounting system first.",
          }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // TODO: Check if the access token is expired and refresh it if needed.
      // if (new Date(activeConnection.token_expires_at) < new Date()) {
      //   const refreshed = await refreshOAuthToken(activeConnection);
      //   // Update the stored tokens in accounting_connections
      // }

      // Fetch the invoices to sync
      const { data: invoices, error: fetchError } = await supabase
        .from("invoices")
        .select("*, vendors(name)")
        .in("id", invoice_ids)
        .eq("customer_id", customerId);

      if (fetchError) {
        throw new Error(`Failed to fetch invoices: ${fetchError.message}`);
      }

      if (!invoices || invoices.length === 0) {
        return new Response(
          JSON.stringify({ error: "No matching invoices found for this customer" }),
          { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      const synced: string[] = [];
      const errors: Array<{ invoice_id: string; error: string }> = [];

      for (const invoice of invoices) {
        try {
          // Create a pending sync_log entry
          const { data: syncLog, error: logInsertError } = await supabase
            .from("sync_logs")
            .insert({
              customer_id: customerId,
              invoice_id: invoice.id,
              provider: activeConnection.provider,
              direction: "export",
              status: "pending",
            })
            .select("id")
            .single();

          if (logInsertError) {
            errors.push({ invoice_id: invoice.id, error: `Failed to create sync log: ${logInsertError.message}` });
            continue;
          }

          // TODO: Make the actual API call to create the bill/invoice in the accounting system.
          //
          // QuickBooks — Create Bill:
          //   POST https://quickbooks.api.intuit.com/v3/company/{companyId}/bill
          //   Headers: Authorization: Bearer {access_token}, Content-Type: application/json
          //   Body: {
          //     "VendorRef": { "value": "{vendor_id_in_qb}" },
          //     "Line": invoice.line_items.map(item => ({
          //       "Amount": item.total,
          //       "DetailType": "AccountBasedExpenseLineDetail",
          //       "Description": item.description,
          //       "AccountBasedExpenseLineDetail": { "AccountRef": { "value": "{expense_account_id}" } }
          //     })),
          //     "TxnDate": invoice.invoice_date,
          //     "DueDate": invoice.due_date,
          //     "DocNumber": invoice.invoice_number,
          //     "TotalAmt": invoice.total
          //   }
          //
          // Xero — Create Bill (Account Payable Invoice):
          //   PUT https://api.xero.com/api.xro/2.0/Invoices
          //   Headers: Authorization: Bearer {access_token}, xero-tenant-id: {tenant_id}
          //   Body: {
          //     "Type": "ACCPAY",
          //     "Contact": { "Name": vendor_name },
          //     "LineItems": invoice.line_items.map(item => ({
          //       "Description": item.description,
          //       "Quantity": item.quantity,
          //       "UnitAmount": item.unit_price,
          //       "AccountCode": "{expense_account_code}"
          //     })),
          //     "Date": invoice.invoice_date,
          //     "DueDate": invoice.due_date,
          //     "InvoiceNumber": invoice.invoice_number,
          //     "CurrencyCode": invoice.currency
          //   }
          //
          // For now, simulate a successful sync with a placeholder external ID.
          const externalId = `${activeConnection.provider}_${invoice.id.substring(0, 8)}_${Date.now()}`;

          // Update sync_log to success
          await supabase
            .from("sync_logs")
            .update({
              status: "success",
              external_id: externalId,
              synced_at: new Date().toISOString(),
            })
            .eq("id", syncLog.id);

          // Update the invoice with the external accounting ID and sync timestamp
          await supabase
            .from("invoices")
            .update({
              external_accounting_id: externalId,
              synced_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", invoice.id);

          synced.push(invoice.id);
        } catch (err) {
          // If we have a sync log, mark it as errored
          errors.push({
            invoice_id: invoice.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Update the connection's last_synced_at timestamp
      if (synced.length > 0) {
        await supabase
          .from("accounting_connections")
          .update({ last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", activeConnection.id);
      }

      return new Response(
        JSON.stringify({
          success: true,
          provider: activeConnection.provider,
          synced: synced.length,
          total_requested: invoice_ids.length,
          errors,
        }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // Should not reach here, but just in case
    return new Response(JSON.stringify({ error: "Unrecognized action" }), {
      status: 400,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    console.error("admin-accounting-sync error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to process accounting sync request" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
