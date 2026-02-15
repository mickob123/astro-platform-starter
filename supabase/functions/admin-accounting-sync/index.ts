/**
 * Admin: Accounting system sync — connect, disconnect, and sync invoices
 * to external accounting providers (QuickBooks, Xero, MYOB).
 *
 * Auth: Supabase JWT + admin role check.
 *
 * GET                                           — returns current accounting connection
 * POST { action: "connect", provider, auth_code } — exchange OAuth code, save connection
 * POST { action: "sync", invoice_ids }            — sync invoices to accounting system
 * POST { action: "disconnect" }                   — deactivate the connection
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyJwt, requireAdmin, AuthError } from "../_shared/auth.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_PROVIDERS = ["quickbooks", "xero", "myob"] as const;
type Provider = (typeof VALID_PROVIDERS)[number];

const VALID_ACTIONS = ["connect", "sync", "disconnect"] as const;
type SyncAction = (typeof VALID_ACTIONS)[number];

const MAX_SYNC_BATCH = 50;

const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QB_API_BASE = Deno.env.get("QUICKBOOKS_API_BASE") || "https://sandbox-quickbooks.api.intuit.com/v3/company";
const QB_MINOR_VERSION = "65";

// ─── QuickBooks helpers ──────────────────────────────────────────────

interface QBConnection {
  id: string;
  provider: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  company_id: string;
}

/**
 * Refresh the QuickBooks access token if expired or expiring soon.
 * Returns the (potentially refreshed) access token.
 */
async function ensureValidToken(
  conn: QBConnection,
  supabase: SupabaseClient,
): Promise<string> {
  const expiresAt = new Date(conn.token_expires_at).getTime();
  const now = Date.now();

  // If token still has > 5 minutes of life, use it
  if (expiresAt - now > 5 * 60 * 1000) {
    return conn.access_token;
  }

  const clientId = Deno.env.get("QUICKBOOKS_CLIENT_ID");
  const clientSecret = Deno.env.get("QUICKBOOKS_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("QuickBooks client credentials not configured");
  }

  const basicAuth = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: conn.refresh_token,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("QB token refresh failed:", err);
    throw new Error("Failed to refresh QuickBooks token. Please reconnect.");
  }

  const tokens = await res.json();
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // Update stored tokens
  await supabase
    .from("accounting_connections")
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conn.id);

  // Update the in-memory connection
  conn.access_token = tokens.access_token;
  conn.refresh_token = tokens.refresh_token;
  conn.token_expires_at = newExpiresAt;

  return tokens.access_token;
}

/**
 * Call the QuickBooks API. Handles JSON parsing and error extraction.
 */
async function qbFetch(
  method: string,
  path: string,
  accessToken: string,
  companyId: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `${QB_API_BASE}/${companyId}/${path}${path.includes("?") ? "&" : "?"}minorversion=${QB_MINOR_VERSION}`;
  const options: RequestInit = {
    method,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const rawText = await res.text();
  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    console.error(`qbFetch: non-JSON response (${res.status}):`, rawText.slice(0, 500));
    data = { rawResponse: rawText.slice(0, 200) };
  }
  if (!res.ok) {
    console.error(`qbFetch: ${method} ${path} error ${res.status}:`, rawText.slice(0, 300));
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Find or create a vendor in QuickBooks.
 * First searches by DisplayName; if not found, creates one.
 * Returns the QuickBooks Vendor ID as a string.
 */
async function resolveQBVendor(
  vendorName: string,
  vendorId: string,
  accessToken: string,
  companyId: string,
  supabase: SupabaseClient,
): Promise<string> {
  // Search for existing vendor by name (QB escapes single quotes with \')
  const safeName = vendorName.replace(/'/g, "\\'");
  const query = `SELECT * FROM Vendor WHERE DisplayName = '${safeName}'`;
  const searchResult = await qbFetch(
    "GET",
    `query?query=${encodeURIComponent(query)}`,
    accessToken,
    companyId,
  );

  if (searchResult.ok && searchResult.data?.QueryResponse?.Vendor?.length > 0) {
    const qbVendorId = String(searchResult.data.QueryResponse.Vendor[0].Id);

    // Cache the mapping in our vendors table
    await supabase
      .from("vendors")
      .update({ external_accounting_id: qbVendorId })
      .eq("id", vendorId);

    return qbVendorId;
  }

  // Vendor not found — create it
  const createResult = await qbFetch("POST", "vendor", accessToken, companyId, {
    DisplayName: vendorName,
  });

  if (!createResult.ok) {
    const errDetail = createResult.data?.Fault?.Error?.[0]?.Detail
      || createResult.data?.Fault?.Error?.[0]?.Message
      || createResult.data?.fault?.error?.[0]?.detail
      || JSON.stringify(createResult.data);
    throw new Error(`Failed to create vendor in QuickBooks: ${errDetail}`);
  }

  const qbVendorId = String(createResult.data.Vendor.Id);

  // Cache the mapping
  await supabase
    .from("vendors")
    .update({ external_accounting_id: qbVendorId })
    .eq("id", vendorId);

  return qbVendorId;
}

/**
 * Fetch expense accounts from QuickBooks and pick the best match for a vendor.
 * Uses keyword matching on vendor name / line item descriptions.
 * Falls back to "Uncategorized Expense" or account ID "1".
 */
const _accountCache = new Map<string, { id: string; name: string }[]>();

async function resolveExpenseAccount(
  vendorName: string,
  lineDescriptions: string[],
  accessToken: string,
  companyId: string,
): Promise<string> {
  // Fetch and cache expense accounts for this company
  if (!_accountCache.has(companyId)) {
    const query = "SELECT * FROM Account WHERE AccountType = 'Expense' MAXRESULTS 200";
    const result = await qbFetch("GET", `query?query=${encodeURIComponent(query)}`, accessToken, companyId);
    if (result.ok && result.data?.QueryResponse?.Account) {
      _accountCache.set(
        companyId,
        result.data.QueryResponse.Account.map((a: any) => ({
          id: String(a.Id),
          name: a.Name,
          subType: a.AccountSubType || "",
        })),
      );
    } else {
      _accountCache.set(companyId, []);
    }
  }

  const accounts = _accountCache.get(companyId) || [];
  if (accounts.length === 0) return "1";

  // Build search text from vendor + line items
  const searchText = [vendorName, ...lineDescriptions].join(" ").toLowerCase();

  // Category keyword mapping: search text keywords -> QB account subtypes/names
  const categoryMap: Array<{ keywords: string[]; accountNames: string[] }> = [
    { keywords: ["electric", "energy", "gas", "water", "power", "utility", "broadband", "internet", "telstra", "optus", "nbn"],
      accountNames: ["Utilities", "Utility"] },
    { keywords: ["office", "stationery", "supplies", "officeworks"],
      accountNames: ["Office Supplies", "Office/General Administrative"] },
    { keywords: ["rent", "lease", "property"],
      accountNames: ["Rent", "Rent or Lease"] },
    { keywords: ["insurance"],
      accountNames: ["Insurance"] },
    { keywords: ["travel", "flight", "hotel", "accommodation", "sheraton", "hilton", "qantas"],
      accountNames: ["Travel", "Travel Meals"] },
    { keywords: ["phone", "mobile", "telecom", "communication"],
      accountNames: ["Telephone", "Communications"] },
    { keywords: ["software", "saas", "subscription", "replit", "stackblitz", "heygen", "cloud"],
      accountNames: ["Software", "Other Miscellaneous Service Cost"] },
    { keywords: ["legal", "lawyer", "solicitor"],
      accountNames: ["Legal & Professional Fees", "Legal"] },
    { keywords: ["accounting", "bookkeep"],
      accountNames: ["Accounting", "Bookkeeper"] },
    { keywords: ["advertising", "marketing", "ads"],
      accountNames: ["Advertising", "Advertising/Promotional"] },
    { keywords: ["repair", "maintenance"],
      accountNames: ["Maintenance and Repair", "Repair"] },
    { keywords: ["auto", "vehicle", "fuel", "petrol"],
      accountNames: ["Automobile", "Auto"] },
  ];

  // Try to match by keywords
  for (const mapping of categoryMap) {
    if (mapping.keywords.some((kw) => searchText.includes(kw))) {
      const match = accounts.find((a: any) =>
        mapping.accountNames.some((name) => a.name.toLowerCase().includes(name.toLowerCase())),
      );
      if (match) return match.id;
    }
  }

  // Fallback: look for "Uncategorized Expense" or "Other Expense"
  const fallback = accounts.find((a: any) =>
    a.name.toLowerCase().includes("uncategorized") || a.name.toLowerCase().includes("other expense"),
  );
  if (fallback) return fallback.id;

  // Last resort: use first expense account
  return accounts[0]?.id || "1";
}

/**
 * Create a Bill in QuickBooks from an invoice.
 */
async function createQBBill(
  invoice: any,
  qbVendorId: string,
  expenseAccountId: string,
  accessToken: string,
  companyId: string,
): Promise<{ billId: string }> {
  const lineItems = (invoice.line_items || []).map(
    (item: { total: number; description: string }, index: number) => ({
      Id: String(index + 1),
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: item.total,
      Description: item.description || "Line item",
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: expenseAccountId },
        BillableStatus: "NotBillable",
      },
    }),
  );

  // Add tax as separate line if present
  if (invoice.tax && invoice.tax > 0) {
    lineItems.push({
      Id: String(lineItems.length + 1),
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: invoice.tax,
      Description: "Tax",
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: expenseAccountId },
        BillableStatus: "NotBillable",
      },
    });
  }

  // If no line items, create a single line with the total
  if (lineItems.length === 0) {
    lineItems.push({
      Id: "1",
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: invoice.total,
      Description: invoice.invoice_number || "Invoice",
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: expenseAccountId },
        BillableStatus: "NotBillable",
      },
    });
  }

  const billPayload: Record<string, unknown> = {
    VendorRef: { value: qbVendorId },
    Line: lineItems,
    TotalAmt: invoice.total,
    PrivateNote: `Auto-imported invoice: ${invoice.invoice_number || invoice.id}`,
  };

  if (invoice.invoice_number) billPayload.DocNumber = invoice.invoice_number;
  if (invoice.invoice_date) billPayload.TxnDate = invoice.invoice_date;
  if (invoice.due_date) billPayload.DueDate = invoice.due_date;

  // Try with CurrencyRef for multi-currency companies
  if (invoice.currency) {
    billPayload.CurrencyRef = { value: invoice.currency };
    billPayload.ExchangeRate = 1;
  }

  let result = await qbFetch("POST", "bill", accessToken, companyId, billPayload);

  // If multi-currency isn't enabled, retry without CurrencyRef
  if (!result.ok && invoice.currency) {
    const errMsg = JSON.stringify(result.data?.Fault?.Error?.[0] || "");
    if (errMsg.includes("Multi Currency") || errMsg.includes("MultiCurrency") || errMsg.includes("currency")) {
      console.log("QB multi-currency not enabled, retrying without CurrencyRef");
      delete billPayload.CurrencyRef;
      delete billPayload.ExchangeRate;
      result = await qbFetch("POST", "bill", accessToken, companyId, billPayload);
    }
  }

  if (!result.ok) {
    const errDetail = result.data?.Fault?.Error?.[0]?.Detail
      || result.data?.Fault?.Error?.[0]?.Message
      || JSON.stringify(result.data);
    console.error("QB bill creation failed:", errDetail);
    throw new Error(`QuickBooks: ${errDetail}`);
  }

  return { billId: String(result.data.Bill.Id) };
}

// ─── Main handler ────────────────────────────────────────────────────

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
      const { provider, auth_code, realm_id } = body as {
        provider: string;
        auth_code: string;
        realm_id?: string;
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

      if (provider === "quickbooks") {
        const clientId = Deno.env.get("QUICKBOOKS_CLIENT_ID");
        const clientSecret = Deno.env.get("QUICKBOOKS_CLIENT_SECRET");
        if (!clientId || !clientSecret) {
          return new Response(
            JSON.stringify({ error: "QuickBooks client credentials not configured" }),
            { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
          );
        }

        // Exchange OAuth code for tokens
        const basicAuth = btoa(`${clientId}:${clientSecret}`);
        const tokenRes = await fetch(QB_TOKEN_URL, {
          method: "POST",
          headers: {
            "Authorization": `Basic ${basicAuth}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: auth_code,
            redirect_uri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/onboarding-state`,
          }),
        });

        if (!tokenRes.ok) {
          const err = await tokenRes.text();
          console.error("QB OAuth exchange failed:", err);
          return new Response(
            JSON.stringify({ error: "Failed to exchange QuickBooks authorization code" }),
            { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
          );
        }

        const tokens = await tokenRes.json();
        const companyId = realm_id || "";

        // Fetch company info
        let companyName = "";
        if (companyId) {
          const infoResult = await qbFetch("GET", `companyinfo/${companyId}`, tokens.access_token, companyId);
          if (infoResult.ok) {
            companyName = infoResult.data?.CompanyInfo?.CompanyName || "";
          }
        }

        // Deactivate existing connection
        await supabase
          .from("accounting_connections")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("customer_id", customerId)
          .eq("provider", "quickbooks")
          .eq("is_active", true);

        const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

        const { data: connection, error: insertError } = await supabase
          .from("accounting_connections")
          .insert({
            customer_id: customerId,
            provider: "quickbooks",
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            token_expires_at: expiresAt,
            company_id: companyId,
            company_name: companyName,
            is_active: true,
          })
          .select("id, provider, company_id, company_name, is_active, created_at")
          .single();

        if (insertError) {
          throw new Error(`Failed to save connection: ${insertError.message}`);
        }

        return new Response(
          JSON.stringify({ success: true, message: `Connected to QuickBooks (${companyName})`, connection }),
          { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Other providers — not yet implemented
      return new Response(
        JSON.stringify({ error: `${provider} integration is not yet available` }),
        { status: 501, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ==============================================================
    // ACTION: disconnect
    // ==============================================================
    if (action === "disconnect") {
      const { provider } = body as { provider?: string };

      let query = supabase
        .from("accounting_connections")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("customer_id", customerId)
        .eq("is_active", true);

      if (provider && VALID_PROVIDERS.includes(provider as Provider)) {
        query = query.eq("provider", provider);
      }

      const { error: disconnectError } = await query.select("id");

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
    // ACTION: sync — create Bills in QuickBooks
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
          JSON.stringify({ error: `Maximum sync batch size is ${MAX_SYNC_BATCH} invoices` }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      const invalidIds = invoice_ids.filter((id) => !UUID_RE.test(id));
      if (invalidIds.length > 0) {
        return new Response(
          JSON.stringify({ error: "All invoice_ids must be valid UUIDs", invalid_ids: invalidIds }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Fetch the invoices to sync (admin can sync any invoice)
      const { data: invoices, error: fetchError } = await supabase
        .from("invoices")
        .select("*, vendors(id, name, external_accounting_id)")
        .in("id", invoice_ids);

      if (fetchError) {
        throw new Error(`Failed to fetch invoices: ${fetchError.message}`);
      }

      if (!invoices || invoices.length === 0) {
        return new Response(
          JSON.stringify({ error: "No matching invoices found" }),
          { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Derive customer_id from the invoices (all must be same customer)
      const invoiceCustomerId = invoices[0].customer_id;

      // Get active accounting connection for the invoice's customer
      const { data: activeConnection, error: connError } = await supabase
        .from("accounting_connections")
        .select("id, provider, access_token, refresh_token, token_expires_at, company_id")
        .eq("customer_id", invoiceCustomerId)
        .eq("is_active", true)
        .limit(1)
        .single();

      if (connError || !activeConnection) {
        return new Response(
          JSON.stringify({ error: "No active accounting connection. Please connect QuickBooks first." }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (activeConnection.provider !== "quickbooks") {
        return new Response(
          JSON.stringify({ error: `Sync for ${activeConnection.provider} is not yet implemented` }),
          { status: 501, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Refresh token if needed
      const accessToken = await ensureValidToken(activeConnection as QBConnection, supabase);

      // Get customer's default expense account
      const { data: customer } = await supabase
        .from("customers")
        .select("default_expense_account_id")
        .eq("id", invoiceCustomerId)
        .single();

      const expenseAccountId = customer?.default_expense_account_id || "1";

      const synced: string[] = [];
      const errors: Array<{ invoice_id: string; error: string }> = [];

      // Cache vendor QB IDs to avoid repeat lookups in a batch
      const vendorCache = new Map<string, string>();

      for (const invoice of invoices) {
        try {
          // Create pending sync_log entry
          const { data: syncLog, error: logInsertError } = await supabase
            .from("sync_logs")
            .insert({
              customer_id: invoiceCustomerId,
              invoice_id: invoice.id,
              provider: "quickbooks",
              direction: "export",
              status: "pending",
            })
            .select("id")
            .single();

          if (logInsertError) {
            errors.push({ invoice_id: invoice.id, error: `Failed to create sync log: ${logInsertError.message}` });
            continue;
          }

          // Resolve vendor in QuickBooks
          const vendorName = invoice.vendors?.name || "Unknown Vendor";
          const vendorDbId = invoice.vendor_id || "";
          let qbVendorId: string;

          // Check cache first, then DB cache, then QB API
          if (vendorCache.has(vendorDbId)) {
            qbVendorId = vendorCache.get(vendorDbId)!;
          } else if (invoice.vendors?.external_accounting_id) {
            qbVendorId = invoice.vendors.external_accounting_id;
            vendorCache.set(vendorDbId, qbVendorId);
          } else {
            qbVendorId = await resolveQBVendor(
              vendorName,
              vendorDbId,
              accessToken,
              activeConnection.company_id,
              supabase,
            );
            vendorCache.set(vendorDbId, qbVendorId);
          }

          // Resolve the best expense account category
          const lineDescs = (invoice.line_items || []).map((li: any) => li.description || "");
          const categoryAccountId = await resolveExpenseAccount(
            vendorName,
            lineDescs,
            accessToken,
            activeConnection.company_id,
          );

          let billId: string;

          // If already synced, update the existing bill
          if (invoice.external_accounting_id) {
            // Fetch existing bill to get SyncToken (required for QB updates)
            const existing = await qbFetch(
              "GET",
              `bill/${invoice.external_accounting_id}`,
              accessToken,
              activeConnection.company_id,
            );

            if (existing.ok && existing.data?.Bill) {
              const updatedBill = { ...existing.data.Bill };
              // Update line items with correct expense account
              for (const line of updatedBill.Line || []) {
                if (line.AccountBasedExpenseLineDetail) {
                  line.AccountBasedExpenseLineDetail.AccountRef = { value: categoryAccountId };
                }
              }
              const updateResult = await qbFetch(
                "POST",
                "bill",
                accessToken,
                activeConnection.company_id,
                updatedBill,
              );
              if (!updateResult.ok) {
                const errDetail = updateResult.data?.Fault?.Error?.[0]?.Detail
                  || updateResult.data?.Fault?.Error?.[0]?.Message
                  || "Unknown error";
                throw new Error(`QuickBooks update: ${errDetail}`);
              }
              billId = invoice.external_accounting_id;
            } else {
              throw new Error("Could not fetch existing bill from QuickBooks");
            }
          } else {
            // Create new Bill in QuickBooks
            const result = await createQBBill(
              invoice,
              qbVendorId,
              categoryAccountId,
              accessToken,
              activeConnection.company_id,
            );
            billId = result.billId;
          }

          // Update sync_log to success
          await supabase
            .from("sync_logs")
            .update({
              status: "success",
              external_id: billId,
              synced_at: new Date().toISOString(),
            })
            .eq("id", syncLog.id);

          // Update invoice with QB bill ID
          await supabase
            .from("invoices")
            .update({
              external_accounting_id: billId,
              synced_at: new Date().toISOString(),
              sync_status: "synced",
              accounting_id: billId,
              accounting_sync_at: new Date().toISOString(),
              accounting_error: null,
              status: "synced",
              updated_at: new Date().toISOString(),
            })
            .eq("id", invoice.id);

          synced.push(invoice.id);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          errors.push({ invoice_id: invoice.id, error: errMsg });

          // Update invoice with error status
          await supabase
            .from("invoices")
            .update({
              sync_status: "error",
              accounting_error: errMsg,
              status: "error",
              updated_at: new Date().toISOString(),
            })
            .eq("id", invoice.id);

          // Update sync_log to error if it was created
          await supabase
            .from("sync_logs")
            .update({ status: "error", error_message: errMsg })
            .eq("invoice_id", invoice.id)
            .eq("status", "pending");
        }
      }

      // Update connection's last_synced_at
      if (synced.length > 0) {
        await supabase
          .from("accounting_connections")
          .update({ last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", activeConnection.id);
      }

      return new Response(
        JSON.stringify({
          success: true,
          provider: "quickbooks",
          synced: synced.length,
          total_requested: invoice_ids.length,
          errors,
        }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

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
