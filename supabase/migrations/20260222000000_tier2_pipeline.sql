-- ============================================================
-- Tier 2 Pipeline: email_dedup, pipeline_alerts, health tracking
-- ============================================================

-- 1. email_dedup table (replaces processing_logs for dedup)
CREATE TABLE IF NOT EXISTS email_dedup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES email_connections(id) ON DELETE CASCADE,
  gmail_message_id text NOT NULL,
  status text NOT NULL DEFAULT 'polled'
    CHECK (status IN ('polled', 'processing', 'processed', 'failed', 'dead_letter')),
  attempt_count int NOT NULL DEFAULT 1,
  max_attempts int NOT NULL DEFAULT 3,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  last_error text,
  invoice_id uuid REFERENCES invoices(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT email_dedup_unique UNIQUE (connection_id, gmail_message_id)
);

CREATE INDEX idx_email_dedup_customer_status
  ON email_dedup (customer_id, status);
CREATE INDEX idx_email_dedup_connection_message
  ON email_dedup (connection_id, gmail_message_id);
CREATE INDEX idx_email_dedup_expires
  ON email_dedup (status, expires_at)
  WHERE status IN ('polled', 'processing');
CREATE INDEX idx_email_dedup_dead_letter
  ON email_dedup (customer_id, status)
  WHERE status = 'dead_letter';

ALTER TABLE email_dedup ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on email_dedup" ON email_dedup
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Tenant read access on email_dedup" ON email_dedup
  FOR SELECT USING (
    auth.role() = 'authenticated'
    AND customer_id = (auth.jwt() -> 'app_metadata' ->> 'customer_id')::uuid
  );

-- 2. pipeline_alerts table
CREATE TABLE IF NOT EXISTS pipeline_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  alert_type text NOT NULL
    CHECK (alert_type IN (
      'poll_failure', 'process_failure', 'high_error_rate',
      'orphaned_emails', 'connection_expired', 'dead_letter_threshold',
      'pipeline_down', 'pipeline_recovered'
    )),
  severity text NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info', 'warning', 'critical')),
  message text NOT NULL,
  metadata jsonb,
  acknowledged boolean NOT NULL DEFAULT false,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pipeline_alerts_customer
  ON pipeline_alerts (customer_id, created_at DESC);
CREATE INDEX idx_pipeline_alerts_unacked
  ON pipeline_alerts (acknowledged, created_at DESC)
  WHERE acknowledged = false;

ALTER TABLE pipeline_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on pipeline_alerts" ON pipeline_alerts
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Authenticated read access on pipeline_alerts" ON pipeline_alerts
  FOR SELECT USING (auth.role() = 'authenticated');

-- 3. Health tracking columns on email_connections
ALTER TABLE email_connections
  ADD COLUMN IF NOT EXISTS last_poll_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_poll_status text DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS poll_error_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consecutive_failures int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_poll_error text;

-- 4. Pipeline status columns on customers
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS last_successful_poll timestamptz,
  ADD COLUMN IF NOT EXISTS last_successful_process timestamptz,
  ADD COLUMN IF NOT EXISTS pipeline_status text DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS pipeline_status_updated_at timestamptz;

-- 5. Auto-update updated_at on email_dedup
CREATE OR REPLACE FUNCTION update_email_dedup_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_email_dedup_updated_at
  BEFORE UPDATE ON email_dedup
  FOR EACH ROW
  EXECUTE FUNCTION update_email_dedup_updated_at();
