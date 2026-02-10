/**
 * Smart duplicate detection for invoices.
 *
 * Checks incoming invoice data against existing invoices to detect duplicates
 * with varying confidence levels:
 *
 *   1.0  — Exact invoice_number + same vendor (definite duplicate)
 *   0.95 — Same vendor + same total + same date (likely duplicate)
 *   0.80 — Same vendor + same total + within 7 days (probable duplicate)
 *   0.60 — Same vendor + total within 1% + within 30 days (possible duplicate)
 *
 * Security:
 *   - API key auth (same as process-invoice)
 *   - All queries scoped to authenticated customer_id (tenant isolation)
 *   - Uses service_role Supabase client
 *
 * Request: POST with JSON body:
 *   { customer_id, vendor_name, invoice_number, total, invoice_date, vendor_id }
 *
 * Response:
 *   { is_duplicate, confidence, matches, reason }
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyApiKey, AuthError } from "../_shared/auth.ts";

interface DuplicateCheckRequest {
  customer_id: string;
  vendor_name?: string;
  invoice_number?: string;
  total: number;
  invoice_date: string;
  vendor_id?: string;
}

interface MatchedInvoice {
  id: string;
  invoice_number: string | null;
  total: number;
  invoice_date: string | null;
  vendor_id: string | null;
  confidence: number;
  reason: string;
}

interface DuplicateCheckResponse {
  is_duplicate: boolean;
  confidence: number;
  matches: MatchedInvoice[];
  reason: string;
}

/** Number of milliseconds in one day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

Deno.serve(async (req: Request) => {
  // --- CORS ---
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    // --- Auth ---
    const auth = await verifyApiKey(req);
    const supabase = auth.supabase;
    const authenticatedCustomerId = auth.customer_id;

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body: DuplicateCheckRequest = await req.json();
    const { customer_id, vendor_name, invoice_number, total, invoice_date, vendor_id } = body;

    // --- Input validation ---
    if (!customer_id) {
      return new Response(
        JSON.stringify({ error: "customer_id is required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // Enforce tenant isolation: the customer_id in the body must match the
    // authenticated customer from the API key. This prevents a caller from
    // probing another tenant's invoices.
    if (customer_id !== authenticatedCustomerId) {
      return new Response(
        JSON.stringify({ error: "customer_id does not match authenticated tenant" }),
        { status: 403, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (total === undefined || total === null || typeof total !== "number") {
      return new Response(
        JSON.stringify({ error: "total is required and must be a number" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (!invoice_date) {
      return new Response(
        JSON.stringify({ error: "invoice_date is required (YYYY-MM-DD)" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Resolve vendor_id if only vendor_name was provided ---
    let resolvedVendorId = vendor_id || null;
    if (!resolvedVendorId && vendor_name) {
      const normalizedName = vendor_name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-");
      const { data: vendorData } = await supabase
        .from("vendors")
        .select("id")
        .eq("customer_id", customer_id)
        .eq("normalized_name", normalizedName)
        .single();
      resolvedVendorId = vendorData?.id || null;
    }

    // If we cannot identify a vendor, we cannot do meaningful duplicate detection
    // beyond exact invoice_number match. We still check invoice_number if provided.
    const matches: MatchedInvoice[] = [];

    // --- Check 1: Exact invoice_number match (with vendor if available) ---
    if (invoice_number && invoice_number.trim() !== "") {
      let query = supabase
        .from("invoices")
        .select("id, invoice_number, total, invoice_date, vendor_id")
        .eq("customer_id", customer_id)
        .eq("invoice_number", invoice_number);

      if (resolvedVendorId) {
        query = query.eq("vendor_id", resolvedVendorId);
      }

      const { data: exactMatches, error: exactError } = await query;

      if (exactError) {
        console.error("Exact match query failed:", exactError.message);
      } else if (exactMatches && exactMatches.length > 0) {
        for (const inv of exactMatches) {
          matches.push({
            id: inv.id,
            invoice_number: inv.invoice_number,
            total: inv.total,
            invoice_date: inv.invoice_date,
            vendor_id: inv.vendor_id,
            confidence: 1.0,
            reason: resolvedVendorId
              ? "Exact invoice number match from same vendor"
              : "Exact invoice number match",
          });
        }
      }
    }

    // --- Fuzzy checks require a vendor_id to be meaningful ---
    if (resolvedVendorId) {
      const invoiceDateMs = new Date(invoice_date).getTime();

      // Fetch candidate invoices: same customer + same vendor
      // We scope the query to a reasonable date range (within 30 days) to limit
      // the result set and avoid scanning the entire table.
      const windowStart = new Date(invoiceDateMs - 30 * MS_PER_DAY).toISOString().split("T")[0];
      const windowEnd = new Date(invoiceDateMs + 30 * MS_PER_DAY).toISOString().split("T")[0];

      const { data: candidates, error: candidatesError } = await supabase
        .from("invoices")
        .select("id, invoice_number, total, invoice_date, vendor_id")
        .eq("customer_id", customer_id)
        .eq("vendor_id", resolvedVendorId)
        .gte("invoice_date", windowStart)
        .lte("invoice_date", windowEnd);

      if (candidatesError) {
        console.error("Candidate query failed:", candidatesError.message);
      } else if (candidates && candidates.length > 0) {
        for (const inv of candidates) {
          // Skip if this invoice was already matched as an exact invoice_number match
          if (matches.some((m) => m.id === inv.id)) continue;

          const candidateDateMs = new Date(inv.invoice_date).getTime();
          const daysDiff = Math.abs(invoiceDateMs - candidateDateMs) / MS_PER_DAY;
          const amountDiffPct = inv.total > 0
            ? Math.abs(inv.total - total) / inv.total
            : (total === 0 ? 0 : 1);

          // Check 2: Same vendor + same total + same date = 0.95
          if (inv.total === total && daysDiff === 0) {
            matches.push({
              id: inv.id,
              invoice_number: inv.invoice_number,
              total: inv.total,
              invoice_date: inv.invoice_date,
              vendor_id: inv.vendor_id,
              confidence: 0.95,
              reason: "Same vendor, same total, and same invoice date",
            });
            continue;
          }

          // Check 3: Same vendor + same total + within 7 days = 0.80
          if (inv.total === total && daysDiff <= 7) {
            matches.push({
              id: inv.id,
              invoice_number: inv.invoice_number,
              total: inv.total,
              invoice_date: inv.invoice_date,
              vendor_id: inv.vendor_id,
              confidence: 0.80,
              reason: `Same vendor and total, dates ${daysDiff.toFixed(0)} days apart`,
            });
            continue;
          }

          // Check 4: Same vendor + total within 1% + within 30 days = 0.60
          if (amountDiffPct <= 0.01 && daysDiff <= 30) {
            matches.push({
              id: inv.id,
              invoice_number: inv.invoice_number,
              total: inv.total,
              invoice_date: inv.invoice_date,
              vendor_id: inv.vendor_id,
              confidence: 0.60,
              reason: `Same vendor, total within 1% ($${inv.total} vs $${total}), dates ${daysDiff.toFixed(0)} days apart`,
            });
            continue;
          }
        }
      }
    }

    // --- Build response ---
    // Sort matches by confidence descending so the strongest match is first
    matches.sort((a, b) => b.confidence - a.confidence);

    const highestConfidence = matches.length > 0 ? matches[0].confidence : 0;
    const isDuplicate = highestConfidence >= 0.6;

    let reason: string;
    if (matches.length === 0) {
      reason = "No duplicate matches found";
    } else if (matches.length === 1) {
      reason = matches[0].reason;
    } else {
      reason = `${matches.length} potential matches found. Strongest: ${matches[0].reason}`;
    }

    const response: DuplicateCheckResponse = {
      is_duplicate: isDuplicate,
      confidence: highestConfidence,
      matches,
      reason,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    console.error("check-duplicate error:", error);
    return new Response(
      JSON.stringify({ error: "Duplicate check failed" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
