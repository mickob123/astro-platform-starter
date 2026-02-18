-- Delete all invoices for this customer to start fresh
UPDATE invoices SET status = 'deleted'
WHERE customer_id = '45493521-4f7e-4ab6-8536-407e11e3ea6a'
  AND status != 'deleted';
