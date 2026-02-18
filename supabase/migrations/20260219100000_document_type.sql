-- Add document_type column to distinguish invoices from expenses.
-- Existing rows default to 'invoice'. New expense-classified documents get 'expense'.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS document_type TEXT NOT NULL DEFAULT 'invoice';

-- Constrain to valid types
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_document_type_check'
  ) THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_document_type_check
      CHECK (document_type IN ('invoice', 'expense'));
  END IF;
END $$;

-- Index for efficient filtering by type
CREATE INDEX IF NOT EXISTS idx_invoices_document_type ON invoices(document_type);
