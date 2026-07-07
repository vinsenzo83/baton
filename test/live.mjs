// Live E2E — drive the DEPLOYED server as a real MCP client and observe side effects.
// "빌드 통과 ≠ 동작": this actually calls the live tools, not just /health.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL = process.argv[2] || "https://baton-mcp-production.up.railway.app/mcp";
const parse = (r) => JSON.parse(r.content[0].text);
let pass = 0; const ok = (n) => { console.log("  ✓", n); pass++; };

const client = new Client({ name: "baton-live-probe", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(URL)));
const call = (name, args) => client.callTool({ name, arguments: args });

// 0. tools present
{
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  if (names.length < 16) throw new Error("tool count " + names.length);
  ok(`live server exposes ${names.length} tools (baton + spider)`);
}

// 1. relay round-trip across two "models"
let roomCode, devId;
{
  roomCode = parse(await call("baton_create_room", { name: "live-probe", ttl_hours: 1 })).code;
  const boss = parse(await call("baton_join", { code: roomCode, alias: "boss", model: "claude-code" }));
  const dev = parse(await call("baton_join", { code: roomCode, alias: "dev", model: "codex" }));
  devId = dev.member_id;
  await call("baton_send", { code: roomCode, member_id: boss.member_id, to: "dev", text: "review this schema" });
  const inbox = parse(await call("baton_inbox", { code: roomCode, member_id: dev.member_id }));
  if (inbox.count !== 1 || !/review this schema/.test(inbox.messages_fenced)) throw new Error("relay lost message");
  if (!/UNTRUSTED/.test(inbox.messages_fenced)) throw new Error("not fenced");
  ok("relay: cross-model DM delivered live, fenced as untrusted");
}

// 2. handoff round-trip, encrypted, observed
let handoffCode;
{
  const passed = parse(await call("baton_pass", { snapshot: {
    meta: { title: "live handoff", author: "boss", source_model: "claude-code", project: "baton" },
    context: { goal: "prove live handoff", current_state: "deployed", decisions: [{ what: "code-derived enc", why: "server can't read" }] },
    next_steps: ["dogfood on real work"],
  }}));
  handoffCode = passed.code;
  if (!/^BTN-H-/.test(handoffCode)) throw new Error("bad handoff code");
  const got = parse(await call("baton_receive", { code: handoffCode }));
  if (!/code-derived enc/.test(got.context_fenced)) throw new Error("context not restored");
  ok("handoff: sealed + received live; context restored, fenced");
}

// 3. THE LESSON — live verify gate: static-only ≠ verified
{
  const staticOnly = parse(await call("baton_verify", { target: "publish",
    static_checks: [{ dim: "integration", passed: true, evidence: "code ok" }] }));
  if (staticOnly.verdict !== "static-only") throw new Error("static earned a verdict it shouldn't");

  const verified = parse(await call("baton_verify", { target: "publish",
    static_checks: [{ dim: "integration", passed: true, evidence: "code ok" }],
    e2e_evidence: [{ claim: "published", observed: true, detail: "POST 200 + rows 41->42" }] }));
  if (verified.verdict !== "verified") throw new Error("observed E2E didn't verify");
  ok("verify gate live: static-only ≠ verified; only observed E2E earns 🕸️");
}

// 4. spider engine reachable live
{
  const sig = parse(await call("spider_signals", { tier: "king" }));
  if (!sig.count) throw new Error("spider knowledge empty");
  ok(`spider engine live: ${sig.count} king-tier bug-class signals`);
}

// 5. revoke works
{
  const r = parse(await call("baton_revoke", { code: handoffCode }));
  if (!r.revoked) throw new Error("revoke failed");
  ok("revoke: handoff code crypto-shredded live");
}

console.log(`\n🕸️  BATON LIVE: ${pass}/6 groups passed against ${URL}\n`);
await client.close();
