-- Migration: Fix invoice status constraint and ensure
-- reviewed columns exist.
--
-- The original schema may have a CHECK constraint on
-- invoices.status that only allows 'pending'/'flagged'/
-- 'error'. This migration drops that constraint and
-- recreates it with all valid status values including
-- 'approved' and 'rejected'.
--
-- Also ensures reviewed_by and reviewed_at columns exist
-- (idempotent, safe to re-run).

-- 1. Drop any existing CHECK constraint on the status column
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid
      AND att.attnum = ANY(con.conkey)
    WHERE con.conrelid = 'invoices'::regclass
      AND con.contype = 'c'
      AND att.attname = 'status'
  ) LOOP
    EXECUTE format(
      'ALTER TABLE invoices DROP CONSTRAINT %I',
      r.conname
    );
    RAISE NOTICE 'Dropped constraint: %', r.conname;
  END LOOP;
END $$;

-- 2. Add updated CHECK with all valid statuses
ALTER TABLE invoices
  ADD CONSTRAINT invoices_status_check
  CHECK (status IN (
    'pending',
    'flagged',
    'approved',
    'rejected',
    'error',
    'synced',
    'deleted'
  ));

-- 3. Ensure reviewed columns exist (idempotent)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
