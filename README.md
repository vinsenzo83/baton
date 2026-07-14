# 🏃 BATON

**Hand off AI work — with a receipt.**

An AI did the work. How does the next person — or the next AI — know it actually *works*, not just that the build passed? BATON seals a unit of AI work into a portable capsule, and an **independent verifier** replays it and issues a **server-signed Verification Receipt**. The receiver trusts observed evidence, not a claim.

> **Never trust an agent handoff without a receipt.**

BATON is a standard MCP (Model Context Protocol) server — any MCP-capable tool (Claude Code, Codex CLI, Gemini CLI, Cursor …) connects with one URL. The producer and the verifier can be **different models, machines, and people**.

## Why this, and not the dozen orchestration tools?

Running Claude + Codex + Gemini together (swarms, rooms, agent messaging) is a crowded space. BATON isn't that. The one thing almost nobody does: **bind the handoff artifact to independent execution evidence as a single, forgeable-proof trust unit.** That's the receipt.

```
Claude did the work
   ↓  baton_pass  → sealed capsule (BTN-H-…)
Codex / a teammate receives it
   ↓  baton_verify → replay in a clean env, observe the real flow
   ↓
🕸️ VERIFIED — signed receipt: who verified · what was observed · in what env · with what artifacts
   ↓
trust  (or reject)
```

The real buyer isn't "me switching Claude→Codex" (just re-read the repo). It's **outsourcer→in-house, leaver→joiner, KO team→US team** — where "an AI made this, does it *really* work?" is a question worth paying to answer.

## The receipt (the differentiator)

`baton_verify` doesn't return a `✅` sticker. It returns a signed record:

```json
{
  "kind": "baton.verification-receipt/v1",
  "capsule": "BTN-H-…",              // the handoff this verifies
  "verifier": "receiver-spider",    // WHO verified — independent of the producer
  "environment": { "os": "ubuntu-24.04", "node": "24.2" },
  "observed": [{ "claim": "payment succeeds", "observed": true,
                 "detail": "POST /pay 200 + order row +1" }],
  "artifacts": ["playwright.trace.zip", "network.har"],
  "verdict": "verified",
  "signature": "…hmac-sha256…"       // server-signed → tamper the verdict, break the sig
}
```

Flip `verdict` to `"verified"` without re-signing and the badge is refused. A passing build never earns `verified` on its own — only **observed** E2E does (this is what catches a silent upsert that returns 200 but writes nothing).

## Tools

| Group | Tools | What it does |
|---|---|---|
| **Handoff** | `baton_pass` `baton_receive` `baton_diff` `baton_revoke` | Seal a work capsule into a code (`BTN-H-…`), hand it over, diff versions. Body encrypted with a code-derived key — the server never sees plaintext |
| **Verify** | `baton_verify` `baton_verify_plan` `baton_consolidate` + `spider_*` ×6 | Independent verifier replays and issues the signed receipt (no observation, no 🕸️); `consolidate` gathers many handoffs into one result board by trust tier |
| **Team rooms** *(supporting)* | `baton_create_room` `baton_new_invite` `baton_join` `baton_send` `baton_inbox` `baton_who` `baton_leave` `baton_kick` `baton_approve` `baton_close_room` | A persistent room the owner manages; people enter via rotating **invite codes** (`BTN-R-…`, 72h, re-issuable). Owner can kick, approve (optional gate), close. After join, activity is keyed by `member_id` |
| **Operations** | `baton_task_*` `baton_git_*` `baton_cost_*` | Cycle-safe private task DAG, Git commit/diff/test evidence binding, and idempotent provider/model/task cost ledger |

Operations dashboard: `/ops.html`. It stores only task metadata, Git evidence, and cost facts; BATON never asks for repository credentials.

## Design principles (from the security review)

- **Code-derived encryption.** The server stores only `ciphertext + code_hash`. Without the code, even the operator can't read the plaintext — the proof of "we can't lock you in."
- **Signed receipts.** Verdicts are HMAC-signed server-side (`BATON_RECEIPT_SECRET`); no client can forge `verified`.
- **Prompt-injection containment.** Inbound capsules/messages are returned fenced as *untrusted data*; secrets are auto-masked before storage.
- **Codes are ≥128-bit secrets**, one-time codes redeem atomically, alias-spoofing blocked.
- **A passing build ≠ working behavior.** `verified` requires observed side effects, never static analysis alone.

## Run

```bash
npm install
npm test                                      # 15/15 E2E groups pass
node src/server.js                            # stdio (local / any CLI)
BATON_HTTP=1 PORT=8080 node src/server.js      # remote Streamable HTTP
```

### Register (remote)
```bash
claude mcp add --transport http baton https://baton-mcp-production.up.railway.app/mcp
```

Billing/gating is **off by default** (dogfooding phase). Set `BATON_BILLING=on` to re-enable quotas. See **[USAGE.md](USAGE.md)** for the full guide.

## Storage
MVP uses SQLite (`better-sqlite3`) — self-host single binary. The hosted service drops a Postgres adapter into the narrow interface in `src/store.js`.

## License
MIT
