#!/usr/bin/env node
// BATON statusLine segment — PER SESSION.
//  • dim "○ baton"            = installed & available (MCP is user-scope → shows in every
//                               session; means "ready", NOT connected).
//  • colored "🏃 baton R · N" = THIS session is joined to room R, with N members live.
// Reads only this session's own file (~/.baton/sessions/<id>.json). Member count is fetched
// for THIS session's room only (5s cache, 0.6s timeout) — never broadcast to other sessions.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIM = "\x1b[2m", O = "\x1b[38;5;208m", G = "\x1b[32m", R = "\x1b[0m";
const BASE = process.env.BATON_URL || "https://baton-mcp-production.up.railway.app";
const inactive = () => process.stdout.write(`${DIM}○ baton${R}`);

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  let sid = null;
  try { sid = JSON.parse(input || "{}").session_id; } catch { /* no stdin */ }
  if (!sid) return inactive();
  const file = join(homedir(), ".baton", "sessions", sid + ".json");
  let s;
  try { s = JSON.parse(readFileSync(file, "utf8")); } catch { return inactive(); }
  if (!s.room) return inactive();

  const room = String(s.room).replace(/^BTN-R-/, "").slice(0, 4);
  let members = s.members;
  // refresh member count at most every 5s (cheap, this room only, short timeout)
  if (!(s.membersTs && Date.now() - s.membersTs < 5000)) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 1500);
      const r = await fetch(BASE + "/api/who", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: s.room }), signal: ac.signal,
      });
      clearTimeout(t);
      const j = await r.json();
      members = (j.members || []).length;
      try { writeFileSync(file, JSON.stringify({ ...s, members, membersTs: Date.now() })); } catch { /* ignore */ }
    } catch { /* network hiccup → use cached/none */ }
  }
  const cnt = members != null ? ` ${DIM}·${R} ${G}${members}명${R}` : "";
  process.stdout.write(`${O}🏃 baton ${room}${R}${cnt}`);
});
