// BATON verify gate — the spider's judgment, hardened by the user's lesson:
// "빌드 통과 ≠ 동작." A VERIFIED verdict REQUIRES observed E2E evidence
// (HTTP status, DB row delta, real model output), never static reasoning alone.
// And per arch review H1, trust is established on the RECEIVER side, not the sender's.
import { BUILTIN_TRAPS, classify } from "./spider.js";

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
  const e2eObserved = e2e_evidence.length > 0 && e2e_evidence.every((e) => e.observed === true);
  // The hard rule: no E2E observation → cannot be verified, only static-only.
  let verdict;
  if (!e2eObserved) verdict = "static-only";
  else if (!staticPass) verdict = "failed";
  else verdict = "verified";

  const manifest = {
    verifier, target, method: e2eObserved ? "static+e2e" : "static",
    static_checks, e2e_evidence, verdict,
    badge: verdict === "verified" ? "🕸️ VERIFIED"
         : verdict === "failed" ? "🔴 FAILED"
         : "⚪ STATIC-ONLY (관측 증거 없음 — 완료 주장 신뢰 불가)",
    // signed-ish attestation of exactly what was compared (H1: label what was checked)
    attested: `${static_checks.length} static checks, ${e2e_evidence.filter((e) => e.observed).length}/${e2e_evidence.length} E2E observations`,
  };
  return { verdict, manifest };
}
