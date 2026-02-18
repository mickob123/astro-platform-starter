-- Delete junk invoices from failed processing attempts (wrong amounts, AI-guessed data)
-- INV-2023-045 ($880, "Strata Services") - wrong vendor/amount from failed PDF extraction
-- INV-2023-0456 ($1,870, "Harbour IT") - wrong amount from failed PDF extraction
-- INV-1001 ($275, "Example Vendor Inc.") - test/seed data
-- INV-2026-001 ($880, "Strata") - wrong amount from failed PDF extraction
UPDATE invoices SET status = 'deleted'
WHERE invoice_number IN ('INV-2023-045', 'INV-2023-0456', 'INV-1001', 'INV-2026-001')
  AND status != 'deleted';
