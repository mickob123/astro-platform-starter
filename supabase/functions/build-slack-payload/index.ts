import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { validateSlackInput } from "../_shared/schemas.ts";
import { logProcessingStep } from "../_shared/db.ts";

function getConfidenceEmoji(confidence: number): string {
  if (confidence >= 0.9) return ":white_check_mark:";
  if (confidence >= 0.7) return ":large_yellow_circle:";
  return ":warning:";
}

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency,
  }).format(amount);
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const startTime = Date.now();
  const customerId = req.headers.get("x-customer-id") || "system";

  try {
    const body = await req.json();
    const input = validateSlackInput(body);

    await logProcessingStep(customerId, null, "slack_payload", "started", input, null, null, null);

    const confidencePercent = Math.round(input.confidence * 100);
    const confidenceEmoji = getConfidenceEmoji(input.confidence);
    const formattedAmount = formatCurrency(input.amount, input.currency);

    const blocks = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: ":page_facing_up: New Invoice Received",
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Vendor:*\n${input.vendor}`,
          },
          {
            type: "mrkdwn",
            text: `*Amount:*\n${formattedAmount}`,
          },
          {
            type: "mrkdwn",
            text: `*Invoice #:*\n${input.invoice_number}`,
          },
          {
            type: "mrkdwn",
            text: `*Due Date:*\n${input.due_date}`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${confidenceEmoji} *Confidence:* ${confidencePercent}%`,
        },
        accessory: {
          type: "button",
          text: {
            type: "plain_text",
            text: ":page_facing_up: View Invoice",
            emoji: true,
          },
          url: input.invoice_url,
          action_id: "view_invoice",
        },
      },
      {
        type: "divider",
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: ":white_check_mark: Approve",
              emoji: true,
            },
            style: "primary",
            action_id: "approve_invoice",
            value: input.invoice_id || input.invoice_number,
            ...(input.approve_url ? { url: input.approve_url } : {}),
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: ":flag-red: Flag for Review",
              emoji: true,
            },
            style: "danger",
            action_id: "flag_invoice",
            value: input.invoice_id || input.invoice_number,
            ...(input.flag_url ? { url: input.flag_url } : {}),
          },
        ],
      },
    ];

    const result = { blocks };

    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "slack_payload", "success", input, result, null, duration);

    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const duration = Date.now() - startTime;
    await logProcessingStep(customerId, null, "slack_payload", "error", null, null, message, duration);
    return errorResponse(message);
  }
});
