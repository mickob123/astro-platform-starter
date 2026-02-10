-- Migration: Accounting system sync tables and invoice sync columns.
--
-- Adds:
--   - accounting_connections: OAuth connections to QuickBooks, Xero, MYOB
--   - sync_logs: audit trail for every export/import sync attempt
--   - invoices.external_accounting_id: the bill/invoice ID in the accounting system
--   - invoices.synced_at: timestamp of last successful sync

-- === accounting_connections ===
CREATE TABLE IF NOT EXISTS accounting_connections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('quickbooks', 'xero', 'myob')),
  access_token  TEXT NOT NULL,   -- encrypted at rest via Supabase Vault or app-level encryption
  refresh_token TEXT NOT NULL,   -- encrypted at rest via Supabase Vault or app-level encryption
  token_expires_at TIMESTAMPTZ,
  company_id    TEXT,
  company_name  TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_synced_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active connection per provider per customer
CREATE UNIQUE INDEX IF NOT EXISTS accounting_connections_customer_provider_active_idx
  ON accounting_connections (customer_id, provider)
  WHERE is_active = true;

-- === sync_logs ===
CREATE TABLE IF NOT EXISTS sync_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  invoice_id    UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('quickbooks', 'xero', 'myob')),
  direction     TEXT NOT NULL CHECK (direction IN ('export', 'import')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'error')),
  external_id   TEXT,            -- the bill/invoice ID in the accounting system
  error_message TEXT,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_logs_customer_id_idx ON sync_logs (customer_id);
CREATE INDEX IF NOT EXISTS sync_logs_invoice_id_idx ON sync_logs (invoice_id);

-- === Add sync columns to invoices ===
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS external_accounting_id TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;

-- === Row Level Security ===

-- accounting_connections
ALTER TABLE accounting_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on accounting_connections" ON accounting_connections;
CREATE POLICY "Service role full access on accounting_connections" ON accounting_connections
  FOR ALL
  USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Tenant isolation for accounting_connections" ON accounting_connections;
CREATE POLICY "Tenant isolation for accounting_connections" ON accounting_connections
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND customer_id = (auth.jwt() -> 'app_metadata' ->> 'customer_id')::uuid
  );

-- sync_logs
ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on sync_logs" ON sync_logs;
CREATE POLICY "Service role full access on sync_logs" ON sync_logs
  FOR ALL
  USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Tenant isolation for sync_logs" ON sync_logs;
CREATE POLICY "Tenant isolation for sync_logs" ON sync_logs
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND customer_id = (auth.jwt() -> 'app_metadata' ->> 'customer_id')::uuid
  );
