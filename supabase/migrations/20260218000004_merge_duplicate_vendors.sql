-- Merge duplicate vendor records caused by inconsistent suffix handling.
-- "AusGrid Energy" (ausgrid-energy) and "AusGrid Energy Pty Ltd" (ausgrid-energy-pty-ltd)
-- should be the same vendor. Keep the full name, merge records.

-- Step 1: Point invoices from short-name vendor to full-name vendor
UPDATE invoices
SET vendor_id = (
  SELECT id FROM vendors
  WHERE normalized_name = 'ausgrid-energy-pty-ltd'
    AND customer_id = invoices.customer_id
  LIMIT 1
)
WHERE vendor_id IN (
  SELECT id FROM vendors WHERE normalized_name = 'ausgrid-energy'
)
AND EXISTS (
  SELECT 1 FROM vendors
  WHERE normalized_name = 'ausgrid-energy-pty-ltd'
    AND customer_id = invoices.customer_id
);

-- Step 2: Delete the now-orphaned short-name vendor
DELETE FROM vendors
WHERE normalized_name = 'ausgrid-energy'
  AND id NOT IN (SELECT DISTINCT vendor_id FROM invoices WHERE vendor_id IS NOT NULL);

-- Step 3: Rename the kept vendor's normalized_name to stripped format
UPDATE vendors
SET normalized_name = 'ausgrid-energy'
WHERE normalized_name = 'ausgrid-energy-pty-ltd';
