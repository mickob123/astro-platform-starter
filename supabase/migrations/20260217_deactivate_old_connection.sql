-- Deactivate old email connection for previous customer account
-- (duplicate connection to mick@agentivegroup.ai under old customer 8db56127)
UPDATE email_connections
SET is_active = false
WHERE customer_id = '8db56127-79f2-4511-8840-de162d598f64';
