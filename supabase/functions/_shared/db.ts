import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export function getSupabaseClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  return createClient(supabaseUrl, supabaseKey);
}

export async function logProcessingStep(
  customerId: string,
  invoiceId: string | null,
  step: string,
  status: "started" | "success" | "error",
  input: unknown,
  output: unknown,
  errorMessage: string | null,
  durationMs: number | null
) {
  const supabase = getSupabaseClient();

  await supabase.from("processing_logs").insert({
    customer_id: customerId,
    invoice_id: invoiceId,
    step,
    status,
    input,
    output,
    error_message: errorMessage,
    duration_ms: durationMs,
  });
}

export async function getCustomerByApiKey(apiKeyHash: string) {
  const supabase = getSupabaseClient();

  const { data } = await supabase
    .from("api_keys")
    .select("customer_id, customers(*)")
    .eq("key_hash", apiKeyHash)
    .eq("is_active", true)
    .single();

  if (data) {
    await supabase
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("key_hash", apiKeyHash);
  }

  return data?.customers;
}

export async function getExistingInvoiceNumbers(customerId: string): Promise<string[]> {
  const supabase = getSupabaseClient();

  const { data } = await supabase
    .from("invoices")
    .select("invoice_number")
    .eq("customer_id", customerId)
    .not("invoice_number", "is", null);

  return (data || []).map((r) => r.invoice_number).filter(Boolean);
}

export async function findOrCreateVendor(
  customerId: string,
  vendorName: string
): Promise<{ id: string; accounting_vendor_id: string | null }> {
  const supabase = getSupabaseClient();
  const normalizedName = vendorName.toLowerCase().replace(/[^a-z0-9]/g, "");

  const { data: existing } = await supabase
    .from("vendors")
    .select("id, accounting_vendor_id")
    .eq("customer_id", customerId)
    .eq("normalized_name", normalizedName)
    .single();

  if (existing) {
    return existing;
  }

  const { data: created } = await supabase
    .from("vendors")
    .insert({
      customer_id: customerId,
      name: vendorName,
      normalized_name: normalizedName,
    })
    .select("id, accounting_vendor_id")
    .single();

  return created || { id: "", accounting_vendor_id: null };
}

export async function createInvoice(
  customerId: string,
  data: {
    source_email_id?: string;
    source_email_subject?: string;
    source_email_from?: string;
    vendor_id?: string;
    invoice_number?: string;
    invoice_date?: string;
    due_date?: string | null;
    currency?: string;
    subtotal?: number;
    tax?: number | null;
    total?: number;
    line_items?: unknown[];
    raw_text?: string;
    confidence?: number;
    signals?: string[];
    is_valid?: boolean;
    validation_errors?: string[];
    validation_warnings?: string[];
    status?: string;
  }
) {
  const supabase = getSupabaseClient();

  const { data: invoice, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: customerId,
      ...data,
    })
    .select()
    .single();

  if (error) throw error;
  return invoice;
}

export async function updateInvoice(
  invoiceId: string,
  data: Record<string, unknown>
) {
  const supabase = getSupabaseClient();

  const { data: invoice, error } = await supabase
    .from("invoices")
    .update(data)
    .eq("id", invoiceId)
    .select()
    .single();

  if (error) throw error;
  return invoice;
}
