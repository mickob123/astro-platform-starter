-- Clean up junk/hallucinated invoices from failed processing and non-invoice emails.
-- INV-2023-045 "IT Services Inc." ($1,100) — AI hallucination from failed PDF parse
-- INV-2023-0456 "Strata Services Pty Ltd" ($715) — AI hallucination from failed PDF parse
-- 57838108 "Aussie Broadband" ($0.00) — Non-invoice email processed incorrectly
UPDATE invoices SET status = 'deleted'
WHERE invoice_number IN ('INV-2023-045', 'INV-2023-0456', '57838108')
  AND status != 'deleted';
