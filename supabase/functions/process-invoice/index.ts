/**
 * Unified invoice processing pipeline — HTTP endpoint.
 *
 * This is a thin wrapper around the shared handler in _shared/process-invoice-handler.ts.
 * The handler is shared so poll-emails can also call it directly without HTTP overhead.
 *
 * Deploy: supabase functions deploy process-invoice --no-verify-jwt
 */

import { handleProcessInvoice } from "../_shared/process-invoice-handler.ts";

Deno.serve(handleProcessInvoice);
