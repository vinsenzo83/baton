# BATON — User Guide

Hand a session over (handoff), connect sessions to each other (relay), and verify what's handed over (spider). Here's how to actually use it.

Endpoint: **https://baton-mcp-production.up.railway.app/mcp**

---

## 0. One-time: register BATON in your AI tool

### Claude Code
```bash
claude mcp add --transport http baton https://baton-mcp-production.up.railway.app/mcp
```

### Codex CLI / Gemini CLI / Cursor, etc.
Add this to the tool's MCP config (the key name varies by tool):
```json
{
  "mcpServers": {
    "baton": { "url": "https://baton-mcp-production.up.railway.app/mcp" }
  }
}
```
> Remote HTTP MCP support varies by tool. If it doesn't work, connect over local stdio instead (see bottom).

To confirm the tools loaded, ask your AI: **"list the baton tools"** — you should see 10 `baton_*` + 6 `spider_*`.

---

## 1. Switch models / hand off work — Handoff

### The side handing off (e.g. working in Claude)
> **"pass the baton on what we've done"**

Your AI calls `baton_pass`, seals a snapshot, and returns a code:
```
🔑 BTN-H-A1B2-C3D4-...   (valid 72h)
```
- It captures **goal · current state · decisions · next steps**, not the whole transcript.
- The body is encrypted with the code — **without the code, even the server can't read it.**
- Secrets (API keys, etc.) are auto-masked.
- To hand off only once: **"pass a one-time baton"**

### The side receiving (e.g. GPT/Codex, or another person)
After getting the code over chat/email:
> **"receive baton BTN-H-A1B2-..."**

Your AI calls `baton_receive` and picks up the context. The content is marked *untrusted data*, so the AI won't blindly execute instructions inside it (safety).

---

## 2. Live collaboration between sessions — Relay room

### Create a room
> **"create a collaboration room"** → get a `BTN-R-....` code. Share it with your teammates.

### Join (each person, any AI)
> **"join baton room BTN-R-.... as 'dev'"**
→ you get a `member_id` (used in later messages).

### Send / receive notes
> **"send 'review this schema' to dev in the room"**
> **"check my baton inbox"**

> ⚠️ Note: MCP tools don't poll on their own. You must say **"check my inbox"** to read new notes. (Real-time push is a later version.)

---

## 3. Verify a handoff is real — Spider

Core principle: **a passing build ≠ working behavior.** Code can look right and still fail silently (e.g. a silent upsert failure). So the spider requires *both* static checks *and* actually running it (E2E).

### Get a verification plan
> **"make a baton verification plan for this work"** → `baton_verify_plan`
Returns the static dimensions to check + the E2E probes you must actually run.

### Verdict
Feed the observed results (HTTP 200 + DB rows 41→42, etc.) into `baton_verify`:
- Real observed evidence → **🕸️ VERIFIED**
- Code looks right but not run → **⚪ STATIC-ONLY** (no badge)
- 200 but rows didn't grow (silent failure) → **verified denied**

Attach the verified manifest to `baton_pass`, and the outgoing baton carries a 🕸️ badge — the receiver can trust it was actually observed to work.

### Spider tools (absorbed recluse)
`spider_plan` `spider_checklist` `spider_signals` `spider_classify_tier` `spider_record_pattern` `spider_pull_corpus` — bug-class knowledge, detection signals, self-growing corpus. Start with **"make a spider verification plan"**.

---

## Code conventions
- `BTN-R-...` = Room · `BTN-H-...` = Handoff
- The code is the key. Don't share it carelessly. Expiry (72h default), one-time, and instant revoke are supported: **"revoke this baton code"** (`baton_revoke`).

## Connect locally (stdio) — when remote doesn't work
```bash
git clone <repo> && cd relay-mcp && npm install
# Claude Code:
claude mcp add baton -- node /path/to/relay-mcp/src/server.js
```

## Troubleshooting
- **Tools don't appear** → restart your AI tool after registering. Check `/health` is 200: `curl https://baton-mcp-production.up.railway.app/health`
- **"code is invalid"** → typo, expired, or (if one-time) already consumed. Case/hyphens auto-normalize, but the code itself must be right.
- **AI executed an instruction from a received note** → BATON fences content as untrusted, but the final call is each AI's. Don't share a room with people you don't trust.
