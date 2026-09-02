# Operator note — 2026-08-27T10:13:32Z 갱신

Claude Code / 사용자 재개용 1장. hermes 자가보고이므로 raw 재검증이 정본.

**첫 열기 (인수인계 정본):** `/home/hermes/rpchat/planning_documents/HANDOFF-2026-08-27.md`

색인: `/home/hermes/rpchat/planning_documents/STATUS.md`
잠금표: rpchat-pwa `references/lock-state.md`
08-25 remaining-locks 핸드오프는 **역사**. 현재로 쓰지 말 것.

## HEAD (2026-08-27T10:13:32Z 실측)

- git root: `/home/hermes/rpchat/app`
- HEAD: `a9114b2cb82b94c00b317b3a36ecc6837f5a28ba`
- describe `--dirty`: **`v0.0.19-57-ga9114b2-dirty`** (`M PROGRESS.md` only)
- unit: `active` PID **21601**
- health: `ok` `db:ok` `authMode=tailscale` `contextTokens=16384`
- migrations on disk: `0001`–`0007` (`0004_memory_scope.sql`, `0006_user_note.sql`). next = `0008_<slug>.sql`

## 무엇이 닫혔나

- PRD A트랙 0~7. 7=임베딩 NOT ADOPTED.
- D1·D2 측정 닫힘.
- F5 ADR **accepted-A** (정의 4). 재레터·F5-B 금지.
- Gate 4 A0–E(B)+dump 원문 항목4 잠금. E는 **PASS (B)** only. 쓴 generate 토큰 재발사 금지.
- Gate 5 **2–6 닫힘** (사용자 확인). F2 isolated 닫힘. 라이브 lore PATCH는 `F2-live`.
- 남은 Gate 5 = **1 Galaxy**. Hermes PASS 불가. 박스 **15개** 미관측.

## 다음 기본 경로 (사람 잠금 불필요)

코드 없음. 위 인수인계 파일을 연다. Galaxy 박스는 기기 증거 없이 체크 금지.

## 사람 잠금 필요 (하나만)

Galaxy 실기기 / E1 P4 Mac Draw Things / F1 Phase2 / F2-live lore PATCH / F3 아바타 파일 / F4 TTS·삽화 / F6 자동승인 / `PRD`

## 무접촉 (유지)

- 서리 `f89ace9b-8684-4d97-96dc-e00c4b25a819` 및 그 모든 방 (방 `09e7827f…`는 방 하나일 뿐)
- 카이 캐릭 `255f96a2-d78e-433d-9169-fb6da6e0963f` / 카이 방 `75dbc864-685f-457b-9ea5-6d659f263030`
- 황지명 페르소나 `b0df2d3a-bf35-45fb-9825-fce0ac26147c` (라이브 카탈로그)
- QA 방 `69e0ad66-333c-4b1c-93c0-3b31e4cfecbe` 삭제 금지 unless asked
- Tailscale 헤더 위조 금지. localhost 보호 라우트 401
- `git add -A` / `.env` 커밋 / leftover BRIEF/DESIGN/`dist.bak` 금지

## 재개 raw 체크

```bash
cd /home/hermes/rpchat/app
git log --oneline -5 ; git describe --tags --always --dirty
systemctl --user is-active rpchat.service ; systemctl --user show -p MainPID --value rpchat.service
curl -sS http://127.0.0.1:8787/api/health
ls apps/server/migrations/
# .env 전문 출력 금지
```
