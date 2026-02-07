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

# --- Admin functions: WITH gateway JWT verification (defense-in-depth) ---
echo "[1/8] Deploying admin-create-customer (JWT verified)..."
supabase functions deploy admin-create-customer

echo "[2/8] Deploying admin-list-customers (JWT verified)..."
supabase functions deploy admin-list-customers

echo "[3/8] Deploying admin-get-dashboard (JWT verified)..."
supabase functions deploy admin-get-dashboard

# --- Processing functions: API key auth at function level ---
# These use --no-verify-jwt because n8n calls them with API keys, not Supabase JWTs.
# Each function verifies the API key itself and scopes all queries to the customer.
echo "[4/8] Deploying process-invoice (API key auth)..."
supabase functions deploy process-invoice --no-verify-jwt

echo "[5/8] Deploying classify-invoice (API key auth)..."
supabase functions deploy classify-invoice --no-verify-jwt

echo "[6/8] Deploying extract-invoice (API key auth)..."
supabase functions deploy extract-invoice --no-verify-jwt

echo "[7/8] Deploying validate-invoice (API key auth)..."
supabase functions deploy validate-invoice --no-verify-jwt

echo "[8/8] Deploying build-slack-payload (API key auth)..."
supabase functions deploy build-slack-payload --no-verify-jwt

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
