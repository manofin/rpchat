# P1-3 계층 요약 — 설계 확정본 (2026-08-23)

> 구현 전 설계 동결 문서. 거버넌스 §0 준수(스키마 변경 = 백업·게이트). HANDOFF.md v2 §4 P1-3 상세화.
> 상태: **✅ 설계 확정 (2026-08-23)** — §7 결정 잠금 완료. P1-3a부터 단계 구현 가능.

---

## 0. 현재 구조 (실측 기준선)

- `summaries` = 평면 단일 계층: `{id, conversation_id, content, covers_until_message_id, status(draft|approved), created_at}`
- `POST /api/conversations/:id/summarize`: 이전 approved 요약 + 마지막 커버 이후 메시지 → **롤링 서사 요약 1건**(8문장, draft) + 기억 후보 최대 8개. 모델 1회 호출.
- `builder.ts:151`: **최신 approved 요약 1건만** 주입 (`ORDER BY created_at DESC LIMIT 1`).
- 예산: `budgets.memory`(= available × SHARE.memory)를 고정기억(memCap=50%)과 요약(나머지)이 분점.
- **관찰**: 현 롤링 요약 = 사실상 "전체(whole) 서사". 계층화의 신규 가치는 ①상태 트래커(직교) ②장면/에피소드 세분화.

---

## 1. 4계층 정의

| 계층 | 성격 | 길이 | 생성 | 주입 |
|---|---|---|---|---|
| **장면 scene** | 단거리 서사 — 한 장소/시점/비트의 사건 | 2~4문장 | summarize 시 (최근 미요약 구간) | 최근 대화 창에서 **밀려난** 장면만 1~2건 |
| **에피소드 episode** | 중거리 — 여러 장면을 묶은 아크 | 4~6문장 | rollup(장면 N건 누적 or 수동) | 최근 에피소드 1건 |
| **전체 whole** | 장거리 — 지금까지의 개요 | 6~8문장 | 에피소드 rollup(P1-3c) / 그 전엔 기존 롤링 유지 | 항상 최신 1건 (backbone) |
| **상태 state** | 서사 아님 — 구조화된 *현재 상태* 스냅샷 | 구조화 ~200t | summarize 시 매번 갱신 | 항상 최신 1건 (최우선) |

**상태 트래커 필드**(구조화): `장소`, `시각/시점`, `동석 인물`, `관계·감정 상태`, `보류된 목표·약속·훅`, (선택)`소지품/신체상태`. RP 모델이 가장 자주 잃는 정보 → 최우선 주입.

---

## 2. 스키마 (migration 0005_summary_tiers.sql)

```sql
-- 러너가 파일당 1 트랜잭션으로 감싼다 → 파일 내 BEGIN/COMMIT 금지 (§2 handoff)
ALTER TABLE summaries ADD COLUMN tier TEXT NOT NULL DEFAULT 'whole';
      -- 'scene' | 'episode' | 'whole' | 'state'. 기존 행 → 'whole'(롤링 서사 = 전체)
ALTER TABLE summaries ADD COLUMN covers_from_message_id TEXT;   -- scene/episode 구간 시작(기존은 until만)
ALTER TABLE summaries ADD COLUMN rolled_up_into TEXT;           -- 상위로 접힌 장면 → 에피소드 id (NULL=미접힘)
CREATE INDEX IF NOT EXISTS idx_summaries_tier ON summaries(conversation_id, tier, created_at);
```
- SQLite `ADD COLUMN`은 비재작성(안전). `NOT NULL DEFAULT`도 안전.
- 기존 approved 1행 → `tier='whole'` 자동. **검증 게이트**: 마이그레이션 후 그 행 tier='whole' 확인.
- `status`는 draft|approved 유지. rollup으로 접힌 장면은 `rolled_up_into` 채워 주입 제외(삭제 아님, 감사 보존).
- `state` tier의 `content`는 구조화 텍스트(마크다운 불릿 or JSON). 스키마 무변경으로 흡수(파싱은 앱 계층).

---

## 3. 생성 전략 (모델 호출 경제 고려 — 로컬 약모델)

**원칙: summarize 1콜로 다계층 동시 산출.** 같은 transcript를 보므로 한 번에 emit.

### 3-1. summarize (매 호출, 모델 1회)
프롬프트 출력 스키마 확장:
```json
{
  "scene":  "최근 미요약 구간의 장면 요약 2~4문장",
  "state":  {"장소":"","시각":"","동석":"","관계":"","보류":""},
  "whole":  "이전 전체 + 신규를 접은 롤링 서사 8문장 이내",
  "memories":[{"content":"직접 확인된 사실 1개","importance":1}]
}
```
- 산출: `scene`(tier=scene, covers_from=직전 커버+1, covers_until=마지막), `state`(tier=state, 항상 최신 대체), `whole`(tier=whole, 롤링), `memories`(기존).
- 전부 **draft**로 저장 → 사용자 승인해야 주입(기존 규율 유지).
- 파싱 실패 내성: `lenientJson` 유지. scene/state 누락 시 해당 tier 스킵(부분 성공 허용).

### 3-2. 에피소드 rollup (P1-3c, 별도 on-demand 콜)
- 트리거: 미접힘 approved 장면 ≥ THRESHOLD(초기 5, 데이터로 조정) or 수동 "에피소드로 묶기".
- 입력: 미접힘 장면 요약들(원문 transcript 아님 → 저렴). 출력: 에피소드 요약 1건.
- 접힌 장면들의 `rolled_up_into` = 새 에피소드 id.
- **whole 재정의(P1-3c)**: whole = 에피소드 rollup. 그 전(P1-3a/b)엔 기존 롤링 whole 유지(호환).

---

## 4. 주입 전략 (builder.ts)

`budgets.memory` 내 고정기억(memCap=50% 유지) 이후 **요약 하위예산** `sumBudget = memory − memEst`를 우선순위 채움:

```
우선순위(가장 내구적·압축적 → 세부):
1. state   (cap = min(200t, sumBudget))         ★항상, 현재상태
2. whole   (cap = 남은 예산의 대부분)            backbone
3. episode (최근 미접힘 에피소드 1건)
4. scene   (최근 장면 1~2건, 단 "최근 대화"창에 이미 든 구간은 제외)
각 tier 순서대로 fill, 예산 소진 시 중단.
```
- **중복 방지**: scene 주입은 `covers_until_message_id`가 `recent_from_id`보다 과거인 것만(이미 원문으로 들어간 장면 재요약 배제).
- 섹션 리포트: 기존 '고정 기억+요약' 항목을 tier별 소계로 확장(BudgetTab 가시화 = P1-6과 연계).
- system 조립부(builder.ts:195): `renderSummary`를 tier별 렌더로 확장(`renderState`, `renderSceneList` 등). 순서: 규칙…기억, **state, whole, episode, scene**, 로어.

---

## 5. UI (ChatDrawer SummaryTab)

- 최상단 **상태 카드**(state): 구조화 필드 표시 + 편집 + 승인. draft/approved 배지.
- **전체(whole)** 카드: 기존 요약 카드 유지.
- **에피소드/장면** 접이식 목록: 각 draft→approve, 장면엔 "원본 구간" 점프(P1-5 재사용), "에피소드로 묶기" 버튼(P1-3c).
- 생성 버튼 결과 토스트: "요약 초안 — 장면/상태/전체 + 기억 N".

---

## 6. 단계 분할 (게이트별 태그)

| 슬라이스 | 범위 | 스키마 | 리스크 | 태그 |
|---|---|---|---|---|
| **P1-3a** | 상태 트래커(state) 생성·주입·UI. 기존 whole 무변 | 0005 | 낮음(직교) | ✅ **v0.0.11**(0929225, 검증완료) |
| **P1-3b** | 장면(scene) 생성·주입(밀려난 구간)·UI | (0005 재사용) | 중 | ✅ **v0.0.12**(f0751fb, 검증완료) |
| **P1-3c** | 에피소드 rollup(2-A: whole 유지, episode 중간tier) + 묶기 UI | (0005 재사용) | 중(Approach X) | ✅ **v0.0.14**(e8d567a, 검증완료) |

> ⚠️ 태그 번호 주의: v0.0.9/v0.0.10은 설계 전 라벨오류 커밋(무해). 실제 P1-3a = **v0.0.11**. HANDOFF §2 참조.

각 슬라이스 게이트(raw 필수):
1. `npm run build --workspace apps/server && npm run build --workspace apps/web` → 각 exit 0 (state 파싱은 서버측 → server 빌드 필수)
2. 마이그레이션(0005, P1-3a만): 백업 `backups/rpchat-pre-0005.db` → restart 시 자동적용 → `schema_migrations`에 0005 기록 + 기존 요약행 `tier='whole'` + `PRAGMA foreign_key_check` 무결
3. restart → health `db:ok`
4. **memories 무접촉**: `candidate|6` 불변 (요약 작업이 기억 건드리지 않음 확인)
5. 임시행(__test__ 대화 or 마커)으로 생성→주입 프리뷰(`/prompt-preview`)에 state/scene 포함 확인 → 정화
6. `PRAGMA integrity_check` → ok

**롤백**: 각 슬라이스 커밋 전 `git reset --hard <이전태그>`; 마이그레이션은 `backups/rpchat-pre-0005.db` 복원.

---

## 7. 결정 잠금 (2026-08-23 확정)

1. ✅ **상태 필드 = 6필드 고정**: `장소`, `시각/시점`, `동석 인물`, `관계·감정`, `보류된 목표·약속·훅`, (선택)`신체·소지`. 캐릭터/장르별 가변 필드는 **P4 world 연계로 이월**.
2. ✅ **state content = 마크다운 불릿**: 사람이 편집 쉽고 프롬프트 직삽 가능. 파싱은 관대(라벨: 값 라인 근사). draft→approve UX 그대로.
3. ✅ **에피소드 THRESHOLD = 초기 5** (미접힘 approved 장면 5건). 데이터로 보정(§8 마법수 금지 → 초기값 명시·관찰).
4. ✅ **whole = 2-A로 개정(2026-08-23, DESIGN-P1-3c 정본)**: 당초 "에피소드 rollup으로 whole 재정의·롤링 폐기"였으나 구현·hermes검수 종합 결과 **롤링 whole 유지 + episode를 신설 중간 tier**로 변경(부트스트랩 공백·기존동작 변경 리스크 회피, 입도 상보). 스키마 무변경. 2-B(whole 재정의)는 기각.

---

## 8. 위임 적합성

- **P1-3a 상태 트래커**: 스키마 마이그레이션 포함 → **Claude Code 직접**(원칙 0, live DB). 단 UI 부분(SummaryTab state 카드)은 게이트 통과 후 hermes 위임 가능.
- **P1-3b/c**: 설계 판단 잔존 → Claude Code 주도, 반복적 UI만 위임.
