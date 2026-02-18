-- Delete invoices with incorrect amounts (extracted without PDF content)
UPDATE invoices SET status = 'deleted' WHERE id IN (
  '140aea4e-879e-45db-8420-6e6eae95b476',
  '8ba0566d-445c-4346-a4b2-f35f5149cf12',
  'e052e82d-8dee-4155-9f9f-577bdf9d570e'
);
-- Also find and delete the CleanTech invoice (created before timeout)
UPDATE invoices SET status = 'deleted'
WHERE customer_id = '45493521-4f7e-4ab6-8536-407e11e3ea6a'
  AND status != 'deleted'
  AND created_at > '2026-02-17';
