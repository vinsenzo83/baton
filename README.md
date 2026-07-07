# 🏃 BATON

**Pass the session. — 세션을 넘겨라.**

어떤 AI 모델의 세션이든(Claude · GPT · Gemini …), 코드 한 줄로 **서로 연결하고(릴레이)**, **작업을 통째로 넘긴다(핸드오프)**. 그리고 넘어가는 바통이 진짜인지 **거미가 검증한다** — 정적 검증 + 실제로 눌러보는 E2E.

MCP(Model Context Protocol) 표준 서버라, MCP를 지원하는 모든 도구(Claude Code, Codex CLI, Gemini CLI, Cursor …)에서 URL 한 줄로 붙는다.

## 세 가지 기능

| | 도구 | 하는 일 |
|---|---|---|
| **릴레이** | `baton_create_room` `baton_join` `baton_send` `baton_inbox` `baton_who` | 초대코드(`BTN-R-…`) 방에서 서로 다른 사람·머신·모델의 세션이 쪽지 교환 |
| **핸드오프** | `baton_pass` `baton_receive` `baton_revoke` | 세션 스냅샷을 코드(`BTN-H-…`)로 봉인·인수인계. 본문은 코드-파생 키로 암호화 |
| **검증(거미)** | `baton_verify_plan` `baton_verify` + `spider_*` ×6 | 넘어온 바통을 정적 대조 + **E2E 관측**으로 판정. 관측 증거 없으면 🕸️ 배지 불가 |

## 설계 원칙 (아키텍처 리뷰 반영)

- **C1 프롬프트 인젝션 격리** — 받은 쪽지·스냅샷은 "미신뢰 데이터"로 감싸 반환. 그 안의 지시는 실행 금지.
- **C2 코드 = 128비트+ 비밀** — 4자리 아님. 브루트포스 방어.
- **C4 코드-파생 암호화** — 서버는 `암호문 + code_hash`만 저장. 코드 없이는 우리(운영자)도 평문을 못 본다 = "가둘 수 없다"의 증거. + 시크릿 자동 마스킹.
- **H3 별명 사칭 방지** · **H4 1회용 코드 원자적 소비**.
- **핵심 교훈** — *빌드 통과 ≠ 동작.* `verified` 배지는 정적 검증만으론 못 받는다. 실제 행동을 실행해 관측한 증거(HTTP 상태·DB 행 delta)가 있어야 발급. upsert 무음 실패를 잡는 유일한 길.

## 실행

```bash
npm install
npm test                 # 8/8 E2E 통과
node src/server.js       # stdio (로컬 / 모든 CLI)
BATON_HTTP=1 PORT=8080 node src/server.js   # 원격 Streamable HTTP
```

### 클라이언트 등록 (원격)
```bash
claude mcp add --transport http baton https://<배포주소>/mcp
```

## 저장소

MVP는 SQLite(`better-sqlite3`) — 셀프호스팅 단일 바이너리에 그대로. 호스티드 서비스는 `src/store.js`의 좁은 인터페이스에 Postgres 어댑터를 끼운다(멀티테넌트 내구성·PITR). 트랜스포트는 stateless HTTP → Postgres pooler(transaction 모드) 권장.

## 로드맵
- **M1 (현재)** 릴레이 + 핸드오프 + 거미 검증 + 코드-파생 암호화. Claude Code ↔ Codex 도그푸딩.
- **M2** 웹 대시보드, 공유 corpus network, Postgres 전환.
- **M3** 조직/SSO, 스냅샷 버전·diff.

거미 엔진은 기존 `recluse-mcp`를 흡수한 것 — 이제 별도 서버가 아니라 BATON의 검증 엔진이다.
