process.env.BATON_BILLING = "on";  // exercise gating in tests (default off in prod)
// BATON E2E: exercise real flows, observe real side effects (not just "it built").
import { openStore } from "../src/store.js";
import { makeCore } from "../src/core.js";
import { gateVerdict } from "../src/verify.js";
import { sealBody, openBody } from "../src/crypto.js";
import { rmSync } from "node:fs";
import assert from "node:assert";

const DB = "./data/test.db";
rmSync(DB, { force: true }); rmSync(DB + "-wal", { force: true }); rmSync(DB + "-shm", { force: true });
const core = makeCore(openStore(DB));
let pass = 0; const ok = (n) => { console.log("  ✓", n); pass++; };
core.setPlan({ api_key: "tkey", plan: "pro" });   // unlimited key for handoff tests

// 1. crypto round-trip + wrong code fails
{
  const s = sealBody("BTN-H-RIGHT", "secret body");
  assert.equal(openBody("BTN-H-RIGHT", s), "secret body");
  assert.throws(() => openBody("BTN-H-WRONG", s));
  ok("code-derived seal/open round-trips; wrong code is rejected (auth failure)");
}

// 2. relay: two different 'models' talk in a room
{
  const { code } = core.createRoom({ name: "bongee-cmi", ttl_hours: 1 });
  assert.match(code, /^BTN-R-[0-9A-Z-]+$/);
  const boss = core.join({ code, alias: "owner", model: "claude-code" });
  const dev = core.join({ code, alias: "dev", model: "codex" });
  core.send({ code, member_id: boss.member_id, to: "dev", text: "이 스키마 검토해줘" });
  const got = core.inbox({ code, member_id: dev.member_id });
  assert.equal(got.count, 1);
  assert.match(got.messages_fenced, /UNTRUSTED/);           // C1 fencing present
  assert.match(got.messages_fenced, /스키마 검토/);
  ok("relay delivers cross-model DM, fenced as untrusted");
}

// 3. alias spoofing + reserved names blocked (H3)
{
  const { code } = core.createRoom({});
  core.join({ code, alias: "dev", model: "x" });
  assert.throws(() => core.join({ code, alias: "dev" }), /taken/);
  assert.throws(() => core.join({ code, alias: "spider" }), /reserved/);
  ok("duplicate + reserved aliases rejected");
}

// 4. secret scrubbing on send
{
  const { code } = core.createRoom({});
  const a = core.join({ code, alias: "a", model: "x" });
  const r = core.send({ code, member_id: a.member_id, text: "key sk-abcdefghij0123456789XYZ done" });
  assert.equal(r.redactions, 1);
  ok("secrets scrubbed before storage");
}

// 5. handoff: pass → receive, encrypted, unverified badge by default
{
  const r = core.pass({ api_key: "tkey", snapshot: {
    meta: { title: "결제 리팩터링", author: "boss", source_model: "claude-code", project: "bongee" },
    context: { goal: "3사 결제 통합", current_state: "2단계까지", decisions: [{ what: "선구매 모델", why: "정산 부담 0" }] },
    next_steps: ["adapter 연동", "E2E 발행 테스트"],
  }});
  assert.match(r.code, /^BTN-H-/);
  assert.equal(r.verified, false);
  assert.match(r.badge, /UNVERIFIED/);
  const got = core.receive({ code: r.code });
  assert.match(got.context_fenced, /UNTRUSTED/);
  assert.match(got.context_fenced, /선구매 모델/);
  ok("handoff seals, receives, fences; unverified by default");
}

// 6. one-time handoff is atomically single-use (H4)
{
  const r = core.pass({ api_key: "tkey", one_time: true, snapshot: { context: { goal: "one shot" } } });
  const first = core.receive({ code: r.code });
  assert.ok(first.meta);
  assert.throws(() => core.receive({ code: r.code }), /consumed/);
  ok("one-time handoff consumed exactly once");
}

// 7. THE LESSON: static-only cannot be 'verified'; needs observed E2E
{
  const staticOnly = gateVerdict({ target: "publish flow",
    static_checks: [{ dim: "integration", passed: true, evidence: "upsert 코드 정상" }] });
  assert.equal(staticOnly.verdict, "static-only");           // build passes ≠ works
  assert.match(staticOnly.manifest.badge, /STATIC-ONLY/);

  const withE2E = gateVerdict({ target: "publish flow",
    static_checks: [{ dim: "integration", passed: true, evidence: "upsert 코드 정상" }],
    e2e_evidence: [{ claim: "발행됨", observed: true, detail: "POST 200 + rows 41→42" }] });
  assert.equal(withE2E.verdict, "verified");
  assert.match(withE2E.manifest.badge, /VERIFIED/);

  const silentFail = gateVerdict({ target: "publish flow",
    static_checks: [{ dim: "integration", passed: true, evidence: "빌드 통과" }],
    e2e_evidence: [{ claim: "발행됨", observed: false, detail: "POST 200 이지만 rows 41→41 (upsert 무음 실패!)" }] });
  assert.equal(silentFail.verdict, "static-only");           // observed:false → not verified
  ok("verify gate: static-only ≠ verified; only observed E2E earns 🕸️; silent upsert fail caught");
}

// 8. verified handoff carries the badge through pass→receive
{
  const { manifest } = gateVerdict({ target: "x",
    static_checks: [{ dim: "security", passed: true, evidence: "RLS on" }],
    e2e_evidence: [{ claim: "저장됨", observed: true, detail: "rows +1" }] });
  const r = core.pass({ api_key: "tkey", snapshot: { context: { goal: "verified handoff" } }, verify_manifest: manifest });
  assert.equal(r.verified, true);
  const got = core.receive({ code: r.code });
  assert.match(got.badge, /🔏 SEALED/);   // legacy raw-evidence path = producer's own → self-attested
  ok("verified manifest (legacy) → 🔏 SEALED (self-attested, not independent)");
}

// 9. snapshot versioning + diff (M3-4)
{
  const v1 = core.pass({ snapshot: { meta: { title: "auth", project: "p" }, context: {
    goal: "add login", current_state: "wireframe", decisions: [{ what: "use OAuth", why: "fast" }] },
    next_steps: ["design db", "build form"] } });
  assert.equal(v1.version, 1);
  const v2 = core.pass({ parent_code: v1.code, snapshot: { meta: { title: "auth", project: "p" }, context: {
    goal: "add login + SSO", current_state: "db done", decisions: [{ what: "use OAuth", why: "fast" }, { what: "add SAML", why: "enterprise" }] },
    next_steps: ["build form"] } });
  assert.equal(v2.version, 2);
  const d = core.diff({ from_code: v1.code, to_code: v2.code });
  assert.ok(d.goal_changed && d.goal_changed.to === "add login + SSO");
  assert.deepEqual(d.decisions.added, ["add SAML"]);
  assert.deepEqual(d.next_steps.removed, ["design db"]);   // completed step dropped
  ok("snapshot versioning (v1→v2) + diff shows goal/decision/step changes");
}

// 10. billing: Free plan meters + gates handoffs; account view reports usage (M3-3)
{
  // registered Free account → real 20/mo gate (anonymous shares a generous bucket instead)
  core.setPlan({ api_key: "k-free", plan: "free" });
  const acctView = core.account({ api_key: "k-free" });
  assert.equal(acctView.plan, "free");
  assert.equal(acctView.limits.snapshotsPerMonth, 20);
  // a Pro key is unlimited
  core.setPlan({ api_key: "k-pro", plan: "pro" });
  const pro = core.account({ api_key: "k-pro" });
  assert.equal(pro.plan, "pro");
  assert.equal(pro.limits.snapshotsPerMonth, "unlimited");
  // usage increments on pass
  const before = core.account({ api_key: "k-pro" }).usage.snapshots_this_month;
  core.pass({ api_key: "k-pro", snapshot: { context: { goal: "metered" } } });
  const after = core.account({ api_key: "k-pro" }).usage.snapshots_this_month;
  assert.equal(after, before + 1);
  ok("billing: plan resolution, usage metering, unlimited Pro");
}

// 11. one-time snapshot can't be re-read via diff after it's consumed (HIGH-2)
{
  const victim = core.pass({ api_key: "tkey", one_time: true, snapshot: { context: { goal: "SECRET-GOAL", current_state: "SECRET" } } });
  core.receive({ code: victim.code });                 // consume it
  const empty = core.pass({ api_key: "tkey", snapshot: { context: { goal: "x" } } });
  assert.throws(() => core.diff({ from_code: empty.code, to_code: victim.code }), /not found/);
  ok("consumed one-time snapshot is not re-readable via baton_diff");
}

// 12. crypto payment: invoice → settle upgrades plan; tx replay blocked (M3-5)
{
  const { codeHash } = await import("../src/crypto.js");
  const st = openStore(DB);            // same DB file/connection for core + direct settle
  const c2 = makeCore(st);
  const inv = c2.upgrade({ plan: "pro", api_key: "pay-key-1" });
  assert.match(inv.invoice_id, /^inv_/);
  assert.equal(inv.amount_usd, 8);
  assert.ok("pay_options" in inv);   // wallet addresses only present when env is set
  // settle directly (on-chain verify is exercised separately) — tests store atomicity + upgrade + replay
  const r1 = st.settleInvoice(inv.invoice_id, { chain: "tron", txHash: "0xTX1", plan: "pro", keyHash: codeHash("pay-key-1") });
  assert.ok(r1.ok);
  assert.equal(c2.account({ api_key: "pay-key-1" }).plan, "pro");   // upgraded
  const r2 = st.settleInvoice(inv.invoice_id, { chain: "tron", txHash: "0xTX1", plan: "pro", keyHash: "x" });
  assert.ok(!r2.ok);   // already paid / tx reused → blocked
  ok("crypto payment: invoice → settle upgrades to Pro; replay/double-settle blocked");
}

// 13. funnel: signup creates a free account with its own quota; anon trial is small
{
  const anon = core.account({});
  assert.equal(anon.limits.snapshotsPerMonth, 5);   // anon trial cap = 5
  const su = core.signup({});
  assert.match(su.api_key, /^btn_/);
  assert.equal(su.plan, "free");
  const acc = core.account({ api_key: su.api_key });
  assert.equal(acc.plan, "free");
  assert.equal(acc.limits.snapshotsPerMonth, 20);   // registered Free = 20, more than anon 5
  ok("funnel: baton_signup → free account (20/mo); anon trial capped at 5");
}

// 14. seats: a room caps concurrent sessions by the OWNER's plan (orchestration paywall)
{
  const KEY = "seat-owner-key-1234";
  core.signup({ api_key: KEY });
  const r = core.createRoom({ api_key: KEY, alias: "boss" });   // session 1 (owner)
  core.join({ code: r.code, alias: "s2" });                     // session 2
  assert.throws(() => core.join({ code: r.code, alias: "s3" }), /full/);  // Free = 2 seats
  core.setPlan({ api_key: KEY, plan: "team" });                 // Team = 10 seats
  core.join({ code: r.code, alias: "s3" });
  assert.equal(core.who({ code: r.code }).members.length, 3);
  // short api_key on signup is rejected (silent-substitution trap fixed)
  assert.throws(() => core.signup({ api_key: "short" }), /12 characters/);
  ok("seats: Free room caps at 2 sessions; Team lifts it; short signup key rejected");
}

// 15. verified handoff via SIGNED RECEIPT (the differentiator) + forgery rejected
{
  // independent verifier issues a signed receipt with observed E2E
  core.signup({ api_key: "indep-verifier-key-1" });   // independent verifier = a registered account
  const receipt = core.verify({
    target: "checkout/payment", capsule: "BTN-H-XYZ", api_key: "indep-verifier-key-1",  // separate identity
    environment: { os: "ubuntu-24.04", node: "24.2" },
    static_checks: [{ dim: "integration", passed: true, evidence: "adapter wired" }],
    e2e_evidence: [{ claim: "payment succeeds", observed: true, detail: "POST /pay 200 + order row +1" }],
    artifacts: ["playwright.trace.zip", "network.har"],
  });
  assert.equal(receipt.kind, "baton.verification-receipt/v1");
  assert.equal(receipt.verdict, "verified");
  assert.ok(receipt.signature && receipt.signature.length === 64);
  // attach to a handoff → badge survives, receipt surfaced on receive
  const r = core.pass({ api_key: "tkey", snapshot: { context: { goal: "signed handoff" } }, receipt });
  assert.equal(r.verified, true);
  const got = core.receive({ code: r.code });
  assert.match(got.badge, /🕸️ VERIFIED/);        // independent verifier → full VERIFIED tier
  assert.match(got.badge, /independent/);
  assert.equal(got.receipt.verdict, "verified");
  assert.equal(got.receipt.tier, "independent");
  // FORGERY: flip verdict to "verified" without re-signing → must be rejected (badge NOT granted)
  const forged = { ...core.verify({ target: "x", static_checks: [{ dim: "d", passed: true, evidence: "e" }] }) };
  forged.verdict = "verified";   // tamper: static-only → claim verified, signature now stale
  const r2 = core.pass({ api_key: "tkey", snapshot: { context: { goal: "forged" } }, receipt: forged });
  assert.equal(r2.verified, false);   // forged receipt earns no badge
  ok("signed receipt: independent verify → 🕸️ badge; tampered/forged receipt rejected");
}

// 16. one-step verified handoff: pass with inline evidence → server mints+signs the receipt
{
  const r = core.pass({ api_key: "tkey",
    snapshot: { context: { goal: "one-step verified handoff" } },
    verify: {
      environment: { os: "mac", node: "24" },
      static_checks: [{ dim: "integration", passed: true, evidence: "wired" }],
      e2e_evidence: [{ claim: "runs", observed: true, detail: "HTTP 200 + row +1" }],
      artifacts: ["trace.zip"],
    },
  });
  assert.equal(r.verified, true);                       // minted inline, no separate verify call
  assert.equal(r.tier, "self-attested");                // producer attested → lower tier
  const got = core.receive({ code: r.code });
  assert.match(got.badge, /🔏 SEALED/);                 // self-attested → SEALED, not VERIFIED
  assert.equal(got.receipt.verdict, "verified");
  assert.equal(got.receipt.capsule, r.code);            // receipt bound to THIS handoff
  // no E2E observation inline → static-only, with a REASON explaining the downgrade
  const r2 = core.pass({ api_key: "tkey", snapshot: { context: { goal: "no e2e" } },
    verify: { static_checks: [{ dim: "d", passed: true, evidence: "e" }] } });
  assert.equal(r2.verified, false);
  assert.match(r2.verify_reason, /not observed|no E2E/);   // transparency: says WHY
  ok("one-step: self-attested→🔏SEALED, independent→🕸️VERIFIED; downgrade reason surfaced");
}

// 17. auto-delivery: pass with a room drops the code into the room (no human copy-paste)
{
  const { code: rcode } = core.createRoom({ name: "handoff-lane" });
  const sender = core.join({ code: rcode, alias: "lead", model: "claude" });
  const receiver = core.join({ code: rcode, alias: "codex", model: "codex" });
  const p = core.pass({ api_key: "tkey", room: rcode, member_id: sender.member_id,
    snapshot: { context: { goal: "auto-delivered handoff" } } });
  assert.equal(p.delivered_to, rcode);                  // reported as auto-sent
  // the receiver sees the handoff code in their inbox — without anyone pasting it
  const inbox = core.inbox({ code: rcode, member_id: receiver.member_id });
  assert.equal(inbox.count, 1);
  assert.match(inbox.messages_fenced, new RegExp(p.code.slice(0, 12)));  // the BTN-H code arrived
  assert.match(inbox.messages_fenced, /New baton/);
  ok("auto-delivery: pass(room) drops the handoff code into the room inbox — no copy-paste");
}

// 18. consolidate: gather departments' handoffs into one result board with trust tiers
{
  // dept A: independently verified
  core.signup({ api_key: "tm-expert-key" });
  const recA = core.verify({ target: "TM script", verifier: "TM-expert-15yr", api_key: "tm-expert-key",
    static_checks: [{ dim: "d", passed: true, evidence: "e" }],
    e2e_evidence: [{ claim: "call flow works", observed: true, detail: "실통화 관측" }] });
  const a = core.pass({ api_key: "tkey", receipt: recA, snapshot: { context: { goal: "TM 상담 스크립트 고도화" }, next_steps: ["A/B 테스트"] } });
  // dept B: self-attested only
  const b = core.pass({ api_key: "tkey", snapshot: { context: { goal: "회계 마감 자동화" }, next_steps: ["감사"] },
    verify: { static_checks: [{ dim: "d", passed: true, evidence: "e" }], e2e_evidence: [{ claim: "합계 맞음", observed: true, detail: "수기대조" }] } });
  // dept C: unverified
  const c = core.pass({ api_key: "tkey", snapshot: { context: { goal: "마케팅 카피" }, next_steps: ["게시"] } });

  const board = core.consolidate({ codes: [a.code, b.code, c.code] });
  assert.equal(board.departments.length, 3);
  assert.match(board.summary, /1 independently verified/);
  assert.match(board.summary, /1 self-attested/);
  assert.match(board.summary, /1 unverified/);
  assert.match(board.trust, /cross-verify/);              // warns because not all independent
  assert.equal(board.departments[0].verifier, "TM-expert-15yr");  // WHO verified is surfaced
  assert.deepEqual(board.open_next_steps.sort(), ["A/B 테스트", "감사", "게시"].sort());
  ok("consolidate: dept handoffs → one board w/ trust tiers + who-verified + open steps");
}

// 19. C1 fix: a producer CANNOT self-claim independent verification by naming a fake verifier
{
  // attack A: inline verify with a fake "independent" verifier name → must stay self-attested
  const atk = core.pass({ api_key: "producer-key-1",
    snapshot: { context: { goal: "self-claim attack" } },
    verify: { verifier: "independent-auditor-jane",
      static_checks: [{ dim: "d", passed: true, evidence: "e" }],
      e2e_evidence: [{ claim: "works", observed: true, detail: "200" }] } });
  assert.equal(atk.tier, "self-attested");                 // NOT independent, despite the name
  assert.match(core.receive({ code: atk.code }).badge, /🔏 SEALED/);

  // attack B: producer verifies with THEIR OWN key, then attaches → still self-attested
  const ownRec = core.verify({ target: "x", verifier: "me", api_key: "producer-key-1",
    static_checks: [{ dim: "d", passed: true, evidence: "e" }], e2e_evidence: [{ claim: "w", observed: true, detail: "200" }] });
  const b = core.pass({ api_key: "producer-key-1", snapshot: { context: { goal: "own-key" } }, receipt: ownRec });
  assert.equal(b.tier, "self-attested");                   // same identity → not independent

  // legit: a DIFFERENT registered account verifies → independent
  core.signup({ api_key: "auditor-key-9" });
  const indRec = core.verify({ target: "x", verifier: "auditor", api_key: "auditor-key-9",
    static_checks: [{ dim: "d", passed: true, evidence: "e" }], e2e_evidence: [{ claim: "w", observed: true, detail: "200" }] });
  const c2 = core.pass({ api_key: "producer-key-1", snapshot: { context: { goal: "cross" } }, receipt: indRec });
  assert.equal(c2.tier, "independent");
  ok("C1 fix: fake verifier name & self-key stay 🔏 SEALED; only a different account earns 🕸️");
}

// 20. C2 fix: consolidate caps code count and dedupes (DoS amplification blocked)
{
  assert.throws(() => core.consolidate({ codes: new Array(51).fill("BTN-H-X") }), /max 50/);
  const one = core.pass({ api_key: "tkey", snapshot: { context: { goal: "dup" } } });
  const board = core.consolidate({ codes: [one.code, one.code, one.code] });  // repeated
  assert.equal(board.departments.length, 1);               // deduped → one scrypt, not three
  ok("C2 fix: consolidate caps at 50 + dedupes repeated codes (no scrypt amplification)");
}

console.log(`\n🕸️  BATON: ${pass}/20 groups passed\n`);
