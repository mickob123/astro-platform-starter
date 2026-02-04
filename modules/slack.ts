import { z } from "zod";

export const SlackInputSchema = z.object({
  vendor: z.string(),
  amount: z.number(),
  currency: z.string(),
  due_date: z.string(),
  invoice_number: z.string(),
  confidence: z.number().min(0).max(1),
  invoice_url: z.string(),
});

export const SlackBlockSchema = z.object({
  type: z.string(),
  text: z
    .object({
      type: z.string(),
      text: z.string(),
      emoji: z.boolean().optional(),
    })
    .optional(),
  elements: z.array(z.any()).optional(),
  accessory: z.any().optional(),
  fields: z.array(z.any()).optional(),
});

export const SlackOutputSchema = z.object({
  blocks: z.array(z.any()),
});

export type SlackInput = z.infer<typeof SlackInputSchema>;
export type SlackOutput = z.infer<typeof SlackOutputSchema>;

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency,
  }).format(amount);
}

function getConfidenceEmoji(confidence: number): string {
  if (confidence >= 0.9) return ":white_check_mark:";
  if (confidence >= 0.7) return ":large_yellow_circle:";
  return ":warning:";
}

function getConfidenceLabel(confidence: number): string {
  if (confidence >= 0.9) return "High";
  if (confidence >= 0.7) return "Medium";
  return "Low";
}

export function buildSlackNotification(input: SlackInput): SlackOutput {
  const validatedInput = SlackInputSchema.parse(input);

  const {
    vendor,
    amount,
    currency,
    due_date,
    invoice_number,
    confidence,
    invoice_url,
  } = validatedInput;

  const formattedAmount = formatCurrency(amount, currency);
  const confidencePercent = Math.round(confidence * 100);
  const confidenceEmoji = getConfidenceEmoji(confidence);
  const confidenceLabel = getConfidenceLabel(confidence);

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
          text: `*Vendor:*\n${vendor}`,
        },
        {
          type: "mrkdwn",
          text: `*Invoice #:*\n${invoice_number}`,
        },
        {
          type: "mrkdwn",
          text: `*Amount:*\n${formattedAmount}`,
        },
        {
          type: "mrkdwn",
          text: `*Due Date:*\n${due_date}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${confidenceEmoji} *Confidence:* ${confidenceLabel} (${confidencePercent}%)`,
      },
      accessory: {
        type: "button",
        text: {
          type: "plain_text",
          text: "View Invoice",
          emoji: true,
        },
        url: invoice_url,
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
          value: invoice_number,
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: ":triangular_flag_on_post: Flag for Review",
            emoji: true,
          },
          style: "danger",
          action_id: "flag_invoice",
          value: invoice_number,
        },
      ],
    },
  ];

  return SlackOutputSchema.parse({ blocks });
}
