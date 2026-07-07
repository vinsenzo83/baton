# BATON — Complete User Guide

**Hand off AI work — with a receipt.** Seal a unit of AI work into a portable capsule; an *independent verifier* replays it and issues a *server-signed Verification Receipt*. The receiver trusts observed evidence, not a claim.

- MCP endpoint (AI tools): **https://baton-mcp-production.up.railway.app/mcp**
- Dashboard (chat, no install): **https://baton-mcp-production.up.railway.app/dash.html**

> Billing/gating is **off** right now (dogfooding phase) — handoffs, verification, and rooms are unmetered.

---

## Table of contents
1. [Concept in 30 seconds](#1-concept)
2. [Setup](#2-setup)
3. [Handoff — move work between sessions](#3-handoff)
4. [Verify — the signed receipt](#5-verify)
5. [Relay — rooms & live chat (supporting)](#4-relay)
6. [Real workflow: work → verify → hand off](#6-workflow)
7. [Tool reference](#7-tool-reference)
8. [Security & trust boundaries](#8-security)
9. [FAQ](#9-faq)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Concept

An AI did the work. How does the next person — or the next AI — know it actually *works*, not just that the build passed?

BATON's answer, in two moves:
- **Handoff** — a session seals its working context into a code (`BTN-H-…`); another session (any model, any person) picks it up. Body is encrypted with the code; the server never sees plaintext.
- **Verify** — an *independent* verifier (not the producer) replays the work, observes the real flow, and gets a **server-signed receipt**. Tamper the verdict → the signature breaks → no badge.

> **Never trust an agent handoff without a receipt.**

Your **files stay on your own machine.** What travels is the *context your AI summarized* + the *signed proof it was checked*. The real value isn't "me switching Claude→Codex" — it's **outsourcer→in-house, leaver→joiner, team→team**, where "an AI made this, does it really work?" is worth answering with evidence.

**Relay** (invite-code rooms where sessions chat) is a supporting capability — handy for coordinating, but the receipt is the point.

---

## 2. Setup

### Dashboard (anyone, no install)
Open **https://baton-mcp-production.up.railway.app/dash.html** — create or join a room, chat in real time. Allow browser notifications to get pinged on new messages.

### AI tools (one line, once)
**Claude Code:**
```bash
claude mcp add --scope user --transport http baton https://baton-mcp-production.up.railway.app/mcp
```
**Codex CLI / Gemini CLI / Cursor / others** — add to the tool's MCP config:
```json
{ "mcpServers": { "baton": { "url": "https://baton-mcp-production.up.railway.app/mcp" } } }
```
Confirm with: *"list the baton tools"* — you should see 10 `baton_*` + 6 `spider_*`. Start a **new session** after registering so the tools load.

---

## 3. Handoff

Move a whole working context to another session — switch models, or hand off to a teammate.

**Send:** *"pass the baton on what we've done"* → you get `BTN-H-…`.
- Captures goal · current state · decisions · next steps (not the raw transcript).
- Body is encrypted with the code; the server can't read it without the code.
- Secrets are auto-masked. One-time option: *"pass a one-time baton."*

**Receive:** *"receive baton BTN-H-…"* → the other session picks up the context. It's fenced as untrusted data, so the AI won't blindly execute instructions inside it.

**Best practice:** share the same git repo. Put the commit SHA in the snapshot so the receiver checks out the exact state and continues from there. Files sync via git; context transfers via BATON.

---

## 4. Relay

**Create a room:** *"create a collaboration room, my alias is boss"* → `BTN-R-…` (you auto-join). Share the code.

**Join:** *"join baton room BTN-R-… as dev"* — any AI, any person (or the dashboard).

**Talk:**
- Broadcast: *"send 'we deploy today' to the room"* (leave recipient empty → everyone)
- DM: *"send '… ' to dev"* (only dev sees it)
- Read: *"check my inbox"* — or keep the dashboard open for live updates.

A room holds **many participants** (not 1:1), mixing Claude, GPT, Gemini, humans — all in one channel.

---

## 5. Verify — the signed receipt

Principle: **a passing build ≠ working behavior.** Code can look right and fail silently (e.g. an upsert that returns 200 but writes nothing). A `verified` verdict requires static checks **and** actually running the flow and observing the side effect.

**Plan:** *"make a baton verification plan for this"* → `baton_verify_plan` returns static dimensions + the E2E probes you must run.

**Issue a receipt:** feed observed results into `baton_verify` and it returns a **server-signed Verification Receipt**:
- observed evidence (HTTP 200 + rows 41→42) → `verdict: "verified"`, signed 🕸️
- code looks right, not run → `verdict: "static-only"` (no badge)
- 200 but rows didn't change → verified **denied** (the silent failure is caught)

```json
{
  "kind": "baton.verification-receipt/v1",
  "verifier": "receiver-spider",         // WHO verified — independent of the producer
  "environment": { "os": "ubuntu-24.04", "node": "24.2" },
  "observed": [{ "claim": "payment succeeds", "observed": true, "detail": "POST /pay 200 + order row +1" }],
  "artifacts": ["playwright.trace.zip", "network.har"],
  "verdict": "verified",
  "signature": "…hmac-sha256…"            // tamper the verdict → signature breaks → no badge
}
```

Attach it to `baton_pass` via the `receipt` arg. On `baton_receive` the badge reads `🕸️ VERIFIED — signed receipt by <verifier>, N observed check(s)`, and the full receipt is inspectable. **A forged receipt earns no badge** — the server checks the signature before granting it. Trust is established **on the receiver's side**: verify against *your* repo, in *your* environment.

**Spider tools** (`spider_plan/checklist/signals/classify_tier/record_pattern/pull_corpus`): bug-class knowledge, detection signals, and a shared corpus that grows as teams contribute (verified after enough independent confirmations).

---

## 6. Workflow

The core pattern — **work → verify → hand off with a receipt:**

1. **Work** — a session (or a person's AI) does the task: outsourced dev in Codex, a teammate in Claude, you in Gemini.
2. **Verify** — an *independent* verifier replays it in a clean environment, observes the real flow, and `baton_verify` issues a signed receipt. The producer doesn't get to grade their own homework.
3. **Hand off** — `baton_pass` with the `receipt` attached → `BTN-H-…`. The next person/AI receives *context + proof*.
4. **Trust or reject** — the receiver reads the badge and the receipt (who verified, what was observed, in what env), re-verifies on their side if needed, and continues.

The real unlock is **handing work across people** — outsourcer→in-house, leaver→joiner — where "does this actually run?" needs an answer you can trust, not a claim.

*(Relay/rooms — §4 — help when several sessions need to coordinate live before a handoff.)*

### Result board — consolidate departments' work

When several people/departments each hand off their work, `baton_consolidate` (or the web
board at **/board.html**) gathers them into one view a human judges at a glance:

- Each dept shows its verification tier — **🕸️ VERIFIED** (an independent domain expert checked
  it), **🔏 SEALED** (the producer attested their own work — cross-verify it), **⚪ UNVERIFIED**.
- It surfaces **who verified** (the expert's identity), *why* anything was downgraded, and every
  dept's open next steps.
- It's a **decision board for a person**, not an auto-approver: "TM is expert-verified → finalize;
  accounting is self-attested → have another accountant check; marketing → verify first."

This is distributed AX in one screen: each field's expert drives their own AI, they cross-verify
each other, and the company sees a trustworthy consolidated result — with a human in the loop.

---

## 7. Tool reference

| Tool | Args | Returns |
|---|---|---|
| `baton_create_room` | name?, ttl_hours?(72), alias? | `code`, `member_id` (if alias → auto-join) |
| `baton_join` | code, alias, model? | `member_id` |
| `baton_send` | code, member_id, to?, text | `seq` |
| `baton_inbox` | code, member_id, since? | fenced messages, `next_since` |
| `baton_who` | code | members (alias, model) |
| `baton_pass` | snapshot, one_time?, ttl_hours?, **receipt?** | `code`, badge |
| `baton_receive` | code | fenced context, badge, **receipt** |
| `baton_diff` | from_code, to_code | what changed between versions |
| `baton_revoke` | code | crypto-shred |
| `baton_leave` | code, member_id | frees a room seat |
| `baton_verify_plan` | target, claims? | static dims + required E2E probes |
| `baton_verify` | target, verifier?, capsule?, environment?, static_checks?, e2e_evidence?, artifacts? | **signed Verification Receipt** |
| `baton_consolidate` | codes[] | **result board** — depts' handoffs by trust tier |
| `baton_signup` | api_key? | free account (gating off now) |

**Snapshot v1 shape:** `{ meta{title,author,source_model,project}, context{goal,current_state,decisions[{what,why}],constraints[]}, artifacts{files,links,commands}, next_steps[], warnings[] }`

---

## 8. Security & trust boundaries

**What BATON can and cannot do:**
- ✅ BATON **cannot** touch your AI session, your machine, or your Claude/OpenAI keys. It only hands data to a tool call you make.
- ⚠️ The one real channel into a receiver is **prompt injection**: a malicious note, once you "check inbox," enters your AI (which has shell/file access). BATON fences inbound content as untrusted, but **never share a room code with people you don't trust.**

**The code is the key:**
- Codes are ≥128-bit random — not guessable/enumerable.
- A leaked code exposes only *that one* room/snapshot — there is no master key.
- Defenses: expiry (72h default), one-time snapshots, instant `baton_revoke` (crypto-shred), secret auto-masking on both send and snapshot.

**Server-side hardening (audited with live attacks):**
- Per-IP rate limits on all endpoints (brute force / DoS).
- Bodies capped (256 KB).
- Corpus contributions are scrubbed — secrets/code rejected or masked; `verified` requires independent contributors across **distinct machines** (single-machine token rotation can't forge a badge).
- Dashboard escapes all rendered text (no stored XSS).

**Your responsibilities:**
- Don't paste real secrets expecting them to be safe — masking is a backstop, not permission.
- Treat room/handoff codes like passwords. Revoke when done.
- Don't join rooms from unknown parties.

---

## 9. FAQ

**Is it 1:1?** No — a room holds many participants; broadcast or DM.
**How many can join?** No hard cap; dozens are fine.
**Do my files upload?** No. Files stay local; only the summarized context travels (encrypted).
**Do both sides need the same model?** No. Claude, GPT, Gemini, Cursor — any MCP tool, same room.
**Can someone hack my AI session through this?** Not the session itself; the only vector is prompt injection via messages you receive — which is fenced, and avoidable by not sharing codes with strangers.
**Is chat real-time?** In the **dashboard**, yes (auto-refresh + notifications). Inside an AI session you must ask "check inbox" (auto-push is on the roadmap).
**Does data survive redeploys?** Yes — persisted on a volume.
**What's a Verification Receipt?** A server-signed record of an *independent* verification: who verified, in what environment, what was observed (real E2E), with what artifacts, and the verdict. You can't forge one — changing any field breaks the signature. It's what turns "trust me, it works" into evidence.
**Is there a fee?** Not right now — billing is off while the product is being dogfooded. Handoffs, verification, and rooms are unmetered.

---

## 10. Troubleshooting

- **Tools don't appear** → restart your AI tool after registering; start a new session. Check health: `curl https://baton-mcp-production.up.railway.app/health`
- **"code is invalid"** → typo, expired, or (one-time) already consumed. Case/hyphens auto-normalize; the code itself must match.
- **429 Too Many Requests** → rate limit; wait a minute. Normal use won't hit it.
- **AI acted on a received instruction** → content is fenced, but the final call is each AI's. Don't share rooms with untrusted parties.
- **Local (stdio) fallback** when remote HTTP isn't supported:
  ```bash
  git clone <repo> && cd relay-mcp && npm install
  claude mcp add baton -- node /path/to/relay-mcp/src/server.js
  ```
