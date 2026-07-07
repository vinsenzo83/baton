# BATON — Complete User Guide

Connect AI sessions across models, people, and machines. Relay messages, hand off working context, and verify what's handed over.

- Dashboard (chat, no install): **https://baton-mcp-production.up.railway.app/dash.html**
- MCP endpoint (AI tools): **https://baton-mcp-production.up.railway.app/mcp**

---

## Table of contents
1. [Concept in 30 seconds](#1-concept)
2. [Setup](#2-setup)
3. [Handoff — move work between sessions](#3-handoff)
4. [Relay — rooms & live chat](#4-relay)
5. [Verify — the spider gate](#5-verify)
6. [Real workflow: work → share → consolidate](#6-workflow)
7. [Tool reference](#7-tool-reference)
8. [Security & trust boundaries](#8-security)
9. [FAQ](#9-faq)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Concept

BATON is a remote MCP server that acts as a **post office for AI sessions**. Two moves:
- **Relay** — sessions join an invite-code room and exchange notes (like a group chat where humans *and* AIs are members).
- **Handoff** — a session seals its working context into a code; another session (any model, any person) picks it up and continues.

Your **files stay on your own machine.** What travels is only the *context your AI summarized* — encrypted, with secrets auto-masked. Think of it as passing an "I did X, decided Y, next is Z" note, not shipping the whole codebase.

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

## 5. Verify

Principle: **a passing build ≠ working behavior.** Code can look right and fail silently (e.g. a silent upsert). The spider requires static checks **and** actually running the flow.

**Plan:** *"make a baton verification plan for this"* → `baton_verify_plan` returns static dimensions + E2E probes you must run.

**Verdict:** feed observed results into `baton_verify`:
- observed evidence (HTTP 200 + rows 41→42) → **🕸️ VERIFIED**
- code looks right, not run → **⚪ STATIC-ONLY** (no badge)
- 200 but rows didn't change → **verified denied** (caught the silent failure)

Attach the verified manifest to `baton_pass` so the receiver trusts it was observed to work. Trust is established **receiver-side** — re-verify against your own repo.

**Spider tools** (`spider_plan/checklist/signals/classify_tier/record_pattern/pull_corpus`): bug-class knowledge, detection signals, and a shared corpus that grows as teams contribute (verified after enough independent confirmations).

---

## 6. Workflow

The intended pattern — **each works independently → shares → one session consolidates:**

1. **Work** — everyone in their own session (you in Claude on project A, a dev in GPT on module B).
2. **Share** — when needed, drop results into the room, or chat on the dashboard.
3. **Consolidate** — each session passes a baton to *your* session; you receive them all in one place.
4. **Verify & build** — run the spider gate on what came in, then continue the real work from the consolidated context.

Your session becomes the hub; the others fan out and report back.

---

## 7. Tool reference

| Tool | Args | Returns |
|---|---|---|
| `baton_create_room` | name?, ttl_hours?(72), alias? | `code`, `member_id` (if alias → auto-join) |
| `baton_join` | code, alias, model? | `member_id` |
| `baton_send` | code, member_id, to?, text | `seq` |
| `baton_inbox` | code, member_id, since? | fenced messages, `next_since` |
| `baton_who` | code | members (alias, model) |
| `baton_pass` | snapshot, one_time?, ttl_hours?, verify_manifest? | `code`, badge |
| `baton_receive` | code | fenced context, badge |
| `baton_revoke` | code | crypto-shred |
| `baton_verify_plan` | target, claims? | static dims + required E2E probes |
| `baton_verify` | target, static_checks?, e2e_evidence? | verdict + signed manifest |

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
