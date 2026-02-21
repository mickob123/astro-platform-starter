-- Step 1: Backfill normalized_name for all vendors where it's NULL or empty.
-- Replicates the TypeScript normalizeVendorName() logic in SQL:
--   1. Strip common business suffixes (PTY LTD, LTD, INC, LLC, CORP, etc.)
--   2. Lowercase
--   3. Trim
--   4. Replace non-alphanumeric with hyphens
--   5. Remove leading/trailing hyphens

UPDATE vendors
SET normalized_name = regexp_replace(
  regexp_replace(
    regexp_replace(
      lower(trim(
        regexp_replace(
          name,
          '\m(pty\.?\s*ltd\.?|ltd\.?|limited|inc\.?|incorporated|llc\.?|l\.l\.c\.?|corp\.?|corporation|plc\.?|co\.?\M)',
          '',
          'gi'
        )
      )),
      '[^a-z0-9]+', '-', 'g'
    ),
    '^-+', '', 'g'
  ),
  '-+$', '', 'g'
)
WHERE normalized_name IS NULL OR normalized_name = '';

-- Step 2: Re-run dedup merge (same logic as 20260221000001 but now catches
-- vendors that previously had NULL normalized_name).

DO $$
DECLARE
  dup RECORD;
  keeper_id uuid;
BEGIN
  FOR dup IN
    SELECT customer_id, normalized_name, COUNT(*) as cnt
    FROM vendors
    WHERE normalized_name IS NOT NULL AND normalized_name != ''
    GROUP BY customer_id, normalized_name
    HAVING COUNT(*) > 1
  LOOP
    -- Pick the keeper: most invoices, then earliest created_at
    SELECT v.id INTO keeper_id
    FROM vendors v
    LEFT JOIN (
      SELECT vendor_id, COUNT(*) as inv_count
      FROM invoices
      GROUP BY vendor_id
    ) ic ON ic.vendor_id = v.id
    WHERE v.customer_id = dup.customer_id
      AND v.normalized_name = dup.normalized_name
    ORDER BY COALESCE(ic.inv_count, 0) DESC, v.created_at ASC
    LIMIT 1;

    -- Reassign invoices from duplicates to the keeper
    UPDATE invoices
    SET vendor_id = keeper_id
    WHERE vendor_id IN (
      SELECT id FROM vendors
      WHERE customer_id = dup.customer_id
        AND normalized_name = dup.normalized_name
        AND id != keeper_id
    );

    -- Delete the duplicates
    DELETE FROM vendors
    WHERE customer_id = dup.customer_id
      AND normalized_name = dup.normalized_name
      AND id != keeper_id;

    RAISE NOTICE 'Merged % duplicate(s) for vendor "%" (customer %)',
      dup.cnt - 1, dup.normalized_name, dup.customer_id;
  END LOOP;
END $$;

-- Step 3: Clean up vendors with no name or 'Unknown' that have no invoices
DELETE FROM vendors
WHERE (name = 'Unknown Vendor' OR name = 'Unknown' OR name = '' OR name IS NULL)
  AND id NOT IN (SELECT DISTINCT vendor_id FROM invoices WHERE vendor_id IS NOT NULL);
