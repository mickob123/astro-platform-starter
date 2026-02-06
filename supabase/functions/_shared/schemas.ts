export interface ClassifierInput {
  email_subject: string;
  email_body: string;
  attachment_text: string | null;
}

export interface ClassifierOutput {
  is_invoice: boolean;
  vendor_name: string | null;
  confidence: number;
  signals: string[];
}

export interface ExtractorInput {
  document_text: string;
}

export interface LineItem {
  description: string;
  quantity: number | null;
  unit_price: number | null;
  total: number;
}

export interface ExtractedInvoice {
  vendor_name: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  currency: string;
  line_items: LineItem[];
  subtotal: number;
  tax: number | null;
  total: number;
}

export interface ValidatorInput {
  invoice: ExtractedInvoice;
  existing_invoice_numbers: string[];
}

export interface ValidatorOutput {
  is_valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface SlackInput {
  vendor: string;
  amount: number;
  currency: string;
  due_date: string;
  invoice_number: string;
  confidence: number;
  invoice_url: string;
  invoice_id?: string;
  approve_url?: string;
  flag_url?: string;
}

export interface AccountingInput {
  invoice: ExtractedInvoice;
  vendor_id: string;
  account_code?: string;
  account_id?: string;
  business_id?: string;
  contact_id?: string;
  expense_category_id?: string;
  tax_type?: string;
}

export function validateClassifierInput(data: unknown): ClassifierInput {
  const input = data as Record<string, unknown>;
  if (typeof input.email_subject !== "string") {
    throw new Error("email_subject must be a string");
  }
  if (typeof input.email_body !== "string") {
    throw new Error("email_body must be a string");
  }
  if (input.attachment_text !== null && typeof input.attachment_text !== "string") {
    throw new Error("attachment_text must be a string or null");
  }
  return {
    email_subject: input.email_subject,
    email_body: input.email_body,
    attachment_text: input.attachment_text as string | null,
  };
}

export function validateExtractorInput(data: unknown): ExtractorInput {
  const input = data as Record<string, unknown>;
  if (typeof input.document_text !== "string") {
    throw new Error("document_text must be a string");
  }
  return { document_text: input.document_text };
}

export function validateInvoice(data: unknown): ExtractedInvoice {
  const inv = data as Record<string, unknown>;

  if (typeof inv.vendor_name !== "string") throw new Error("vendor_name must be string");
  if (typeof inv.invoice_number !== "string") throw new Error("invoice_number must be string");
  if (typeof inv.invoice_date !== "string") throw new Error("invoice_date must be string");
  if (inv.due_date !== null && typeof inv.due_date !== "string") throw new Error("due_date must be string or null");
  if (typeof inv.currency !== "string") throw new Error("currency must be string");
  if (!Array.isArray(inv.line_items)) throw new Error("line_items must be array");
  if (typeof inv.subtotal !== "number") throw new Error("subtotal must be number");
  if (inv.tax !== null && typeof inv.tax !== "number") throw new Error("tax must be number or null");
  if (typeof inv.total !== "number") throw new Error("total must be number");

  return inv as ExtractedInvoice;
}

export function validateValidatorInput(data: unknown): ValidatorInput {
  const input = data as Record<string, unknown>;
  const invoice = validateInvoice(input.invoice);

  if (!Array.isArray(input.existing_invoice_numbers)) {
    throw new Error("existing_invoice_numbers must be array");
  }

  return {
    invoice,
    existing_invoice_numbers: input.existing_invoice_numbers as string[],
  };
}

export function validateSlackInput(data: unknown): SlackInput {
  const input = data as Record<string, unknown>;

  if (typeof input.vendor !== "string") throw new Error("vendor must be string");
  if (typeof input.amount !== "number") throw new Error("amount must be number");
  if (typeof input.currency !== "string") throw new Error("currency must be string");
  if (typeof input.due_date !== "string") throw new Error("due_date must be string");
  if (typeof input.invoice_number !== "string") throw new Error("invoice_number must be string");
  if (typeof input.confidence !== "number") throw new Error("confidence must be number");
  if (typeof input.invoice_url !== "string") throw new Error("invoice_url must be string");

  return {
    vendor: input.vendor,
    amount: input.amount,
    currency: input.currency,
    due_date: input.due_date,
    invoice_number: input.invoice_number,
    confidence: input.confidence,
    invoice_url: input.invoice_url,
    invoice_id: input.invoice_id as string | undefined,
    approve_url: input.approve_url as string | undefined,
    flag_url: input.flag_url as string | undefined,
  };
}

export function validateAccountingInput(data: unknown): AccountingInput {
  const input = data as Record<string, unknown>;
  const invoice = validateInvoice(input.invoice);

  if (typeof input.vendor_id !== "string") throw new Error("vendor_id must be string");

  return {
    invoice,
    vendor_id: input.vendor_id,
    account_code: input.account_code as string | undefined,
    account_id: input.account_id as string | undefined,
    business_id: input.business_id as string | undefined,
    contact_id: input.contact_id as string | undefined,
    expense_category_id: input.expense_category_id as string | undefined,
    tax_type: input.tax_type as string | undefined,
  };
}
