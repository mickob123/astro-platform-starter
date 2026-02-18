-- Backfill pdf_storage_path for invoices created from poll-emails
-- (temp paths from poll-emails storage uploads)
UPDATE invoices SET pdf_storage_path = 'temp/45493521-4f7e-4ab6-8536-407e11e3ea6a/1771290590453_ticket1.pdf' WHERE id = '698db45b-8eb8-4791-9f6f-91702a39df4c';
UPDATE invoices SET pdf_storage_path = 'temp/45493521-4f7e-4ab6-8536-407e11e3ea6a/1771290591748_Aussie_Broadband_Invoice_45756615.pdf' WHERE id = 'a08d08c4-a4e8-494f-b9a0-ec78955dba48';
UPDATE invoices SET pdf_storage_path = 'temp/45493521-4f7e-4ab6-8536-407e11e3ea6a/1771290593904_ppmel_folio_opi63191309.pdf' WHERE id = '834e0a4e-394e-4a7f-98e8-ccda3569656d';
UPDATE invoices SET pdf_storage_path = 'temp/45493521-4f7e-4ab6-8536-407e11e3ea6a/1771290595137_Invoice_SINV1473293.pdf' WHERE id = '1ea44080-bc86-476e-a555-675eb15a3d33';
UPDATE invoices SET pdf_storage_path = 'temp/45493521-4f7e-4ab6-8536-407e11e3ea6a/1771290596800_77090137686_ELEC_2211437.PDF' WHERE id = 'faf5a8ed-586c-48ec-aed1-c96503c0c7f1';
UPDATE invoices SET pdf_storage_path = 'temp/45493521-4f7e-4ab6-8536-407e11e3ea6a/1771290592828_receipt.pdf' WHERE id = '04884b4d-3959-423f-b1d2-818677083413';
