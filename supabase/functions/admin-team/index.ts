/**
 * Admin: Team member management.
 *
 * Auth: Supabase JWT + admin role check.
 * Deploy with --no-verify-jwt.
 *
 * GET    — List team members for the admin's customer_id
 * POST   { email, role } — Invite a new team member
 * PUT    { user_id, role } — Change a member's role
 * DELETE { user_id } — Remove a team member
 */

import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyJwt, requireAdmin, AuthError } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VALID_ROLES = ["admin", "viewer"];

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    const { user } = await verifyJwt(req);
    requireAdmin(user);

    const customerId = user.app_metadata?.customer_id as string;
    if (!customerId) {
      return new Response(
        JSON.stringify({ error: "No customer_id in user metadata" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ----------------------------------------------------------------
    // GET — List team members
    // ----------------------------------------------------------------
    if (req.method === "GET") {
      const { data: { users }, error: listError } = await supabase.auth.admin.listUsers({
        perPage: 1000,
      });

      if (listError) {
        throw new Error(`Failed to list users: ${listError.message}`);
      }

      // Filter to users belonging to this customer
      const members = users
        .filter((u: any) => u.app_metadata?.customer_id === customerId)
        .map((u: any) => ({
          id: u.id,
          email: u.email,
          role: u.app_metadata?.role || "viewer",
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at,
        }));

      return new Response(
        JSON.stringify({ members }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // POST — Invite new team member
    // ----------------------------------------------------------------
    if (req.method === "POST") {
      const body = await req.json();
      const { email, role } = body;

      if (!email || typeof email !== "string") {
        return new Response(
          JSON.stringify({ error: "email is required" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (!role || !VALID_ROLES.includes(role)) {
        return new Response(
          JSON.stringify({ error: `role must be one of: ${VALID_ROLES.join(", ")}` }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Invite user via Supabase Auth admin API
      const { data: inviteData, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(
        email,
        { data: { role, customer_id: customerId } },
      );

      if (inviteError) {
        console.error("Invite error:", inviteError.message);

        if (inviteError.message.includes("already been registered")) {
          return new Response(
            JSON.stringify({ error: "A user with this email already exists" }),
            { status: 409, headers: { ...headers, "Content-Type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({ error: "Failed to invite user" }),
          { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Set app_metadata (inviteUserByEmail sets user_metadata via data, not app_metadata)
      if (inviteData?.user?.id) {
        const { error: metaError } = await supabase.auth.admin.updateUserById(
          inviteData.user.id,
          { app_metadata: { role, customer_id: customerId } },
        );

        if (metaError) {
          console.error("Failed to set app_metadata:", metaError.message);
        }
      }

      return new Response(
        JSON.stringify({
          member: {
            id: inviteData?.user?.id,
            email,
            role,
            created_at: inviteData?.user?.created_at,
          },
        }),
        { status: 201, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // PUT — Change member role
    // ----------------------------------------------------------------
    if (req.method === "PUT") {
      const body = await req.json();
      const { user_id, role } = body;

      if (!user_id || typeof user_id !== "string") {
        return new Response(
          JSON.stringify({ error: "user_id is required" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (!role || !VALID_ROLES.includes(role)) {
        return new Response(
          JSON.stringify({ error: `role must be one of: ${VALID_ROLES.join(", ")}` }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Prevent changing own role
      if (user_id === user.id) {
        return new Response(
          JSON.stringify({ error: "Cannot change your own role" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Verify target user belongs to same customer
      const { data: { user: targetUser }, error: getUserError } = await supabase.auth.admin.getUserById(user_id);

      if (getUserError || !targetUser) {
        return new Response(
          JSON.stringify({ error: "User not found" }),
          { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (targetUser.app_metadata?.customer_id !== customerId) {
        return new Response(
          JSON.stringify({ error: "User not found" }),
          { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      const { error: updateError } = await supabase.auth.admin.updateUserById(user_id, {
        app_metadata: { ...targetUser.app_metadata, role },
      });

      if (updateError) {
        throw new Error(`Failed to update user role: ${updateError.message}`);
      }

      return new Response(
        JSON.stringify({ success: true, user_id, role }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    // ----------------------------------------------------------------
    // DELETE — Remove team member
    // ----------------------------------------------------------------
    if (req.method === "DELETE") {
      const body = await req.json();
      const { user_id } = body;

      if (!user_id || typeof user_id !== "string") {
        return new Response(
          JSON.stringify({ error: "user_id is required" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Prevent deleting self
      if (user_id === user.id) {
        return new Response(
          JSON.stringify({ error: "Cannot remove yourself" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      // Verify target user belongs to same customer
      const { data: { user: targetUser }, error: getUserError } = await supabase.auth.admin.getUserById(user_id);

      if (getUserError || !targetUser) {
        return new Response(
          JSON.stringify({ error: "User not found" }),
          { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      if (targetUser.app_metadata?.customer_id !== customerId) {
        return new Response(
          JSON.stringify({ error: "User not found" }),
          { status: 404, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }

      const { error: deleteError } = await supabase.auth.admin.deleteUser(user_id);

      if (deleteError) {
        throw new Error(`Failed to delete user: ${deleteError.message}`);
      }

      return new Response(
        JSON.stringify({ success: true, user_id }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

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
    console.error("admin-team error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
