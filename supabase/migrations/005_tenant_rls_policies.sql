-- Migration: Enforce tenant isolation via Row Level Security.
--
-- Every table with customer_id gets RLS policies ensuring:
--   - Authenticated users can only see their own customer's data
--   - Service role (Edge Functions) can access all data
--   - No cross-tenant data leakage

-- === INVOICES ===
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolation for invoices" ON invoices;
DROP POLICY IF EXISTS "Service role full access on invoices" ON invoices;

-- Service role can do everything (used by Edge Functions)
CREATE POLICY "Service role full access on invoices" ON invoices
  FOR ALL
  USING (auth.role() = 'service_role');

-- Authenticated users only see their own customer's invoices.
-- The user's customer_id is stored in their JWT app_metadata (set during user creation).
-- This prevents any cross-tenant data leakage at the database level.
CREATE POLICY "Tenant isolation for invoices" ON invoices
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND customer_id = (auth.jwt() -> 'app_metadata' ->> 'customer_id')::uuid
  );

-- === VENDORS ===
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolation for vendors" ON vendors;
DROP POLICY IF EXISTS "Service role full access on vendors" ON vendors;

CREATE POLICY "Service role full access on vendors" ON vendors
  FOR ALL
  USING (auth.role() = 'service_role');

-- Authenticated users only see their own customer's vendors.
CREATE POLICY "Tenant isolation for vendors" ON vendors
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND customer_id = (auth.jwt() -> 'app_metadata' ->> 'customer_id')::uuid
  );

-- === PROCESSING_LOGS ===
ALTER TABLE processing_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolation for processing_logs" ON processing_logs;
DROP POLICY IF EXISTS "Service role full access on processing_logs" ON processing_logs;

CREATE POLICY "Service role full access on processing_logs" ON processing_logs
  FOR ALL
  USING (auth.role() = 'service_role');

-- Authenticated users only see their own customer's processing logs.
CREATE POLICY "Tenant isolation for processing_logs" ON processing_logs
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND customer_id = (auth.jwt() -> 'app_metadata' ->> 'customer_id')::uuid
  );

-- === CUSTOMERS ===
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on customers" ON customers;

CREATE POLICY "Service role full access on customers" ON customers
  FOR ALL
  USING (auth.role() = 'service_role');

-- === Add unique constraint for vendor upsert ===
-- The process-invoice function upserts vendors by (customer_id, normalized_name)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendors_customer_id_normalized_name_unique'
  ) THEN
    ALTER TABLE vendors ADD CONSTRAINT vendors_customer_id_normalized_name_unique UNIQUE (customer_id, normalized_name);
  END IF;
END $$;
