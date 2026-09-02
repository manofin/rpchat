# 위임 브리프 — P1-3b 장면(scene) 계층 (hermes 실행용)

> 선행: `DESIGN-P1-3.md`(§1 scene 정의, §4 주입) 읽어라. P1-3a(상태트래커, v0.0.11) 완료 위에 얹는다.
> 거버넌스 §0 절대 준수: raw 증거만·최소 풋프린트·게이트 통과 전 다음 단계 금지.
> 위치 `/home/hermes/rpchat/app`. 착수 전 `git log --oneline -1` → HEAD=v0.0.11(0929225) 확인.
> **스키마 변경 없음**(0005의 tier·covers_from_message_id 재사용). **마이그레이션·DB 쓰기 없음** → 원칙0 마이그레이션 절차 불요. 단 candidate|6·summaries 기존행 무접촉 확인은 게이트.
> **설계 판단이 필요하거나 아래에 없는 결정이 나오면 진행 말고 PROGRESS.md에 질문만 남기고 STOP.**

범위: **장면(scene) 생성 + 주입 + UI만.** 에피소드 rollup·whole 재정의는 P1-3c(이번 아님).

---

## STEP 1 — 생성 프롬프트 (apps/server/src/prompt/templates.ts)
`renderSummaryPrompt`의 출력 JSON에 `scene` 추가(state와 같은 방식):
```
{"summary":"…8문장 이내","state":{…6키…},"scene":"직전 요약 이후 구간을 한 장면으로 2~4문장","memories":[…]}
```
지시문 한 줄 추가: `scene 은 이번에 요약되는 최근 구간만 2~4문장 산문으로. 전체(summary)와 달리 이 구간만.`

## STEP 2 — 생성 저장 (apps/server/src/routes/memory.ts /summarize)
- `parsed`에 `scene?: unknown` 추가. `const sceneText = typeof parsed.scene === 'string' ? parsed.scene.trim() : '';`
- **covers_from 확보**: `const firstId = slice[0].id;` (slice는 이미 있음; lastId도 이미 있음)
- 트랜잭션 내 whole/state INSERT 옆에 scene INSERT(내용 있을 때만):
```ts
const sceneId = uid();
if (sceneText) {
  run(db, 'INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      sceneId, conv.id, sceneText, lastId, firstId, 'draft', t, 'scene');
}
```
- 반환 payload에 `scene`(선택) 포함 가능. memories 로직 무변.

## STEP 3 — 주입 (apps/server/src/prompt/builder.ts)
현재 3)블록: state → whole 순으로 `sumBudget`(=budgets.memory−memEst) 소비 중. **whole 실사용 뒤 잔여를 scene에 배정**(priority-fill 유지, whole 캡 무변).

state/whole 계산부(`summaryText`/`sumEst` 산출 직후, sections.push 전) 아래 추가:
```ts
// scene: whole 실사용 후 잔여 예산에만. 이미 recent 창에 있는 장면(=최근 SCENE_RECENT_GUARD개 메시지 안에 끝나는)은 원문 중복이라 제외.
const SCENE_RECENT_GUARD = 24; // 휴리스틱 가드(튜닝 가능): 최근 이만큼 메시지는 recent로 곧 들어감
const wholeEstOnly = summaryText ? estimateTokens(summaryText, cal) : 0;
let sceneBudget = Math.max(0, sumBudget - stateEst - wholeEstOnly);
const recentGuardIds = new Set(history.slice(-SCENE_RECENT_GUARD).map((m) => m.id));
const sceneParts: string[] = [];
let sceneEst = 0;
if (sceneBudget > 0) {
  const scenes = many<SummaryRow>(db,
    `SELECT * FROM summaries WHERE conversation_id = ? AND tier = 'scene' AND status = 'approved' AND rolled_up_into IS NULL ORDER BY created_at DESC`,
    conv.id);
  for (const sc of scenes) {
    if (sceneParts.length >= 2) break; // 최대 2개
    if (sc.covers_until_message_id && recentGuardIds.has(sc.covers_until_message_id)) continue; // 아직 recent에 있음 → 중복
    const rendered = `- ${sc.content}`;
    const tok = estimateTokens(rendered, cal);
    if (sceneEst + tok > sceneBudget) break;
    sceneParts.push(sc.content);
    sceneEst += tok;
  }
}
const sceneTierText = sceneParts.length ? `### 최근 장면\n${sceneParts.map((c) => `- ${c}`).join('\n')}` : null;
```
- `sumEst`에 sceneEst 합산: `const sumEst = (summaryText ? estimateTokens(summaryText, cal) : 0) + stateEst + sceneEst;`
- sections.push note에 scene 표기 추가(예: sceneParts.length ? `장면 ${sceneParts.length}` : '').
- **systemParts(현재 라인)**: `renderSummary(summaryText)` 뒤에 `sceneTierText` 삽입(주의: builder에 이미 renderScene용 sceneText가 있으니 반드시 다른 이름):
  `[..., stateText, renderSummary(summaryText), sceneTierText, loreText]` (state→whole→scene→lore).
- `estimateTokens`, `many`, `SummaryRow`는 이미 import됨(확인).

## STEP 4 — UI (apps/web/src/pages/ChatDrawer.tsx SummaryTab)
- `renderCard`의 kind 타입에 `'장면'` 추가: `kind: '상태' | '전체' | '장면'`.
- 분리: `const sceneRows = summaries.filter((s) => s.tier === 'scene');`
- `wholeRows` 필터는 이미 scene 제외함(`tier !== 'scene'`) — 유지.
- 렌더 순서: `{stateRows.map(s=>renderCard(s,'상태'))}{sceneRows.map(s=>renderCard(s,'장면'))}{wholeRows.map(s=>renderCard(s,'전체'))}`
- generate 토스트: `요약 초안 — 상태 + 장면 + 전체 + 기억 ${r.candidates.length}`.

---

## 게이트 (raw 필수, 전부 통과해야 커밋)
1. `npm run build --workspace apps/server` → exit 0
2. `npm run build --workspace apps/web` → exit 0
3. `systemctl --user restart rpchat` → active; `curl -s localhost:8787/api/health | head -c 80` → db:ok
4. **주입 검증(생성 모델콜 없이)**: 임시 approved scene 행 SQL 삽입(covers_from/until에 **현재 대화 head가 아닌 과거 메시지 id**, 마커 '__test__' 포함) → `prompt-preview` 응답 system에 `### 최근 장면` + 그 내용 포함 확인 → **임시행 DELETE**.
   - 대조: covers_until을 head(최근) 메시지로 한 임시행은 recentGuard로 **제외**되는지도 1회 확인(주입 안 됨) → DELETE.
5. **무접촉**: `sqlite3 data/rpchat.db "SELECT status,count(*) FROM memories GROUP BY status;"` → candidate|6 / `SELECT tier,count(*) FROM summaries GROUP BY tier;` → 기존 whole|1 외 잔여 테스트행 0 / `PRAGMA integrity_check;` → ok
6. (선택) summarize 실호출 가능하면 scene draft 생성 확인 후 정화. 모델콜 승인 이슈로 불가하면 STEP4 주입검증으로 갈음(사유 로그).

## 통과 시
```
git add apps/server/src/prompt/templates.ts apps/server/src/routes/memory.ts apps/server/src/prompt/builder.ts apps/web/src/pages/ChatDrawer.tsx
git commit -m "feat(summary): scene tier generation + injection (P1-3b)"
git tag v0.0.12
```
PROGRESS.md에 append: 변경파일·커밋·태그, 게이트 raw(build/health/주입검증 both cases/candidate|6/tier 분포/integrity), 미결.

## 실패 시
`git checkout -- <파일>` 되돌리고 STOP, 사유 PROGRESS.md 기록. (DB 마이그레이션 없으므로 DB 롤백 불요, 단 테스트행 삽입했으면 반드시 DELETE.)

## ★ 주의 (지난 회차 교훈)
- 라벨=실체 일치시켜라. 이 브리프는 **장면 tier**다. covers_until 점프 UI 같은 다른 것과 혼동 금지.
- 임시행에 반드시 '__test__' 마커, 검증 후 즉시 DELETE. 기존 whole|1·candidate|6 절대 무접촉.
