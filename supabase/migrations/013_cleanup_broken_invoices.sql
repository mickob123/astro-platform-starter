-- Migration 013: Clean up invoices created by the broken
-- workflow (missing email body = bad extraction data)
--
-- These invoices have $0 amounts or NULL amounts because
-- the n8n workflow was only sending a ~190 char snippet
-- instead of the full email body to GPT.

-- Delete processing logs for broken invoices first
DELETE FROM processing_logs
WHERE invoice_id IN (
  SELECT id FROM invoices
  WHERE (total = 0 OR total IS NULL)
);

-- Delete the broken invoice records
DELETE FROM invoices
WHERE (total = 0 OR total IS NULL);

-- Clean up vendors with no remaining invoices
DELETE FROM vendors
WHERE id NOT IN (
  SELECT DISTINCT vendor_id FROM invoices
  WHERE vendor_id IS NOT NULL
);
