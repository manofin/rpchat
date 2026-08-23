# P3 임베딩 벤치 사전등록 (preregistration)

> 실행 전 고정. 실행 중 정정은 append만 (날짜 + 사유 명시). 상위 계획:
> `/home/hermes/.hermes/plans/2026-08-23_224435-rpchat-p3-embedding-bench.md`
> 2026-08-23 사용자 승인 (피드백 3건 반영 완료, §0/§2/§6 정정 포함).

## 1. 신호 (Signal)
(a) 키워드/2차키워드+FTS5 기준선과 임베딩 후보의 품질 격차가 실제로 존재하는지.
(b) 그 격차가 Mac 자원 예산(M3 Ultra 96GB) 안에서 유지되는지.

## 2. 대조군 (Control) — 수정 금지
- `loreEntryActive` — `apps/server/src/prompt/loreMatch.ts` 컴파일 재사용 (1차+2차 selective).
- `classify` — `apps/server/src/memory/conflict.ts` 컴파일 재사용 (bigram 자카드 CAL_CUT=0.35,
  conflict-suppressed XOR baseline: conflict 도달 시 kind='new' + reason='conflict-suppressed').

## 3. 임베딩 후보
| 후보 | 모델 | 비고 |
|---|---|---|
| H1 | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (ONNX) | 384차원, 다국어 |
| H2 | `Xenova/multilingual-e5-small` (ONNX) | 384차원, multilingual 계열 |

**H2 선정 근거 (2026-08-23 피드백 반영)**: 구안 `BAAI/bge-small-zh-v1.5`는 중국어 특화로
한국어 픽스처에서 "언어 불일치"와 "기법 한계"를 구분할 수 없어 폐기. H2는 한국어를 커버하는
multilingual 모델로 교체해 교차검증의 전제(언어 적합성)를 확보.
**e5 접두어 규약**: 어댑터에서 로어 엔트리 본문 = `passage: `, 판정 대상 문장 = `query: `
접두어 부착을 실행 전 고정. H1은 접두어 없음.

모델 sha256은 다운로드 직후 기록 (`~/.cache/rpchat-embed/`). ONNX 가용성 실패 시 §6 분기.

## 4. 성공 기준 (채택 필요조건 — 판정컷 θ=0.70 기준, H1·H2 각각)
1. **로어**: must_not_fire false-trigger **0/10**, AND 기존 오발동 3건 미발동 유지, AND 애매 5케이스
   ambiguous top-1 hit ≥ 50% (≥3/5), AND 진양성(must_fire 10) 발동 유지.
   임베딩 게이트식: `cos(문장, entry 본문) ≥ θ` AND (keyword OR secondary OR always_on).
2. **기억**: duplicate precision/recall이 baseline(자카드 0.35) 이상 수준 유지, conflict recall
   **≥ 3/5** (baseline 0), complement → conflict 오탐 **0**.
3. **성능**: idle RSS ≤ 8GB, 100문장 인코딩 ≤ 30s, Gemma `:8083` health 응답 지연 변화 ≤ 20%
   (동시실행 시; 분리 프로세스면 구조상 0으로 기록).

## 5. 판정 합산 규칙 (사전등록 명문화 — 2026-08-23 사용자 피드백 반영)
- **θ 규칙**: **θ=0.70을 유일한 채택 판정 컷으로 사전 지정**. 0.65/0.75는 민감도 참고자료로만
  측정·보고하며 판정에 사용 금지. θ=0.70 통과인데 인접 컷에서 급반전 시 REPORT에 "fragility"로
  기록하되 판정에는 영향 없음. 결과 확인 후 컷 변경·재해석 금지 (사후선택 차단).
- **H1·H2 합산**: 채택 필요조건 = **H1과 H2 각각이 위 성공 기준 1~3 전부 충족**.
  한 후보만 통과하고 다른 하나가 실패하면 → **비채택** (근거: 판정 대상은 "모델"이 아니라
  "임베딩 기법 자체"이므로 후보 간 분열 = 기법 강건성 미확보). 분열 발생 시 REPORT.md에
  어느 조건에서 갈렸는지 raw와 함께 상세 기재.
- **비채택도 정상 결과**: 규칙 천장 확인 = 근거 확보 = PRD 순서 7 종료. 규칙 완화 금지 —
  더 좋은 결과가 나오도록 픽스처/컷 조정 금지.

## 6. 분기 (Branch)
- 성공기준 3개 중 1개라도 불충족(합산규칙 §5 적용) → **비채택**. REPORT 작성,
  `conflict.ts`/`loreMatch.ts` 미변경, P3 종료, B군 "로어 의미 발동"도 닫힘.
- 전부 충족 → **채택 후보**. 실제 주입은 별도 ADR + 다음 슬라이스 (본 벤치 범위 외).
- 엔진 실행 자체가 실패(onnxruntime-node 빌드 실패, 모델 다운로드 차단, 특히
  `Xenova/multilingual-e5-small` ONNX 가용성 부재) → **벤치 무효 선언**, 결과 해석 금지, 재시도.
  H2를 `Xenova/paraphrase-multilingual-mpnet-base-v2`(또는 동등 multilingual small)로 교체하는 경우
  **사전등록 파일에 append로 정정**(모델명·근거·sha256)한 뒤에만 진행. 조용한 교체 금지.

## 7. 픽스처 스키마 (Task 1에서 생성)
### lore-v1.json — 25케이스
분할: 필수 발동 10 (진양성 예문 + 2차키워드 의존), 필수 미발동 10 (오발동 3계열: '다리'=신체·'소리'=일반청각 등 + 동음이의·일반어), 애매 5 (키워드 없음 + 의미 일치).
```json
{ "id": "L01", "entryId": "<lore id>", "text": "…", "label": "must_fire|must_not_fire|ambiguous" }
```
`_meta`: `{ lore_snapshot_sha, date, source: 'live DB read', db_path }`. 스냅샷은 벤치 실행 시점에
`SELECT id, title, keywords_json, secondary_keys_json, always_on FROM lore_entries WHERE enabled=1`
1회 읽기(읽기 전용) 후 고정.
### memory-v1.json — 20쌍
new 5 / duplicate 5 / complement 3 / conflict 5 (XOR-suppressed 유형 3 + XOR 미탐 유형 2) / transient 2.
```json
{ "id": "M01", "cand": "…", "existing": "…", "existingId": "synthetic-N", "label": "new|duplicate|complement|conflict|transient" }
```
인공 픽스처 한계 고지: 실 라이브 기억 6행과 분포 상이 가능. 실데이터 검증은 주입 단계(프라이버시 원칙상 본 벤치에서 안 함).

## 8. 측정 스크립트 계약
- `run-lore.ts` / `run-memory.ts` / `run-perf.ts` — `--engine H1|H2|all`, raw JSON stdout →
  `bench/embeddingBench/results/<run-id>.json`, `process.exitCode` 설정.
- 코사인 유사도는 harness 내부 계산 (엔진은 L2-normalized 벡터만 반환 — 재현 가능성).
- baseline 측정에는 라이브 코드 그대로 import (tsx).

## 9. 경계
- 라이브 무접촉: DB 쓰기 없음, `apps/server/src/**` 수정 없음, `systemctl --user rpchat` 재시작 없음.
- Gemma 호출 자체는 하지 않음 (health + 동시 RSS만).
- git remote 없음(의도), 태그는 벤치 통과 전 부여하지 않음. 각 Task별 커밋 `bench(p3-embed): <task>`.

---
## Append log
- (초판 2026-08-23, Task 0. 정정 시 아래에 append)

---
## Append 2026-08-23T23:5x — 성공기준 1번 정정 (must_fire_recall 누락)
- 사유: Task 3 실행 후 확인된 사전등록 결함. §4-1(=계획 승인본 §0 성공기준1)이
  "오발동 억제 + 애매 재현율"만 규정하고 **must_fire_recall이 baseline(10/10) 대비 회귀 없음**
  조건을 누락. 이 누락으로 H1의 "전혀 발동하지 않음" 실패가 문구상 통과처럼 보일 뻔함.
- **추가 조건**: 성공기준 1은 다음을 포함한다 — **AND must_fire_recall ≥ baseline 수준 (10/10 유지, 회귀 없음)**.
- 적용 방식: 재실행 없음. 기존 results/lore-1787528032904.json raw로만 재평가.
- 판정 영향: H1 must_fire 0/10 → 불충족. H2 false_trigger 10/10 → 불충족(기존 조건).
  **H1·H2 둘 다 성공기준 1 불충족 → 합산규칙(§5, 둘 다 전부 충족 시에만 채택)에 따라 비채택 확정.**
- 명시: 게이트식(cos≥θ AND keyword)과 baseline 설정은 변경하지 않는다. 옵션(a)/(b) 재설계·재실행은
  하지 않는다 — 결과를 바꾸기 위한 규칙 변경은 §5 사후편향 금지와 충돌한다.
