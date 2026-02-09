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
echo "[1/9] Deploying admin-create-customer (JWT + admin auth)..."
supabase functions deploy admin-create-customer --no-verify-jwt

echo "[2/9] Deploying admin-list-customers (JWT + admin auth)..."
supabase functions deploy admin-list-customers --no-verify-jwt

echo "[3/9] Deploying admin-get-dashboard (JWT + admin auth)..."
supabase functions deploy admin-get-dashboard --no-verify-jwt

echo "[4/9] Deploying approve-invoice (JWT + admin auth)..."
supabase functions deploy approve-invoice --no-verify-jwt

# --- Processing functions: API key auth at function level ---
# These use --no-verify-jwt because n8n calls them with API keys, not Supabase JWTs.
# Each function verifies the API key itself and scopes all queries to the customer.
echo "[5/9] Deploying process-invoice (API key auth)..."
supabase functions deploy process-invoice --no-verify-jwt

echo "[6/9] Deploying classify-invoice (API key auth)..."
supabase functions deploy classify-invoice --no-verify-jwt

echo "[7/9] Deploying extract-invoice (API key auth)..."
supabase functions deploy extract-invoice --no-verify-jwt

echo "[8/9] Deploying validate-invoice (API key auth)..."
supabase functions deploy validate-invoice --no-verify-jwt

echo "[9/9] Deploying build-slack-payload (API key auth)..."
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
