# P1-6 프롬프트 디버거 — 설계 확정본 (2026-08-23)

> 구현 전 설계 동결 문서. 거버넌스 §0 준수. **스키마 변경 없음**(진단은 계산 산출물, 저장 안 함) → P1-3보다 저위험.
> 상태: **✅ 구현·검증 완료 (v0.0.13, 4a4d88c, 2026-08-23)** — 조립 SHA 불변 확인. P1-6a(진단)+P1-6b(UI) 완료.

---

## 0. 현재 구조 (실측 기준선)

- `GET /api/conversations/:id/prompt-preview?draft=…` → `{messages(최종 조립), budget(BudgetReport), model, profile, stop, isOoc}`. `buildPrompt` 그대로 호출(초안 메시지 임시 push).
- **BudgetReport 이미 보유**: `sections[{name,est_tokens,budget,note}]`, `included_memories[]`, `dropped_memories[]`, `active_lore[]`, `dropped_lore[]`, `dropped_messages`, `included_messages`, `summary_used`, `summary_preview`, `recent_from_id/to_id`, `calibration`.
- **BudgetTab(ChatDrawer)이 렌더 중**: 모델/프로필, 총 토큰, 섹션별 예산 막대, 보정계수, 제외 메시지 수, 활성/제외 로어, OOC 경고, "조립된 프롬프트 보기"(최종 messages 원문).
- **⚠️ v0.0.9(hermes)가 P1-6a 일부 선구현**: BudgetReport 기본 목록(included/dropped_memories, summary_used/preview, recent_from/to) 채움 + BudgetTab `DebugList` UI. **남은 P1-6a** = 드롭 사유 입도·로어 매칭 키워드·`opts.diagnostics` 플래그·tier 분해(§2). 이 설계는 v0.0.9 위에 확장.

## 1. 목표와 격차

"프롬프트 조립 **과정** 가시화" = 각 조각이 **왜 들어갔고/빠졌는지**를 추적 가능하게. 현재 부족분:

| 격차 | 현재 | 필요 |
|---|---|---|
| **드롭 사유 입도** | dropped_lore/memory는 *이름만* | 항목별 사유: 예산초과 / 키워드 무매칭 / superseded |
| **로어 매칭 근거** | active_lore 이름만 | 어떤 **키워드**가 어떤 엔트리를 발동시켰나(결정론적 스캔 투명화) |
| **섹션 실내용 전개** | 최종 조립 원문 전체만 | 섹션별 접기/펼치기로 해당 조각 원문 + 토큰 |
| **요약 tier 가시성** | summary_used/preview 1건 | P1-3 후 state/whole/episode/scene 각 주입 여부·토큰·사유 |
| **초안 영향 diff** | draft 반영된 결과만 | draft 추가 시 무엇이 밀려났는지(선택, P1-6b) |

## 2. 설계 — 서버 진단 페이로드 (P1-6a)

`buildPrompt`가 `budget`에 **`diagnostics`** 필드를 추가(BudgetReport 확장, additive, 저장 없음):

```ts
interface PromptDiagnostics {
  lore: Array<{ title: string; status: 'active'|'dropped-budget'|'no-match';
                matched?: string;            // 발동 키워드(있으면)
                always_on: boolean; tokens: number }>;
  memory: Array<{ content: string; status: 'included'|'dropped-budget';
                  importance: number; scope: 'conversation'|'character'; tokens: number }>;
  summary: Array<{ tier: 'state'|'whole'|'episode'|'scene'; used: boolean;
                   tokens: number; reason?: string }>;   // P1-3 전엔 whole 1건만
  messages: { included: number; dropped: number; from_id: string|null; to_id: string|null };
}
```
- 산출 위치: 이미 builder가 각 루프에서 판정 중 → 그 지점에서 진단 배열에 push만 추가(중복 계산 없음).
  - 로어: `loreEntryActive` 호출부(builder.ts:108~)에서 hit/miss + 매칭 키워드 기록. **매칭 키워드 노출을 위해** `loreEntryActive`가 bool 대신 `{hit, matched?}` 반환하도록 소폭 확장(호출부 1곳).
  - 기억: pinned 루프(builder.ts:142~)에서 included/dropped + 토큰.
  - 요약: state/whole 주입부에서 tier별 used/tokens.
- **행동 무변**: 진단은 관찰만. 조립 로직·토큰 배분 불변. 회귀 위험 최소.
- prompt-preview는 자동으로 `budget.diagnostics` 반환(별도 파라미터 불요).

## 3. 설계 — UI 디버거 뷰 (P1-6b)

BudgetTab 하단에 **"조립 상세" 토글** 추가(기존 예산 막대는 유지). 펼치면 섹션 트리:

- **활성/제외 로어**: 각 항목 배지(active=발동 키워드 표시 / dropped=예산 / no-match=회색). 클릭 시 content 펼침.
- **고정 기억**: included/dropped 배지 + 중요도 + 토큰. dropped는 사유.
- **요약 tier**: state/whole/(P1-3 후 episode/scene) 각 used·토큰·사유. (P1-3와 자연 합류)
- **최근 대화**: included N / dropped N, from~to 메시지. (P1-5 재사용: from/to id → 원본 점프)
- 상단 요약 바: est_total/available, 보정계수, 섹션별 over(빨강)/under.
- "조립된 프롬프트 보기"(기존 원문)와 병존 — 원문은 "무엇을", 디버거는 "왜".

## 4. 단계 분할 (게이트별 태그)

| 슬라이스 | 범위 | 스키마 | 리스크 | 태그 |
|---|---|---|---|---|
| **P1-6a** | 서버 diagnostics 산출(BudgetReport 확장, loreEntryActive 반환 확장) | 없음 | 낮음(관찰만) | (P1-3 이후 다음 태그) |
| **P1-6b** | UI 디버거 뷰(BudgetTab 조립 상세 토글) | 없음 | 낮음 | 그 다음 태그 |

각 슬라이스 게이트(raw):
1. `npm run build --workspace apps/server && npm run build --workspace apps/web` → 각 exit 0
2. restart → health `db:ok`
3. **행동 무변 검증**(P1-6a 핵심): 기존 대화 prompt-preview 호출 → `messages`(최종 조립)가 **변경 전과 동일**(진단 추가는 조립을 안 바꿈). budget.diagnostics 존재 확인.
4. memories 무접촉: candidate|6 불변 / integrity ok
5. 임시 로어/기억으로 매칭·드롭 사유가 진단에 정확히 반영되는지 raw 확인 → 정화

## 5. 위임 적합성

- **스키마 없음 + 행동 무변** → **P1-6 전체 hermes 위임 적합**. 단 게이트3(조립 불변)이 회귀 방어 핵심 — 브리프에 명시.
- P1-3 구현·검토 완료 후 착수 권장(요약 tier 진단이 P1-3 스키마에 의존 → 순서상 P1-3 다음).

## 6. 결정 잠금 (2026-08-23 확정)

1. ✅ **diagnostics = preview-only opts 플래그(최종)**: buildPrompt에 `opts?:{diagnostics?:boolean}` 추가, conversations.ts(preview)만 `{diagnostics:true}` 전달, chat.ts(생성)는 미전달 → **생성 핫패스 진단 0**. `BudgetReport.diagnostics?` 옵셔널. (구현 중 always-compute로 잠깐 단순화했다가 hermes가 preview-only로 구현, 그게 원설계·더 나아 채택. v0.0.13.)
   - **messages 진단 드롭**: BudgetReport 최상위 included/dropped_messages·recent_from/to_id로 이미 충분 → diagnostics에 미포함.
2. ✅ **로어/기억 원문 = 펼침 시 전체 노출** (디버깅 목적, 접힘 기본).
3. ✅ **순서 = P1-3 → P1-6**: 요약 tier 진단이 P1-3 스키마(tier 컬럼)에 의존. P1-3a/b/c 완료·검토 후 P1-6a 착수. P1-6a 시점의 summary 진단은 존재하는 tier만 채움(자연 확장).
