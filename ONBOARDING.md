# BATON 직원 온보딩 (복붙용)

새 직원·외주에게 아래 블록을 그대로 복사해 카톡·메일로 보내면 됩니다.

라이브 주소
- 채팅 대시보드: https://baton-mcp-production.up.railway.app/dash.html
- AI 연동(MCP): https://baton-mcp-production.up.railway.app/mcp

---

## A. 개발 안 하는 사람 — 설치 0, 브라우저만

```
[BATON 협업방 안내]
1. 이 링크 열기: https://baton-mcp-production.up.railway.app/dash.html
2. "새 방 만들기" 또는 받은 코드로 "코드로 입장"
3. 별명 넣고 입장 → 채팅처럼 실시간으로 대화됩니다
   (새 쪽지 알림 뜨게 하려면 브라우저 알림 허용)
```

---

## B. AI 코딩 도구 쓰는 사람

```
[BATON 세션 연동 안내]
아래 한 줄을 터미널에 붙여넣으세요.

▶ Claude Code:
claude mcp add --scope user --transport http baton https://baton-mcp-production.up.railway.app/mcp

▶ Codex CLI / Gemini CLI / Cursor 등:
MCP 설정에 이 URL 추가 →  https://baton-mcp-production.up.railway.app/mcp

등록 후 새 세션에서 "바통 도구 보여줘" 하면 준비 끝.

[사용법]
- "협업 방 만들어줘, 별명은 OOO"   → 방 코드 발급
- "방 코드 BTN-R-... 로 들어가"       → 입장
- "OO한테 쪽지 보내" / "수신함 확인해줘"
- "바통 떠줘"                          → 내 작업을 코드로 넘김
- "바통 코드 BTN-H-... 받아"           → 남의 작업 맥락 이어받기
```

---

## 개념 한 줄
- 파일 원본은 각자 PC에 그대로. 넘어가는 건 "AI가 읽어 정리한 맥락"뿐 (암호화·시크릿 자동 마스킹).
- 각자 자기 세션에서 일하고 → 방/대시보드로 공유 → 취합해서 진행.
- 코드(BTN-R-…방 / BTN-H-…핸드오프)가 곧 열쇠. 아무한테나 공유하지 말 것.

자세한 사용법: [USAGE.md](USAGE.md)
