# 🏃 BATON

**Pass the session.**

Connect any AI session to any other — across models (Claude · GPT · Gemini …), machines, and people — with one code. **Relay** messages between live sessions, **hand off** a whole working context, and let the **spider** verify that what's handed over actually works — static checks *and* real E2E.

BATON is a standard MCP (Model Context Protocol) server, so any MCP-capable tool (Claude Code, Codex CLI, Gemini CLI, Cursor …) connects with a single URL.

## Three capabilities

| | Tools | What it does |
|---|---|---|
| **Relay** | `baton_create_room` `baton_join` `baton_send` `baton_inbox` `baton_who` | Sessions from different people/machines/models talk in an invite-code room (`BTN-R-…`) |
| **Handoff** | `baton_pass` `baton_receive` `baton_revoke` | Seal a session snapshot into a code (`BTN-H-…`) and hand it over. Body is encrypted with a code-derived key |
| **Verify (spider)** | `baton_verify_plan` `baton_verify` + `spider_*` ×6 | Judge a handoff with static checks **and observed E2E**. No observation, no 🕸️ badge |

## Design principles (from the architecture review)

- **C1 — Prompt-injection containment.** Inbound messages/snapshots are returned fenced as *untrusted data*; the receiving agent is told not to execute instructions inside them.
- **C2 — Codes are ≥128-bit secrets.** Not 4 digits. Resistant to horizontal brute force.
- **C4 — Code-derived encryption.** The server stores only `ciphertext + code_hash`. Without the code, even the operator can't read the plaintext — the proof of "we can't lock you in." Plus automatic secret masking.
- **H3** alias-spoofing blocked · **H4** one-time codes redeemed atomically.
- **The hard-won lesson — *a passing build ≠ working behavior.*** A `verified` verdict cannot be earned by static analysis alone. It requires evidence from actually running the flow and observing the side effect (HTTP status, DB row delta). This is the only way to catch a silent upsert failure.

## Run

```bash
npm install
npm test                                     # 8/8 E2E groups pass
node src/server.js                           # stdio (local / any CLI)
BATON_HTTP=1 PORT=8080 node src/server.js     # remote Streamable HTTP
```

### Register (remote)
```bash
claude mcp add --transport http baton https://baton-mcp-production.up.railway.app/mcp
```

See **[USAGE.md](USAGE.md)** for the full end-user guide.

## Storage

MVP uses SQLite (`better-sqlite3`) — ships as-is for the self-host single binary. The hosted service drops a Postgres adapter into the narrow interface in `src/store.js` (multi-tenant durability, PITR). With a stateless HTTP server, connect through a Postgres pooler (transaction mode).

## Roadmap
- **M1 (now)** — relay + handoff + spider verify + code-derived encryption. Dogfooded on real handoffs.
- **M2** — web dashboard, shared corpus network, Postgres.
- **M3** — org/SSO, snapshot versioning & diff.

The spider engine is an absorbed `recluse-mcp` — no longer a separate server, but BATON's verification engine.

## License
MIT
