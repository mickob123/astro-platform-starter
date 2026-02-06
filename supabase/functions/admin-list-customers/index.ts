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

    // Get all customers with invoice counts
    const { data: customers, error } = await supabase
      .from("customers")
      .select(`
        id,
        name,
        slug,
        email,
        accounting_platform,
        slack_webhook_url,
        is_active,
        created_at,
        invoices (count)
      `)
      .order("created_at", { ascending: false });

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Transform the data
    const result = customers.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      email: c.email,
      accounting_platform: c.accounting_platform,
      has_slack: !!c.slack_webhook_url,
      is_active: c.is_active,
      created_at: c.created_at,
      invoice_count: c.invoices?.[0]?.count || 0,
    }));

    return new Response(
      JSON.stringify({ customers: result }),
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
