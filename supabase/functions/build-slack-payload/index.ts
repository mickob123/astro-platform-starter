import { getCorsHeaders, handleCors } from "../_shared/cors.ts";
import { verifyApiKey, AuthError } from "../_shared/auth.ts";

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const headers = getCorsHeaders(req);

  try {
    await verifyApiKey(req);

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { vendor, amount, currency, due_date, invoice_number, confidence, invoice_url } = body;

    if (!vendor || !amount || !currency || !invoice_number || confidence === undefined || !invoice_url) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: vendor, amount, currency, invoice_number, confidence, invoice_url" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    const formattedAmount = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(amount);

    const confidencePercent = Math.round(confidence * 100);
    const confidenceEmoji = confidence >= 0.9 ? ":white_check_mark:" : confidence >= 0.7 ? ":large_yellow_circle:" : ":warning:";
    const confidenceLabel = confidence >= 0.9 ? "High" : confidence >= 0.7 ? "Medium" : "Low";

    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: ":page_facing_up: New Invoice Received", emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Vendor:*\n${vendor}` },
          { type: "mrkdwn", text: `*Invoice #:*\n${invoice_number}` },
          { type: "mrkdwn", text: `*Amount:*\n${formattedAmount}` },
          { type: "mrkdwn", text: `*Due Date:*\n${due_date || "Not specified"}` },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `${confidenceEmoji} *Confidence:* ${confidenceLabel} (${confidencePercent}%)` },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "View Invoice", emoji: true },
          url: invoice_url,
          action_id: "view_invoice",
        },
      },
      { type: "divider" },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: ":white_check_mark: Approve", emoji: true },
            style: "primary",
            action_id: "approve_invoice",
            value: invoice_number,
          },
          {
            type: "button",
            text: { type: "plain_text", text: ":triangular_flag_on_post: Flag for Review", emoji: true },
            style: "danger",
            action_id: "flag_invoice",
            value: invoice_number,
          },
        ],
      },
    ];

    return new Response(
      JSON.stringify({ blocks }),
      { status: 200, headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    console.error("build-slack-payload error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to build Slack payload" }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
