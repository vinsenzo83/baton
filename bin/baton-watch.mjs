#!/usr/bin/env node
// BATON companion watcher — desktop notification the moment a new message arrives,
// so a session no longer has to poll ("check inbox") to notice incoming work.
// Usage: baton-watch <BTN-R-code> <member_id> [--name alias]
//    or: baton-watch --join <BTN-R-code> --as <alias>   (joins then watches)
import { execFile } from "node:child_process";
import { platform, homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Shared status file the Claude Code statusLine reads → "🏃 baton · room · N connected".
const STATUS_DIR = join(homedir(), ".baton");
const STATUS_FILE = join(STATUS_DIR, "status.json");
function writeStatus(s) {
  try { mkdirSync(STATUS_DIR, { recursive: true }); writeFileSync(STATUS_FILE, JSON.stringify(s)); } catch { /* best-effort */ }
}

const BASE = process.env.BATON_URL || "https://baton-mcp-production.up.railway.app";
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const post = (path, body) => fetch(BASE + path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}).then(async (r) => { const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || "request failed"); return j; });

// Desktop notification, cross-platform (macOS / Linux / fallback bell).
function notify(title, message) {
  process.stdout.write("\x07"); // terminal bell
  const os = platform();
  if (os === "darwin") {
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Ping"`;
    execFile("osascript", ["-e", script], () => {});
  } else if (os === "linux") {
    execFile("notify-send", [title, message], () => {});
  }
}

const C = { dim: "\x1b[2m", orange: "\x1b[38;5;208m", green: "\x1b[32m", reset: "\x1b[0m", bold: "\x1b[1m" };
const stamp = () => new Date().toLocaleTimeString();

async function main() {
  let code = flag("--join") || args.find((a) => /^BTN-R-/i.test(a));
  let memberId = flag("--member") || args.find((a) => /^p_/.test(a));
  const alias = flag("--as") || flag("--name");

  if (!code) {
    console.error("Usage: baton-watch <BTN-R-code> <member_id>\n   or: baton-watch --join <BTN-R-code> --as <alias>");
    process.exit(1);
  }
  // If we were given an alias but no member_id, join first.
  if (!memberId) {
    if (!alias) { console.error("Provide a member_id, or --as <alias> to join."); process.exit(1); }
    const j = await post("/api/join", { code, alias });
    memberId = j.member_id;
    console.log(`${C.green}✓${C.reset} joined as ${C.bold}${alias}${C.reset}`);
  }

  const who = await post("/api/who", { code }).catch(() => ({ members: [] }));
  console.log(`${C.orange}▸ BATON${C.reset} watching ${C.bold}${code.slice(0, 14)}…${C.reset}  ${C.dim}(${who.members.length} in room, Ctrl+C to stop)${C.reset}\n`);

  let since = 0, firstPass = true, unread = 0;
  async function tick() {
    try {
      const w = await post("/api/who", { code }).catch(() => null);
      const inb = await post("/api/inbox", { code, member_id: memberId, since });
      for (const m of inb.messages || []) {
        if (!firstPass) { notify(`BATON · ${m.from}`, m.text); unread++; }
        const arrow = m.to ? ` → ${m.to}` : "";
        console.log(`${C.dim}${stamp()}${C.reset}  ${C.bold}${C.orange}${m.from}${C.reset}${C.dim}${arrow}${C.reset}  ${m.text}`);
      }
      since = inb.next_since || since;
      firstPass = false;
      // publish status for the statusLine (members = who count, unread since watch start)
      writeStatus({ room: code, members: w ? (w.members || []).length : null, unread, alias: alias || null, ts: Date.now() });
    } catch (e) { /* transient network */ }
  }
  await tick();
  setInterval(tick, 2500);
  // clear status on exit so the statusLine doesn't show a stale room
  const clear = () => { writeStatus({ ts: 0 }); process.exit(0); };
  process.on("SIGINT", clear); process.on("SIGTERM", clear);
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
