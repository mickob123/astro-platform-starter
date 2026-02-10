-- Migration: Email intake addresses for forwarding invoices via email.
--
-- Maps a dedicated intake email address (e.g. invoices-abc123@intake.agentivegroup.ai)
-- to a customer so that forwarded emails can be automatically routed to the
-- correct tenant's processing pipeline.
--
-- RLS policies:
--   - Service role has full access (used by Edge Functions)
--   - Authenticated users can only view their own customer's intake addresses

CREATE TABLE IF NOT EXISTS email_intake_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  email_address text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT email_intake_addresses_email_unique UNIQUE (email_address)
);

-- Index for fast lookup by email address (the hot path in the webhook handler)
CREATE INDEX IF NOT EXISTS idx_email_intake_addresses_email
  ON email_intake_addresses (email_address);

-- Index for listing a customer's intake addresses
CREATE INDEX IF NOT EXISTS idx_email_intake_addresses_customer
  ON email_intake_addresses (customer_id);

-- === Row Level Security ===
ALTER TABLE email_intake_addresses ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (used by Edge Functions)
CREATE POLICY "Service role full access on email_intake_addresses" ON email_intake_addresses
  FOR ALL
  USING (auth.role() = 'service_role');

-- Authenticated users only see their own customer's intake addresses.
-- The user's customer_id is stored in their JWT app_metadata (set during user creation).
CREATE POLICY "Tenant isolation for email_intake_addresses" ON email_intake_addresses
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND customer_id = (auth.jwt() -> 'app_metadata' ->> 'customer_id')::uuid
  );
