import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get customer count
    const { count: customerCount } = await supabase
      .from("customers")
      .select("*", { count: "exact", head: true })
      .eq("is_active", true);

    // Get invoice stats
    const { data: invoiceStats } = await supabase
      .from("invoices")
      .select("status, total, currency");

    const totalInvoices = invoiceStats?.length || 0;
    const pendingInvoices = invoiceStats?.filter((i) => i.status === "pending").length || 0;
    const approvedInvoices = invoiceStats?.filter((i) => i.status === "approved").length || 0;
    const syncedInvoices = invoiceStats?.filter((i) => i.status === "synced").length || 0;
    const flaggedInvoices = invoiceStats?.filter((i) => i.status === "flagged").length || 0;

    // Calculate total value (USD only for simplicity)
    const totalValue = invoiceStats
      ?.filter((i) => i.currency === "USD")
      .reduce((sum, i) => sum + (i.total || 0), 0) || 0;

    // Get recent invoices
    const { data: recentInvoices } = await supabase
      .from("invoices")
      .select(`
        id,
        invoice_number,
        total,
        currency,
        status,
        created_at,
        customers (name)
      `)
      .order("created_at", { ascending: false })
      .limit(10);

    // Get recent processing logs for errors
    const { data: recentErrors } = await supabase
      .from("processing_logs")
      .select("*")
      .eq("status", "error")
      .order("created_at", { ascending: false })
      .limit(5);

    // Get invoices processed today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { count: todayCount } = await supabase
      .from("invoices")
      .select("*", { count: "exact", head: true })
      .gte("created_at", today.toISOString());

    return new Response(
      JSON.stringify({
        stats: {
          total_customers: customerCount || 0,
          total_invoices: totalInvoices,
          invoices_today: todayCount || 0,
          pending_approval: pendingInvoices,
          approved: approvedInvoices,
          synced: syncedInvoices,
          flagged: flaggedInvoices,
          total_value_usd: totalValue,
        },
        recent_invoices: recentInvoices?.map((inv) => ({
          id: inv.id,
          invoice_number: inv.invoice_number,
          total: inv.total,
          currency: inv.currency,
          status: inv.status,
          created_at: inv.created_at,
          customer_name: inv.customers?.name || "Unknown",
        })) || [],
        recent_errors: recentErrors || [],
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: corsHeaders }
    );
  }
});
