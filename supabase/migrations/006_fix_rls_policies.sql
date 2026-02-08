-- Migration: Fix broken RLS policies identified by security audit.
--
-- Problems in migration 005:
--   1. Invoices "tenant isolation" policy had a tautological condition
--      (SELECT customer_id FROM api_keys WHERE customer_id = invoices.customer_id)
--      which always returns true if any api_key exists for that customer.
--   2. Vendors and processing_logs policies allowed ANY authenticated user
--      to read ALL rows (no customer_id scoping).
--
-- Fix: Since all application access goes through Edge Functions using the
-- service_role key (which bypasses RLS), and there is no user-to-customer
-- mapping table, the safest approach is to restrict these tables to
-- service_role only. This prevents accidental data leakage via direct
-- PostgREST or Supabase client access.

-- === INVOICES: Remove broken tenant isolation policy ===
DROP POLICY IF EXISTS "Tenant isolation for invoices" ON invoices;

-- === VENDORS: Remove overly permissive policy ===
DROP POLICY IF EXISTS "Tenant isolation for vendors" ON vendors;

-- === PROCESSING_LOGS: Remove overly permissive policy ===
DROP POLICY IF EXISTS "Tenant isolation for processing_logs" ON processing_logs;

-- All three tables now only allow service_role access (policies created in 005).
-- If a user-to-customer mapping is added later, proper tenant isolation
-- policies can be re-created at that time.
