You are continuing work on an automated invoice processing platform for Agentive Group. Here is the full context:

## Project
- Repo: ~/Desktop/astro-platform-starter (user's Mac) or /home/user/astro-platform-starter (dev env)
- Branch: claude/invoice-intake-architecture-Bj3U3
- Netlify site: refundrescue.netlify.app
- Supabase project ref: tcgptxbqqyxmvsaqiblc
- Supabase anon key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRjZ3B0eGJxcXl4bXZzYXFpYmxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzOTQwODksImV4cCI6MjA4NTk3MDA4OX0.nyTEkolz8sft-qFoHpwsLl4F4JkIEW7A3c8aPGftprc
- Customer API key: inv_85faae7910374ee7d0c37cd3af67e6e824445ecc215e0fdf90277436f09e83f2
- n8n instance: https://n8n.agentivegroup.ai
- n8n API key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmNTE4MDM0NC0wMDY3LTQwZDctYmQ0Ny0xYjBlZTQ3NTYzN2YiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiZDBmZjk5MTktMDNhNC00NjkyLWEzYjctMzQ2NTJjZWQ0NWYzIiwiaWF0IjoxNzcwNTg4NjE3fQ.03yX-sGT4ttO9pTqAs3UXae6y-i8uRhZli9aNez2LhU
- n8n workflow ID: 2cof0TS0bpgy5Van
- Gmail credential ID: gyzPGDB9paIsxQOF
- ALLOWED_ORIGINS: https://refundrescue.netlify.app,https://n8n.agentivegroup.ai,http://localhost:4321

## Architecture
- Frontend: Astro + Tailwind + DaisyUI (lofi theme), deployed on Netlify
- Backend: Supabase Edge Functions (Deno runtime), 20 functions total
- Automation: n8n workflow polling Gmail every minute
- Auth: JWT+admin role for admin endpoints, API key (SHA-256 hashed) for processing endpoints
- Storage: Supabase Storage bucket "invoice-pdfs" (private, signed URLs)

## Project Structure
- /modules/ - Core TS modules (classifier, extractor, validator, slack, quickbooks)
- /supabase/functions/ - Edge Functions (process-invoice, classify/extract/validate-invoice, admin-*, build-*-payload, get-invoice-pdf, upload-invoice-pdf)
- /supabase/functions/_shared/ - Shared utilities (auth.ts, cors.ts, retry.ts)
- /supabase/migrations/ - DB migrations (001-014)
- /tests/ - Vitest tests (8 files, 227 tests)
- /n8n/ - n8n workflow template JSON
- /src/pages/ - Astro pages (dashboard, invoice/[id], login, settings, vendors)

## DB Tables
customers, vendors, invoices, processing_logs, api_keys

## n8n Workflow (v5 - LIVE)
Gmail Trigger -> Fetch Full Email (Gmail API HTTP Request) -> Parse Email (Code) -> Has PDF? (IF)
  -> TRUE: Fetch PDF -> Merge PDF Data -> Process Invoice
  -> FALSE: No PDF Path -> Process Invoice
  -> Success?
    -> TRUE: Log Success -> Prepare PDF Upload (Code) -> Upload PDF (binary POST to upload-invoice-pdf) -> Log PDF Upload
    -> FALSE: Log Error

Key details:
- Parse Email uses Gmail API directly (not Gmail node) because Gmail node v2.1 doesn't return full body
- Process Invoice JSON body does NOT include attachment_base64 (PDFs upload separately)
- Upload PDF node has continueOnFail: true (failures are silent)
- Prepare PDF Upload returns [] when no PDF data or no invoice_id (fixed)

## Critical Code Patterns
- verifyApiKey() in _shared/auth.ts returns { customer_id, supabase } (SNAKE_CASE)
- Must destructure as: const { customer_id: customerId } = await verifyApiKey(req)
- n8n Code node sandbox does NOT allow require()
- RLS policies enforce tenant isolation via customer_id
- All Edge Functions use service_role key to bypass RLS for writes

## What Was Just Completed (Sessions 1-4)

### Session 1-2: Core Platform
- Full Supabase schema (14 migrations)
- Edge Functions for invoice processing pipeline (classify, extract, validate, process-invoice)
- Admin endpoints (admin-invoices, admin-vendors, admin-customers, admin-api-keys)
- n8n workflow v1-v3 with Gmail integration
- Dashboard, invoice detail, login, settings, vendors pages
- Vitest test suite (227 tests)
- API key auth with SHA-256 hashing
- RLS policies for tenant isolation
- CORS locking to ALLOWED_ORIGINS

### Session 3: Email Intake Fixes
- Fixed n8n workflow to use Gmail API directly (HTTP Request node) instead of Gmail node
- Fixed Parse Email code to properly extract body from MIME parts
- Fixed "always fetch PDF" (removed 500-char body length filter)
- Fixed 502 Bad Gateway by separating PDF upload from invoice processing
- Created upload-invoice-pdf Edge Function (binary POST, not JSON)
- Created get-invoice-pdf Edge Function (signed URL generation)
- Migration 014: Storage bucket + pdf_storage_path column

### Session 4 (Most Recent):
- Fixed snake_case bug in upload-invoice-pdf (customer_id not customerId)
- Fixed n8n Prepare PDF Upload code to return [] instead of error JSON when no invoice_id
- Updated n8n workflow to v5 via API (deactivate -> PUT -> activate)
- Updated n8n workflow template in repo
- Verified PDF uploads working (2 Officeworks invoices uploaded successfully via n8n executions 225-226)
- PDF viewer UI built in invoice/[id].astro (button + modal with iframe + download link)

## Current Status / What's Pending

1. DEPLOY FRONTEND TO NETLIFY: The PDF viewer code is committed to git but NOT yet deployed to refundrescue.netlify.app. User needs to run:
   cd ~/Desktop/astro-platform-starter
   git pull origin claude/invoice-intake-architecture-Bj3U3
   netlify deploy --build --prod

2. PDF VIEWER: Will show "View Invoice PDF" button on invoice detail page ONLY when that invoice has pdf_storage_path set. Currently only 2 Officeworks invoices have PDFs uploaded.

3. OLDER INVOICES: Invoices processed before the PDF upload pipeline was built won't have PDFs. User can re-forward the emails to trigger re-processing.

4. NON-PDF EMAILS: Stripe HTML receipts (Lovable Labs), order confirmations, etc. will never have PDFs - this is expected behavior.

5. POTENTIAL DUPLICATES: When user re-forwards emails, duplicate invoices may be created. Migration 008 has duplicate detection but it's based on vendor+invoice_number, which may not catch all cases.

## Known Gotchas
- User sometimes browses localhost:4321 which has old code - needs refundrescue.netlify.app or git pull
- n8n API can be flaky - use file output, longer timeouts, and retry with sleep
- n8n Code node v2 sandbox: no require(), no process, limited Node.js APIs
- Gmail forwarded emails have extra headers that inflate body length
- The approve-invoice GET endpoint uses SELECT * so pdf_storage_path is automatically included
- deploy.sh deploys all 20 functions sequentially

## deploy.sh Functions (20 total)
classify-invoice, extract-invoice, validate-invoice, process-invoice,
admin-invoices, admin-vendors, admin-customers, admin-api-keys,
build-xero-payload, build-qbo-payload, build-myob-payload,
sync-to-accounting, get-accounting-status, admin-accounting-config,
approve-invoice, invoice-comments, admin-dashboard-stats,
get-invoice-pdf, upload-invoice-pdf, admin-processing-logs
