// 🕸️ Spider 공유 corpus — 스크럽 파이프라인 (신뢰 핵심).
// 기여 패턴에서 코드·시크릿·프로젝트 식별정보를 제거하고 *일반화된 기법*만 남긴다.
// 의심되면 거부(저장 안 함). "사실 왜곡 금지"의 데이터 버전 — 새는 것보다 막는 게 우선.
import { createHash } from 'node:crypto';

// 고엔트로피(시크릿 추정) 토큰: 길고 무작위한 영숫자/base64/hex
const HIGH_ENTROPY = /[A-Za-z0-9_+/=\-]{24,}/g;   // include +/= so raw base64 secrets are caught (L3)
const HEX_LONG = /\b[0-9a-f]{16,}\b/gi;
const JWT = /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g;
const KEY_PREFIXED = /\b(sk|pk|rk|whsec|xox[baprs]|ghp|gho|AKIA|AIza|SG\.)[_\-A-Za-z0-9]{8,}/gi;
const EMAIL = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
const URL = /\bhttps?:\/\/[^\s)'"]+/gi;
const IPV4 = /\b\d{1,3}(\.\d{1,3}){3}\b/g;
// 코드 좌표(file:line)·경로
const FILEPATH = /\b[\w./\-]+\.(ts|tsx|js|jsx|sql|py|go|rb|java|php|cs|rs|kt|vue|svelte)(:\d+(:\d+)?)?\b/gi;
// 따옴표 리터럴(코드 문자열·식별자 유출 가능) → 자리표시자
const QUOTED = /(['"`])(?:\\.|(?!\1).){2,}\1/g;

const REDACTIONS = [
  [JWT, '⟨jwt⟩'], [KEY_PREFIXED, '⟨secret⟩'], [HEX_LONG, '⟨hex⟩'],
  [EMAIL, '⟨email⟩'], [URL, '⟨url⟩'], [IPV4, '⟨ip⟩'], [FILEPATH, '⟨file⟩'],
  [QUOTED, '⟨literal⟩'], [HIGH_ENTROPY, '⟨token⟩'],
];

/** 자유텍스트에서 코드·시크릿·식별정보 제거(일반화). */
export function scrubText(input) {
  let s = String(input ?? '');
  s = s.replace(/<[^>]*>/g, ' ');           // C1: strip HTML tags (stored-XSS defense)
  s = s.replace(/[<>]/g, ' ');              // and any stray angle brackets
  for (const [re, repl] of REDACTIONS) s = s.replace(re, repl);
  return s.replace(/\s+/g, ' ').trim().slice(0, 600);
}

// 스크럽 후에도 시크릿 잔존 의심 → 거부.
const STILL_SUSPICIOUS = [/password\s*[:=]\s*\S+/i, /secret\s*[:=]\s*\S+/i, /token\s*[:=]\s*\S+/i, /\b[A-Za-z0-9+/]{24,}={0,2}\b/];
/** 안전성 판정: 일반화 기법으로 보이면 ok, 시크릿/원시코드 냄새면 reject. */
export function isSafe(scrubbed, { minLen = 8 } = {}) {
  if (scrubbed.length < minLen) return { ok: false, reason: 'too short after scrub' };
  if (STILL_SUSPICIOUS.some((re) => re.test(scrubbed))) return { ok: false, reason: 'possible secret remains' };
  // ⟨literal⟩ 자리표시자가 과도하면(원문이 코드 덩어리) 거부
  const ph = (scrubbed.match(/⟨\w+⟩/g) || []).length;
  if (ph > 6) return { ok: false, reason: 'too much redacted content (looks like raw code)' };
  return { ok: true };
}

const STOP = new Set(['the','a','to','of','in','is','and','or','for','with','을','를','이','가','은','는','에','의','로']);
/** dedup용 정규화 지문 — class + 정규화 signal의 핵심 토큰 정렬 해시. */
export function fingerprint(klass, signal) {
  const norm = scrubText(`${klass} ${signal}`).toLowerCase()
    .replace(/⟨\w+⟩/g, ' ').replace(/[^a-z0-9가-힣\s]/g, ' ')
    .split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).sort();
  const uniq = [...new Set(norm)].join(' ');
  return createHash('sha256').update(uniq).digest('hex').slice(0, 32);
}

/** 익명 해시(불가역) — 신원/원문 토큰 저장 금지. 서버 솔트 필수. */
export function anonHash(token, salt) {
  if (!token) return null;
  return createHash('sha256').update(`${salt || ''}:${token}`).digest('hex').slice(0, 40);
}

/**
 * 기여 패턴을 스크럽·검증·정규화해 저장 가능한 레코드로.
 * @returns {ok, record?|reason}
 */
export function preparePattern(raw, { contributorToken, projectId, salt } = {}) {
  const klass = scrubText(raw.klass).slice(0, 80);
  const name = scrubText(raw.name).slice(0, 120);
  const signal = scrubText(raw.signal);
  const fix = scrubText(raw.fix);
  if (!klass || !name || !signal || !fix) return { ok: false, reason: 'missing fields after scrub' };
  // L3: gate ALL free-text fields (name/klass too, not just signal/fix) for residual secrets.
  for (const [k, v, minLen] of [['klass', klass, 2], ['name', name, 2], ['signal', signal, 8], ['fix', fix, 8]]) {
    const safe = isSafe(v, { minLen });
    if (!safe.ok) return { ok: false, reason: `${k}: ${safe.reason}` };
  }
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t) => String(t).toLowerCase().replace(/[^a-z0-9\-]/g, '').slice(0, 24)).filter(Boolean).slice(0, 8)
    : [];
  const severity = ['red', 'yellow', 'green'].includes(raw.severity) ? raw.severity : 'yellow';
  const tier = ['king', 'mid', 'baby'].includes(raw.tier) ? raw.tier : 'mid';
  return {
    ok: true,
    record: {
      klass, name, signal, fix, tags, severity, tier,
      fingerprint: fingerprint(klass, signal),
      contributor_hash: anonHash(contributorToken, salt) || anonHash('anon', salt),
      project_hash: projectId ? anonHash(projectId, salt) : null,
    },
  };
}
