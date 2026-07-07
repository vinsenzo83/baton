# BATON Billing — how the money works

## The model: server is free, the service is paid

BATON's server code is open (npm + GitHub) so it spreads through MCP directories. **Revenue comes from the hosted service**, metered per account — the standard MCP monetization pattern. Copying the code doesn't copy the corpus data, the uptime, or the account base.

| Plan | Price | Handoffs/mo | Rooms | Retention | Extras |
|---|---|---|---|---|---|
| Free | $0 | 20 | 2 | 7 days | corpus pull |
| Pro | $8/mo | unlimited | unlimited | 90 days | priority |
| Team | $25/mo | unlimited | unlimited | 365 days | org, audit log, E2E |

Enforced in `src/plans.js` + `core.pass()` (monthly quota) and reported by `baton_account`.

## What's built (enforcement layer)
- Plan definitions + quotas (`src/plans.js`)
- `accounts` + `usage_counters` tables, metered on every `baton_pass`
- `baton_account` tool — user sees plan, limits, usage
- Quota gate on Free (20 handoffs/mo, 7-day retention cap)
- `POST /v1/billing/webhook` — sets a key's plan after a charge (secret-guarded)

## What's a human step (payment)
1. **Pick a provider** — Lemon Squeezy (global Merchant-of-Record, handles tax) or Stripe.
2. **Create products** — Pro $8/mo, Team $25/mo.
3. **Issue API keys** — on signup, generate a key; store `codeHash(key) → plan`.
4. **Wire the webhook** — on successful payment, provider calls:
   ```
   POST https://baton-mcp-production.up.railway.app/v1/billing/webhook
   x-baton-webhook-secret: <BATON_WEBHOOK_SECRET>
   { "api_key": "<user key>", "plan": "pro" }
   ```
   On cancellation, send `"plan": "free"`.
5. **Set env** — `BATON_WEBHOOK_SECRET` on Railway (without it the webhook rejects all calls).

## Note
The webhook is disabled until `BATON_WEBHOOK_SECRET` is set — safe by default. Pricing, tax, and terms are business/legal decisions, not code.
