// BATON verify gate — the spider's judgment, hardened by the user's lesson:
// "빌드 통과 ≠ 동작." A VERIFIED verdict REQUIRES observed E2E evidence
// (HTTP status, DB row delta, real model output), never static reasoning alone.
// And per arch review H1, trust is established on the RECEIVER side, not the sender's.
import { BUILTIN_TRAPS, classify } from "./spider.js";
import { signReceipt, verifyReceiptSig } from "./crypto.js";

// Plan: what a receiver's spider should statically check AND what it must E2E-probe.
export function planVerify({ target, claims = [] } = {}) {
  const dims = [
    { key: "security", tier: "king", check: "인증 게이팅·시크릿·RLS·SECURITY DEFINER PUBLIC grant" },
    { key: "data-payment", tier: "king", check: "단위/제약·결제→권한 전경로·집계 캡" },
    { key: "cost-integrity", tier: "king", check: "예산가드·폭주 루프·리밋 우회·이중계상" },
    { key: "integration", tier: "mid", check: "생산자→저장소→소비자 계약·이벤트 이름/페이로드" },
  ];
  // Each claim of "완료/동작함" must map to a concrete E2E probe that OBSERVES a side effect.
  const e2e_required = claims.map((c) => ({
    claim: c,
    probe: "실제 행동을 실행하고 부수효과를 관측하라 — 예: 발행 버튼 클릭 후 HTTP 200 + DB 행 수 before/after 증가 확인 (upsert 무음 실패 색출).",
  }));
  return {
    principle: "⚖️ 정적 대조만으로 PASS 금지. 빌드 통과 ≠ 동작. 실제 관측 증거로만 verified.",
    target,
    static_dims: dims.map((d) => ({ ...d, spider: classify({ area: d.key }).spider })),
    known_traps_check_first: BUILTIN_TRAPS.map((t) => `[${t.klass}] ${t.name}`),
    e2e_required: e2e_required.length ? e2e_required : [{
      claim: "(스냅샷의 모든 완료 주장)",
      probe: "각 완료 주장마다 실제 경로를 실행해 관측 — HTTP 상태·DB delta·실제 출력. 무음 실패 필수 색출.",
    }],
    gate: "static_checks 통과 AND 모든 e2e_required 에 관측 증거가 있어야 verdict='verified'. 하나라도 미관측이면 'static-only'.",
  };
}

// Gate: decide the verdict from what the receiver actually collected.
// static_checks: [{dim, passed, evidence}], e2e_evidence: [{claim, observed, detail}]
export function gateVerdict({ verifier = "receiver-spider", target, static_checks = [], e2e_evidence = [] } = {}) {
  const staticPass = static_checks.length > 0 && static_checks.every((s) => s.passed);
  const unobserved = e2e_evidence.filter((e) => e.observed !== true);
  const e2eObserved = e2e_evidence.length > 0 && unobserved.length === 0;
  // The hard rule: no E2E observation → cannot be verified, only static-only.
  let verdict, reason;
  if (!e2eObserved) {
    verdict = "static-only";
    reason = e2e_evidence.length === 0
      ? "no E2E evidence supplied — a passing build ≠ working behavior; run the flow and observe a side effect"
      : `${unobserved.length}/${e2e_evidence.length} E2E claim(s) not observed: ${unobserved.map((e) => `"${e.claim}"`).join(", ")}. Every claim needs observed:true.`;
  } else if (!staticPass) {
    verdict = "failed";
    reason = static_checks.length === 0
      ? "no static checks supplied"
      : `static check failed: ${static_checks.filter((s) => !s.passed).map((s) => s.dim).join(", ")}`;
  } else {
    verdict = "verified";
    reason = `all ${static_checks.length} static checks passed and all ${e2e_evidence.length} E2E claim(s) observed`;
  }

  const manifest = {
    verifier, target, method: e2eObserved ? "static+e2e" : "static",
    static_checks, e2e_evidence, verdict, reason,
    // legacy manifest badge: does NOT assert independence (that's decided at consumption by identity)
    badge: verdict === "verified" ? "🕸️ VERIFIED" : verdict === "failed" ? "🔴 FAILED" : "⚪ STATIC-ONLY",
    attested: `${static_checks.length} static checks, ${e2e_evidence.filter((e) => e.observed).length}/${e2e_evidence.length} E2E observations`,
  };
  return { verdict, reason, manifest };
}

// Badge from verdict + whether the verifier is INDEPENDENT of the producer (identity-based).
export function badgeFor(verdict, independent) {
  if (verdict === "verified") return independent ? "🕸️ VERIFIED" : "🔏 SEALED (self-attested — receiver should re-verify)";
  if (verdict === "failed") return "🔴 FAILED";
  return "⚪ STATIC-ONLY (no observed evidence — claims not trusted)";
}

// ── Verification Receipt (the differentiator) ──
// A SERVER-SIGNED record of an independent verification: who verified, in what environment,
// what was observed, with what artifacts, and the verdict. The signature makes it a trust unit
// no client can forge — "never trust an agent handoff without a receipt."
// The receipt records WHO verified as an identity (verifier_key_hash = codeHash(api_key)),
// NOT a free string — so nobody can type a fake "independent auditor" name (C1). The tier
// (independent vs self-attested) is NOT stored here: it can only be decided at consumption
// time by comparing the verifier's identity to the PRODUCER's. So issueReceipt signs the
// facts (verdict, evidence, verifier identity); pass/receive compute the trust tier.
export function issueReceipt({ verifier, verifier_key_hash = null, target, capsule, environment, static_checks = [], e2e_evidence = [], artifacts = [], issued_at = 0 } = {}) {
  const v = verifier || "receiver-spider";
  const { verdict, reason } = gateVerdict({ verifier: v, target, static_checks, e2e_evidence });
  const body = {
    kind: "baton.verification-receipt/v1",
    capsule: capsule || null,                 // hash of the handoff this verifies
    target: target || null,
    verifier: v,                              // display label (untrusted — identity is the hash)
    verifier_key_hash,                        // WHO verified, bound to a registered account (or null)
    environment: environment || {},           // os / runtime / commit the replay ran in
    static_checks,
    observed: e2e_evidence,                    // what was actually run + observed
    artifacts,                                 // trace / har / screenshots / logs digests
    verdict,                                   // verified | static-only | failed
    reason,                                    // WHY this verdict (transparency)
    issued_at,
  };
  return { ...body, signature: signReceipt(body) };
}

// Anyone can verify a receipt's authenticity; nobody can forge one.
export function verifyReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || !receipt.signature) return { valid: false, reason: "no signature" };
  const { signature, ...body } = receipt;
  const valid = verifyReceiptSig(body, signature);
  return { valid, verdict: valid ? receipt.verdict : null, reason: valid ? "signature ok" : "bad signature (forged or tampered)" };
}

// Decide the trust tier by comparing identities — the ONLY sound basis for "independent".
// independent 🕸️ requires: the verifier is a REGISTERED account AND is not the producer.
// Anonymous verification, or the producer verifying their own work, is at most 🔏 SEALED.
export function tierOf(verifierKeyHash, producerKeyHash) {
  return verifierKeyHash && verifierKeyHash !== producerKeyHash ? "independent" : "self-attested";
}
