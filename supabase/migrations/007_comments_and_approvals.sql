-- Migration: Add invoice comments and approval rules tables.
--
-- invoice_comments: supports threaded discussion on invoices
-- approval_rules: configurable multi-level approval workflows per customer
-- Also adds approval tracking fields to the invoices table.

-- === INVOICE COMMENTS ===
CREATE TABLE invoice_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  user_id UUID NOT NULL,
  user_email TEXT NOT NULL,
  user_name TEXT,
  content TEXT NOT NULL,
  mentioned_user_ids UUID[] DEFAULT '{}',
  attachments JSONB DEFAULT '[]',
  is_system BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_invoice_comments_invoice ON invoice_comments(invoice_id);
CREATE INDEX idx_invoice_comments_customer ON invoice_comments(customer_id);

-- RLS policies for invoice_comments (same pattern as invoices table in 005)
ALTER TABLE invoice_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role has full access to invoice_comments"
  ON invoice_comments FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Users can view comments for their customer"
  ON invoice_comments FOR SELECT
  USING (customer_id = (auth.jwt() -> 'app_metadata' ->> 'customer_id')::uuid);

CREATE POLICY "Users can insert comments for their customer"
  ON invoice_comments FOR INSERT
  WITH CHECK (customer_id = (auth.jwt() -> 'app_metadata' ->> 'customer_id')::uuid);

-- === APPROVAL RULES ===
CREATE TABLE approval_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  min_amount NUMERIC(12,2) DEFAULT 0,
  max_amount NUMERIC(12,2),
  required_approvers INTEGER DEFAULT 1,
  approver_emails TEXT[] NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_approval_rules_customer ON approval_rules(customer_id);

ALTER TABLE approval_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role has full access to approval_rules"
  ON approval_rules FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Users can manage approval rules for their customer"
  ON approval_rules FOR ALL
  USING (customer_id = (auth.jwt() -> 'app_metadata' ->> 'customer_id')::uuid);

-- === ADD APPROVAL TRACKING FIELDS TO INVOICES ===
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS required_approvals INTEGER DEFAULT 1;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS current_approvals INTEGER DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS approval_rule_id UUID REFERENCES approval_rules(id);
