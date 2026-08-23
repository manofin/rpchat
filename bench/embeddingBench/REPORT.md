# P3 임베딩 벤치 REPORT (raw + 판정)

> 사전등록: `bench/embeddingBench/preregistration.md` (커밋 a775c01, append ef56803).
> 실행일 2026-08-23. 라이브 무접촉 확인(DB 쓰기 0, `apps/server/src/**` 미수정, rpchat 서비스 재시작 없음).

## 판정: **비채택** (확정)

- 근거: Task 3(로어)에서 H1·H2 **둘 다 성공기준 1 불충족** → 합산규칙(사전등록 §5:
  "H1과 H2 각각이 성공기준 1~3 전부 충족 시에만 채택")에 따라 비채택.
- 판정컷 θ=0.70 기준. 0.65/0.75는 민감도 참고 전용.
- 비채택 = 정상 결과 (규칙 천장 확인 = 근거 확보 = PRD 순서 7 종료).
- `conflict.ts` / `loreMatch.ts` 미변경. B군 "로어 의미 발동" 닫힘.

## Task별 raw 게이트

| Task | 게이트(raw stdout) | 결과 |
|---|---|---|
| 1 픽스처 | `FIXTURE_OK lore=25 memory=20`, `JSON_PARSE_OK` | PASS |
| 2 엔진 | `H1_DIM 384 / H2_DIM 384 / SMOKE_OK` (e5-small ONNX 가용 확인) | PASS |
| 3 로어 | 아래 상세 — 성공기준 1 불충족 | **FAIL → 비채택** |
| 4 기억 | 참고자료 전용 (판정 불영향) | 기록만 |
| 5 성능 | 참고자료 전용 (판정 불영향) | 기록만 |

## Task 3 로어 벤치 상세 (results/lore-1787528032904.json)

baseline(live `loreEntryActive`, 키워드-only): must_fire 10/10, false_trigger 10/10
— live 엔트리 전부 `selective=0`이라 오발동 억제 장치가 꺼진 실사용 설정 그대로.

### 두 후보의 실패 모드 (서로 다른 원인)

**H1 (`paraphrase-multilingual-MiniLM-L12-v2`) — 과소발화 (전구간 저평가)**
- must_fire_recall: **0/10** (θ=0.65/0.70/0.75 모두). must_not_fire false-trigger: 0/10.
- 원인: 코사인 절대값이 전 구간 낮다 — 진양성조차 0.20~0.67, θ=0.65 이상인 케이스는 2건뿐(L03 0.660, L06 0.665). 애매 케이스 top-1 cos도 0.37~0.60.
- AND 게이트 자체는 정상 작동: kw=true에서 cos<θ면 발동 안 함 → 오발동 억제는 "아예 안 쏘는" 방식으로만 달성.
- ambiguous top-1 정확: 3/5 (L21·L22·L23을 '쫓아오는 것'으로 오매칭).

**H2 (`multilingual-e5-small`) — 과대발화 (전구간 고평가)**
- must_fire_recall: 10/10. 그러나 must_not_fire false-trigger: **10/10** (θ=0.65/0.70/0.75 모두 — 인접 컷에서 반전 없음).
- 원인: e5 특유의 점수 분포 — 무관한 문장('서가 곤충', '잉크 번진 영수증')에도 cos 0.79~0.84의 균일한 고점. 절대 임계값과 맞지 않는 스케일.
- ambiguous top-1 정확: 4/5 (L23 '골짜기'를 추격자로 오매칭).

### 판정 적용

- H1: 성공기준 1의 must_fire 조건 불충족 (0/10 < baseline 10/10).
- H2: 성공기준 1의 must_not_fire false-trigger 0/10 불충족 (10/10).
- 둘 다 불충족 → 재실행·게이트식 변경 없이 비채택 확정.

## 사전등록 결함 정정 기록

- **결함**: 사전등록 §4-1(성공기준 1)이 "오발동 억제 + 애묘 재현율 ≥50%"만 규정하고
  **must_fire_recall ≥ baseline(회귀 없음)** 조건이 누락. 이 누락 때문에 H1의 "전혀 안 쏨" 실패가
  문구상 통과처럼 보일 수 있었다.
- **정정**: preregistration.md Append(ef56803)로 "AND must_fire_recall ≥ baseline 수준" 추가.
  기존 raw JSON 재평가만 적용, 재실행 없음. 옵션(a)(b) 게이트식/baseline 재설계는 하지 않음
  — 결과가 마음에 들지 않는다는 이유의 규칙 변경은 §5 사후편향 금지와 충돌하기 때문.

## 보고 정정 기록 (agent 자체 오류)

- 초기 PROGRESS 기록(8b33f6b)에서 "H1·H2 모두 false_trigger 10/10", "keyword 항이 오발동을 통과시킨다"고
  잘못 기술 — raw와 반대(H1은 0/10)였으며 사용자 raw 대조로 지적받아 본 섹션으로 정정함.
  올바른 진단은 **모델별 코사인 스케일 문제**(H1 저평가/H2 고평가)이며 AND 게이트 로직의 결함이 아님.

## Task 4 기억 벤치 (참고자료 전용 — results/memory-1787529022256.json, θ=0.70)

| 지표 | baseline(live classify) | H1 | H2 |
|---|---|---|---|
| duplicate recall | 2/5 | 5/5 | 5/5 |
| duplicate 오탐(new→dup) | 0/5 | 0/5 | 5/5 |
| conflict 감지(cos-only 참고, 극성판정 미구현) | suppressed 1/5 | 5/5 | 5/5 |
| complement → dup/conf 오탐 | — | 2/3 | 3/3 |
| transient 오탐 | — | 0/2 | 2/2 |

해석 주의: conflict는 cos-only 관측값(반의어/부정 극성 판정 미포함)이므로 "conflict 탐지 가능"
의 증거가 아님. H1은 complement 2/3을 중복/충돌로 오표시(개체 동일+문체 유사 한계), H2는
스케일 문제로 new/transient까지 전부 컷 통과. 어느 쪽도 주입 가능 수준의 근거는 아님.

## Task 5 성능 벤치 (참고자료 전용 — results/perf-*.json, Ubuntu VM 단독 실행 기준)

| 엔진 | 100문장 인코딩 | 1문당 | idle RSS | Gemma :8083 health |
|---|---|---|---|---|
| H1 | 395ms | 3.95ms | 716MB | idle 응답 null(포트 미응답 — 이 환경에 서버 없음), busy 중 -1 |
| H2 | 446ms | 4.46ms | 687MB | 동일 |

- RSS ≤ 8GB, 100문장 ≤ 30s 조건은 두 엔진 모두 여유 있게 충족 (성능이 병목이었어도 판정 변화 없음).
- Gemma TTFT 동시실행 측정은 이 환경에 :8083 서비스가 없어 미실측 — 사전등록 §4-3의 해당 항목은 "확인 안 함".

## 확인함 / 확인 안 함

**확인함**
- 픽스처 n=25/20 및 분할 규칙 준수
- 두 엔진 ONNX 로드·384차원 출력
- 로어 벤치 raw (baseline/H1/H2 × 3θ)
- H1 과소발화 / H2 과대발화 실패 모드 분리
- 사전등록 결함(must_fire_recall 누락)과 append 정정
- 기억/성능 벤치 참고자료 측정

**확인 안 함 (범위 외 또는 환경 제약)**
- Gemma :8083 TTFT 동시실행 영향 (이 환경에 서비스 부재)
- conflict 의미 판정(극성/반의어 포함) — cos-only 관측만
- 실 라이브 기억 6행·실 대화 기반 재측정 (프라이버시 원칙)
- 임베딩 주입 후 실사용 UX (별도 ADR — 비채택으로 발생하지 않음)
- Galaxy 실기기

## 향후 실험 아이디어 (P3-v2 후보 — 본 벤치 재작업 아님, 별도 사전등록 필요)

1. **문체 격차 완화**: H1 저평가의 원인 후보 — entry.content(백과사전식 설명문) vs RP 대화체 문장의
   문체 불일치. entry를 문장 단위로 분해하거나 대화체 유사 예시를 pair로 구성하면 달라질 수 있음.
2. **상대/퍼센타일 컷**: H2 고평가는 절대 임계값의 문제가 아니라 스케일의 문제 — 고정 컷 대신
   배경 분포 퍼센타일(예: 무관 문장 분포 상위 α) 기반 상대컷이 적합할 가능성.
3. 위 둘 다 "기법을 다르게 구성/정규화하면 살릴 수 있다"는 가설이며, 그 경우에도 새 사전등록
   (신호/대조군/성공기준/분기 + 모델별 캘리브레이션 절차 명시)을 먼저 작성해야 한다.

## 산출물 목록

- bench/embeddingBench/preregistration.md (+append)
- fixtures/lore-v1.json, fixtures/memory-v1.json, verify-fixtures.ts
- engine.ts, smoke-engine.ts, run-lore.ts, run-memory.ts, run-perf.ts
- results/lore-1787528032904.json, results/memory-1787529022256.json, results/perf-*.json
