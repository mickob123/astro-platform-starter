-- Migration: Add duplicate detection tracking to invoices.
--
-- Adds columns to link an invoice to the original it duplicates,
-- along with a confidence score for how likely it is a duplicate.
-- Also adds a composite index for fast duplicate lookups by
-- customer + vendor + total.

-- === ADD DUPLICATE TRACKING COLUMNS TO INVOICES ===
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS duplicate_of UUID REFERENCES invoices(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS duplicate_confidence NUMERIC(3,2);

-- Add a CHECK constraint so confidence is always between 0 and 1 when set
ALTER TABLE invoices ADD CONSTRAINT chk_duplicate_confidence
  CHECK (duplicate_confidence IS NULL OR (duplicate_confidence >= 0 AND duplicate_confidence <= 1));

-- === INDEX FOR FAST DUPLICATE LOOKUPS ===
-- The check-duplicate function queries by (customer_id, vendor_id, total)
-- to find potential matches. This composite index makes those lookups fast
-- even as the invoices table grows.
CREATE INDEX IF NOT EXISTS idx_invoices_duplicate_lookup
  ON invoices (customer_id, vendor_id, total);

-- Additional index on invoice_number within a customer for exact-match checks
CREATE INDEX IF NOT EXISTS idx_invoices_customer_invoice_number
  ON invoices (customer_id, invoice_number);
