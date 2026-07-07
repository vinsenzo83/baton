# BATON 어드민 대시보드 — PRD

**작성 2026-07-08 · 대상: BATON 운영자(owner)**

## 1. 배경 · 현황

BATON은 결제(USDT/USDC on Tron·BSC)까지 라이브 완성됐지만, **운영자가 상태를 볼 수단이 없다.** 지금 결제가 들어와도 확인하려면 DB를 직접 열거나 MCP 도구를 하나씩 불러야 한다.

실제 데이터 원천(SQLite `baton.db`):
- `invoices` — 결제 인보이스 (status pending/paid, plan, amount, chain, tx_hash)
- `used_txs` — 소비된 tx (replay 방지)
- `accounts` — 유료 계정 (key_hash, plan, org)
- `usage_counters` — 계정별 사용량 (핸드오프/월)
- `rooms · members · messages` — 릴레이 (암호화, 본문은 조회 불가·통계만)
- `snapshots` — 핸드오프 (메타만, 본문 암호화)
- `spider_patterns · spider_contributions` — 거미 corpus

## 2. 목적 · KPI

**운영 가시성 한 화면.** 사장님이 로그인 한 번으로 "돈이 얼마 들어왔나, 유료 계정 몇 명, 얼마나 쓰나, corpus 얼마나 컸나"를 본다.

- 북극성: **결제 확인까지 걸리는 시간** (지금 = DB 직접 열기 → 목표 = 로그인 후 3초)
- 부가: 유료 전환율(Free→Pro/Team), 월 핸드오프 수, corpus 패턴 수

## 3. 사용자 · 권한

단일 role = **owner(운영자)**. `BATON_ADMIN_SECRET` 로그인. 봉이 같은 다중 role 없음.
- 읽기 전용이 기본. 쓰기(수동 플랜 조정·인보이스 취소)는 v1.

## 4. 기능 (MVP)

### F1. 결제 대시보드 ⭐ 핵심
- **매출 요약**: 총 수령액(USD), 이번 달, paid 인보이스 수
- **인보이스 목록**: id · plan · amount · status · chain · token · tx_hash(explorer 링크) · 시각
- 필터: paid / pending, chain(tron/bsc)
- pending 인보이스(결제 안 된 것) 별도 표시

### F2. 계정 · 플랜
- 플랜별 계정 수 (Free 익명 제외 등록 계정 / Pro / Team)
- 최근 업그레이드 (누가 언제 어느 플랜)
- 전환율 (등록 계정 중 유료 비율)

### F3. 사용량
- 이번 달 핸드오프 수 (익명 버킷 + 계정별)
- 활성 방 수 · 참가자 수 · 메시지 수 (통계만, 본문 X)
- 스냅샷 수 (verified 배지 비율)

### F4. 거미 corpus
- 패턴 수 · verified 수 · 총 기여자
- 최근 기여 패턴 (klass, name, hit_count)

### F5. 운영 상태
- health (서버 up, 버전)
- 최근 rate-limit 차단 수 (선택)

## 5. 정보 구조 (IA)

```
eduverse-ai.app/baton-admin   (Next rewrite → Railway /admin.html)
  └─ 로그인 (BATON_ADMIN_SECRET)
       └─ 대시보드 (단일 페이지, 탭 or 스크롤)
            ├─ 💰 결제      (F1)
            ├─ 👤 계정      (F2)
            ├─ 📊 사용량    (F3)
            ├─ 🕸️ Corpus   (F4)
            └─ 🩺 운영      (F5)
```

## 6. API 설계

모든 `/admin/*`는 `x-baton-admin-secret` 헤더 필수. 없으면 401(fail-closed). rate limit.

| 엔드포인트 | 반환 |
|---|---|
| `POST /admin/login` | secret 확인 → ok (세션은 클라 localStorage) |
| `GET /admin/payments` | 매출 요약 + 인보이스 목록 |
| `GET /admin/accounts` | 플랜별 수 + 최근 업그레이드 |
| `GET /admin/usage` | 핸드오프·방·메시지·스냅샷 통계 |
| `GET /admin/corpus` | 패턴·verified·기여 |
| `GET /admin/health` | up, version |

## 7. 보안 (핵심 — 결제·계정 노출)

- `BATON_ADMIN_SECRET` env 필수. 미설정 시 `/admin/*` 전면 401.
- 상수시간 비교(secret), rate limit(로그인 시도), 응답에 원문 tx는 OK(공개 온체인)이나 key_hash·주소는 마스킹.
- 본문(방 메시지·스냅샷)은 **애초에 서버가 복호 불가**(code-derived) → 어드민도 못 봄. 통계만. ← 설계상 프라이버시 보장.
- admin.html은 noindex.

## 8. 기술 · 배포

- 기존 `src/store.js`에 조회 함수 추가 (listInvoices, planCounts, usageStats, corpusStats).
- `src/server.js`에 `/admin/*` 라우트 + `public/admin.html` 정적.
- eduverse Next rewrite: `/baton-admin → Railway /admin.html`.
- Node + SQLite, 기존 스택. 새 의존성 없음.

## 9. 로드맵

- **MVP** (지금): F1~F5 읽기 전용 + 로그인. 결제 확인이 핵심.
- **v1**: 차트(매출 추이), 인보이스 필터·검색, 수동 플랜 조정(환불·수동 업그레이드).
- **v2**: 결제 알림(새 결제 시 텔레그램/이메일), 실시간 갱신, 감사 로그.

## 10. 리스크

| 리스크 | 대응 |
|---|---|
| admin secret 유출 = 결제·계정 노출 | 강력 secret, rate limit, 노출 시 즉시 rotate |
| tx 위조 표시 | 온체인 explorer 링크로 교차 확인 |
| SQLite 단일 인스턴스 조회 부하 | 통계는 경량 쿼리, 인덱스 활용 |
