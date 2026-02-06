-- Customers (your enterprise clients)
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    accounting_platform TEXT CHECK (accounting_platform IN ('quickbooks', 'xero', 'freshbooks', 'wave')),
    accounting_credentials JSONB DEFAULT '{}',
    slack_webhook_url TEXT,
    slack_channel TEXT,
    settings JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vendors (mapped per customer)
CREATE TABLE vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    accounting_vendor_id TEXT,
    default_category TEXT,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(customer_id, normalized_name)
);

-- Processed invoices
CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    vendor_id UUID REFERENCES vendors(id),

    -- Source info
    source_email_id TEXT,
    source_email_subject TEXT,
    source_email_from TEXT,
    attachment_url TEXT,

    -- Extracted data
    invoice_number TEXT,
    invoice_date DATE,
    due_date DATE,
    currency TEXT,
    subtotal DECIMAL(12,2),
    tax DECIMAL(12,2),
    total DECIMAL(12,2),
    line_items JSONB DEFAULT '[]',
    raw_text TEXT,

    -- Classification
    confidence DECIMAL(3,2),
    signals JSONB DEFAULT '[]',

    -- Validation
    is_valid BOOLEAN,
    validation_errors JSONB DEFAULT '[]',
    validation_warnings JSONB DEFAULT '[]',

    -- Status tracking
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'flagged', 'rejected', 'synced', 'error')),
    accounting_id TEXT,
    accounting_sync_at TIMESTAMPTZ,
    accounting_error TEXT,

    -- Approval
    approved_by TEXT,
    approved_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Processing logs (audit trail)
CREATE TABLE processing_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
    step TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('started', 'success', 'error')),
    input JSONB,
    output JSONB,
    error_message TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- API keys for customer access
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    name TEXT,
    last_used_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_created ON invoices(created_at DESC);
CREATE INDEX idx_vendors_customer ON vendors(customer_id);
CREATE INDEX idx_vendors_normalized ON vendors(customer_id, normalized_name);
CREATE INDEX idx_logs_invoice ON processing_logs(invoice_id);
CREATE INDEX idx_logs_customer ON processing_logs(customer_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

-- Row Level Security
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- Updated at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Function to normalize vendor names for matching
CREATE OR REPLACE FUNCTION normalize_vendor_name(name TEXT)
RETURNS TEXT AS $$
BEGIN
    RETURN LOWER(REGEXP_REPLACE(TRIM(name), '[^a-zA-Z0-9]', '', 'g'));
END;
$$ LANGUAGE plpgsql IMMUTABLE;
