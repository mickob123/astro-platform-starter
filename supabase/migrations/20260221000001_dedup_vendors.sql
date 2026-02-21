-- Merge duplicate vendors (same customer_id + normalized_name).
-- Keeps the vendor with the most invoices (or earliest created_at as tiebreak).
-- Reassigns invoices from duplicates to the keeper, then deletes duplicates.

DO $$
DECLARE
  dup RECORD;
  keeper_id uuid;
BEGIN
  -- Find all (customer_id, normalized_name) groups with more than 1 vendor
  FOR dup IN
    SELECT customer_id, normalized_name, COUNT(*) as cnt
    FROM vendors
    WHERE normalized_name IS NOT NULL AND normalized_name != ''
    GROUP BY customer_id, normalized_name
    HAVING COUNT(*) > 1
  LOOP
    -- Pick the keeper: the one with the most invoices, then earliest created_at
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

    -- Reassign all invoices from duplicate vendors to the keeper
    UPDATE invoices
    SET vendor_id = keeper_id
    WHERE vendor_id IN (
      SELECT id FROM vendors
      WHERE customer_id = dup.customer_id
        AND normalized_name = dup.normalized_name
        AND id != keeper_id
    );

    -- Delete the duplicate vendors
    DELETE FROM vendors
    WHERE customer_id = dup.customer_id
      AND normalized_name = dup.normalized_name
      AND id != keeper_id;

    RAISE NOTICE 'Merged % duplicate(s) for vendor "%" (customer %)',
      dup.cnt - 1, dup.normalized_name, dup.customer_id;
  END LOOP;
END $$;

-- Also clean up vendors with name 'Unknown Vendor' or 'Unknown' that have no invoices
DELETE FROM vendors
WHERE (name = 'Unknown Vendor' OR name = 'Unknown')
  AND id NOT IN (SELECT DISTINCT vendor_id FROM invoices WHERE vendor_id IS NOT NULL);
