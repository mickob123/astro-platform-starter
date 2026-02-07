/**
 * CORS configuration — locked down to specific origins.
 *
 * Set ALLOWED_ORIGINS as a comma-separated list in Supabase secrets:
 *   supabase secrets set ALLOWED_ORIGINS="https://your-admin.netlify.app,https://n8n.agentivegroup.ai"
 *
 * If ALLOWED_ORIGINS is not set, all cross-origin requests are rejected.
 */

const ALLOWED_ORIGINS: string[] = (Deno.env.get("ALLOWED_ORIGINS") || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const isAllowed = ALLOWED_ORIGINS.includes(origin);

  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-api-key",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: getCorsHeaders(req) });
  }
  return null;
}
