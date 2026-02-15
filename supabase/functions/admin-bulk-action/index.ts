/**
 * Admin: Bulk invoice operations — approve, reject, soft-delete, or export as CSV.
 *
 * Auth: Supabase JWT + admin role check.
 * Deploy WITHOUT --no-verify-jwt.
 *
 * POST { action: "approve" | "reject" | "delete" | "export_csv", invoice_ids: string[] }
 *
 * Returns:
 *   - approve/reject/delete: { success: true, processed: number, errors: [...] }
 *   - export_csv: CSV text response (text/csv)
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyJwt, requireAdmin, AuthError } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_ACTIONS = ["approve", "reject", "delete", "export_csv"] as const;
type BulkAction = (typeof VALID_ACTIONS)[number];

const MAX_BATCH_SIZE = 100;

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    const { user } = await verifyJwt(req);
    requireAdmin(user);

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json();
    const { action, invoice_ids } = body as {
      action: string;
      invoice_ids: string[];
    };

    // --- Validation ---
    if (!action || !VALID_ACTIONS.includes(action as BulkAction)) {
      return new Response(
        JSON.stringify({
          error: `action must be one of: ${VALID_ACTIONS.join(", ")}`,
        }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (!Array.isArray(invoice_ids) || invoice_ids.length === 0) {
      return new Response(
        JSON.stringify({ error: "invoice_ids must be a non-empty array" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (invoice_ids.length > MAX_BATCH_SIZE) {
      return new Response(
        JSON.stringify({
          error: `Maximum batch size is ${MAX_BATCH_SIZE} invoices`,
        }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // Validate every ID is a proper UUID
    const invalidIds = invoice_ids.filter((id) => !UUID_RE.test(id));
    if (invalidIds.length > 0) {
      return new Response(
        JSON.stringify({
          error: "All invoice_ids must be valid UUIDs",
          invalid_ids: invalidIds,
        }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // export_csv — fetch and return CSV text
    // ----------------------------------------------------------------
    if (action === "export_csv") {
      const { data: invoices, error: fetchError } = await supabase
        .from("invoices")
        .select("*, vendors(name)")
        .in("id", invoice_ids);

      if (fetchError) {
        throw new Error(`Failed to fetch invoices: ${fetchError.message}`);
      }

      if (!invoices || invoices.length === 0) {
        return new Response(
          JSON.stringify({ error: "No invoices found for the given IDs" }),
          { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      const csv = buildCsv(invoices);

      return new Response(csv, {
        status: 200,
        headers: {
          ...headers,
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="invoices_export_${Date.now()}.csv"`,
        },
      });
    }

    // ----------------------------------------------------------------
    // approve / reject / delete — batch status update
    // ----------------------------------------------------------------
    const statusMap: Record<string, string> = {
      approve: "approved",
      reject: "rejected",
      delete: "deleted",
    };
    const newStatus = statusMap[action];

    const processed: string[] = [];
    const errors: Array<{ invoice_id: string; error: string }> = [];

    for (const invoiceId of invoice_ids) {
      try {
        // Fetch current invoice to get customer_id for the log
        const { data: existing, error: existingError } = await supabase
          .from("invoices")
          .select("id, customer_id, status")
          .eq("id", invoiceId)
          .single();

        if (existingError || !existing) {
          errors.push({ invoice_id: invoiceId, error: "Invoice not found" });
          continue;
        }

        // Build the update payload
        const updatePayload: Record<string, unknown> = {
          status: newStatus,
          updated_at: new Date().toISOString(),
        };

        // For approve/reject, also record who reviewed it
        if (action === "approve" || action === "reject") {
          updatePayload.reviewed_by = user.email;
          updatePayload.reviewed_at = new Date().toISOString();
        }

        const { error: updateError } = await supabase
          .from("invoices")
          .update(updatePayload)
          .eq("id", invoiceId);

        if (updateError) {
          errors.push({ invoice_id: invoiceId, error: updateError.message });
          continue;
        }

        // Log the action to processing_logs
        await supabase.from("processing_logs").insert({
          customer_id: existing.customer_id,
          invoice_id: invoiceId,
          step: `admin_bulk_${action}`,
          status: "success",
          input: {
            action,
            previous_status: existing.status,
            admin_user_id: user.id,
            admin_email: user.email,
          },
        });

        processed.push(invoiceId);
      } catch (err) {
        errors.push({
          invoice_id: invoiceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        action,
        processed: processed.length,
        errors,
      }),
      { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    console.error("admin-bulk-action error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to process bulk action" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});

// --- Helpers ---

/**
 * Escape a value for CSV output.
 * Wraps in double-quotes if it contains commas, quotes, or newlines.
 */
function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build a CSV string from an array of invoice records.
 */
function buildCsv(
  invoices: Array<Record<string, unknown>>,
): string {
  const columns = [
    "id",
    "customer_id",
    "vendor_name",
    "invoice_number",
    "invoice_date",
    "due_date",
    "currency",
    "subtotal",
    "tax",
    "total",
    "status",
    "confidence",
    "is_valid",
    "validation_errors",
    "validation_warnings",
    "line_items",
    "source_email_subject",
    "reviewed_by",
    "reviewed_at",
    "external_accounting_id",
    "synced_at",
    "created_at",
    "updated_at",
  ];

  const headerRow = columns.join(",");

  const dataRows = invoices.map((inv) => {
    return columns
      .map((col) => {
        if (col === "vendor_name") {
          // vendor name comes from the join
          const vendor = inv.vendors as { name: string } | null;
          return escapeCsvValue(vendor?.name ?? "");
        }
        return escapeCsvValue(inv[col]);
      })
      .join(",");
  });

  return [headerRow, ...dataRows].join("\n");
}
