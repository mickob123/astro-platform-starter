# DocuBot - Invoice Processing Automation Platform

## Project Overview

DocuBot is a production invoice automation platform that ingests invoices via email, classifies and extracts data with AI (OpenAI GPT-4), provides human-in-the-loop approval, and syncs with accounting systems (QuickBooks). Built for multi-tenant SaaS with role-based access control.

**Live URL:** https://agentivegroup.netlify.app

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Astro 4.16 (hybrid SSR) + React 18 + Tailwind CSS + DaisyUI |
| **Backend** | 27 Supabase Edge Functions (Deno/TypeScript) |
| **Database** | PostgreSQL (Supabase) with Row-Level Security |
| **Auth** | Supabase Auth (JWT) + API key auth for external systems |
| **AI** | OpenAI GPT-4 Turbo (classify, extract) |
| **Storage** | Supabase Storage (PDF uploads) |
| **Deployment** | Netlify (frontend), Supabase (backend/functions) |
| **Integrations** | QuickBooks, Gmail, Slack, SendGrid/Mailgun/Postmark webhooks |

---

## Project Structure

```
astro-platform-starter/
├── src/
│   ├── pages/                    # Astro pages (SSR/hybrid)
│   │   ├── index.astro           # Auth router → /dashboard or /onboarding
│   │   ├── login.astro           # Email/password login
│   │   ├── signup.astro          # Registration → creates auth user + customer + API key
│   │   ├── dashboard.astro       # Main invoice dashboard (stats, filters, table, charts, bulk actions)
│   │   ├── expenses.astro        # Expense tracking (document_type=expense, mirrors dashboard)
│   │   ├── vendors.astro         # Vendor master list management
│   │   ├── settings.astro        # Account settings, team, API keys, integrations
│   │   ├── invoice/[id].astro    # Single invoice detail, edit, approve/reject, comments
│   │   ├── onboarding/index.astro # Multi-step onboarding wizard
│   │   ├── admin/                # Platform admin pages
│   │   │   ├── index.astro       # Platform overview: all orgs, global stats
│   │   │   ├── create.astro      # Create new organization
│   │   │   ├── org/[id].astro    # Single org detail: members, invoices, API keys
│   │   │   └── users.astro       # All platform users
│   │   ├── terms.astro           # Terms of service
│   │   ├── privacy.astro         # Privacy policy
│   │   └── blobs/, edge/, image-cdn.astro, revalidation.astro  # Netlify platform demos
│   ├── layouts/
│   │   ├── Layout.astro          # Base layout (public pages: login, signup, terms)
│   │   ├── DashboardLayout.astro # Dashboard layout (navbar, nav links, notification bell, logout, role-based visibility)
│   │   ├── AdminLayout.astro     # Platform admin layout
│   │   └── OnboardingLayout.astro # Onboarding wizard layout with step indicator
│   ├── components/               # Astro components (Alert, Card, Logo, Footer, etc.)
│   ├── lib/
│   │   └── supabase.ts           # Supabase client init, FUNCTIONS_URL constant, getAccessToken() with smart token refresh
│   └── styles/                   # Global CSS
├── supabase/
│   ├── functions/                # 27 Edge Functions (see below)
│   │   └── _shared/              # Shared utilities (auth, cors, retry, process-invoice-handler)
│   └── migrations/               # 17 SQL migrations
├── public/                       # Static assets
├── package.json                  # Dependencies
├── astro.config.mjs              # Astro: hybrid output, Netlify adapter, React + Tailwind integrations
└── tailwind.config.mjs           # Custom theme: Plus Jakarta Sans, IBM Plex Mono, docubot DaisyUI theme
```

---

## Database Schema (Key Tables)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| **customers** | Company/org records | id, auth_user_id, name, email, slug, country, currency, tax_rate, timezone, accounting_platform, is_active, onboarding_step |
| **invoices** | Invoice & expense records | id, customer_id, vendor_id, invoice_number, invoice_date, due_date, currency, subtotal, tax, total, status (pending/approved/flagged/rejected/synced/error), document_type (invoice/expense), confidence, sync_status, reviewed_by, reviewed_at |
| **vendors** | Vendor master list | id, customer_id, name, normalized_name (for dedup), accounting_id (QB) |
| **api_keys** | API keys (SHA-256 hashed) | id, customer_id, key_hash, name, is_active, last_used_at |
| **email_intake_addresses** | Incoming email webhook addresses | id, customer_id, email_address, provider, is_active |
| **email_connections** | Gmail OAuth tokens | id, customer_id, provider, email_address, access_token, refresh_token, token_expires_at |
| **accounting_connections** | QuickBooks OAuth tokens | id, customer_id, provider, access_token, refresh_token, company_id, realm_id |
| **processing_logs** | Audit trail of every processing step | id, customer_id, invoice_id, step (classify/extract/validate/check_duplicate/sync), input, output, duration_ms, status, error |
| **processed_articles** | Dedup tracking | id, customer_id, source_url, url_hash (MD5), title |
| **invoice_comments** | Comment threading on invoices | id, invoice_id, user_id, content, created_at |

**Security:** Row-Level Security (RLS) enforces tenant isolation. All queries scoped to customer_id. Service role key bypasses RLS for admin functions.

**17 migrations** in `supabase/migrations/` cover initial schema, invoice fields, processing logs, API key hashing, RLS policies, comments, duplicate detection, email intake, accounting sync, and more.

---

## Supabase Edge Functions (27 total)

### Shared Utilities (`_shared/`)

| File | Exports | Purpose |
|------|---------|---------|
| **auth.ts** | `verifyJwt()`, `verifyApiKey()`, `requireAdmin()`, `requireRole()` | JWT validation + API key auth + role checking |
| **cors.ts** | `getCorsHeaders()`, `handleCors()` | CORS with origin whitelist (env: `ALLOWED_ORIGINS`) |
| **retry.ts** | `withRetry<T>()` | Exponential backoff retry for external APIs |
| **process-invoice-handler.ts** | Shared handler | Core pipeline: classify → extract → validate → dedup → store |

### Invoice Processing Pipeline

| Function | Auth | Description |
|----------|------|-------------|
| **classify-invoice** | JWT/API Key | GPT-4 classifies email as invoice. Returns `{is_invoice, vendor_name, confidence, signals}`. Rate: 30/hr |
| **extract-invoice** | JWT/API Key | GPT-4 extracts structured data (vendor, invoice #, dates, line items, totals). Rate: 30/hr |
| **validate-invoice** | JWT/API Key | Math validation, required fields, duplicate check. Rate: 60/hr |
| **check-duplicate** | JWT/API Key | Fuzzy duplicate detection with confidence scoring (1.0=exact, 0.95=same vendor+total+date, etc.) |
| **process-invoice** | No JWT (wrapper) | Orchestrates full pipeline. Deploy with `--no-verify-jwt` |
| **upload-invoice-pdf** | JWT/API Key | Uploads PDF to Supabase Storage, returns public URL |
| **get-invoice-pdf** | JWT | Returns signed download URL for PDF |

### HITL (Human-in-the-Loop)

| Function | Auth | Description |
|----------|------|-------------|
| **approve-invoice** | JWT + Admin | GET: fetch invoice detail. POST: approve/reject. PATCH: edit fields |
| **invoice-comments** | JWT | GET/POST comments on invoices |

### Email Integration

| Function | Auth | Description |
|----------|------|-------------|
| **email-intake** | Webhook (HMAC) | Receives emails from SendGrid/Mailgun/Postmark. Maps "to" address → customer. Processes attached PDF |
| **poll-emails** | JWT/API Key | Polls Gmail via OAuth. Downloads PDF attachments. Returns staged data for n8n |

### Integrations

| Function | Auth | Description |
|----------|------|-------------|
| **build-quickbooks-payload** | JWT/API Key | Constructs QB bill creation payload from invoice data |
| **build-slack-payload** | JWT/API Key | Constructs Slack message blocks with approve/flag action buttons |

### Onboarding

| Function | Auth | Description |
|----------|------|-------------|
| **onboarding-register** | None (public) | Creates auth user + customer + API key. Rate: 5/hr globally. Deploy with `--no-verify-jwt` |
| **onboarding-state** | JWT | GET/PUT onboarding wizard state. Handles Gmail/QB OAuth exchange |

### Admin Functions (11)

| Function | Auth | Description |
|----------|------|-------------|
| **admin-platform** | JWT + Admin | Platform dashboards: overview (org list), customer detail, global stats, all users |
| **admin-get-dashboard** | JWT + Admin | Customer dashboard: invoices + summary stats + pagination. Supports `document_type` filter (invoice/expense) |
| **admin-get-analytics** | JWT + Admin | 30-day analytics: volume_by_day, spend_by_vendor, status_breakdown, avg_confidence, avg_processing_time |
| **admin-list-customers** | JWT + Admin | List all customers with pagination |
| **admin-create-customer** | JWT + Admin | Create new customer record |
| **admin-approval-rules** | JWT + Admin | Configure auto-approval rules |
| **admin-bulk-action** | JWT + Admin | Bulk: approve/reject/delete/reclassify/export_csv. Max 100 per batch. Reclassify flips document_type (invoice ↔ expense) |
| **admin-accounting-sync** | JWT + Admin | QuickBooks sync: trigger uploads, retry failures |
| **admin-processing-logs** | JWT + Admin | View step-by-step processing audit trail |
| **admin-team** | JWT + Admin | Manage team: list, invite, update role, remove |
| **admin-vendors** | JWT + Admin | Manage vendor database |

---

## Invoice Processing Workflow

```
Email Intake (Webhook: SendGrid/Mailgun/Postmark)
    ↓
Email Parse (extract to/from/subject/body/attachments)
    ↓
Customer Lookup (via "to" email → email_intake_addresses table)
    ↓
PDF Upload (Supabase Storage)
    ↓
Classify Invoice (GPT-4: is_invoice? vendor? confidence?)
    ↓
Extract Invoice (GPT-4: structured data - vendor, dates, line items, totals)
    ↓
Validate Invoice (math checks, required fields)
    ↓
Dedup Check (fuzzy match against existing invoices by vendor+amount+date)
    ↓
Store Invoice (insert into invoices table, status=pending)
    ↓
Slack Notification (webhook with approve/flag action buttons)
    ↓
HITL Review (admin approves/rejects/flags via dashboard)
    ↓
Edit (optional: admin modifies extracted fields)
    ↓
Approve → QuickBooks Sync (create bill in QB) → Webhook Callback
```

---

## Frontend Architecture

### Dashboard (`dashboard.astro`) — Main Page
- **Stats cards:** Needs Review, Approved, Amount Awaiting, Amount Approved
- **Analytics section** (collapsible): Chart.js charts for volume, vendor spend, status breakdown, avg confidence/processing time
- **Time range filters:** Today, This Week, This Month, All Time
- **Filter bar:** Search, Status dropdown, Sort, Per Page, Group by Vendor toggle, Export CSV
- **Invoice table:** Checkbox selection, clickable rows → `/invoice/[id]`, status badges, confidence indicators, quick approve/reject buttons
- **Bulk actions bar** (fixed bottom): Approve, Reject, Delete, "→ Expenses" (reclassify), Cancel
- **Pagination:** Server-side with client-side page number generation
- **Auto-refresh:** Every 30 seconds

### Expenses (`expenses.astro`) — Mirror of Dashboard
- Same UI but filters by `document_type=expense`
- Bulk reclassify button says "→ Invoices" (moves items back to dashboard)
- Column headers say "Receipt #" and "Payment Date" instead of "Invoice #" and "Due Date"

### Invoice Detail (`invoice/[id].astro`)
- Full invoice data display
- Edit fields inline (PATCH to approve-invoice)
- Approve/Reject/Flag actions
- Comments thread

### Auth Flow
- `index.astro` checks session → redirects to `/dashboard` (if onboarded) or `/onboarding/signup` (if not)
- `login.astro` uses `supabase.auth.signInWithPassword()`
- `signup.astro` calls `onboarding-register` function (creates user + customer + API key)

### Role-Based UI
- Two roles: `admin` (full access), `viewer` (read-only)
- `.admin-only` CSS class hides elements for viewers
- DashboardLayout reads role from `app_metadata.role`

---

## Key Code Patterns

### Supabase Client (`src/lib/supabase.ts`)
```typescript
import { createClient } from '@supabase/supabase-js';
const SUPABASE_URL = 'https://tcgptxbqqyxmvsaqiblc.supabase.co';
const SUPABASE_ANON_KEY = '...';
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

export async function getAccessToken(): Promise<string | null> {
  // Smart refresh: only if < 2 min remaining
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const expiresAt = session.expires_at ?? 0;
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt - now < 120) {
    const { data } = await supabase.auth.refreshSession();
    return data.session?.access_token ?? null;
  }
  return session.access_token;
}
```

### Edge Function Pattern
```typescript
import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyJwt, requireAdmin, AuthError } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    const { user } = await verifyJwt(req);
    requireAdmin(user);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,  // Bypasses RLS
    );

    // ... business logic ...

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
});
```

### Frontend API Call Pattern
```typescript
const FUNCTIONS_URL = 'https://tcgptxbqqyxmvsaqiblc.supabase.co/functions/v1';
const token = await getAccessToken();
const response = await fetch(`${FUNCTIONS_URL}/admin-get-dashboard?page=1&limit=25`, {
  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
});
const data = await response.json();
```

---

## Security Features

1. **Tenant Isolation:** RLS on all tables, queries scoped by customer_id
2. **API Key Auth:** SHA-256 hashed, `inv_<64hex>` format, shown once at signup
3. **CORS Whitelist:** `ALLOWED_ORIGINS` env var
4. **Rate Limiting:** Per-customer, per-step (30-60/hour) via processing_logs
5. **Email Webhook HMAC:** Optional `WEBHOOK_SIGNING_SECRET` with constant-time comparison
6. **Audit Logging:** processing_logs tracks every pipeline step with timing and errors

---

## Environment Variables

### Frontend (Astro — hardcoded in `src/lib/supabase.ts`)
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — Supabase anonymous key

### Backend (Supabase Edge Functions)
- `SUPABASE_URL` — Auto-set by Supabase
- `SUPABASE_SERVICE_ROLE_KEY` — For RLS bypass in admin functions
- `OPENAI_API_KEY` — GPT-4 API calls
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Gmail OAuth
- `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_API_BASE` — QB OAuth + API
- `SLACK_WEBHOOK_URL` — Slack notifications
- `ALLOWED_ORIGINS` — CORS whitelist (comma-separated)
- `WEBHOOK_SIGNING_SECRET` — Email webhook HMAC verification (optional)

---

## Deploy Commands

```bash
# Deploy a Supabase edge function
npx supabase functions deploy <function-name>

# Deploy with no JWT verification (for public endpoints)
npx supabase functions deploy <function-name> --no-verify-jwt

# Build and deploy frontend to Netlify
npm run build
npx netlify deploy --build --prod

# Run locally
npm run dev                    # Astro dev server on localhost:4321
npx supabase functions serve   # Local edge functions
```

---

## DaisyUI Theme

Custom "docubot" theme in `tailwind.config.mjs`:
- **Primary:** Agent Indigo (#6C5CE7)
- **Secondary:** Slate (#64748B)
- **Accent:** Emerald (#00C9A7)
- **Base:** Vault dark (#0C1220) background, Ledger light (#F7F5F0) cards
- **Font:** Plus Jakarta Sans (headings), IBM Plex Mono (data/numbers)
- **Components:** Rounded buttons (0.5rem), cards with subtle shadow, status badges (success/warning/error/info)
