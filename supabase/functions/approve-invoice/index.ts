/**
 * Admin: Approve/reject invoices, edit invoice fields, and fetch full invoice details.
 *
 * Auth: Supabase JWT + admin role check.
 * Deploy WITHOUT --no-verify-jwt.
 *
 * GET   ?invoice_id=uuid  — returns full invoice record
 * POST  { invoice_id, action: "approve" | "reject" } — updates status + logs action
 * PATCH { invoice_id, updates: { invoice_number?, currency?, invoice_date?, due_date?, subtotal?, tax?, total? } } — edits invoice fields
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyJwt, requireAdmin, requireRole, AuthError } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    const { user } = await verifyJwt(req);

    // GET (view invoice) — admins and viewers; POST/PATCH/DELETE (actions) — admins only
    if (req.method === "GET") {
      requireRole(user, ["admin", "viewer"]);
    } else {
      requireAdmin(user);
    }

    // Use service role for all DB operations (RLS only allows service_role)
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ----------------------------------------------------------------
    // GET — fetch full invoice record
    // ----------------------------------------------------------------
    if (req.method === "GET") {
      const url = new URL(req.url);
      const invoiceId = url.searchParams.get("invoice_id");

      if (!invoiceId) {
        return new Response(
          JSON.stringify({ error: "invoice_id query parameter is required" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (!UUID_RE.test(invoiceId)) {
        return new Response(
          JSON.stringify({ error: "invoice_id must be a valid UUID" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      const { data: invoice, error: fetchError } = await supabase
        .from("invoices")
        .select("*, vendors(name)")
        .eq("id", invoiceId)
        .single();

      if (fetchError || !invoice) {
        return new Response(
          JSON.stringify({ error: "Invoice not found" }),
          { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ invoice }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // PATCH — edit invoice fields
    // ----------------------------------------------------------------
    if (req.method === "PATCH") {
      const body = await req.json();
      const { invoice_id, updates } = body;

      // --- Validate invoice_id ---
      if (!invoice_id) {
        return new Response(
          JSON.stringify({ error: "invoice_id is required" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (!UUID_RE.test(invoice_id)) {
        return new Response(
          JSON.stringify({ error: "invoice_id must be a valid UUID" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // --- Validate updates object ---
      if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
        return new Response(
          JSON.stringify({ error: "updates object is required" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      const ALLOWED_FIELDS = [
        "invoice_number",
        "currency",
        "invoice_date",
        "due_date",
        "subtotal",
        "tax",
        "total",
        "document_type",
      ];

      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      const CURRENCY_RE = /^[A-Z]{3}$/;

      // Only keep allowed fields, reject unknown keys
      const unknownKeys = Object.keys(updates).filter(
        (k) => !ALLOWED_FIELDS.includes(k),
      );
      if (unknownKeys.length > 0) {
        return new Response(
          JSON.stringify({
            error: `Unknown update fields: ${unknownKeys.join(", ")}`,
          }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Build sanitized update payload with field-level validation
      const sanitized: Record<string, unknown> = {};
      const validationErrors: string[] = [];

      for (const key of Object.keys(updates)) {
        const value = updates[key];

        // Allow null for any field (clears the value)
        if (value === null) {
          sanitized[key] = null;
          continue;
        }

        switch (key) {
          case "invoice_number":
            if (typeof value !== "string") {
              validationErrors.push("invoice_number must be a string");
            } else {
              sanitized[key] = value;
            }
            break;

          case "currency":
            if (typeof value !== "string" || !CURRENCY_RE.test(value)) {
              validationErrors.push(
                "currency must be a 3-letter uppercase code (e.g. USD)",
              );
            } else {
              sanitized[key] = value;
            }
            break;

          case "invoice_date":
          case "due_date":
            if (typeof value !== "string" || !DATE_RE.test(value)) {
              validationErrors.push(`${key} must be in YYYY-MM-DD format`);
            } else {
              // Verify it parses to a real date
              const parsed = new Date(value + "T00:00:00Z");
              if (isNaN(parsed.getTime())) {
                validationErrors.push(`${key} is not a valid date`);
              } else {
                sanitized[key] = value;
              }
            }
            break;

          case "subtotal":
          case "tax":
          case "total":
            if (typeof value !== "number" || !isFinite(value)) {
              validationErrors.push(`${key} must be a finite number`);
            } else if (value < 0) {
              validationErrors.push(`${key} must not be negative`);
            } else {
              sanitized[key] = value;
            }
            break;

          case "document_type":
            if (typeof value !== "string" || !["invoice", "expense"].includes(value)) {
              validationErrors.push('document_type must be "invoice" or "expense"');
            } else {
              sanitized[key] = value;
            }
            break;
        }
      }

      if (validationErrors.length > 0) {
        return new Response(
          JSON.stringify({ error: validationErrors.join("; ") }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (Object.keys(sanitized).length === 0) {
        return new Response(
          JSON.stringify({ error: "No valid fields to update" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // --- Fetch existing invoice to verify it exists and get customer_id ---
      const { data: existing, error: existingError } = await supabase
        .from("invoices")
        .select("id, customer_id")
        .eq("id", invoice_id)
        .single();

      if (existingError || !existing) {
        return new Response(
          JSON.stringify({ error: "Invoice not found" }),
          { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // --- Update the invoice ---
      sanitized.updated_at = new Date().toISOString();

      const { data: updated, error: updateError } = await supabase
        .from("invoices")
        .update(sanitized)
        .eq("id", invoice_id)
        .select("*, vendors(name)")
        .single();

      if (updateError) {
        throw new Error(`Failed to update invoice: ${updateError.message}`);
      }

      // --- Log the edit action to processing_logs ---
      await supabase.from("processing_logs").insert({
        customer_id: existing.customer_id,
        invoice_id: invoice_id,
        step: "admin_edit",
        status: "success",
        input: {
          action: "edit",
          admin_user_id: user.id,
          admin_email: user.email,
          updated_fields: Object.keys(sanitized).filter((k) => k !== "updated_at"),
        },
      });

      return new Response(
        JSON.stringify({ invoice: updated }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // POST — approve or reject invoice
    // ----------------------------------------------------------------
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { invoice_id, action } = body;

    // --- Validation ---
    if (!invoice_id) {
      return new Response(
        JSON.stringify({ error: "invoice_id is required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (!UUID_RE.test(invoice_id)) {
      return new Response(
        JSON.stringify({ error: "invoice_id must be a valid UUID" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (!action || !["approve", "reject"].includes(action)) {
      return new Response(
        JSON.stringify({ error: 'action must be "approve" or "reject"' }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Fetch current invoice to verify it exists ---
    const { data: existing, error: existingError } = await supabase
      .from("invoices")
      .select("id, customer_id")
      .eq("id", invoice_id)
      .single();

    if (existingError || !existing) {
      return new Response(
        JSON.stringify({ error: "Invoice not found" }),
        { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Update invoice status ---
    const newStatus = action === "approve" ? "approved" : "rejected";

    const { data: updated, error: updateError } = await supabase
      .from("invoices")
      .update({
        status: newStatus,
        updated_at: new Date().toISOString(),
        reviewed_by: user.email,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", invoice_id)
      .select("*")
      .single();

    if (updateError) throw new Error(`Failed to update invoice: ${updateError.message}`);

    // --- Log the action to processing_logs ---
    await supabase.from("processing_logs").insert({
      customer_id: existing.customer_id,
      invoice_id: invoice_id,
      step: `admin_${action}`,
      status: "success",
      input: { action, admin_user_id: user.id, admin_email: user.email },
    });

    // --- Auto-sync to QuickBooks on approval ---
    let syncResult: { synced?: boolean; error?: string } = {};
    if (action === "approve") {
      try {
        // Check if customer has an active accounting connection
        const { data: conn } = await supabase
          .from("accounting_connections")
          .select("id, provider")
          .eq("customer_id", existing.customer_id)
          .eq("is_active", true)
          .single();

        if (conn) {
          // Call the sync function internally
          const syncUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/admin-accounting-sync`;
          const syncRes = await fetch(syncUrl, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${req.headers.get("Authorization")?.replace("Bearer ", "") ?? ""}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action: "sync",
              invoice_ids: [invoice_id],
            }),
          });

          if (syncRes.ok) {
            const syncData = await syncRes.json();
            syncResult = { synced: true, ...syncData };
            console.log(`Auto-synced invoice ${invoice_id} to ${conn.provider}`);
          } else {
            const errText = await syncRes.text();
            syncResult = { synced: false, error: `Sync returned ${syncRes.status}` };
            console.error(`Auto-sync failed for ${invoice_id}:`, errText);
          }
        }
      } catch (syncErr) {
        syncResult = { synced: false, error: "Sync call failed" };
        console.error("Auto-sync error:", syncErr);
      }
    }

    return new Response(
      JSON.stringify({ invoice: updated, sync: syncResult }),
      { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    console.error("approve-invoice error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to process action" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
