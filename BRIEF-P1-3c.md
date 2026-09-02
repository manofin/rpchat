# 위임 브리프 — P1-3c 에피소드 rollup (hermes 실행용)

> 선행: `DESIGN-P1-3c.md` v2(2-A 확정) 읽어라. P1-3a/b/P1-6 완료 위. HEAD=v0.0.13(4a4d88c) 확인 후 착수.
> 거버넌스 §0 준수: raw만·최소 풋프린트·게이트 통과 전 금지. **스키마 변경 없음. summarize/whole 생성 경로 무변**(2-A).
> 설계 판단 필요하거나 아래에 없는 결정 나오면 진행 말고 PROGRESS.md 질문 남기고 STOP.
> 핵심 개념: 장면을 에피소드로 접되 **rollup 시점에 rolled_up_into 세팅**, 장면 주입 배제는 **episode가 approved일 때만**(자가 치유). 세부는 DESIGN-P1-3c §3.

범위: 에피소드 rollup 엔드포인트 + 승인 게이팅 주입 + DELETE 정리 + UI. 태그 **v0.0.14**.

---

## STEP 1 — templates.ts: 에피소드 프롬프트/렌더 신규
```ts
export function renderEpisodePrompt(sceneContents: string[]): string {
  return [
    '다음은 시간순 장면 요약들이다. 이들을 하나의 에피소드로 압축한다. 아래 JSON 객체 하나만 출력한다. 설명·코드펜스 금지.',
    '{"episode":"장면들을 아우르는 하나의 아크로 4~6문장. 시간순, 핵심 사건·변화 중심."}',
    '',
    sceneContents.map((c, i) => `${i + 1}. ${c}`).join('\n'),
  ].join('\n');
}
export function renderEpisode(text: string | null): string | null {
  return text && text.trim() ? `### 지난 에피소드\n${text.trim()}` : null;
}
```

## STEP 2 — memory.ts: rollup 엔드포인트 + DELETE 정리
### 2a. import 추가
`import { renderSummaryPrompt, stateToBullets } from '../prompt/templates.js';` → `renderEpisodePrompt` 추가.

### 2b. DELETE 핸들러 정리 (에피소드 삭제 시 장면 해제)
현재:
```ts
app.delete<{ Params: { id: string } }>('/api/summaries/:id', async (req, reply) => {
  const r = run(db, 'DELETE FROM summaries WHERE id = ?', req.params.id);
  if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
  return { ok: true };
});
```
교체:
```ts
app.delete<{ Params: { id: string } }>('/api/summaries/:id', async (req, reply) => {
  const s = one<SummaryRow>(db, 'SELECT * FROM summaries WHERE id = ?', req.params.id);
  if (!s) return reply.code(404).send({ error: 'not found' });
  db.transaction(() => {
    if (s.tier === 'episode') run(db, 'UPDATE summaries SET rolled_up_into = NULL WHERE rolled_up_into = ?', s.id); // 접힌 장면 해제
    run(db, 'DELETE FROM summaries WHERE id = ?', s.id);
  })();
  return { ok: true };
});
```

### 2c. rollup 엔드포인트 (summarize 라우트 근처에 추가)
```ts
app.post<{ Params: { id: string }; Querystring: { force?: string } }>('/api/conversations/:id/rollup-episode', async (req, reply) => {
  const conv = loadConversation(ctx, req.params.id);
  if (!conv) return reply.code(404).send({ error: 'not found' });
  if (ctx.queue.activeList.some((g) => g.conversationId === conv.id)) return reply.code(409).send({ error: '생성 중에는 묶을 수 없음' });
  const THRESHOLD = 5;
  const force = req.query.force === '1';
  const scenes = many<SummaryRow>(db, `SELECT * FROM summaries WHERE conversation_id = ? AND tier = 'scene' AND status = 'approved' AND rolled_up_into IS NULL ORDER BY created_at ASC`, conv.id);
  const targets = scenes.slice(0, THRESHOLD);
  if (targets.length === 0) return reply.code(400).send({ error: '묶을 장면 없음' });
  if (targets.length < THRESHOLD && !force) return reply.code(400).send({ error: `묶을 장면이 부족 (${targets.length}/${THRESHOLD})` });

  const profile = loadProfile(db, 'summary');
  const prompt = renderEpisodePrompt(targets.map((s) => s.content));
  const messages = profile.system_mode === 'merge'
    ? [{ role: 'user' as const, content: prompt }]
    : [{ role: 'system' as const, content: '당신은 역할극 기록을 정확하게 요약하는 편집자다. 요청된 JSON 만 출력한다.' }, { role: 'user' as const, content: prompt }];
  const controller = new AbortController();
  const genId = uid();
  ctx.queue.register({ id: genId, conversationId: conv.id, messageId: '', startedAt: nowIso(), controller });
  let text = '';
  try {
    const r = await ctx.queue.run(() => ctx.model.complete({ model: profile.model || ctx.resolvedModel(), messages, temperature: profile.temperature, top_p: profile.top_p, max_tokens: profile.max_tokens, signal: controller.signal }), controller.signal);
    text = r.text;
  } catch (err) {
    return reply.code(502).send({ error: `에피소드 생성 실패: ${(err as Error).message}` });
  } finally {
    ctx.queue.unregister(genId);
  }
  const parsed = lenientJson(text) as { episode?: unknown } | null;
  const episodeText = parsed && typeof parsed.episode === 'string' ? parsed.episode.trim() : '';
  if (!episodeText) return reply.code(502).send({ error: '모델 출력을 JSON 으로 해석하지 못함', raw: text.slice(0, 2000) });

  const epId = uid();
  const t = nowIso();
  const coversFrom = targets[0].covers_from_message_id ?? targets[0].covers_until_message_id;
  const coversUntil = targets[targets.length - 1].covers_until_message_id;
  db.transaction(() => {
    run(db, 'INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', epId, conv.id, episodeText, coversUntil, coversFrom, 'draft', t, 'episode');
    run(db, `UPDATE summaries SET rolled_up_into = ? WHERE id IN (${targets.map(() => '?').join(',')})`, epId, ...targets.map((s) => s.id));
  })();
  return { episode: one<SummaryRow>(db, 'SELECT * FROM summaries WHERE id = ?', epId), rolledScenes: targets.map((s) => s.id) };
});
```
- PATCH 핸들러는 **변경 없음**(승인시 마킹 안 함 — rollup이 이미 마킹, 배제는 builder 쿼리가 판단).

## STEP 3 — builder.ts: 승인 게이팅 배제 + episode 주입(예약)
### 3a. 장면 주입 쿼리 교체 (approved episode에 접힌 것만 배제)
현재 scene 쿼리:
```
WHERE conversation_id = ? AND tier = 'scene' AND status = 'approved' AND rolled_up_into IS NULL ORDER BY created_at DESC
```
교체:
```
WHERE conversation_id = ? AND tier = 'scene' AND status = 'approved'
  AND (rolled_up_into IS NULL OR rolled_up_into NOT IN (SELECT id FROM summaries WHERE tier = 'episode' AND status = 'approved'))
ORDER BY created_at DESC
```

### 3b. episode 주입 + 예산 예약 (state 계산 후, whole 계산 전에 삽입)
★ **교체 경계 명확히**: 기존 `const stateEst = ...` 줄부터 기존 `let sceneBudget = ...` 줄까지(그 사이의 기존 `const summaryText`, 기존 주석, 기존 `const SCENE_RECENT_GUARD`, `const recentGuardIds`, `const wholeEstOnly`, `let sceneBudget` 전부)를 **아래 블록으로 통째 교체**한다. 중복 선언(summaryText/recentGuard/SCENE_RECENT_GUARD/wholeEstOnly/sceneBudget) 남기지 마라. 이후 scene 루프는 그대로 두되 루프 안 쿼리만 3a로 교체.
```ts
const stateEst = stateText ? estimateTokens(stateText, cal) : 0;
// recentGuard 를 episode/scene 공용으로 먼저 정의
const SCENE_RECENT_GUARD = 24;
const recentGuardIds = new Set(history.slice(-SCENE_RECENT_GUARD).map((m) => m.id));
// episode: 최신 approved 1건, 예약(상태 후 잔여의 35%), recentGuard 적용
const afterState = Math.max(0, sumBudget - stateEst);
const episodeRow = one<SummaryRow>(db, `SELECT * FROM summaries WHERE conversation_id = ? AND tier = 'episode' AND status = 'approved' ORDER BY created_at DESC LIMIT 1`, conv.id);
let episodeText: string | null = null;
let episodeEst = 0;
if (episodeRow && !(episodeRow.covers_until_message_id && recentGuardIds.has(episodeRow.covers_until_message_id))) {
  const epCap = Math.floor(afterState * 0.35);
  const rendered = renderEpisode(episodeRow.content);
  const truncated = rendered ? truncateToTokens(rendered, epCap, cal) : null;
  if (truncated) { episodeText = truncated; episodeEst = estimateTokens(truncated, cal); }
}
// whole: 상태·episode 예약 후 잔여
const summaryText = summaryRow ? truncateToTokens(summaryRow.content, Math.max(0, sumBudget - stateEst - episodeEst), cal) : null;
const wholeEstOnly = summaryText ? estimateTokens(summaryText, cal) : 0;
let sceneBudget = Math.max(0, sumBudget - stateEst - episodeEst - wholeEstOnly);
```
그 다음 기존 scene 루프 그대로(단 위 3a 쿼리, recentGuardIds는 이미 정의됨 — **중복 정의 제거**: 기존 `const SCENE_RECENT_GUARD`/`const recentGuardIds` 줄 삭제).
- `renderEpisode` import 추가(templates에서).
- `import { ..., renderState, renderSummary } ...`에 `renderEpisode` 추가.

### 3c. sumEst + systemParts + 진단
- `const sumEst = wholeEstOnly + stateEst + sceneEst + episodeEst;`
- systemParts: `renderSummary(summaryText)` 뒤에 `episodeText` 삽입 →
  `[..., stateText, renderSummary(summaryText), episodeText, sceneTierText, loreText]`
- **summaryDiag는 3-tuple(state/whole/scene) 그대로 유지** — episode 진단은 P1-6 후속(이 커밋 제외). note에 episode 표기만 선택적으로 추가 가능(안 해도 됨).
- 섹션 note에 `episodeText ? 'episode 포함' : ''` 추가 가능(선택).

## STEP 4 — UI (ChatDrawer.tsx SummaryTab)
- `const episodeRows = summaries.filter((s) => s.tier === 'episode');`
- `wholeRows` 필터에 episode 이미 제외됨(`tier !== 'episode'`) — 유지.
- renderCard kind 타입에 `'에피소드'` 추가. 렌더 순서: 상태 → **에피소드** → 장면 → 전체.
- **"에피소드로 묶기" 버튼**: 미접힘 approved 장면 수 계산 —
  `const foldableScenes = summaries.filter((s) => s.tier === 'scene' && s.status === 'approved' && !s.rolled_up_into).length;`
  버튼(장면 ≥ 5일 때 노출): `{foldableScenes >= 5 && <button className="btn sm block" onClick={rollup}>에피소드로 묶기 ({foldableScenes})</button>}`
  ```ts
  async function rollup() {
    try { await post(`/api/conversations/${conversationId}/rollup-episode`, {}); await load(); onApplied(); ui.toast('에피소드 초안 생성 — 승인하면 장면이 접힙니다'); }
    catch (e) { ui.toast((e as Error).message, 'err'); }
  }
  ```
  (post는 이미 import. Summary 타입에 rolled_up_into? 이미 있음.)

## 게이트 (raw 필수)
1. server build exit 0 / web build exit 0
2. restart active / health db:ok
3. **수명주기 시나리오** (임시 __test__ 장면 5건 tier='scene' status='approved' SQL 삽입, covers_until은 **과거 메시지 id**로 recentGuard 밖):
   a. rollup 호출(`curl -X POST .../rollup-episode`) → episode **draft** 생성 확인. **이 시점 prompt-preview에 그 장면들 여전히 개별 주입**(draft라 배제 안 됨) 확인.
   b. episode PATCH status='approved' → prompt-preview에서 그 장면 사라지고 `### 지난 에피소드` 등장 확인.
   c. episode DELETE → 장면 5건 주입 **복귀** + 그 장면 rolled_up_into NULL 확인(자가 치유).
   d. 임시 장면 전량 DELETE → 정화.
4. **조립 회귀**: 에피소드 없는 상태(정화 후) prompt-preview messages SHA = `b3a19a8be24ba9aacaad5f33d3d859e184c220866949773968df1a06f55fe430` 불변.
5. candidate|6 / 기존 whole|approved|1 무접촉 / summaries 잔여 __test__ 0 / integrity ok.

## 통과 시
```
git add apps/server/src/prompt/templates.ts apps/server/src/routes/memory.ts apps/server/src/prompt/builder.ts apps/web/src/pages/ChatDrawer.tsx
git commit -m "feat(summary): episode rollup tier — manual fold, approval-gated exclusion (P1-3c)"
git tag v0.0.14
```
PROGRESS.md append: 변경파일·커밋·태그, 게이트 raw(수명주기 a~d·조립 SHA·candidate|6·integrity), 미결.

## 실패 시
`git checkout -- <파일>` 되돌리고 STOP. 임시 __test__ 행 삽입했으면 반드시 DELETE. DB 마이그레이션 없으므로 스키마 롤백 불요.

## ★ 불변 (지난 회차 교훈)
- summarize/whole 생성 경로·출력 스키마(whole/state/scene) 무변. loreEntryActive/loreEntryMatch 무변. 생성 경로 진단 금지.
- PATCH 핸들러에 승인-마킹 로직 넣지 마라(Approach X는 rollup이 마킹, builder 쿼리가 배제 판단).
- 조립 로직: episode 삽입 외 기존 순서·예산 로직 보존. state/whole/scene 진단 3-tuple 유지(episode 진단은 이 커밋 제외).
- 임시행 '__test__' 마커 필수·검증 후 즉시 삭제. candidate|6·기존 whole 절대 무접촉.
- 브랜치-스코프(getPath head) 부채는 손대지 말 것.
