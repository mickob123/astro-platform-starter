import type { Handler } from "@netlify/functions";
import { z } from "zod";

const InputSchema = z.object({
  vendor: z.string(),
  amount: z.number(),
  currency: z.string(),
  due_date: z.string(),
  invoice_number: z.string(),
  confidence: z.number().min(0).max(1),
  invoice_url: z.string(),
});

function formatCurrency(amount: number, currency: string): string {
  const symbols: Record<string, string> = {
    USD: "$",
    EUR: "€",
    GBP: "£",
    JPY: "¥",
    CAD: "C$",
    AUD: "A$",
  };
  const symbol = symbols[currency] || currency + " ";
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getConfidenceEmoji(confidence: number): string {
  if (confidence >= 0.9) return "🟢";
  if (confidence >= 0.7) return "🟡";
  return "🔴";
}

function getConfidenceLabel(confidence: number): string {
  if (confidence >= 0.9) return "High";
  if (confidence >= 0.7) return "Medium";
  return "Low";
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const input = InputSchema.parse(body);

    const blocks = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "📄 New Invoice Received",
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
            text: `*Amount:*\n${formatCurrency(input.amount, input.currency)}`,
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
        fields: [
          {
            type: "mrkdwn",
            text: `*Confidence:*\n${getConfidenceEmoji(input.confidence)} ${getConfidenceLabel(input.confidence)} (${(input.confidence * 100).toFixed(0)}%)`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<${input.invoice_url}|View Invoice Document>`,
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
              text: "✅ Approve",
              emoji: true,
            },
            style: "primary",
            action_id: "approve_invoice",
            value: input.invoice_number,
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "🚩 Flag for Review",
              emoji: true,
            },
            style: "danger",
            action_id: "flag_invoice",
            value: input.invoice_number,
          },
        ],
      },
    ];

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      statusCode: 400,
      body: JSON.stringify({ error: message }),
    };
  }
};
