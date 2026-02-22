# Competitive Analysis: Agentive Group Invoice Automation Platform
> **Date:** 2026-02-22
> **Prepared for:** Internal product review
> **Context:** Reframed for actual use case — SMB door-opener product for AI automation consulting sales

---

## The Reframe That Changes Everything

The previous analysis benchmarked you against Bill.com and Tipalti. That was the wrong frame. You're not building a SaaS business. You're building a **demonstration product** that:

1. Solves a real pain for a real client segment (trades, importers, SMBs drowning in supplier invoices)
2. Gets deployed and used by those clients as part of a broader AI automation engagement
3. Gives you something concrete to show when a builder asks "what does AI automation actually look like for my business?"

That's a completely different brief. And against *that* brief, where you actually are is much more useful than the previous analysis suggested.

---

## What You've Actually Built (Honest Inventory)

From the codebase — 27 migrations, 24 Edge Functions, live n8n workflow:

**Working:**
- Gmail polling via n8n (live, v5, running every minute)
- GPT-4o vision extraction from email body + PDF attachments
- Invoice classification (invoice vs. receipt vs. statement vs. irrelevant)
- Structured extraction: vendor, invoice number, date, due date, line items, subtotal, GST, total, currency
- Multi-tenant architecture with RLS + API key isolation
- Dashboard with approve/reject workflow
- Vendor management with contact fields
- PDF storage (signed URLs via Supabase Storage)
- Slack notifications on new invoices
- Expense classification by category
- RBAC (admin/viewer roles)
- Duplicate detection
- QuickBooks OAuth flow + sync endpoint (coded, needs real credentials)
- Processing logs and audit trail
- Approval rules engine (coded)
- Vitest suite — 227 tests

**Not connected / needs work:**
- QuickBooks: OAuth flow built, payload builder built, sync endpoint built — but requires live `QB_CLIENT_ID` / `QB_CLIENT_SECRET` credentials and a real QBO company. This is one set of env vars away from working.
- Xero: referenced in `admin-accounting-sync` but only QuickBooks is implemented. The Xero branch is a stub.
- MYOB: same — stub only.
- PDF viewer: committed, deployed status unclear (was pending as of last handoff).
- Approval rules UI: backend exists, frontend wiring uncertain.

**Still fragile:**
- The n8n workflow has `continueOnFail: true` on PDF upload — failures are silent.
- No magic-byte validation on PDF uploads (MIME type is trusted from client).
- Gmail-only intake — no Outlook, no direct upload, no forwarding address.

---

## The Real Competitive Landscape for Your Target Customer

Your target: a builder running $2M–$15M revenue, a tiler/stone wholesaler importing from Italy or China, a small electrical contractor with 30–50 supplier invoices per week. They use Xero or MYOB. They have a bookkeeper who enters invoices manually or exports CSVs.

This is **not** the enterprise AP automation market. Here's who you're actually competing with at this level:

| Competitor | What they do | Price | Why SMBs care |
|---|---|---|---|
| **Hubdoc** (Xero-owned) | Auto-fetches docs from portals, email forward | ~$50/mo (bundled in Xero) | Already in Xero, automatic fetch |
| **Dext** (formerly Receipt Bank) | Mobile capture + email forward → Xero/QBO | $60–$150/mo | Bookkeeper favourite, mobile app |
| **AutoEntry** (Sage-owned) | Email/upload → OCR → Xero/QBO/MYOB | $12–$55/mo per user | MYOB support, cheap entry tier |
| **Lightyear** | AP automation for mid-market | $200–$800/mo | AU-focused, good Xero integration |
| **ApprovalMax** | Approval workflows on top of Xero/QBO | $50–$150/mo | Xero app marketplace distribution |
| **Spendesk / Payhawk** | Corporate card + AP | Enterprise-ish | Not relevant to your segment |
| **n8n + GPT (DIY)** | What a technical person can build | Time cost | The build-vs-buy comparison |
| **You** | Email → GPT → dashboard → (Xero/QBO) | TBD | AI-native, customisable, bundled in engagement |

### The Honest Gap at Your Level

Hubdoc and Dext already solve this problem for most of your target market — but they're generic, they charge ongoing subscription fees, they don't customise to a client's workflow, and they don't speak "trades." A tiler doesn't need 1,000 portal integrations. They need: email comes in, invoice gets read correctly, it lands in Xero, done.

The gap you can actually own: **customised, AI-native extraction that you set up, configure, and maintain as part of an ongoing automation relationship.** That's different from a SaaS subscription they manage themselves.

---

## Strengths (Earned, Not Flattery)

**1. GPT-4o vision is better than legacy OCR for messy invoices.**
Hubdoc and Dext use trained OCR models. They fail on handwritten amounts, scanned-and-rotated PDFs, invoices in non-standard formats. GPT-4o handles those. For a stone importer getting PDFs from Italian suppliers in mixed formats, this is a genuine advantage.

**2. GST handling is baked in.**
Tax is a separate field, validated. US-built tools (Bill.com, BILL) treat GST as an afterthought. This matters for AU SMBs.

**3. The architecture scales without you.**
Multi-tenant RLS, API keys per customer, Edge Functions that are stateless. Adding a new client is an env var and an API key. You don't need to redeploy anything.

**4. QuickBooks payload is basically done.**
The `build-quickbooks-payload` function and `admin-accounting-sync` endpoint are built. The OAuth exchange is implemented. This needs live credentials and a test run, not a rewrite.

**5. You can customise the extraction prompt per client.**
If a stone wholesaler always gets invoices from the same 5 Italian suppliers with the same quirky format, you can tune the extraction. Dext can't do that.

**6. It's a working demo today.**
n8n is running. Gmail polling is live. Invoices are coming in. The dashboard shows them. That's enough to sit in front of a builder and say "here's what we did for another client."

---

## Weaknesses (The Ones That Actually Matter for Your Use Case)

**1. Xero is not connected, and Xero is where AU SMBs live.**
QuickBooks has maybe 20–25% AU market share. Xero has 60–70%. Your accounting sync has Xero as a stub. This is the highest-priority gap for your target market. Without Xero, you're pitching to the minority of AU SMBs.

**2. Gmail-only is a real constraint.**
Your target client — a builder, a tiler — likely has a business Google Workspace account, so Gmail works. But some run Outlook through their accountant or MYOB's hosted email. The "forward to a magic address" pattern (that Hubdoc uses) is more flexible. This is not a dealbreaker for your use case, but it narrows who you can take on without friction.

**3. No direct upload / mobile path.**
Dext's killer feature for tradespeople is the mobile app: photo of a receipt, done. You have no upload path other than email. A builder on a job site won't email their invoices — they'll take a photo. This is a real gap for the trades segment specifically.

**4. The workflow still has silent failure modes.**
`continueOnFail: true` on PDF upload means a failed PDF upload looks like success in the n8n logs. For a client relying on this in production, a missed PDF is a support ticket they don't know to raise. This should log to Slack or the processing_logs table explicitly.

**5. Pricing and margin are undefined.**
You're bundling this into AI automation engagements, which is the right call. But if you don't have a rough idea of what the Supabase + n8n + GPT-4o costs per client per month, you can't price the engagement properly. Run the maths: at 500 invoices/month, GPT-4o vision at ~$0.01/invoice = $5/month. Supabase free tier handles it. n8n is $20/month shared. Total cost: under $30/month per client. That's a strong margin at any reasonable engagement price.

**6. No client-facing status or errors.**
When the n8n workflow fails (502, silent PDF error, GPT timeout), the client has no visibility. The processing_logs table exists but there's no client-facing view of it. For a paying client, "we're not sure if it worked" is not acceptable.

---

## Opportunities (Specific to Your Model)

**1. Xero OAuth — one sprint, unlocks your core market.**
The QuickBooks pattern is already built. Xero's OAuth 2.0 is similar. Build it, get it working with one Xero test company, and you have a complete loop: email → extract → Xero. That's the demo that closes engagements.

**2. "Managed invoice automation" as a retainer line item.**
Not SaaS. You set it up, you monitor it, you fix it when it breaks, you tune the extraction when a new supplier format appears. Charge $300–$800/month per client as a managed service. Dext charges $60–150 and does none of that. You charge more and do more.

**3. Trades-specific vertical.**
Builder gets invoices from: concrete supplier, steel supplier, scaffolding hire, plumbing sub, electrical sub. Each has a different invoice format. Pre-train your extraction prompts for the common AU trades suppliers (Boral, BlueScope, Kennards Hire, etc.). That's something no generic tool offers.

**4. Bookkeeper channel.**
One bookkeeper manages 20–30 small business clients. Get one bookkeeper using this platform for their clients and you've got 20 potential engagements from one relationship. This is how Dext scaled. You don't need 1,000 users — you need 3 bookkeepers who trust you.

**5. Document type expansion.**
You already have `document_type` in migrations. Receipts, statements, purchase orders — the same pipeline handles them all. A builder's bookkeeper also deals with bank statements, supplier statements, hire agreements. One platform, multiple document types, higher stickiness.

---

## Threats (Real Ones for Your Model)

**1. Xero builds GPT extraction natively.**
Xero already has Hubdoc. They're actively adding AI features. If they add "GPT extraction from email forward" to the Hubdoc product — which they're probably already testing — your extraction value prop disappears for Xero users. Your moat then becomes the relationship, the customisation, and the managed service, not the technology.

**2. ChatGPT/Claude artifacts are a constant comparison.**
Any SMB owner who's used ChatGPT will ask "can't I just drag the invoice into ChatGPT?" The answer is yes, for one invoice. Not for automated pipeline, not for bulk, not for Xero sync, not for approval workflows. But you need to be ready with that answer.

**3. n8n pricing changes.**
You're on n8n cloud. If they change their pricing or if your workflow becomes high-volume (many executions per day per client), costs increase. Know your execution budget per client.

**4. You're the single point of failure.**
Right now, you are the engineer, the PM, the support, and the sales. If you land 5 clients using this platform and one of them has a critical failure at 8pm before payroll, that's your problem. The architecture is solid but the operational model needs thought.

---

## The Honest Bottom Line (Updated Frame)

**You don't have a SaaS product. You have a functional, deployable, client-ready managed service.**

That's not a consolation prize — for your stated goal, it's exactly right. Here's where you actually sit:

Against **Hubdoc and Dext** at the SMB level: you're comparable on extraction quality, behind on integrations (Xero), ahead on customisation and Australian GST handling.

Against **doing nothing** (which is what most of your target clients are doing): you're miles ahead.

Against **a bookkeeper entering invoices manually**: you're solving a real problem at a fraction of the time cost.

**The three things that would make this a proper sales tool in the next few weeks:**

1. **Get Xero OAuth working end-to-end.** One test company, one real invoice flowing through to Xero. Record a 60-second screen capture of it working. That's your close.

2. **Fix the silent failures.** Add explicit Slack notification when PDF upload fails or n8n returns an error. Clients on retainer need to trust it works.

3. **Calculate your cost per client.** Know your numbers before you price an engagement. At current architecture, it's probably $25–$40/month per client in infrastructure. Price accordingly.

Everything else — mobile upload, Outlook support, MYOB, approval chains, multi-currency — is only relevant once you have a paying client asking for it.

---

## Competitive Position Summary

| Dimension | You (Today) | Hubdoc | Dext | Lightyear |
|---|---|---|---|---|
| AI extraction quality | High (GPT-4o vision) | Medium (OCR) | Medium (OCR + ML) | High |
| AU GST handling | Yes | Partial | Yes | Yes |
| Xero integration | Stub (not live) | Yes (native) | Yes | Yes |
| MYOB integration | Stub | No | Yes | No |
| QuickBooks integration | Built, needs credentials | No | Yes | No |
| Mobile capture | No | No | Yes (killer feature) | No |
| Customisation | High | None | None | Medium |
| Managed service model | Yes | No | No | No |
| Pricing model | Bundled engagement | $0 (in Xero) | $60–$150/mo | $200–$800/mo |
| Client self-serve | No | Yes | Yes | Partial |
| Multi-channel intake | Email only | Portal + email | Email + mobile | Email + portal |

Your differentiator is not the technology. It's **managed, customised, AI-native automation with a human you can call**. That's what a $5M builder wants. They don't want another SaaS subscription they have to manage. They want it handled.

Build the Xero integration. Close one client. Charge properly. Everything else follows.
