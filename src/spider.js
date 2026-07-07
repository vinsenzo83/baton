#!/usr/bin/env node
// 🕸️ Spider MCP — 거미줄 검증 방법론을 MCP tool/resource로 노출.
// 모델(클라이언트)이 오케스트레이터, 이 서버는 결정론적 지식·계획·기억을 제공한다.
//  - resources: 체크리스트 / 계약쿼리 템플릿 / 자가발전 corpus
//  - tools: weave 플랜 / 등급분류(King·Mid·Baby) / 탐지신호 조회 / 패턴 기록 / 패턴 조회
// corpus·checklist는 스킬(~/.claude/skills/spiderweb-qc/references)과 같은 파일을 공유해
// 스킬과 MCP가 같은 기억을 키운다. SPIDER_REF_DIR 로 경로 교체 가능.
//
// ⚠️ npm 배포판은 references 디렉터리를 동봉하지 않는다(files=[src,README]). 따라서 외부
// (npx recluse-mcp) 사용자에겐 SPIDER_REF_DIR 파일이 없다 → 아래 BUILTIN_* 지식을 코드에
// 내장해 파일이 없어도 툴이 실제로 동작하게 한다(그물망이 이 안에서 산다). 파일이 있으면 파일이
// 우선(스킬 corpus가 더 풍부), 없으면 내장 지식으로 폴백한다. 세션 실증 그물코는 파일 유무와
// 무관하게 항상 병합해 반환한다.
// BATON absorbs the spider (recluse) engine — one server, not two (S2 handoff gate).
// src/server.js creates the McpServer; here we register spider_* tools onto it via
// registerSpiderTools(server) and export BUILTIN_TRAPS/classify for baton_verify.
import { z } from 'zod';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const REF_DIR = process.env.SPIDER_REF_DIR
  || join(homedir(), '.claude', 'skills', 'spiderweb-qc', 'references');
const read = (f) => { try { return readFileSync(join(REF_DIR, f), 'utf8'); } catch { return ''; } };

// 공유 corpus(집단 거미 두뇌) — 설정 시 로컬 파일과 함께 원격 기여/조회.
const CORPUS_API = process.env.SPIDER_CORPUS_API || ''; // 예: https://corpus.example.com
const CORPUS_TOKEN = process.env.SPIDER_CORPUS_TOKEN || ''; // 익명 기여자 토큰(신원 아님)
async function corpusFetch(path, init) {
  if (!CORPUS_API) return null;
  try {
    const r = await fetch(`${CORPUS_API}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(CORPUS_TOKEN ? { authorization: `Bearer ${CORPUS_TOKEN}` } : {}), ...(init?.headers || {}) },
    });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// ══════════════════════════════════════════════════════════════════
// 내장 그물망 — 실증 버그 클래스(각 신호 = 라이브 쿼리 / grep). 파일 부재 시 이게 산다.
// 각 항목: { klass, name, tier, tags, signal, fix }.  signal = "어떻게 잡는가"(쿼리/grep).
// ══════════════════════════════════════════════════════════════════
const BUILTIN_TRAPS = [
  {
    klass: '권한경계', name: 'SECURITY DEFINER PUBLIC grant (REVOKE anon = no-op)', tier: 'king',
    tags: ['postgres', 'supabase', 'rls', 'privilege'],
    signal: "select p.proname, p.prosecdef, p.proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef order by 1;  proacl가 NULL이거나 '=X/owner'(PUBLIC EXECUTE)를 포함하면 anon 실행 가능. `has_function_privilege('anon',oid,'EXECUTE')`=true 재확인 + PostgREST /rest/v1/rpc/<fn> 를 anon key로 실제 호출해 200/데이터 나오는지 실증.",
    fix: "REVOKE EXECUTE ON FUNCTION fn(args) FROM PUBLIC;  그 다음 GRANT EXECUTE ... TO service_role. `REVOKE ... FROM anon`만으론 PUBLIC grant가 남아 no-op — 반드시 FROM PUBLIC. CREATE OR REPLACE는 ACL을 보존하므로 교체 후에도 재점검.",
  },
  {
    klass: '권한경계', name: 'plpgsql NULL 3치논리 가드 우회', tier: 'king',
    tags: ['postgres', 'plpgsql', 'privilege'],
    signal: "SECURITY DEFINER 함수 본문 grep: `IF NOT (cond) THEN raise` / `IF cond THEN ... END IF` 가드에서 cond가 NULL 가능한가(비교 대상이 nullable 컬럼·인자). `NULL OR false`=NULL, `IF NOT NULL`→false 취급이라 예외가 안 터진다. pg_get_functiondef로 본문 추출 후 가드식의 NULL 처리 확인.",
    fix: "가드를 fail-closed로: `coalesce(cond,false)` 또는 `cond IS NOT TRUE` / `IS DISTINCT FROM`. NULL이면 거부(권한 없음)로 떨어지게. `= NULL` 대신 `IS NULL` 명시.",
  },
  {
    klass: '권한경계', name: 'SECURITY DEFINER 뷰 write-through (RLS 우회)', tier: 'king',
    tags: ['postgres', 'supabase', 'rls', 'view'],
    signal: "뷰가 security_invoker=off(기본)이면 정의자 권한으로 base 테이블 접근 → anon이 뷰로 SELECT/INSERT/UPDATE 시 base RLS 우회. 조회: `select relname, reloptions from pg_class where relkind='v'` (security_invoker=on 없으면 off). anon JWT로 뷰에 REST write/read 재현해 base RLS가 우회되는지 실증.",
    fix: "`ALTER VIEW v SET (security_invoker = on)` → 뷰가 호출자 권한·RLS를 상속. 또는 뷰 자체를 anon에서 REVOKE. 민감 base면 뷰 경유 write 차단.",
  },
  {
    klass: '순서무결성', name: '커리큘럼/그래프 band 역전 · 순환 의존', tier: 'mid',
    tags: ['curriculum', 'graph', 'dag', 'content'],
    signal: "선행(prerequisite) 노드가 후행보다 band/level이 높으면 역전(선행을 먼저 못 배움). SQL: `select e.* from prereq_edges e join nodes a on a.id=e.prereq_id join nodes b on b.id=e.node_id where a.band > b.band`. 순환은 recursive CTE(WITH RECURSIVE)로 cycle 탐지 — A→B→A면 학습경로 무한/막힘.",
    fix: "불변식: prereq.band ≤ node.band. 시드/마이그레이션에 검증 쿼리(위) 0행 게이트. 순환 엣지 제거(DAG 강제). 클라 로드맵도 같은 순서를 소비하는지 대조.",
  },
  {
    klass: '비용공격', name: 'per-user 리밋 익명 파밍(한도 우회)', tier: 'king',
    tags: ['abuse', 'ratelimit', 'quota', 'anonymous', 'cost'],
    signal: "일일/사용자 한도의 키가 user_id인데 익명 계정 생성이 무료·무제한이면 재가입으로 한도 리셋 → 고가 LLM 무한 파밍. grep: rate/quota/daily 체크가 참조하는 키 + 익명 계정(anonymous sign-in / 게스트) 생성 경로. 라이브: 익명 세션 반복 생성 후 한도 초과분이 실제로 소비되는지.",
    fix: "리밋 키를 비용 드는 축으로 이중화(IP·디바이스·전화 검증). 익명엔 훨씬 낮은 전역 한도. 고가 경로 진입부 budgetGuard 병행(개인 한도와 별개로 시스템 상한).",
  },
  {
    klass: '폴백/스트림', name: '스트림 LLM 예산초과 → 502 (가드 위치)', tier: 'mid',
    tags: ['stream', 'sse', 'budget', 'llm', 'fallback'],
    signal: "SSE/스트림 라우트에서 budgetGuard가 스트림 *시작 후* throw하면 헤더 이미 전송돼 502/연결끊김(친절한 오류 불가). grep: stream/SSE 응답 시작(ReadableStream·res.write 헤더)와 budgetGuard·예산체크의 상대 위치. 라이브: 예산 초과 상태에서 스트림 엔드포인트 호출해 502 관찰.",
    fix: "가드를 스트림 시작 *전*에 배치. 초과면 스트림 대신 정상 JSON 429/503(친절). 스트림 usage는 래퍼가 못 보므로 호출부에서 기록(이중계상과 상호배타).",
  },
  {
    klass: '이벤트계약', name: 'producer↔consumer 이벤트 불일치(죽은/유령 이벤트)', tier: 'mid',
    tags: ['analytics', 'events', 'contract', 'integration'],
    signal: "이벤트 이름·페이로드 키를 producer(track/emit/insert event=)와 consumer(집계 필터 `event='X'`·구독)가 grep 대조. 대소문자·철자 불일치면 소비 0행. 소비자 없는 생산=죽은 이벤트, 생산자 없는 소비=항상 빈 대시보드. 라이브 count로 실적재 확인(`select event,count(*) from analytics_events group by 1`).",
    fix: "이벤트 이름·페이로드 스키마를 단일 상수/타입으로 공유(producer·consumer 같은 소스). 적재 실효는 배포전 0인지 안-fire인지 라이브 count로 구분.",
  },
  // ── 이전 라운드 고신호 패턴(npm 사용자에게도 항상 제공) ──
  {
    klass: '단위/제약', name: '결제 plan 센트↔달러 불일치', tier: 'king',
    tags: ['postgres', 'payment', 'unit', 'stripe'],
    signal: "`select pg_get_constraintdef(oid) from pg_constraint where conname like '%plan%check'` 허용값 vs 코드 가격상수·webhook write·PRICE_TIER·집계 라벨. 셋이 같은 스케일인가.",
    fix: "한 단위로 전 구간 통일(코드 USD면 CHECK도 (9,19,29)). 한쪽만 고치면 소비자 폴백이 깨짐.",
  },
  {
    klass: '폭주루프', name: '자가치유 재트리거 × 고가 크론 = 비용폭탄', tier: 'king',
    tags: ['cron', 'cost', 'budget', 'runaway'],
    signal: "healthcheck/autorepair 재트리거 fetch 루프에 쿨다운·회수상한이 있는가 + 재트리거 대상에 opus/web_search급 고가 크론이 있는가. 라이브: 최고액 api 호출이 15분 정각 간격이면 확정.",
    fix: "재트리거 쿨다운(마지막 실행 후 N시간) + 대상 크론 진입부 budgetGuard + 일일 페이싱(월예산/30).",
  },
  {
    klass: '집계오류', name: 'PostgREST max-rows 1000 캡 과소집계', tier: 'mid',
    tags: ['postgres', 'supabase', 'aggregate'],
    signal: "`.from(t).select(col)` + 클라 reduce 합산 grep. 행수 1000 초과 테이블이면 확정(limit 20000 걸어도 서버 캡이 이김).",
    fix: "DB측 집계 RPC(sum/group by)로 전환. 민감 정보면 service_role 전용 grant.",
  },
  {
    klass: '이중계상', name: '비용 래퍼 + 호출부 동시 기록', tier: 'mid',
    tags: ['cost', 'billing', 'observability'],
    signal: "`grep recordUsage` 전수 — 래퍼가 기록하는데 호출부도 기록하면 이중. 라이브: 동일 model·in/out_tokens ±3초 중복쌍.",
    fix: "단일 기록 지점(래퍼). 라벨은 params 특수필드로 전달. 스트림만 호출부 기록(래퍼가 usage 못 봄 — 상호배타).",
  },
];

// 세션 실증 그물코(체크리스트에 항상 병합할 dimension 9 마크다운)
const SESSION_NET = `
## 9. 이번 세션 실증 그물코 (2026-07, 파일·내장 병합)
- [ ] **SECURITY DEFINER 함수 grant가 PUBLIC이 아닌가.** \`select proname,proacl from pg_proc where prosecdef\` — proacl NULL/=X/(PUBLIC)면 anon 실행. \`REVOKE ... FROM anon\`은 PUBLIC grant면 no-op → \`REVOKE EXECUTE ... FROM PUBLIC\` + service_role만 GRANT. PostgREST rpc anon 호출로 실증.
- [ ] **plpgsql 가드가 NULL 3치논리로 뚫리지 않는가.** \`IF NOT (cond)\`의 cond가 nullable이면 NULL→false 취급으로 예외 미발화. \`coalesce(cond,false)\`/\`IS NOT TRUE\`로 fail-closed.
- [ ] **SECURITY DEFINER 뷰로 anon write-through 없나.** reloptions에 security_invoker=on 없으면 정의자 권한 → base RLS 우회. \`ALTER VIEW ... SET(security_invoker=on)\`.
- [ ] **커리큘럼/그래프 순서 무결성.** prereq.band ≤ node.band(역전 0행)·순환 의존(recursive CTE cycle 0). DAG 위반 = 학습경로 막힘.
- [ ] **per-user 리밋이 익명 파밍으로 우회되지 않나.** 한도 키가 user_id뿐이고 익명 재가입 무제한이면 고가 경로 무한 파밍. 비용 축(IP/디바이스) 이중화 + 진입부 budgetGuard.
- [ ] **스트림 예산 가드가 스트림 시작 前인가.** 시작 후 throw면 502(친절한 오류 불가). 초과 시 정상 JSON 429/503.
- [ ] **이벤트 producer↔consumer 계약 일치.** event 이름·페이로드 키 대소문자/철자 생산=소비. 죽은 이벤트/유령 소비 0. 라이브 count로 실적재 구분.
`;

// 내장 체크리스트(파일 부재 시 폴백) — 스킬 references/checklist.md 의 8차원 요약본.
const BUILTIN_CHECKLIST = `# 🕸️ 스파이더 전수 체크리스트 (내장 폴백)

각 항목은 증거(쿼리/grep/HTTP) 없이 PASS 불가. 좌표(file:line/제약/정책)와 함께 보고.

## 1. 인증·권한 경계
- [ ] 보호 엔드포인트 전부 진입부 인증 가드(우회 라우트 0).
- [ ] 빈값/널 통과 차단(\`key && expected && key===expected\`). 타이밍 민감이면 상수시간 비교.
- [ ] service-role/시크릿이 클라 번들에 없음. grep \`NEXT_PUBLIC.*(SERVICE|SECRET|KEY)\`.
- [ ] RLS ON + 정책 의도대로(own-row=\`auth.uid()=id\`).
- [ ] anon/authenticated 불필요 테이블 grant 없음(REVOKE INSERT/UPDATE/DELETE).
- [ ] SECURITY DEFINER 함수 anon EXECUTE 과다 없음 — **grant가 PUBLIC이면 anon REVOKE는 no-op**.

## 2. 데이터 계약 (생산자↔저장소↔소비자)
- [ ] 소비 컬럼 실재·타입 일치. enum/status 문자열 생산=소비 동일(대소문자).
- [ ] onConflict 대상에 PK/UNIQUE 실재. CHECK/NOT NULL/FK 통과.

## 3. 단위·스케일
- [ ] 금액 단위 통일(센트↔달러 혼재 0). 시간(ms↔s)·비율(%↔소수) 생산=소비 동일.

## 4. 끊긴 고리·죽은 코드
- [ ] 생산자 없는 소비 0·소비자 없는 생산 0·죽은 enum 절 0. 라이브 count로 fire 여부.

## 5. 비즈니스 핵심 흐름 (end-to-end)
- [ ] 권한 부여 3경로(결제·쿠폰·관리자)가 entitlement로 수렴. 결제 전 구간 단위 일치.
- [ ] 모더레이션: 공개 소비자가 검수본만(미검수 누수 0). i18n fallback 체인.

## 6. 폴백·오류 처리
- [ ] 조용한 폴백이 진짜 실패를 안 가림. 품질 경로 저품질 폴백 금지. 레이트리밋 빈도.

## 7. 런타임·빌드·회귀
- [ ] 빌드 EXIT=0. lint 신규위반 0. HTTP 스모크(403/200/렌더). 수정+인접 가닥 재실행.

## 8. 자가발전
- [ ] 시작 시 알려진 함정 우선 점검. 종료 시 새 🔴/🟡 패턴 증류.

---
**판정**: 결제·권한·데이터유실은 기본 🔴. 미검수 노출·과다 grant·죽은 절·비용폭주·리밋우회는 🟡~🔴(맥락).`;

// 내장 계약쿼리(파일 부재 시 폴백) + 세션 신규 탐지 SQL.
const BUILTIN_QUERIES = `-- 🕸️ SPIDER 증거 수집 쿼리 (내장 폴백, Supabase/Postgres). 추정 금지 — 실제 결과로 판정.

-- 1) 컬럼 계약
select column_name,data_type,is_nullable from information_schema.columns
where table_schema='public' and table_name=:'table' order by ordinal_position;

-- 2) 제약/enum
select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid=(:'table')::regclass;
select t.typname,e.enumlabel from pg_type t join pg_enum e on e.enumtypid=t.oid order by 1,e.enumsortorder;

-- 3) RLS/권한 경계
select relname,relrowsecurity from pg_class where relkind='r' and relnamespace='public'::regnamespace;
select table_name,grantee,privilege_type from information_schema.role_table_grants
where table_schema='public' and grantee in('anon','authenticated') and privilege_type in('INSERT','UPDATE','DELETE');

-- ── 세션 신규 탐지 SQL (2026-07) ──
-- (A) SECURITY DEFINER 함수의 실제 ACL — proacl NULL/PUBLIC(=X/) 이면 anon 실행. anon REVOKE는 PUBLIC이면 무효.
select p.proname, p.prosecdef, p.proacl,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.prosecdef order by anon_exec desc, 1;

-- (B) SECURITY DEFINER 뷰(security_invoker=off) — base RLS 우회 write-through 위험.
select c.relname, c.reloptions
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='v'
  and (c.reloptions is null or not (c.reloptions @> array['security_invoker=on'] or c.reloptions @> array['security_invoker=true']));

-- (C) 커리큘럼 band 역전(선행이 후행보다 상위 band) — 0행이어야 정상. 테이블/컬럼명 치환.
-- select e.* from prereq_edges e
--   join nodes a on a.id=e.prereq_id join nodes b on b.id=e.node_id
-- where a.band > b.band;

-- (D) 순환 의존(cycle) 탐지 — recursive CTE. 경로에 이미 방문한 노드 재등장 = cycle.
-- with recursive walk(node_id, path, cyc) as (
--   select node_id, array[node_id], false from prereq_edges
--   union all
--   select e.node_id, w.path||e.node_id, e.node_id = any(w.path)
--   from prereq_edges e join walk w on e.prereq_id=w.node_id where not w.cyc
-- ) select distinct path from walk where cyc;

-- (E) 이벤트 실적재 — 배포전 0 vs 안-fire 구분.
-- select event, count(*), max(created_at) from analytics_events group by 1 order by 2 desc;`;

// ── 위험도 → 거미 등급 매핑(자원 배분) ─────────────────────────────
// 키워드 substring 매칭. 보수적으로: 애매하면 상위 등급으로(FN 비용 큰 경로에 힘).
const TIERS = {
  king: {
    spider: '🕷️ 대왕거미 (King)', model: 'opus', votes: 3,
    areas: [
      // 결제·계정·보안
      'payment', 'billing', 'auth', 'authz', 'grant', 'entitlement', 'gdpr', 'delete',
      'account', 'secret', 'migration', 'money', 'legal', 'rls',
      // 권한상승(세션 실증)
      'definer', 'privilege', 'escalation', 'revoke', 'security-definer',
      // 비용·비용공격(돈이 새는 경로 = king)
      'budget', 'cost', 'spend', 'runaway', 'abuse', 'farming',
    ],
  },
  mid: {
    spider: '🕸️ 중간거미 (Mid)', model: 'sonnet', votes: 2,
    areas: [
      'contract', 'integration', 'i18n', 'locale', 'content', 'moderation', 'aggregate',
      'gating', 'business',
      // 순서무결성·이벤트계약·스트림·리밋(세션 실증)
      'order', 'sequence', 'ordering', 'prerequisite', 'curriculum', 'cycle', 'dag',
      'event', 'stream', 'fallback', 'quota', 'ratelimit', 'rate-limit',
    ],
  },
  baby: {
    spider: '🐜 세끼거미 (Baby)', model: 'haiku', votes: 1,
    areas: ['style', 'docs', 'comment', 'dead-code', 'lint', 'string', 'ui-copy', 'cleanup'],
  },
};
function classify({ severity = 'yellow', area = '' } = {}) {
  const a = String(area).toLowerCase();
  if (TIERS.king.areas.some((k) => a.includes(k)) || severity === 'red') return { tier: 'king', ...TIERS.king };
  if (TIERS.baby.areas.some((k) => a.includes(k))) return { tier: 'baby', ...TIERS.baby };
  return { tier: 'mid', ...TIERS.mid };
}

// Exported for baton_verify: the receiving-side gate reasons over these traps + tiers.
export { BUILTIN_TRAPS, TIERS, classify, BUILTIN_CHECKLIST, SESSION_NET };

export function registerSpiderTools(server) {

// ── Resources: 지식 베이스(스킬과 공유, 부재 시 내장 폴백) ─────────
server.resource('checklist', 'spider://checklist', async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'text/markdown', text: (read('checklist.md') || BUILTIN_CHECKLIST) + '\n' + SESSION_NET }],
}));
server.resource('contract-queries', 'spider://queries', async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'text/x-sql', text: read('contract-queries.sql') || BUILTIN_QUERIES }],
}));
server.resource('learned-patterns', 'spider://corpus', async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'text/markdown', text: read('learned-patterns.md') || renderTrapsMd() }],
}));
server.resource('live-web', 'spider://blackbox', async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'text/markdown', text: read('live-web-blackbox.md') || '# live-web-blackbox 미발견(SPIDER_REF_DIR 확인)' }],
}));

function renderTrapsMd() {
  return '# 🧬 스파이더 학습 corpus (내장)\n\n' + BUILTIN_TRAPS.map((t) =>
    `### [${t.klass}] ${t.name}\n- tier: ${t.tier} (${t.tags.join(',')})\n- 신호: ${t.signal}\n- 수정: ${t.fix}\n`).join('\n');
}

// ── Tool: weave 플랜 ──────────────────────────────────────────────
server.tool(
  'spider_plan',
  '대상에 대한 거미줄 검증 계획을 반환: 던질 거미(차원·등급·모델), 우선 점검할 학습 패턴, 절대원칙. 라운드 시작 시 호출.',
  { target: z.string().describe('검증 대상(레포/기능/배포 범위)'), thorough: z.boolean().optional().describe('true면 거미 수↑·다수결 강화') },
  async ({ target, thorough }) => {
    const corpus = read('learned-patterns.md');
    // 파일 corpus 헤더가 있으면 그걸, 없으면 내장 trap 이름을 알려진 함정으로.
    const fileTraps = (corpus.match(/^### \[.*$/gm) || []).join('\n');
    const builtinTraps = BUILTIN_TRAPS.map((t) => `### [${t.klass}] ${t.name} (${t.tier})`).join('\n');
    const dims = [
      { key: 'security', tier: 'king', focus: '인증 게이팅·시크릿·RLS·권한경계·webhook 위조 · SECURITY DEFINER PUBLIC grant(REVOKE anon=no-op)·plpgsql NULL 3치논리 가드우회·DEFINER 뷰 write-through' },
      { key: 'data-payment', tier: 'king', focus: '단위/제약·결제→권한 전경로·집계(max-rows 1000 캡)·계정삭제(GDPR)' },
      { key: 'cost-integrity', tier: 'king', focus: '예산가드 전수(스트림 시작 前)·자가치유 폭주 루프 쿨다운·per-user 리밋 익명 파밍·비용 이중계상' },
      { key: 'integration', tier: 'mid', focus: '생산자→저장소→소비자 계약·끊긴고리·죽은enum·이벤트 producer↔consumer 이름/페이로드·i18n' },
      { key: 'order-integrity', tier: 'mid', focus: '커리큘럼 band 역전·순환 의존(DAG)·로드맵 순서 소비 일치' },
    ];
    if (thorough) dims.push({ key: 'runtime-ux', tier: 'mid', focus: '클라 렌더·깨진링크·콘솔에러·성능' });
    const plan = {
      principle: '⚖️ 사실 왜곡 금지 — 코드 file:line + 라이브 DB 쿼리 + 실제 HTTP/모델 출력으로만 판정.',
      target,
      weave: dims.map((d) => ({ ...d, spider: TIERS[d.tier].spider, model: TIERS[d.tier].model, votes: TIERS[d.tier].votes })),
      known_traps_check_first: fileTraps || builtinTraps,
      builtin_high_signal_traps: BUILTIN_TRAPS.map((t) => `[${t.klass}] ${t.name}`),
      loop: 'weave(탐지) → catch(걸림) → dispatch(등급매칭 거미 자율수정) → re-weave(재직조) → 🔴 0까지',
      resources: ['spider://checklist', 'spider://queries', 'spider://corpus'],
      tip: 'spider_signals 로 각 함정의 탐지 쿼리/grep 을 바로 받아 실행하라.',
    };
    return { content: [{ type: 'text', text: JSON.stringify(plan, null, 2) }] };
  },
);

// ── Tool: 등급 분류 ───────────────────────────────────────────────
server.tool(
  'spider_classify_tier',
  'finding을 King/Mid/Baby 거미로 분류하고 모델·검증표수를 반환. 수정 거미 급파 전 호출. 비용·권한상승·순서무결성 경로 반영.',
  { severity: z.enum(['red', 'yellow', 'green']).optional(), area: z.string().describe('영역 키워드(payment, definer, budget, order, event 등)') },
  async ({ severity, area }) => {
    const c = classify({ severity, area });
    const matched = c.areas.filter((k) => String(area).toLowerCase().includes(k));
    return { content: [{ type: 'text', text: JSON.stringify({ tier: c.tier, spider: c.spider, model: c.model, verification_votes: c.votes, matched_keywords: matched }, null, 2) }] };
  },
);

// ── Tool: 체크리스트 조회 ─────────────────────────────────────────
server.tool(
  'spider_checklist',
  '차원별 전수 체크리스트(증거 없이 PASS 금지)를 반환. 파일 부재 시 내장 체크리스트 + 세션 실증 그물코(권한상승·순서·비용·이벤트) 병합.',
  { dimension: z.string().optional().describe('인증/데이터/단위/끊긴고리/권한경계/폴백/런타임/순서/비용/이벤트 등') },
  async ({ dimension }) => {
    const all = (read('checklist.md') || BUILTIN_CHECKLIST) + '\n' + SESSION_NET;
    if (!dimension) return { content: [{ type: 'text', text: all }] };
    const blocks = all.split(/\n(?=## )/).filter((s) => s.toLowerCase().includes(dimension.toLowerCase()));
    return { content: [{ type: 'text', text: blocks.length ? blocks.join('\n') : all }] };
  },
);

// ── Tool: 탐지 신호 조회(신규) ────────────────────────────────────
server.tool(
  'spider_signals',
  '실증 버그 클래스의 탐지 신호(라이브 쿼리/grep)와 수정 원칙을 반환. klass/tier/tag로 필터. 계획 후 이 신호를 그대로 실행해 증거를 수집하라.',
  {
    klass: z.string().optional().describe('버그 클래스 부분일치(권한경계/순서무결성/비용공격/이벤트계약/단위 등)'),
    tier: z.enum(['king', 'mid', 'baby']).optional(),
    tag: z.string().optional().describe('스택 태그(postgres, stream, curriculum 등)'),
  },
  async ({ klass, tier, tag }) => {
    let out = BUILTIN_TRAPS;
    if (klass) out = out.filter((t) => t.klass.toLowerCase().includes(klass.toLowerCase()) || t.name.toLowerCase().includes(klass.toLowerCase()));
    if (tier) out = out.filter((t) => t.tier === tier);
    if (tag) out = out.filter((t) => t.tags.some((x) => x.toLowerCase().includes(tag.toLowerCase())));
    return { content: [{ type: 'text', text: JSON.stringify({ count: out.length, signals: out }, null, 2) }] };
  },
);

// ── Tool: 패턴 기록(자가발전 — corpus 증류) ───────────────────────
server.tool(
  'spider_record_pattern',
  '이번 라운드에 잡은 버그를 학습 corpus에 1줄 패턴으로 증류 추가(다음 라운드에 먼저 점검). 실제로 잡은 것만.',
  {
    klass: z.string().describe('버그 클래스(단위/제약·끊긴고리·권한경계 등)'),
    name: z.string().describe('짧은 이름'),
    signal: z.string().describe('탐지 신호 — 어떤 쿼리/grep/코드위치로 잡는가'),
    fix: z.string().describe('수정 원칙'),
    hit: z.string().describe('적중 예시(프로젝트·날짜·file:line)'),
    tags: z.string().optional().describe('스택 태그 쉼표(postgres,stream,curriculum 등)'),
  },
  async ({ klass, name, signal, fix, hit, tags }) => {
    const f = join(REF_DIR, 'learned-patterns.md');
    let local = '로컬 파일 없음(내장 corpus만) — SPIDER_REF_DIR 확인';
    if (existsSync(f)) {
      const entry = `\n### [${klass}] ${name}\n- 신호: ${signal}\n- 수정: ${fix}\n- 적중: ${hit}\n`;
      try { appendFileSync(f, entry); local = '로컬 corpus 파일에 증류됨'; }
      catch (e) { local = `로컬 기록 실패: ${e.message}`; }
    }
    // 공유 corpus에도 기여(설정 시) — 서버가 스크럽·dedup·신뢰도 누적. 코드/시크릿은 서버에서 거부됨.
    let shared = '로컬만(SPIDER_CORPUS_API 미설정)';
    if (CORPUS_API) {
      const tagArr = tags ? tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const r = await corpusFetch('/patterns', { method: 'POST', body: JSON.stringify({ klass, name, signal, fix, severity: 'yellow', ...(tagArr ? { tags: tagArr } : {}) }) });
      shared = r?.ok ? `공유됨(${r.body?.action}, hits ${r.body?.hit_count}, verified ${r.body?.verified})`
        : (r?.status === 422 ? `공유 거부(스크럽: ${r.body?.reason})` : `공유 실패(${r?.status || r?.error})`);
    }
    return { content: [{ type: 'text', text: `✅ corpus 증류: [${klass}] ${name}\n   로컬: ${local}\n   공유: ${shared}` }] };
  },
);

// ── Tool: 집단 corpus pull(다른 거미들이 잡은 패턴) ───────────────
server.tool(
  'spider_pull_corpus',
  '공유 corpus(집단 거미 두뇌)에서 검증된 패턴을 가져온다. verified 우선·tag/klass 필터. 원격 미설정/실패 시 내장 corpus로 graceful 폴백. 라운드 시작 시 알려진 함정 우선 점검용.',
  {
    tags: z.string().optional().describe('스택 태그 쉼표(postgres,nextjs,payment 등)'),
    klass: z.string().optional(),
    verified: z.boolean().optional().describe('true(기본)=합의검증된 패턴 우선. false=미검증 포함'),
    limit: z.number().optional(),
  },
  async ({ tags, klass, verified, limit }) => {
    const wantVerified = verified !== false; // 기본 verified 우선
    // 로컬/내장 폴백을 tag·klass로 필터한 결과(원격 실패 시에도 뭔가 반환).
    const localFiltered = () => {
      let out = BUILTIN_TRAPS.map((t) => ({ klass: t.klass, name: t.name, signal: t.signal, fix: t.fix, tier: t.tier, tags: t.tags, verified: false, source: 'builtin' }));
      if (klass) out = out.filter((p) => p.klass.toLowerCase().includes(klass.toLowerCase()) || p.name.toLowerCase().includes(klass.toLowerCase()));
      if (tags) { const ts = tags.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); out = out.filter((p) => p.tags.some((x) => ts.some((t) => x.toLowerCase().includes(t)))); }
      if (limit) out = out.slice(0, limit);
      return out;
    };

    if (!CORPUS_API) {
      const local = localFiltered();
      return { content: [{ type: 'text', text: JSON.stringify({ source: 'builtin (SPIDER_CORPUS_API 미설정)', count: local.length, patterns: local }, null, 2) }] };
    }

    const qs = new URLSearchParams();
    if (tags) qs.set('tags', tags);
    if (klass) qs.set('class', klass);
    if (wantVerified) qs.set('verified', '1');
    qs.set('limit', String(limit || 50));
    const r = await corpusFetch(`/patterns?${qs}`, { method: 'GET' });

    if (!r?.ok) {
      // graceful: 원격 실패 → 내장 corpus로 폴백(빈손 금지).
      const local = localFiltered();
      return { content: [{ type: 'text', text: JSON.stringify({ source: `builtin fallback (remote ${r?.status || r?.error})`, count: local.length, patterns: local }, null, 2) }] };
    }
    // verified 우선 정렬(원격이 이미 필터해도 안전하게 재정렬).
    const body = r.body || {};
    if (Array.isArray(body.patterns) && wantVerified) {
      body.patterns.sort((a, b) => (b.verified === true ? 1 : 0) - (a.verified === true ? 1 : 0) || (b.hit_count || 0) - (a.hit_count || 0));
    }
    return { content: [{ type: 'text', text: JSON.stringify({ source: 'remote', verified_first: wantVerified, ...body }, null, 2) }] };
  },
);
} // end registerSpiderTools
