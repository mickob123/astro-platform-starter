/**
 * Admin: CRUD for approval rules.
 *
 * Auth: Supabase JWT + admin role check.
 *
 * GET                                                         — list all approval rules for the customer
 * POST  { name, min_amount, max_amount, required_approvers, approver_emails } — create a rule
 * PUT   { id, ...fields }                                     — update a rule
 * DELETE { id }                                                — delete a rule
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyJwt, requireAdmin, AuthError } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    const { user } = await verifyJwt(req);
    requireAdmin(user);

    const customerId = user.app_metadata?.customer_id as string | undefined;
    if (!customerId) {
      return new Response(
        JSON.stringify({ error: "User is not associated with a customer" }),
        { status: 403, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // Use service role for all DB operations
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ----------------------------------------------------------------
    // GET — list all approval rules for the customer
    // ----------------------------------------------------------------
    if (req.method === "GET") {
      const { data: rules, error: fetchError } = await supabase
        .from("approval_rules")
        .select("*")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false });

      if (fetchError) throw new Error(`Failed to fetch approval rules: ${fetchError.message}`);

      return new Response(
        JSON.stringify({ rules }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // POST — create a new approval rule
    // ----------------------------------------------------------------
    if (req.method === "POST") {
      const body = await req.json();
      const { name, min_amount, max_amount, required_approvers, approver_emails } = body;

      // --- Validation ---
      if (!name || typeof name !== "string" || name.trim().length === 0) {
        return new Response(
          JSON.stringify({ error: "name is required and must be a non-empty string" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (!approver_emails || !Array.isArray(approver_emails) || approver_emails.length === 0) {
        return new Response(
          JSON.stringify({ error: "approver_emails is required and must be a non-empty array" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (required_approvers != null && (typeof required_approvers !== "number" || required_approvers < 1)) {
        return new Response(
          JSON.stringify({ error: "required_approvers must be a positive integer" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (min_amount != null && (typeof min_amount !== "number" || min_amount < 0)) {
        return new Response(
          JSON.stringify({ error: "min_amount must be a non-negative number" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (max_amount != null && (typeof max_amount !== "number" || max_amount < 0)) {
        return new Response(
          JSON.stringify({ error: "max_amount must be a non-negative number" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      const { data: rule, error: insertError } = await supabase
        .from("approval_rules")
        .insert({
          customer_id: customerId,
          name: name.trim(),
          min_amount: min_amount ?? 0,
          max_amount: max_amount ?? null,
          required_approvers: required_approvers ?? 1,
          approver_emails,
          is_active: true,
        })
        .select("*")
        .single();

      if (insertError) throw new Error(`Failed to create approval rule: ${insertError.message}`);

      return new Response(
        JSON.stringify({ rule }),
        { status: 201, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // PUT — update an existing approval rule
    // ----------------------------------------------------------------
    if (req.method === "PUT") {
      const body = await req.json();
      const { id, ...updates } = body;

      if (!id) {
        return new Response(
          JSON.stringify({ error: "id is required" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (!UUID_RE.test(id)) {
        return new Response(
          JSON.stringify({ error: "id must be a valid UUID" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Verify the rule belongs to the user's customer
      const { data: existing, error: existingError } = await supabase
        .from("approval_rules")
        .select("id, customer_id")
        .eq("id", id)
        .eq("customer_id", customerId)
        .single();

      if (existingError || !existing) {
        return new Response(
          JSON.stringify({ error: "Approval rule not found" }),
          { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Build safe update object — only allow known fields
      const safeUpdates: Record<string, unknown> = {};
      if (updates.name !== undefined) safeUpdates.name = updates.name;
      if (updates.min_amount !== undefined) safeUpdates.min_amount = updates.min_amount;
      if (updates.max_amount !== undefined) safeUpdates.max_amount = updates.max_amount;
      if (updates.required_approvers !== undefined) safeUpdates.required_approvers = updates.required_approvers;
      if (updates.approver_emails !== undefined) safeUpdates.approver_emails = updates.approver_emails;
      if (updates.is_active !== undefined) safeUpdates.is_active = updates.is_active;
      safeUpdates.updated_at = new Date().toISOString();

      const { data: rule, error: updateError } = await supabase
        .from("approval_rules")
        .update(safeUpdates)
        .eq("id", id)
        .eq("customer_id", customerId)
        .select("*")
        .single();

      if (updateError) throw new Error(`Failed to update approval rule: ${updateError.message}`);

      return new Response(
        JSON.stringify({ rule }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // DELETE — remove an approval rule
    // ----------------------------------------------------------------
    if (req.method === "DELETE") {
      const body = await req.json();
      const { id } = body;

      if (!id) {
        return new Response(
          JSON.stringify({ error: "id is required" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (!UUID_RE.test(id)) {
        return new Response(
          JSON.stringify({ error: "id must be a valid UUID" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Verify the rule belongs to the user's customer before deleting
      const { data: existing, error: existingError } = await supabase
        .from("approval_rules")
        .select("id, customer_id")
        .eq("id", id)
        .eq("customer_id", customerId)
        .single();

      if (existingError || !existing) {
        return new Response(
          JSON.stringify({ error: "Approval rule not found" }),
          { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      const { error: deleteError } = await supabase
        .from("approval_rules")
        .delete()
        .eq("id", id)
        .eq("customer_id", customerId);

      if (deleteError) throw new Error(`Failed to delete approval rule: ${deleteError.message}`);

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // --- Unsupported method ---
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    console.error("admin-approval-rules error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to process request" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
