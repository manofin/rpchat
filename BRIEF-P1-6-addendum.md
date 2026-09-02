# BRIEF-P1-6 애드덤 — STOP 질문 답변 + 마감 지시 (hermes 실행용)

> 현재 워킹트리(미커밋, HEAD=v0.0.12) 유지 상태에서 **이어서** 아래만 반영하고 커밋한다.
> 판정: 지금까지 구현(preview-only opts, 조립불변 SHA 동일, lore hit/memory/summary-whole)은 **채택**. 아래 3가지만 보완.
> ★ **조립 로직 절대 불변** 유지(진단 배열만 수정). messages 최종 조립 SHA가 baseline과 동일해야 함.

## 답변
- **conversations.ts 커밋 포함**: 예. preview-only 방식(`{ diagnostics: true }`) 채택 확정. chat.ts는 미변경 유지(생성 경로 진단 0 — 맞다).
- **요약 tier**: **(A) 채택** — state/whole/scene **3개 항상 emit**(없으면 used=false).

## 수정 1 — builder.ts 요약 진단: 조건부 → 항상 3개
현재:
```ts
if (stateText || stateRow) summaries.push({ tier: 'state', ... });
if (summaryText || summaryRow) summaries.push({ tier: 'whole', ... });
if (sceneParts.length) summaries.push({ tier: 'scene', used: true, tokens: sceneEst });
```
교체(무조건 3개):
```ts
summaries.push({ tier: 'state', used: !!stateText, tokens: stateEst, note: stateText ? undefined : (stateRow ? '예산 부족' : '승인된 상태 없음') });
summaries.push({ tier: 'whole', used: !!summaryText, tokens: wholeEstOnly, note: summaryText ? undefined : (summaryRow ? '예산 부족' : '승인된 요약 없음') });
summaries.push({ tier: 'scene', used: sceneParts.length > 0, tokens: sceneEst, note: sceneParts.length ? undefined : '해당 장면 없음/제외' });
```
(episode는 P1-3c 전이라 emit 안 함 — 타입 union에 남겨둬도 무방.)

## 수정 2 — builder.ts 로어 진단: no-match도 기록 + status 필드
현재 로어 루프는 `if (!match.hit) continue;`로 no-match를 버린다. 디버거 핵심이 "왜 안 뜨나"이므로 no-match도 기록한다.
- 루프 상단(`const match = loreEntryMatch(...)` 직후)로 diag push를 옮겨 **모든 엔트리** 기록:
```ts
const match = loreEntryMatch({ always_on: e.always_on, keywords: parseJson<string[]>(e.keywords_json, []), secondary_keys: parseJson<string[]>(e.secondary_keys_json, []), selective: e.selective, scanText });
if (!match.hit) { loreDiag.push({ title: e.title, alwaysOn: !!e.always_on, matched: match.matched, tokens: 0, included: false, status: 'no-match' }); continue; }
const content = truncateToTokens(e.content, e.token_cap, cal);
const t = estimateTokens(`- [${e.title}] ${content}`, cal);
const included = loreEst + t <= budgets.lore;
loreDiag.push({ title: e.title, alwaysOn: !!e.always_on, matched: match.matched, tokens: t, included, status: included ? 'active' : 'dropped-budget' });
if (!included) { droppedLore.push(e.title); continue; }
activeLore.push({ title: e.title, content }); loreEst += t;
```
(activeLore/droppedLore 결과·조건 동일 → 조립 불변 유지. diag만 추가.)
- **타입(types.ts server+web) BudgetDiagnostics.lore 항목에 `status: 'active' | 'dropped-budget' | 'no-match'` 추가.**

## 수정 3 — UI(ChatDrawer BudgetTab): no-match·3-tier 반영
- 로어 렌더: `included` 대신 `status`로 3분기 — active(발동: matched or 'always'), dropped-budget(예산 초과), no-match(회색 opacity 0.5, '미매칭'). matched가 배열이면 `matched.join(', ')`.
- 요약 렌더: 이제 항상 3항목 → 그대로 map(각 used/tokens/note).

## messages 진단
- **불요(드롭)**: BudgetReport 최상위 included_messages/dropped_messages/recent_from_id/recent_to_id로 충분. diagnostics에 messages 넣지 않는다.

## 게이트 (재측정, raw)
1. server tsc EXIT 0 / web build EXIT 0
2. restart active / health db:ok
3. prompt-preview: `budget.diagnostics.summaries` **3항목(state,whole,scene)**; `budget.diagnostics.lore`에 각 항목 `status` 존재(현재 대화에 no-match 로어 있으면 status:'no-match' 최소 1건 확인, 없으면 active/dropped 확인).
4. **★조립 불변**: prompt-preview `messages` SHA = baseline `b3a19a8be24ba9aacaad5f33d3d859e184c220866949773968df1a06f55fe430` 동일.
5. candidate|6 / summaries whole|1 / integrity ok.

## 커밋
```
git add apps/server/src/prompt/loreMatch.ts apps/server/src/prompt/builder.ts apps/server/src/routes/conversations.ts apps/server/src/types.ts apps/web/src/types.ts apps/web/src/pages/ChatDrawer.tsx
git commit -m "feat(prompt): assembly diagnostics — lore match/no-match + summary tiers (P1-6, preview-only)"
git tag v0.0.13
```
PROGRESS.md append: 수정 3건·게이트 raw(특히 summaries 3항목·lore status·조립 SHA 동일)·커밋·태그.
