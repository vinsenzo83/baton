#!/usr/bin/env node
// BATON PostToolUse hook — tracks THIS session's room connection, PER SESSION (not global).
// On baton_create_room/join → record the room under this session_id.
// On baton_leave/revoke → clear it. The statusLine reads only its own session's file, so a
// session shows "connected" (colored) only when IT actually joined — never because another did.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".baton", "sessions");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const e = JSON.parse(input || "{}");
    const sid = e.session_id || "unknown";
    const tool = e.tool_name || "";
    mkdirSync(DIR, { recursive: true });
    const f = join(DIR, sid + ".json");
    if (/(create_room|join)/.test(tool)) {
      // pull the room code from the tool result (or the call args)
      let code = null;
      try {
        const r = e.tool_response ?? e.tool_result;
        const t = typeof r === "string" ? JSON.parse(r) : r;
        code = t?.code || (Array.isArray(t?.content) ? JSON.parse(t.content[0]?.text || "{}").code : null);
      } catch { /* fall through */ }
      if (!code) code = e.tool_input?.code;
      writeFileSync(f, JSON.stringify({ room: code || "room", ts: Date.now() }));
    } else if (/(leave|revoke)/.test(tool)) {
      try { rmSync(f); } catch { /* already gone */ }
    }
  } catch { /* never block the tool */ }
  process.exit(0);
});
