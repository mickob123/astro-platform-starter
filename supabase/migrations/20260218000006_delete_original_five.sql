-- Delete original 5 invoices to reprocess with correct PDF-extracted line items.
-- These were processed with manually-typed text that didn't match the actual PDFs.
UPDATE invoices SET status = 'deleted'
WHERE invoice_number IN (
  'EL-2026-00847',
  'CT-2026-0312',
  'HIT-26-1094',
  'WSM-Q1-2026-0078',
  'GS-440291'
)
AND status != 'deleted';
