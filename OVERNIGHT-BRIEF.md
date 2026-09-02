# 야간 작업 브리프 (2026-08-23 17:00 → 08-24 10:00, hermes 무인 실행)

> Claude Code 세션이 사용량 한도로 17:00~익일 10:00 자리를 비운다. 이 문서가 그 사이 유일한 지시다.
> **절대 규칙**: 아래 Task 1·2 **외의 새 작업 시작 금지**(Phase 2, 다른 설계, 리팩터 등 전부 금지). 각 작업은 명시된 호출 예산을 넘기지 말 것. 막히면 재시도 대신 **STOP하고 PROGRESS.md에 기록** — 밤새 무한 재시도 금지.
> 거버넌스 §0(HANDOFF.md) 그대로 적용: raw 증거만, 원칙0(live DB 파괴적 쓰기 금지), 임시행 마커+정화.
> 완료해도 다음 작업을 만들어내지 말 것. 두 Task 끝나면 **정지하고 대기**(사용자가 10시 이후 확인).

---

## Task 1 (우선, 안전, 코드 변경 없음) — P1-3 실사용(real-model) 도그푸딩

**목적**: 지금까지 P1-3a/b/c 게이트는 전부 SQL로 끼워넣은 가짜 승인행으로 검증했다. **실제 로컬 모델이 생성한 state/scene/whole/episode**를 한 번도 못 봤다. whole↔episode 문구 메아리 우려(REVIEW-P1-3c.md §1)도 실측이 필요하다. 이 태스크로 실측 데이터를 만든다.

**절대 원칙: 실제 사용자 대화(`09e7827f-c2c4-4db8-89c0-e37aea2fe62d`, 캐릭터 "서리")는 절대 건드리지 않는다.** 새 **격리된 테스트 대화**를 만들어 쓰고 끝나면 통째로 삭제한다(cascade로 그 안의 messages/summaries 전부 삭제됨, 실제 데이터 무관).

### 1-1. 테스트 대화 생성
```bash
curl -s -X POST -H 'Tailscale-User-Login: manofin@github' -H 'Content-Type: application/json' \
  -d '{"characterId":"a5073af0-14b3-4c3f-8750-04d76b547504","mode":"chat","title":"[TEST-dogfood] delete before 10am"}' \
  localhost:8787/api/conversations
```
(characterId는 "임포트테스트" — 실제 RP 캐릭터 "서리"/"카이" 아님. 응답의 `id`를 `$TC`로 기록.) 인사말 메시지 1개 자동 생성됨.

### 1-2. 대화 진행 (실제 채팅 API, 모델 실호출)
3라운드, 각 라운드 1개 사용자 메시지 전송(POST가 블로킹 — 응답 완료까지 대기, SSE 스트림이라 응답 바디 파싱은 불요, 완료만 기다리면 됨):
```bash
curl -s -X POST -H 'Tailscale-User-Login: manofin@github' -H 'Content-Type: application/json' \
  -d '{"content":"<메시지>"}' localhost:8787/api/conversations/$TC/messages > /dev/null
```
각 라운드 사이 **장면 전환이 되는 내용**을 직접 작성해라(장소·시각·동석인물·약속이 바뀌게, 예: "우리는 도서관을 나와 강가로 갔다..." 등 3개 정도 서로 다른 장면). 총 호출 **3회만**(초과 금지 — 모델 자원 절약).

### 1-3. 요약 생성 (real model, 최대 2회)
```bash
curl -s -X POST -H 'Tailscale-User-Login: manofin@github' localhost:8787/api/conversations/$TC/summarize
```
응답 JSON의 `summary.content`(whole), `state.content`, `scene.content`를 **원문 그대로** 기록해둬라(REPORT용). **최대 2회**(1라운드 후 1회, 추가 메시지 뒤 1회 — 장면 최소 2개 확보 목적).

각 생성물을 승인(주입 확인 위해 필요):
```bash
curl -s -X PATCH -H 'Tailscale-User-Login: manofin@github' -H 'Content-Type: application/json' -d '{"status":"approved"}' localhost:8787/api/summaries/<id>
```
(whole/state/scene 각각 approved로.)

### 1-4. 주입 확인 (real 데이터로 prompt-preview)
```bash
curl -s -H 'Tailscale-User-Login: manofin@github' localhost:8787/api/conversations/$TC/prompt-preview
```
- `budget.diagnostics.summaries`에 state/whole/scene 각 `used:true`와 토큰 수 기록.
- **whole↔scene 텍스트가 문구를 그대로 반복하는지(echo) 육안 대조** — REPORT에 "메아리 있음/없음 + 예시" 남겨라. 이게 이 태스크의 핵심 관찰이다.

### 1-5. 에피소드 rollup은 장면 5건 필요 — 부족하면 생략 가능
장면이 2건뿐이면 THRESHOLD(5) 미달이라 정상 rollup 불가. **억지로 `?force=1` 쓰지 말고, 장면 2~3건 상태로 관찰을 종료해도 된다.** (에피소드 실사용 검증은 사용자가 실제 대화를 충분히 진행한 뒤 자연히 확인될 것 — 이 태스크의 필수 목표 아님.)

### 1-6. 정화 (필수, 순서 중요)
```bash
curl -s -X DELETE -H 'Tailscale-User-Login: manofin@github' localhost:8787/api/conversations/$TC
```
확인:
```bash
sqlite3 /home/hermes/rpchat/data/rpchat.db \
  "SELECT status,count(*) FROM memories GROUP BY status;  -- candidate|6 그대로
   SELECT tier,count(*) FROM summaries WHERE conversation_id='09e7827f-c2c4-4db8-89c0-e37aea2fe62d' GROUP BY tier;  -- whole|1 그대로
   SELECT count(*) FROM conversations WHERE id='$TC';  -- 0 (삭제됨)
   PRAGMA integrity_check;"  -- ok
```

### 1-7. 리포트 작성
`/home/hermes/rpchat/app/REPORT-P1-3-dogfood.md`:
```
# P1-3 실사용 도그푸딩 [ISO시각]
## 생성물 원문
- whole: "..."
- state: "..."
- scene: "..."
## 관찰
- whole↔scene 메아리: 있음/없음 (근거 인용)
- 토큰: state Nt / whole Nt / scene Nt
- 이상 징후: (있으면 서술, 없으면 "없음")
## 정화 확인
- candidate|6, whole|1(실제 대화), 테스트 대화 삭제 확인, integrity ok
```

**이 태스크는 관찰·기록만. 코드 변경 없음. git 무관.**

---

## Task 2 (Task 1 끝난 뒤, 작음, 코드 변경 있음) — P1-6 진단에 episode 추가

builder.ts에 이미 `episodeText`/`episodeEst` 변수가 있다(P1-3c). `summaries.push(...)` 3줄(state/whole/scene) 바로 뒤에 **한 줄만** 추가:
```ts
summaries.push({ tier: 'episode', used: !!episodeText, tokens: episodeEst, note: episodeText ? undefined : (episodeRow ? '예산 부족/최근창' : '승인된 에피소드 없음') });
```
**UI 변경 불요** — BudgetTab이 이미 `g.summaries.map(...)`로 범용 렌더링 중(ChatDrawer.tsx 확인됨). types.ts 유니온도 이미 `'episode'` 포함(server+web 둘 다). **정말 이 한 줄뿐.**

### 게이트
1. `npm run build --workspace apps/server` → exit 0 (web은 무변경이라 재빌드 불요, 원하면 확인만)
2. restart · health db:ok
3. prompt-preview: `budget.diagnostics.summaries`에 이제 4항목(state/whole/scene/episode) 확인 (episode는 승인된 게 없으니 `used:false, note:'승인된 에피소드 없음'`이어야 함 — 실제 대화 09e7827f에는 에피소드 없음, 정상)
4. **조립 SHA 불변**: messages 부분은 이 변경과 무관(diagnostics만 추가) — 그래도 확인: SHA가 v0.0.14와 같아야 함(같은 데이터 상태 기준).
5. candidate|6 / whole|1 무접촉 / integrity ok

### 통과 시
```
git add apps/server/src/prompt/builder.ts
git commit -m "feat(prompt): add episode to summary diagnostics (P1-6 follow-up)"
git tag v0.0.15
```
PROGRESS.md에 append.

### 실패 시
`git checkout -- apps/server/src/prompt/builder.ts`, STOP, 사유 기록. 재시도 금지(다음날 Claude Code가 판단).

---

## 종료 조건 (반드시 지킬 것)
- Task 1, 2 둘 다(또는 막힌 것까지) 끝나면 **정지**. 추가 작업 시작 금지.
- 각 단계 실패 시 **최대 1회 재시도**, 그래도 안 되면 STOP + PROGRESS.md 기록(사유·현재 상태) 후 다음 작업으로 넘어가지 말고 대기.
- 텔레그램으로 완료/중단 보고 남겨도 좋음 — 단, 사용자가 10시 이전에 볼 수도, 못 볼 수도 있다. **핵심 기록은 반드시 PROGRESS.md 파일에.**
- 실제 대화(09e7827f...)·memories 6행·기존 whole 1건은 이 브리프의 어떤 단계에서도 건드리지 않는다.
