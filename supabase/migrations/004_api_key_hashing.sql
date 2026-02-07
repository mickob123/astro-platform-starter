-- Migration: Switch api_keys table to store hashed keys instead of plaintext.
-- This migration adds a key_hash column and removes the plaintext key column.
--
-- IMPORTANT: After running this migration, you must re-generate API keys
-- for existing customers using the admin-create-customer Edge Function.

-- Add key_hash column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'key_hash'
  ) THEN
    ALTER TABLE api_keys ADD COLUMN key_hash TEXT;
  END IF;
END $$;

-- Add label column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'label'
  ) THEN
    ALTER TABLE api_keys ADD COLUMN label TEXT;
  END IF;
END $$;

-- Add is_active column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'is_active'
  ) THEN
    ALTER TABLE api_keys ADD COLUMN is_active BOOLEAN DEFAULT true;
  END IF;
END $$;

-- Create unique index on key_hash for lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash);

-- Add index for customer_id lookups
CREATE INDEX IF NOT EXISTS idx_api_keys_customer_id ON api_keys (customer_id);

-- Add RLS policy: only service role can access api_keys
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to avoid conflicts
DROP POLICY IF EXISTS "Service role only" ON api_keys;

-- Only the service role (used by Edge Functions) can read/write api_keys
CREATE POLICY "Service role only" ON api_keys
  FOR ALL
  USING (auth.role() = 'service_role');
