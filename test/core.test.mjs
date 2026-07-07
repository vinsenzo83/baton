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
  const r = core.pass({ snapshot: {
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
  const r = core.pass({ one_time: true, snapshot: { context: { goal: "one shot" } } });
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
  const r = core.pass({ snapshot: { context: { goal: "verified handoff" } }, verify_manifest: manifest });
  assert.equal(r.verified, true);
  const got = core.receive({ code: r.code });
  assert.match(got.badge, /VERIFIED/);
  ok("verified manifest → 🕸️ badge survives handoff");
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
  const acctView = core.account({});
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

console.log(`\n🕸️  BATON: ${pass}/10 groups passed\n`);
