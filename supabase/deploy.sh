#!/bin/bash
#
# Deploy all Supabase Edge Functions with correct security settings.
#
# Admin functions: deployed WITH JWT verification (gateway + function-level auth)
# Processing functions: deployed with --no-verify-jwt (function-level API key auth only)
#
# Usage:
#   cd ~/Desktop/astro-platform-starter
#   chmod +x supabase/deploy.sh
#   ./supabase/deploy.sh
#
# Prerequisites:
#   1. supabase login
#   2. supabase link --project-ref tcgptxbqqyxmvsaqiblc
#   3. Set secrets:
#      supabase secrets set OPENAI_API_KEY="sk-..."
#      supabase secrets set ALLOWED_ORIGINS="https://your-admin-site.netlify.app,https://n8n.agentivegroup.ai"
#      supabase secrets set SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."  (optional)

set -e

echo "=== Deploying Supabase Edge Functions ==="
echo ""

# --- Admin functions: function-level JWT + admin role auth ---
# Deployed with --no-verify-jwt so the gateway doesn't block valid Supabase Auth tokens.
# Each function verifies JWT + admin role itself via verifyJwt() + requireAdmin().
echo "[1/13] Deploying admin-create-customer (JWT + admin auth)..."
supabase functions deploy admin-create-customer --no-verify-jwt

echo "[2/13] Deploying admin-list-customers (JWT + admin auth)..."
supabase functions deploy admin-list-customers --no-verify-jwt

echo "[3/13] Deploying admin-get-dashboard (JWT + admin auth)..."
supabase functions deploy admin-get-dashboard --no-verify-jwt

echo "[4/13] Deploying admin-get-analytics (JWT + admin auth)..."
supabase functions deploy admin-get-analytics --no-verify-jwt

echo "[5/13] Deploying admin-approval-rules (JWT + admin auth)..."
supabase functions deploy admin-approval-rules --no-verify-jwt

echo "[6/13] Deploying approve-invoice (JWT + admin auth)..."
supabase functions deploy approve-invoice --no-verify-jwt

echo "[7/13] Deploying invoice-comments (JWT auth)..."
supabase functions deploy invoice-comments --no-verify-jwt

echo "[8/13] Deploying admin-bulk-action (JWT + admin auth)..."
supabase functions deploy admin-bulk-action --no-verify-jwt

echo "[9/13] Deploying admin-accounting-sync (JWT + admin auth)..."
supabase functions deploy admin-accounting-sync --no-verify-jwt

# --- Processing functions: API key auth at function level ---
# These use --no-verify-jwt because n8n calls them with API keys, not Supabase JWTs.
# Each function verifies the API key itself and scopes all queries to the customer.
echo "[10/17] Deploying process-invoice (API key auth)..."
supabase functions deploy process-invoice --no-verify-jwt

echo "[11/17] Deploying classify-invoice (API key auth)..."
supabase functions deploy classify-invoice --no-verify-jwt

echo "[12/17] Deploying extract-invoice (API key auth)..."
supabase functions deploy extract-invoice --no-verify-jwt

echo "[13/17] Deploying validate-invoice (API key auth)..."
supabase functions deploy validate-invoice --no-verify-jwt

echo "[14/17] Deploying build-slack-payload (API key auth)..."
supabase functions deploy build-slack-payload --no-verify-jwt

echo "[15/17] Deploying build-quickbooks-payload (API key auth)..."
supabase functions deploy build-quickbooks-payload --no-verify-jwt

echo "[16/17] Deploying check-duplicate (API key auth)..."
supabase functions deploy check-duplicate --no-verify-jwt

# --- Webhook functions: signature-based auth ---
echo "[17/17] Deploying email-intake (webhook auth)..."
supabase functions deploy email-intake --no-verify-jwt

echo ""
echo "=== All functions deployed ==="
echo ""
echo "IMPORTANT: Make sure you have set these secrets:"
echo "  supabase secrets set ALLOWED_ORIGINS=\"https://your-admin.netlify.app,https://n8n.agentivegroup.ai\""
echo "  supabase secrets set OPENAI_API_KEY=\"sk-...\""
echo "  supabase secrets set SLACK_WEBHOOK_URL=\"https://hooks.slack.com/services/...\"  (optional)"
echo ""
echo "To verify, run:"
echo "  supabase functions list"
