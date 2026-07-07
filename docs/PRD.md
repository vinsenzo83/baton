# BATON — AI 세션 릴레이 & 핸드오프 MCP
**제품 기획서 v1.0** · 2026-07-07 · 작성: Claude (발제: 김광세)

> 한 줄 정의: **어떤 모델의 세션이든, 코드 한 줄로 서로 연결하고(릴레이), 통째로 넘긴다(핸드오프).**
> 태그라인: *Pass the session. — 세션을 넘겨라.*

---

## 1. 문제 정의

### P1. 컨텍스트 락인 — "모델을 못 갈아탄다"
개발자가 Claude ↔ GPT ↔ Gemini를 옮기지 못하는 진짜 이유는 모델 성능이 아니라 **쌓아둔 세션 컨텍스트가 이전되지 않아서**다. 대화 이력, 결정 사항, 프로젝트 맥락이 툴 안에 갇혀 있고, 옮기는 순간 전부 죽는다. 컨텍스트가 곧 락인이며, 벤더는 이걸 풀어줄 동기가 없다.

### P2. 인수인계 불가 — "내 작업을 남에게 못 넘긴다"
내 세션에서 한 작업(무엇을, 왜, 어떻게 결정했는지)을 다른 사람에게 전달하려면 결국 사람이 문서를 다시 쓴다. 상대방의 AI는 그 맥락을 모른 채 처음부터 시작한다. 팀 단위 AI 협업의 최대 병목.

### P3. 세션 간 실시간 소통 부재
서로 다른 머신·다른 사람·다른 모델의 세션끼리 메시지를 주고받을 표준 방법이 없다. 기존 도구는 전부 "한 컴퓨터 안"에 갇혀 있다.

## 2. 시장 공백 (2026-07 실측 조사)

| 제품 | 실시간 메시징 | 원격(인터넷) | 타인 연결 | 모델 불문 | 세션 핸드오프 |
|---|---|---|---|---|---|
| TeamMCP | ✅ 채널·DM | ❌ "개발 중" | ❌ 로컬 한정 | 부분 | ❌ |
| MCP Agent Mail | ✅ 쪽지함 | ❌ 로컬 | ❌ | 부분 | ❌ |
| agent-message-queue | ✅ 파일 큐 | ❌ 로컬 | ❌ | 부분 | ❌ |
| OpenMemory(mem0) | ❌ | 부분 | ❌ 개인용 | ✅ | ❌ 메모리만 |
| Claude Agent Teams | ✅ | ❌ 내 머신 | ❌ 내 팀만 | ❌ Claude만 | ❌ |
| **BATON** | ✅ | ✅ | ✅ 초대코드 | ✅ MCP 표준 | ✅ **핵심 차별점** |

**결론: "원격 + 모델 불문 + 타인 + 핸드오프" 4박자를 갖춘 제품은 없다.** 전부 한 컴퓨터 안 에이전트 조율에 머물러 있다. MCP가 모든 주요 AI 툴(Claude Code, Codex CLI, Gemini CLI, Cursor, Windsurf...)에 꽂히는 지금이 서드파티가 이 공백을 칠 수 있는 첫 시점.

## 3. 타깃 사용자 · 핵심 시나리오

### 시나리오 A — 모델 이사 (P1)
> Claude Code에서 3주째 작업하던 개발자가 GPT Codex로 갈아타고 싶다.
1. Claude 세션: "바통 패스 떠줘" → `baton_pass` → 스냅샷 코드 `BTN-H-7K2F` 발급
2. Codex 세션: "바통 코드 BTN-H-7K2F 받아" → `baton_receive` → 프로젝트 맥락·결정사항·다음 할일 주입
3. **그 자리에서 이어서 작업.** 갈아타기 공포 소멸.

### 시나리오 B — 직원에게 인수인계 (P2)
> 사장이 밤에 잡아둔 작업 방향을 아침에 직원이 이어받는다.
1. 사장 세션: `baton_pass` → `BTN-H-9Q1M` → 카톡으로 코드 전달
2. 직원(어떤 AI든): `baton_receive BTN-H-9Q1M` → "어젯밤 사장님이 여기까지 했고, 이유는 이거고, 다음은 이거"
3. 직원 세션이 맥락 완비 상태로 시작.

### 시나리오 C — 실시간 협업 방 (P3)
> 서울 사장 + 광주 개발자 + 외주사, 각자 다른 AI로 같은 프로젝트.
1. 사장: `baton_create_room` → `BTN-R-4D8A` 발급, 두 사람에게 전달
2. 각자: `baton_join BTN-R-4D8A` — Claude·GPT·Gemini 섞여서 입장
3. "개발자 세션한테 이 스키마 검토하라고 보내" → `baton_send` → 상대 세션이 `baton_inbox`로 수신·응답

## 4. 핵심 기능 명세

### F1. 릴레이 (초대코드 방)
| MCP 도구 | 파라미터 | 동작 |
|---|---|---|
| `baton_create_room` | name, expires?, one_time? | 방 생성, 코드 `BTN-R-XXXX` 발급 |
| `baton_join` | code, alias | 코드로 입장, 별명 등록 |
| `baton_send` | room/to, text, refs? | 방 전체 또는 특정 별명에게 쪽지 |
| `baton_inbox` | since? | 내 수신함 확인 (오프라인분 보존) |
| `baton_who` | room | 참가자·모델·최근 활동 |

### F2. 핸드오프 (세션 스냅샷)
| MCP 도구 | 파라미터 | 동작 |
|---|---|---|
| `baton_pass` | scope(summary/full), note | 클라이언트 모델이 표준 포맷으로 스냅샷 생성 → 서버 저장 → 코드 `BTN-H-XXXX` 발급 |
| `baton_receive` | code | 스냅샷 수신 → 컨텍스트 주입 프롬프트 반환 |
| `baton_revoke` | code | 코드 즉시 무효화 |

**BATON Snapshot v1 표준 포맷** (JSON + Markdown 미러):
```json
{
  "meta":     { "title", "author", "source_model", "created_at", "project" },
  "context":  { "goal", "current_state", "decisions": [{"what","why"}], "constraints": [] },
  "artifacts":{ "files": [], "links": [], "commands": [] },
  "next_steps": [],
  "warnings":   [],
  "glossary":   {}
}
```
포인트: 대화 로그 전체가 아니라 **"이어서 일하는 데 필요한 것"**을 구조화. 받는 쪽 모델이 무엇이든 동일하게 해석 가능. `full` 스코프는 원문 로그 첨부(옵션).

### F3. 보안
- 코드 = 열쇠: 만료시간(기본 72h)·1회용 옵션·즉시 revoke
- 방·스냅샷 단위 격리, Bearer 토큰 세션 인증
- v2: E2E 암호화(서버는 암호문만 보관), 셀프호스팅 배포판(기업 기밀 대응)

## 4.5 스파이더 레이어 — 거미 v2 (BATON 결합 업그레이드)

기존 자산: spiderweb-qc 스킬(그물탐지→거미 자율수정→재직조 폐루프) + spider-mcp/recluse(버그클래스 지식 내장, `spider_signals` 등 6개 도구) + recluse corpus-backend(자가발전 패턴 저장소). **한계 = 전부 내 세션·내 머신 안에서만 돈다.** BATON에 붙이면 세 방향으로 확장된다:

### S1. 원격 거미 — Spider-as-a-Session
거미가 BATON 방의 **상주 참가자**가 된다. 어떤 세션이든(모델 불문) `baton_send @spider "이 API 검증해줘"` → 거미 세션이 그물을 짜서 검증하고 결과를 회신. **검증의 아웃소싱** — GPT 쓰는 직원도, 외주사 Gemini도 같은 거미를 고용한다.

### S2. 핸드오프 게이트 — 검증된 바통만 넘어간다
`baton_pass --verified`: 스냅샷 발행 전에 거미가 무결성 검증 — 스냅샷의 주장을 실제 코드·DB와 1:1 대조(mock-trial-spider 철학의 일반화), 거짓 완료 주장·빠진 결정·모순 색출. 통과하면 🕸️ 배지가 붙고, 받는 쪽은 "검증된 바통"만 신뢰하면 된다. **인수인계 시장의 핵심 불안을 정면으로 해소하는 기능 = 경쟁 매트릭스의 5번째 박자.**

### S3. 공유 그물 — Corpus Network
거미가 세션마다 배우는 버그 패턴(learned-patterns)을 BATON 서버의 **중앙 corpus**로 승격(recluse corpus-backend 재사용). 한 세션이 물린 함정을 모든 참가 세션이 그물로 물려받는다 — 자가발전 corpus가 **네트워크 효과**로 성장. 참가자가 늘수록 그물이 촘촘해지는 구조라 그 자체가 해자.

### 추가 도구
| MCP 도구 | 동작 |
|---|---|
| `baton_verify` | target(스냅샷 코드/파일/URL), tier → 거미 검증 요청·결과 회신 |
| `spider_corpus_push` / `pull` | 배운 패턴을 중앙 corpus에 기여/구독 |

### 로드맵 반영
- M1: S2 핸드오프 게이트 최소판(스냅샷 자기모순·주장 대조)
- M2: S1 원격 거미 상주 세션
- M3: S3 corpus network (기여 크레딧 = 과금 연동 가능)

## 5. 기술 아키텍처
```
[Claude Code] ─┐
[GPT/Codex]  ──┼── MCP(Streamable HTTP) ──> BATON 서버 (Node + 공식 MCP SDK)
[Gemini CLI] ──┤                            ├─ 방/쪽지/스냅샷 저장 (Postgres)
[Cursor 등]  ──┘                            └─ 웹 대시보드 (v1)
```
- 서버: Node.js + `@modelcontextprotocol/sdk` StreamableHTTP — 표준만 따르면 모든 MCP 클라이언트 호환
- 저장: Postgres(Supabase) — 방·메시지·스냅샷·코드
- 배포: Railway. 클라이언트 등록은 URL 한 줄: `claude mcp add --transport http baton https://.../mcp`
- 실시간성: 폴링(inbox) 기본 + SSE 알림(v1)

## 6. 수익 모델 (초안)
| 플랜 | 가격 | 내용 |
|---|---|---|
| Free | 0 | 방 1개 · 스냅샷 월 5개 · 7일 보관 |
| Pro | $8/월 | 무제한 방·스냅샷 · 90일 보관 · 우선 지원 |
| Team | $25/월~ | 조직 공간 · 멤버 관리 · 감사 로그 · E2E |
| Self-host | 라이선스 | 기업 내부망 설치판 |

### 유통 채널 (MCP 마켓 현황)
MCP "마켓"은 앱스토어형 유료 장터가 아니라 **무료 디렉토리(등록처)** 생태계다: 공식 MCP Registry(registry.modelcontextprotocol.io), Smithery, mcpmarket.com, mcpservers.org, Glama, PulseMCP, Anthropic 커넥터 디렉토리 등. 등록은 무료이며 결제 기능이 내장된 마켓은 아직 없다. **업계 표준 수익화 = 서버 코드는 공개(디렉토리로 유통), 돈은 뒤의 서비스 구독으로 수취** — BATON의 Free/Pro/Team 모델이 정확히 이 구조. 디렉토리 전부에 등록해 유입을 얻고, 코드 발급량·보관기간으로 과금한다.

## 7. 로드맵
- **M1 · MVP (2주)**: 릴레이 + 핸드오프 + 초대코드 + Railway 배포. Claude Code ↔ Codex 실전 검증(우리 회사가 첫 고객 — 봉이·EduVerse 작업 인수인계에 즉시 사용)
- **M2 · v1 (1개월)**: 웹 대시보드(방·스냅샷 열람), SSE 실시간 알림, 스냅샷 보관함·검색
- **M3 · v2**: E2E 암호화, 조직/SSO, 스냅샷 버전·diff, 셀프호스팅판

## 8. KPI
- **핸드오프 재개율**: 받은 코드로 실제 작업을 이어간 비율 (북극성 지표)
- 모델 교차율: Claude↔GPT 등 서로 다른 모델 간 전달 비중 (차별점 검증)
- 주간 활성 방 수 / 방당 메시지 수
- 스냅샷 생성→수신 소요 시간

## 9. 리스크 & 대응
| 리스크 | 대응 |
|---|---|
| 벤더가 자체 지원 (예: Agent Teams 원격화) | 벤더는 **타사 모델과의** 연결·이탈을 도울 동기가 없음 — 모델 중립은 서드파티만 가능한 포지션 |
| 기밀 유출 우려 | 코드 만료·1회용·revoke 기본 탑재, v2 E2E·셀프호스팅 |
| MCP 스펙 변화 | 공식 SDK 추종, 표준 외 확장 최소화 |
| 스냅샷 품질(요약 손실) | 표준 포맷 강제 + 수신측 "빠진 것 질문" 프로토콜 + full 스코프 옵션 |

## 10. 이름 · 브랜드
- **BATON(바통)** — 릴레이 경주의 바통. 릴레이(방)와 핸드오프(패스)를 한 단어로 상징
- 코드 체계: 방 `BTN-R-XXXX` / 핸드오프 `BTN-H-XXXX`
- 동사화 목표: *"바통 떠줘" / "바통 받아"*
