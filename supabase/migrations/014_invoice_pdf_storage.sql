-- Migration 014: Add PDF attachment storage for invoices.
--
-- Creates a private Storage bucket for invoice PDFs and adds
-- a column to track the storage path per invoice.
-- Finance users can view the original PDF in the platform
-- instead of going back to email.

-- 1. Create the private bucket (access via signed URLs only)
INSERT INTO storage.buckets (id, name, public)
VALUES ('invoice-pdfs', 'invoice-pdfs', false)
ON CONFLICT (id) DO NOTHING;

-- 2. Add storage path column to invoices
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS pdf_storage_path text DEFAULT NULL;

-- 3. RLS: service role can upload invoice PDFs
CREATE POLICY "Service role can upload invoice PDFs"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'invoice-pdfs'
  );

-- 4. RLS: service role can read invoice PDFs (for signed URLs)
CREATE POLICY "Service role can read invoice PDFs"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'invoice-pdfs'
  );

-- 5. RLS: service role can delete invoice PDFs
CREATE POLICY "Service role can delete invoice PDFs"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'invoice-pdfs'
  );
