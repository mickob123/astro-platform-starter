-- Migration: Add admin role access to RLS policies.
--
-- The admin user (role = 'admin' in app_metadata) does
-- not have a customer_id, so tenant isolation policies
-- return zero rows. This adds read access for admin
-- users across all tenant-scoped tables.

-- === VENDORS: admin can see all vendors ===
DROP POLICY IF EXISTS
  "Admin read access on vendors" ON vendors;

CREATE POLICY "Admin read access on vendors"
  ON vendors FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (
      auth.jwt() -> 'app_metadata'
      ->> 'role'
    ) = 'admin'
  );

-- === INVOICES: admin can see all invoices ===
DROP POLICY IF EXISTS
  "Admin read access on invoices" ON invoices;

CREATE POLICY "Admin read access on invoices"
  ON invoices FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (
      auth.jwt() -> 'app_metadata'
      ->> 'role'
    ) = 'admin'
  );

-- === PROCESSING_LOGS: admin can see all logs ===
DROP POLICY IF EXISTS
  "Admin read access on processing_logs"
  ON processing_logs;

CREATE POLICY "Admin read access on processing_logs"
  ON processing_logs FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (
      auth.jwt() -> 'app_metadata'
      ->> 'role'
    ) = 'admin'
  );

-- === CUSTOMERS: admin can see all customers ===
DROP POLICY IF EXISTS
  "Admin read access on customers" ON customers;

CREATE POLICY "Admin read access on customers"
  ON customers FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (
      auth.jwt() -> 'app_metadata'
      ->> 'role'
    ) = 'admin'
  );
