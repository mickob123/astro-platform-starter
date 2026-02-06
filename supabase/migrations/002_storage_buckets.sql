-- Create storage bucket for invoice attachments
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'invoices',
    'invoices',
    false,
    10485760, -- 10MB limit
    ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp']
);

-- RLS policies for invoice attachments
-- Allow authenticated users to upload to their customer folder
CREATE POLICY "Customers can upload invoices" ON storage.objects
    FOR INSERT
    WITH CHECK (
        bucket_id = 'invoices' AND
        (storage.foldername(name))[1] IN (
            SELECT id::text FROM customers WHERE id IN (
                SELECT customer_id FROM api_keys WHERE key_hash = current_setting('request.headers')::json->>'x-api-key-hash'
            )
        )
    );

-- Allow customers to read their own invoices
CREATE POLICY "Customers can read own invoices" ON storage.objects
    FOR SELECT
    USING (
        bucket_id = 'invoices' AND
        (storage.foldername(name))[1] IN (
            SELECT id::text FROM customers WHERE id IN (
                SELECT customer_id FROM api_keys WHERE key_hash = current_setting('request.headers')::json->>'x-api-key-hash'
            )
        )
    );

-- Service role can do everything (for Edge Functions)
CREATE POLICY "Service role full access" ON storage.objects
    FOR ALL
    USING (auth.role() = 'service_role');
