# 위임 브리프 — P1-6 프롬프트 디버거 (hermes 실행용)

> 선행: `DESIGN-P1-6.md` 읽어라. v0.0.9가 기본 목록(included/dropped_memories, active/dropped_lore 이름, summary_used)을 이미 노출·DebugList UI를 넣었다. **이 브리프는 그 위에 "왜"를 더한다**: 로어 매칭 키워드·드롭 사유·요약 tier 진단.
> 거버넌스 §0 준수: raw 증거만·최소 풋프린트·게이트 통과 전 다음 단계 금지.
> 위치 `/home/hermes/rpchat/app`. 착수 전 `git log --oneline -1` → HEAD=v0.0.12(f0751fb) 확인.
> **스키마 변경 없음. DB 쓰기 없음.** 조립 로직 불변(진단은 관찰만) — 이게 핵심 회귀 방어.
> **설계 판단 필요하거나 아래에 없는 결정이 나오면 진행 말고 PROGRESS.md에 질문 남기고 STOP.**
> ★ 단순화(설계 §6-1 갱신): opts 플래그 없이 **항상 계산**(진단은 이미 도는 루프라 비용 미미, v0.0.9와 동일 패턴). buildPrompt 시그니처 무변.

범위: 서버 진단 페이로드(P1-6a) + BudgetTab 디버거 표시 강화(P1-6b). 태그 **v0.0.13**.

---

## STEP 1 — loreMatch.ts: 상세 반환 함수 신규 추가 (기존 loreEntryActive 무변)
파일 끝에 추가(기존 함수 삭제·수정 금지 — 다른 곳 영향 없게):
```ts
/** 로어 매칭 상세: 발동 키워드·사유까지. loreEntryActive 와 동일 판정 규칙. */
export function loreEntryMatch(opts: {
  always_on: boolean | number; keywords: string[]; secondary_keys?: string[]; selective?: boolean | number; scanText: string;
}): { hit: boolean; matched: string | null } {
  if (opts.always_on === true || opts.always_on === 1) return { hit: true, matched: null };
  const keys = (opts.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  const secondary = (opts.secondary_keys ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  const primary = keys.find((k) => opts.scanText.includes(k));
  if (!primary) return { hit: false, matched: null };
  const selective = opts.selective === true || opts.selective === 1;
  if (selective && secondary.length > 0) {
    const sec = secondary.find((k) => opts.scanText.includes(k));
    return sec ? { hit: true, matched: primary } : { hit: false, matched: null };
  }
  return { hit: true, matched: primary };
}
```

## STEP 2 — builder.ts: 진단 수집 + BudgetReport.diagnostics
### 2a. import
`import { loreEntryActive } from './loreMatch.js';` → `import { loreEntryMatch } from './loreMatch.js';` (loreEntryActive 더 안 쓰면 제거, 남아도 무방).
`PromptDiagnostics` 타입 import(STEP 3에서 types.ts에 정의) — `import type { ..., PromptDiagnostics } from '../types.js';` 기존 type import 줄에 추가.

### 2b. 로어 루프 교체 (동작 보존 + loreDiag 수집)
현재 `const activeLore ... used += loreEst;` 블록에서 루프를 아래로 교체:
```ts
const activeLore: Array<{ title: string; content: string }> = [];
const droppedLore: string[] = [];
const loreDiag: PromptDiagnostics['lore'] = [];
let loreEst = 0;
for (const e of entries) {
  const always = e.always_on === true || e.always_on === 1;
  const m = loreEntryMatch({
    always_on: e.always_on, keywords: parseJson<string[]>(e.keywords_json, []),
    secondary_keys: parseJson<string[]>(e.secondary_keys_json, []), selective: e.selective, scanText,
  });
  if (!m.hit) { loreDiag.push({ title: e.title, status: 'no-match', matched: null, always_on: always, tokens: 0 }); continue; }
  const content = truncateToTokens(e.content, e.token_cap, cal);
  const t = estimateTokens(`- [${e.title}] ${content}`, cal);
  if (loreEst + t > budgets.lore) { droppedLore.push(e.title); loreDiag.push({ title: e.title, status: 'dropped-budget', matched: m.matched, always_on: always, tokens: t }); continue; }
  activeLore.push({ title: e.title, content }); loreEst += t;
  loreDiag.push({ title: e.title, status: 'active', matched: m.matched, always_on: always, tokens: t });
}
```
(activeLore/droppedLore 조건·순서 그대로 → 조립 불변.)

### 2c. 기억 루프에 memDiag 수집
pinned 루프에 병행 배열:
```ts
const memDiag: PromptDiagnostics['memory'] = [];
```
루프 내: dropped 분기에 `memDiag.push({ content: m.content, status: 'dropped-budget', importance: m.importance, tokens: t });`
포함 분기에 `memDiag.push({ content: m.content, status: 'included', importance: m.importance, tokens: t });`

### 2d. 요약 tier 진단 (sceneTierText 계산 직후)
```ts
const summaryDiag: PromptDiagnostics['summary'] = [
  { tier: 'state', used: !!stateText, tokens: stateEst, note: stateText ? undefined : (stateRow ? '예산부족' : '승인없음') },
  { tier: 'whole', used: !!summaryText, tokens: wholeEstOnly, note: summaryRow ? undefined : '승인없음' },
  { tier: 'scene', used: sceneParts.length > 0, tokens: sceneEst, note: sceneParts.length ? undefined : '없음/제외' },
];
```

### 2e. BudgetReport 반환에 diagnostics 추가
budget 객체(맨 끝 `const budget: BudgetReport = { ... }`)에 추가:
```ts
diagnostics: {
  lore: loreDiag,
  memory: memDiag,
  summary: summaryDiag,
  messages: { included: recent.length, dropped, from_id: recent[0]?.id ?? null, to_id: recent[recent.length - 1]?.id ?? null },
},
```
(recent/dropped 는 이미 계산됨 — budget 객체 위치에서 접근 가능.)

## STEP 3 — types.ts (server + web 둘 다 동일 추가)
BudgetReport 위에 추가:
```ts
export interface PromptDiagnostics {
  lore: Array<{ title: string; status: 'active' | 'dropped-budget' | 'no-match'; matched: string | null; always_on: boolean; tokens: number }>;
  memory: Array<{ content: string; status: 'included' | 'dropped-budget'; importance: number; tokens: number }>;
  summary: Array<{ tier: 'state' | 'whole' | 'scene'; used: boolean; tokens: number; note?: string }>;
  messages: { included: number; dropped: number; from_id: string | null; to_id: string | null };
}
```
BudgetReport 에 `diagnostics?: PromptDiagnostics;` 추가(옵셔널 — 기존 소비자 무영향).

## STEP 4 — UI: BudgetTab 디버거 강화 (apps/web/src/pages/ChatDrawer.tsx)
v0.0.9의 DebugList는 두되, 진단 있으면 더 풍부히. BudgetTab에서 `const g = b.diagnostics;` 후:
- **로어**: g가 있으면 DebugList('발동 로어'/'제외 로어') 대신 g.lore 렌더 —
  각 항목: `제목 · [배지]` where 배지 = active(발동:matched or 'always') / dropped-budget(예산) / no-match(회색). 예:
  ```tsx
  {g && <div className="small" style={{ marginTop: 8 }}>
    <div className="muted">로어 판정 · {g.lore.length}</div>
    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
      {g.lore.map((l, i) => <li key={i} style={{ opacity: l.status === 'no-match' ? 0.55 : 1 }}>
        {l.title} — {l.status === 'active' ? (l.always_on ? '발동(always)' : `발동(${l.matched})`) : l.status === 'dropped-budget' ? '예산 초과' : '미매칭'} {l.tokens ? `· ${l.tokens}t` : ''}
      </li>)}
    </ul></div>}
  ```
- **요약 tier**: g.summary 렌더 — `state/whole/scene: 사용여부 · 토큰 · note`.
  ```tsx
  {g && <div className="small" style={{ marginTop: 8 }}><div className="muted">요약 계층</div>
    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
      {g.summary.map((s, i) => <li key={i}>{s.tier} — {s.used ? `주입 · ${s.tokens}t` : `미주입${s.note ? ` (${s.note})` : ''}`}</li>)}
    </ul></div>}
  ```
- 기억/최근 범위는 v0.0.9 기존 표시 유지(g.memory로 토큰 병기하면 가점, 필수 아님).
- g 없을 때(옛 응답)는 기존 DebugList 폴백 유지 → 조건부 렌더.

---

## 게이트 (raw 필수)
1. `npm run build --workspace apps/server` → exit 0
2. `npm run build --workspace apps/web` → exit 0
3. `systemctl --user restart rpchat` → active; `curl -s localhost:8787/api/health|head -c 60` → db:ok
4. **진단 존재**: `curl -s -H 'Tailscale-User-Login: manofin@github' localhost:8787/api/conversations/09e7827f-c2c4-4db8-89c0-e37aea2fe62d/prompt-preview` → JSON의 `budget.diagnostics.lore/memory/summary/messages` 존재. summary에 state/whole/scene 3항목.
5. **★조립 불변(회귀 방어)**: 같은 prompt-preview의 `messages`(최종 조립 텍스트)가 v0.0.12와 동일해야 함. 방법: 변경 전 `git stash` 없이 — 커밋 전 현재 preview의 messages를 파일로 저장 → 변경 빌드 후 preview messages와 diff 없음 확인. 또는 최소: systemParts 순서·내용 로직을 안 건드렸음을 diff로 확인(진단 배열 push만 추가).
6. 무접촉: candidate|6 / summaries whole|1 / integrity ok.

## 통과 시
```
git add apps/server/src/prompt/loreMatch.ts apps/server/src/prompt/builder.ts apps/server/src/types.ts apps/web/src/types.ts apps/web/src/pages/ChatDrawer.tsx
git commit -m "feat(prompt): assembly diagnostics — lore match/drop reasons + summary tiers (P1-6)"
git tag v0.0.13
```
PROGRESS.md append: 변경파일·커밋·태그, 게이트 raw(build/health/diagnostics 존재/조립불변/candidate|6/integrity), 미결.

## 실패 시
`git checkout -- <파일>` 되돌리고 STOP, 사유 PROGRESS.md.

## ★ 주의
- **조립을 바꾸지 마라**: systemParts 구성·순서·예산 로직 그대로. 진단은 배열 push만. messages 출력이 달라지면 실패로 간주.
- loreEntryActive 규칙과 loreEntryMatch 규칙 동일 유지(판정 불일치 금지).
- 라벨=실체: 이번은 진단 페이로드+디버거 표시. 다른 것 추가 금지.
