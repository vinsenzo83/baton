#!/usr/bin/env node
// BATON statusLine segment — prints "🏃 baton · <room> · N connected · M new" when a watcher
// is running (reads ~/.baton/status.json, refreshed every 2.5s by baton-watch), else a dim
// "🏃 baton" so the tool is always visible in the Claude Code bottom status line.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const O = "\x1b[38;5;208m", DIM = "\x1b[2m", GRN = "\x1b[32m", R = "\x1b[0m";
try {
  const s = JSON.parse(readFileSync(join(homedir(), ".baton", "status.json"), "utf8"));
  const fresh = s.ts && Date.now() - s.ts < 10000;   // watcher alive (updated within 10s)
  if (fresh && s.room) {
    const room = String(s.room).replace(/^BTN-R-/, "").slice(0, 4);
    const conn = s.members != null ? ` ${DIM}·${R} ${GRN}${s.members} connected${R}` : "";
    const New = s.unread ? ` ${DIM}·${R} ${O}${s.unread} new${R}` : "";
    process.stdout.write(`${O}🏃 baton${R} ${DIM}${room}${R}${conn}${New}`);
  } else {
    process.stdout.write(`${DIM}🏃 baton${R}`);
  }
} catch {
  process.stdout.write(`${DIM}🏃 baton${R}`);
}
