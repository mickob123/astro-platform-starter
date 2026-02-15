/**
 * Onboarding: State management for the setup wizard.
 *
 * Auth: Supabase JWT (user must be logged in). Looks up customer via
 * app_metadata.customer_id on the JWT.
 *
 * GET  — Returns current onboarding state (step, customer data, connections).
 * PUT  — Advances through onboarding steps.
 *
 * Steps:
 *   1. company_details  — Save company name, country, currency, tax rate, timezone
 *   2. connect_email    — Exchange Gmail OAuth code for tokens, store connection
 *   3. connect_accounting — Exchange QuickBooks OAuth code, store connection
 *      skip_accounting  — Skip accounting setup
 *   4. preferences      — Auto-approve threshold, notification settings
 *   5. test_pipeline    — Poll for first invoice (handled client-side)
 *      test_complete    — Mark onboarding as finished
 *
 * Additional PUT actions:
 *   - fetch_expense_accounts — Query QuickBooks Chart of Accounts
 *   - set_expense_account    — Save default expense account
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyJwt, AuthError } from "../_shared/auth.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const QB_API_BASE = Deno.env.get("QUICKBOOKS_API_BASE") || "https://sandbox-quickbooks.api.intuit.com/v3/company";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OnboardingState {
  completed: boolean;
  current_step: string;
  customer: Record<string, unknown>;
  email_connection: { connected: boolean; email?: string };
  accounting_connection: {
    connected: boolean;
    provider?: string;
    company?: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

async function getCustomerId(req: Request): Promise<string> {
  const { user } = await verifyJwt(req);
  const customerId = user.app_metadata?.customer_id as string | undefined;
  if (!customerId) {
    throw new AuthError("No customer linked to this account", 403);
  }
  return customerId;
}

const STEP_ORDER = [
  "company_details",
  "connect_email",
  "connect_accounting",
  "preferences",
  "test_pipeline",
];

function nextStep(current: string): string {
  const idx = STEP_ORDER.indexOf(current);
  if (idx < 0 || idx >= STEP_ORDER.length - 1) return "test_pipeline";
  return STEP_ORDER[idx + 1];
}

// ---------------------------------------------------------------------------
// GET: Fetch current onboarding state
// ---------------------------------------------------------------------------

async function handleGet(customerId: string): Promise<OnboardingState> {
  const supabase = serviceClient();

  const { data: customer, error } = await supabase
    .from("customers")
    .select(
      "id, name, email, country, currency, tax_rate, timezone, onboarding_step, onboarding_completed_at",
    )
    .eq("id", customerId)
    .single();

  if (error || !customer) {
    throw new AuthError("Customer not found", 404);
  }

  // Check email connection
  const { data: emailConn } = await supabase
    .from("email_connections")
    .select("email_address, is_active")
    .eq("customer_id", customerId)
    .eq("is_active", true)
    .maybeSingle();

  // Check accounting connection
  const { data: accountingConn } = await supabase
    .from("accounting_connections")
    .select("provider, company_name, is_active")
    .eq("customer_id", customerId)
    .eq("is_active", true)
    .maybeSingle();

  return {
    completed: !!customer.onboarding_completed_at,
    current_step: customer.onboarding_step || "company_details",
    customer: {
      name: customer.name,
      country: customer.country,
      currency: customer.currency,
      tax_rate: customer.tax_rate,
      timezone: customer.timezone,
    },
    email_connection: {
      connected: !!emailConn,
      email: emailConn?.email_address || undefined,
    },
    accounting_connection: {
      connected: !!accountingConn,
      provider: accountingConn?.provider || undefined,
      company: accountingConn?.company_name || undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// PUT: Advance onboarding steps
// ---------------------------------------------------------------------------

async function handlePut(
  customerId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const step = body.step as string;
  const data = (body.data || {}) as Record<string, unknown>;

  switch (step) {
    case "company_details":
      return await saveCompanyDetails(customerId, data);
    case "connect_email":
      return await connectEmail(customerId, data);
    case "connect_accounting":
      return await connectAccounting(customerId, data);
    case "skip_accounting":
      return await skipStep(customerId, "connect_accounting");
    case "preferences":
      return await savePreferences(customerId, data);
    case "fetch_expense_accounts":
      return await fetchExpenseAccounts(customerId);
    case "set_expense_account":
      return await setExpenseAccount(customerId, data);
    case "check_invoices":
      return await checkInvoices(customerId);
    case "test_complete":
      return await completeOnboarding(customerId);
    default:
      throw new Error(`Unknown step: ${step}`);
  }
}

// --- Step 1: Company Details ---

async function saveCompanyDetails(
  customerId: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const supabase = serviceClient();

  const { error } = await supabase
    .from("customers")
    .update({
      name: data.company_name || undefined,
      country: data.country || undefined,
      currency: data.currency || undefined,
      tax_rate: data.tax_rate || undefined,
      timezone: data.timezone || undefined,
      onboarding_step: "connect_email",
    })
    .eq("id", customerId);

  if (error) throw new Error(`Failed to save: ${error.message}`);

  return { next_step: "connect_email" };
}

// --- Step 2: Connect Gmail ---

async function connectEmail(
  customerId: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const supabase = serviceClient();
  const authCode = data.gmail_auth_code as string;
  const redirectUri = data.redirect_uri as string;

  if (!authCode) throw new Error("Missing gmail_auth_code");

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth not configured on server");
  }

  // Exchange authorization code for tokens
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: authCode,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    const errBody = await tokenResponse.text();
    console.error("Google token exchange failed:", errBody);
    throw new Error("Failed to connect Gmail. Please try again.");
  }

  const tokens = await tokenResponse.json();

  // Get user's email from the ID token or userinfo
  let userEmail = "";
  try {
    const userinfoResponse = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    );
    if (userinfoResponse.ok) {
      const userinfo = await userinfoResponse.json();
      userEmail = userinfo.email || "";
    }
  } catch {
    console.warn("Failed to fetch userinfo, continuing without email");
  }

  // Upsert email connection
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  const { error: connError } = await supabase
    .from("email_connections")
    .upsert(
      {
        customer_id: customerId,
        provider: "gmail",
        email_address: userEmail,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        token_expires_at: expiresAt,
        is_active: true,
      },
      { onConflict: "customer_id" },
    );

  if (connError) {
    console.error("Failed to save email connection:", connError.message);
    throw new Error("Failed to save Gmail connection");
  }

  // Advance step
  await supabase
    .from("customers")
    .update({ onboarding_step: "connect_accounting" })
    .eq("id", customerId);

  return { email: userEmail, next_step: "connect_accounting" };
}

// --- Step 3: Connect Accounting ---

async function connectAccounting(
  customerId: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const supabase = serviceClient();
  const provider = data.provider as string;
  const authCode = data.auth_code as string;
  const redirectUri = data.redirect_uri as string;
  const realmId = data.realm_id as string;

  if (!authCode || !provider) {
    throw new Error("Missing auth_code or provider");
  }

  let accessToken = "";
  let refreshToken = "";
  let expiresIn = 0;
  let companyName = "";
  let companyId = realmId || "";

  if (provider === "quickbooks") {
    const qbClientId = Deno.env.get("QUICKBOOKS_CLIENT_ID");
    const qbClientSecret = Deno.env.get("QUICKBOOKS_CLIENT_SECRET");

    if (!qbClientId || !qbClientSecret) {
      throw new Error("QuickBooks OAuth not configured on server");
    }

    // Exchange code for tokens
    const basicAuth = btoa(`${qbClientId}:${qbClientSecret}`);
    const tokenResponse = await fetch(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({
          code: authCode,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      },
    );

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text();
      console.error("QuickBooks token exchange failed:", errBody);
      throw new Error("Failed to connect QuickBooks. Please try again.");
    }

    const tokens = await tokenResponse.json();
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token || "";
    expiresIn = tokens.expires_in || 3600;

    // Fetch company info
    if (realmId) {
      try {
        const companyResponse = await fetch(
          `${QB_API_BASE}/${realmId}/companyinfo/${realmId}?minorversion=65`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
            },
          },
        );
        if (companyResponse.ok) {
          const companyData = await companyResponse.json();
          companyName =
            companyData.CompanyInfo?.CompanyName || "";
        }
      } catch {
        console.warn("Failed to fetch QuickBooks company info");
      }
    }
  } else {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  // Upsert accounting connection
  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;

  const { error: connError } = await supabase
    .from("accounting_connections")
    .upsert(
      {
        customer_id: customerId,
        provider,
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expires_at: expiresAt,
        company_id: companyId,
        company_name: companyName,
        is_active: true,
      },
      { onConflict: "customer_id,provider", ignoreDuplicates: false },
    );

  if (connError) {
    console.error("Failed to save accounting connection:", connError.message);
    // Try insert instead (upsert may not match if no existing row)
    const { error: insertError } = await supabase
      .from("accounting_connections")
      .insert({
        customer_id: customerId,
        provider,
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expires_at: expiresAt,
        company_id: companyId,
        company_name: companyName,
        is_active: true,
      });

    if (insertError) {
      throw new Error("Failed to save accounting connection");
    }
  }

  // Advance step
  await supabase
    .from("customers")
    .update({ onboarding_step: "preferences" })
    .eq("id", customerId);

  return { company_name: companyName, next_step: "preferences" };
}

// --- Skip accounting ---

async function skipStep(
  customerId: string,
  currentStep: string,
): Promise<Record<string, unknown>> {
  const supabase = serviceClient();
  const next = nextStep(currentStep);

  await supabase
    .from("customers")
    .update({ onboarding_step: next })
    .eq("id", customerId);

  return { next_step: next };
}

// --- Step 4: Preferences ---

async function savePreferences(
  customerId: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const supabase = serviceClient();

  // Upsert customer_preferences
  const { error } = await supabase
    .from("customer_preferences")
    .upsert(
      {
        customer_id: customerId,
        auto_approve_threshold: data.auto_approve_threshold || 0,
        notification_email: data.notification_email !== false,
        notification_slack: data.notification_slack === true,
        slack_webhook_url: data.slack_webhook_url || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "customer_id" },
    );

  if (error) {
    console.error("Failed to save preferences:", error.message);
    throw new Error("Failed to save preferences");
  }

  // Also update slack_webhook_url on the customer record for backward compat
  if (data.slack_webhook_url) {
    await supabase
      .from("customers")
      .update({ slack_webhook_url: data.slack_webhook_url })
      .eq("id", customerId);
  }

  // Advance step
  await supabase
    .from("customers")
    .update({ onboarding_step: "test_pipeline" })
    .eq("id", customerId);

  return { next_step: "test_pipeline" };
}

// --- Fetch expense accounts from QuickBooks ---

async function fetchExpenseAccounts(
  customerId: string,
): Promise<Record<string, unknown>> {
  const supabase = serviceClient();

  const { data: conn } = await supabase
    .from("accounting_connections")
    .select("access_token, company_id, provider")
    .eq("customer_id", customerId)
    .eq("is_active", true)
    .maybeSingle();

  if (!conn || !conn.access_token || !conn.company_id) {
    return { accounts: [], current_default: null };
  }

  if (conn.provider === "quickbooks") {
    try {
      const query = encodeURIComponent(
        "SELECT * FROM Account WHERE AccountType IN ('Expense', 'Cost of Goods Sold') AND Active = true MAXRESULTS 200",
      );
      const response = await fetch(
        `${QB_API_BASE}/${conn.company_id}/query?query=${query}&minorversion=65`,
        {
          headers: {
            Authorization: `Bearer ${conn.access_token}`,
            Accept: "application/json",
          },
        },
      );

      if (!response.ok) {
        console.error("QuickBooks query failed:", response.status);
        return { accounts: [], current_default: null };
      }

      const result = await response.json();
      const qbAccounts = result.QueryResponse?.Account || [];

      const accounts = qbAccounts.map(
        (acc: Record<string, unknown>) => ({
          id: acc.Id,
          name: acc.Name,
          full_name: acc.FullyQualifiedName || acc.Name,
          type: acc.AccountType,
          sub_type: acc.AccountSubType || "",
        }),
      );

      // Get current default
      const { data: customer } = await supabase
        .from("customers")
        .select("default_expense_account_id")
        .eq("id", customerId)
        .single();

      return {
        accounts,
        current_default: customer?.default_expense_account_id || null,
      };
    } catch (err) {
      console.error("Failed to query QuickBooks accounts:", err);
      return { accounts: [], current_default: null };
    }
  }

  return { accounts: [], current_default: null };
}

// --- Set default expense account ---

async function setExpenseAccount(
  customerId: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const supabase = serviceClient();

  const { error } = await supabase
    .from("customers")
    .update({ default_expense_account_id: data.account_id })
    .eq("id", customerId);

  if (error) throw new Error("Failed to save expense account");

  return { saved: true };
}

// --- Check invoices (for Step 5 polling) ---

async function checkInvoices(
  customerId: string,
): Promise<Record<string, unknown>> {
  const supabase = serviceClient();

  const { count, error } = await supabase
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customerId)
    .neq("status", "deleted");

  if (error) {
    console.error("Failed to check invoices:", error.message);
    return { total_invoices: 0, latest: null };
  }

  // Also get the latest invoice for display
  const { data: latest } = await supabase
    .from("invoices")
    .select("id, total, status, created_at, vendor_id, vendors(name)")
    .eq("customer_id", customerId)
    .neq("status", "deleted")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    total_invoices: count || 0,
    latest: latest
      ? {
          id: latest.id,
          total: latest.total,
          status: latest.status,
          vendor: (latest as Record<string, unknown>).vendors
            ? ((latest as Record<string, unknown>).vendors as Record<string, unknown>).name
            : "Unknown vendor",
        }
      : null,
  };
}

// --- Complete onboarding ---

async function completeOnboarding(
  customerId: string,
): Promise<Record<string, unknown>> {
  const supabase = serviceClient();

  await supabase
    .from("customers")
    .update({
      onboarding_completed_at: new Date().toISOString(),
      onboarding_step: "completed",
    })
    .eq("id", customerId);

  return { completed: true };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    const customerId = await getCustomerId(req);

    if (req.method === "GET") {
      const state = await handleGet(customerId);
      return new Response(JSON.stringify(state), {
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (req.method === "PUT") {
      const body = await req.json();
      const result = await handlePut(customerId, body);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    console.error("onboarding-state error:", error);
    const message =
      error instanceof Error ? error.message : "Onboarding request failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
});
