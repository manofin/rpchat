# partyBench 사전등록 (preregistration)

- Token: `f9-partybench-prereg`
- Date: `2026-09-01T14:44:36Z`
- HEAD (기준): `v0.0.19-78-g1e827f1-dirty` (`1e827f18c470812c79d022d9c29c71b55165cc7e`; `git -C /home/hermes/rpchat/app describe --tags --always --dirty` + `rev-parse HEAD`). dirty는 이 슬라이스와 무관한 기존 leftover(E-bytes `index.ts`/`adapter.ts`/`chat.ts`/`requestDump.ts` 등). 이후 describe가 바뀌어도 이 줄을 「현재」로 고쳐 쓰지 않는다.
- ADR: `/home/hermes/rpchat/planning_documents/ADR-F9-scene-engine.md` sha256 `0abda90198926867e3b5fc2a64d05c769167f5fcd8f3a9dcc29743950763b882` (디스크 재해시 2026-09-01T14:44:36Z, F9A 기록과 동일). Status accepted (아키텍처만. 제품 채택은 Bench-Latency).
- 범위: **이 파일 1개. 측정 기준 정의만.** `apps/**` 0. 마이그레이션 0. 라이브 DB 0. 벤치 실행 0. `prompt/pickSpeaker.ts` 0. 빈 `0010_*.sql` 0.
- 잠금명 사전 검색 (`f9-partybench-prereg` / `f9-bench-a-router` / `f9-bench-latency`, planning_documents + `app/PROGRESS.md` + `app/bench/**/*.md`, EXIT 1, 0행): 미사용.
- 실행 전 고정. 실행 중 정정은 **append만** (날짜 + 사유). 결과 보고 후 컷 완화·재해석 금지 (F4/E1 전례).

이 파일은 F5·F8을 대체하지 않는다. F9B가 아니다.

---

## 0. 봉인 (2026-09-01T15:22:25Z)

초판의 열린 4항을 사용자 제안으로 닫는다. 결과 보고 후 이 숫자를 완화하지 않는다.

### 0-1 Accuracy — n / 컷

Bench-A의 목적은 Accuracy 점수보다 **Router 구조 검증**. Explicit는 규칙 엔진에 가깝다. Ambiguous는 정답이 흔들려 게이트로 쓰지 않는다.

```text
Bucket A. Explicit Mention     n = 50    cut = 98%
Bucket B. Duty Fitness         n = 50    cut = 90%
Bucket C. Scene Location       n = 50    cut = 85%
Bucket D. Ambiguous            n = 50    cut = 보고용 (pass/fail 미사용)

총 N = 200
```

채택 판정 (Accuracy):

```text
A >= 98%
AND
B >= 90%
AND
C >= 85%
```

D는 보고만. 케이스 정답 정의는 §6.1 (단계 일치 ∧ 주화자 일치).

### 0-2 Reach corpus — 구성 (INPUT)

목표 분포에 맞추려고 측정 후 코퍼스를 다시 섞지 않는다. 아래는 **투입 구성**이지 측정 결과가 아니다.

```text
Reach Corpus

Explicit Mention 50턴
Duty Fitness     30턴
Scene Location   10턴
Ambiguous        10턴

Total 100 turns
```

인간 라벨은 라우터 출력과 독립. 측정 OUTPUT은 라우터가 결정을 끝낸 단계 비율(§6.2). 예: Explicit 61% / Duty 26% / Location 8% / LLM 5% 가 나오면 **그 숫자를 그대로 보고**한다. 목표에 맞게 코퍼스를 재구성하지 않는다. 판정은 OUTPUT에 §6.2 AND를 적용한다.

구성비(INPUT)를 다시 세어 「도달률」로 보고하는 것은 금지.

### 0-3 Bench-Latency 채택선

1콜 바인드 38.08s는 통과선이 아니다. 2콜 산술 ≈76s에 여유만 둔다.

```text
N = 50 turns

p50 <= 90s
p95 <= 120s

Queue depth = 1
Context overflow = 0
```

```text
p50 150s
→ F9 설계 자체 재검토
```

38.08s·76s를 이 컷으로 바꿔 쓰지 않는다.

### 0-4 대표 프롬프트 2개

토큰 상한을 숫자로 발명하지 않는다. 구조만 고정.

**Prompt-A (평균)**

```text
scene
participants 3
recent messages 10
1 main speaker
1 secondary speaker
```

예상 사용량: ~= 실제 평균턴.

**Prompt-B (상한)**

```text
scene
participants 5
compressed cast
recent messages 20
```

예상 사용량: 16K 근접 검증.

본문 문자열은 `f9-bench-latency`가 채운다. 이 잠금에서 프롬프트 전문을 쓰지 않는다.

---

## 1. 이 잠금이 하는 일 / 하지 않는 일

**한다:** Bench-A·Bench-Latency의 신호·격리·도달 분포 목표·재검토 트리거·측정 방법·사후 완화 금지를 이 파일에 못박는다.

**하지 않는다:**

- Bench-A 실행, Bench-Latency 실행, REPORT 작성
- F9B 스키마, `0010_<slug>.sql`, 빈 `0010_.sql`
- `apps/server/**` · `apps/web/**` 수정
- 라이브 generate / 배포 / 재시작
- 기존 6개 대화 행, 서리 `f89ace9b-8684-4d97-96dc-e00c4b25a819`, 카이 `255f96a2-d78e-433d-9169-fb6da6e0963f` (둘 다 SELECT-only, QA 픽스처 아님)
- hosted `임포트테스트` `a5073af0-14b3-4c3f-8750-04d76b547504`를 이 벤치 픽스처로 사용
- Bench-B / Bench-C / Bench-D / Bench-F 실행 (ADR 표는 §12에 인용만)
- `scene_json.time` vs `scene.time` 키 이름 확정 (F9B 착수 시 첫 과제, 현재 결정 보류)

다음 잠금 (사용자 제안, 이 토큰이 아님):

```text
f9-bench-a-router
    ↓
f9-bench-latency
```

침묵은 다음 슬라이스가 아니다.

---

## 2. 권한 모델 (이 벤치가 상태를 쓰지 않는 이유)

F9A 계약 (사용자 정정 2026-09-01, 의역 아님):

```text
Scene State
→ 승인 큐는 타지 않음
→ 모델이 patch/delta 제안
→ 서버 검증
→ 허용 키만 반영
→ 실패 키는 무시
→ 검증 전에는 사실 아님

Model    └─ proposal
Server   └─ authority
State    └─ result
```

`relationship` / `memory` / `summaries.state` 는 계속 승인 게이트 대상이다.

Bench-A와 Bench-Latency는 화자 선택과 지연만 본다. Apply 없음. 장면 필드를 사실로 쓰지 않는다.

---

## 3. 신호 (Signal)

(a) 화자 선택 정확도 — 라벨 픽스처에서 단계와 주화자가 맞는지.
(b) 단계별 도달 분포 — **LLM 도달률을 반드시 포함** (문서 체크 2).
(c) 턴당 실지연 — 콜 #1 + 콜 #2 직렬, 큐 동시성 1, 16K 예산 초과 0.

(a)(b)는 Bench-A. (c)는 Bench-Latency = F9 전체의 채택 게이트.

---

## 4. 대조 / 격리 (Control) — 수정 금지

- 전부 격리 실행. 라이브 DB 읽기 0, 쓰기 0.
- 라우터 1~3단계: 픽스처 위 순수함수. DB 쿼리 0. 선례 `prompt/resolveStory.ts`.
- 4단계: 프롬프트일 뿐. 제품 스키마·마이그레이션 불필요.
- 지연 측정: 대표 크기 프롬프트 2개를 라이브 모델 엔드포인트에 직렬로 던진다. 대화 행 INSERT 없음.
- 큐 동시성 1 (`apps/server/src/model/queue.ts:18`). 라우터도 같은 Gemma-31B (모델은 하나뿐).
- 1:1 `HARD_RULES` 텍스트, `STORY_CHOICES_INSTRUCTION` 불변.
- `conversations.character_id NOT NULL` 유지. 이 벤치가 스키마를 열지 않는다.

---

## 5. 라우터 4단계 (ADR 계약, 이 파일에서 수정 금지)

앞 단계에서 결정되면 뒤로 가지 않는다. LLM은 최후 수단. 출력은 단일 id가 아니라 점수.

| 단계 | 이름 | Bench-A Accuracy 버킷 |
|---|---|---|
| 1 | 명시 호명 | `explicit_name` |
| 2 | 업무 적합성 | `duty_fit` |
| 3 | 장면 위치 | `scene_position` |
| 4 | 모호 → LLM | `ambiguous` |

도달 분포의 4칸은 단계 1·2·3·4이다. Accuracy 버킷 `ambiguous`가 단계 4에 가는 것은 그 버킷의 정상 경로일 수 있다. Reach **구성비(INPUT)** 와 **단계 도달률(OUTPUT)** 을 같은 숫자로 쓰지 않는다 (§0-2).

---

## 6. Bench-A

측정 대상 (ADR §9): 고정 픽스처(명시 호명 / 업무 적합성 / 장면 위치 / 모호)에 라우터만 태워 **정확도 + 단계별 도달 분포**.

게이트 (ADR): 4단계 중 LLM까지 가는 비율이 지연의 직접 원인.

### 6.1 Accuracy corpus

라벨이 있는 픽스처. 케이스마다:

- `expected_stage` ∈ {1,2,3,4}
- `expected_main_speaker_id`
- (예고, 이번 게이트 아님) `forbidden_speakers` — Bench-D 정답 라벨 자리

통과 조건의 **정의** (컷은 §0-1에 봉인):

1. 라우터가 결정을 끝낸 단계 = `expected_stage`
2. 점수 1위 = `expected_main_speaker_id`

둘 다 맞아야 그 케이스 정답. 단계만 맞고 화자가 다르면 오답.

n / 컷: A 50 @ 98%, B 50 @ 90%, C 50 @ 85%, D 50 보고용. 총 N=200. 판정 AND는 A∧B∧C. D는 게이트가 아니다.

Bench-A 보고에 **Fallback Rate** 를 같이 남긴다 (판정 컷 아님, Latency 해석용):

```text
Fallback Rate

1~3단계 해결 %
LLM 도달 %
```

같은 정확도라도 LLM 3%와 35%는 Latency 의미가 다르다.

### 6.2 Reach corpus — 잠긴 목표치

실측이 아니다. 사용자 2026-09-01 제안, 이 잠금에서 사전등록. 사후 완화 금지.

```text
명시 호명     ≥ 50%
업무 적합성   ≥ 30%
장면 위치     ≥ 10%
LLM           ≤ 10%
```

앞 셋은 하한, LLM은 상한. **네 조건 AND.**

정의: Reach corpus에서 라우터가 **그 단계에서 결정을 끝낸** 비율. Accuracy 픽스처 장수 비율이 아니다.

추가 잠금 (같은 날, 같이 고정):

```text
LLM 40~60%
→ Router 재검토
```

이것은 통과선이 아니다. ≤10%를 실패한 뒤 컷을 올려 통과시키는 경로를 닫는다. 실측이 이 구간에 떨어지면 라우터 설계를 다시 본다. F9B 스키마로 도망가지 않는다.

INPUT 구성은 §0-2 (50/30/10/10, N=100). 판정은 이 OUTPUT 네 조건 AND. 측정 후 코퍼스 재구성 금지.

---

## 7. Bench-Latency

측정 대상 (ADR §9): 턴당 실지연(콜 #1 + 콜 #2 직렬, 큐 동시성 1) + 16K 예산 초과 0.

**F9 전체의 채택 게이트.**

고정한 것:

| 항목 | 값 | 성격 |
|---|---|---|
| 1콜 실측 | 38.08s | 바인드. ADR §2 / STATUS.md E-bytes 행, `POST /messages` 2026-08-30 generate. 이 잠금에서 재측정하지 않음 |
| 2콜 산술 | ≈ 76s | 함의. 실측 아님 |
| 3콜 산술 (라우터가 LLM) | ≈ 114s | 함의. 실측 아님 |
| 큐 | 동시성 1 | 디스크 |
| 모델 | 라우터도 같은 Gemma-31B | ADR. 「경량 라우터 = 무료」 가정 금지 (짧은 JSON이어도 prefill은 남음) |
| 예산 | 16K 초과 0 = Context overflow 0 | 게이트. 컷 완화 금지 |
| 표본 | N = 50 turns | §0-3 |
| 채택 컷 | p50 ≤ 90s AND p95 ≤ 120s | §0-3. 38.08s·76s가 이 컷이 아님 |
| 설계 재검토 | p50 150s | F9 설계 자체 재검토. 폴백 잠금과 별개 |
| 대표 프롬프트 | Prompt-A 평균 / Prompt-B 상한 | §0-4 구조. 전문은 latency 잠금 |

탈락 시 폴백 (ADR §8, 사후 발명 아님): STEP1+STEP2를 1콜 2채널 (`display_markdown` + `proposed_state_patch`)로 합친다. 전환은 **새 잠금 이름**. 이 파일에서 폴백 코드를 쓰지 않는다.

실행 순서: ADR → Bench-A → Bench-Latency → F9B → F9E → F9C → F9D → F9F. Bench-A를 건너뛰고 Latency로 채택하지 않는다.

---

## 8. 판정 합산

- Bench-A Accuracy: A≥98% AND B≥90% AND C≥85% (D 보고용, 게이트 아님).
- Bench-A Reach: §6.2 네 조건 AND (OUTPUT). LLM 40~60%면 §9 재검토 분기. Fallback Rate는 보고만.
- Bench-Latency: p50≤90s AND p95≤120s AND Context overflow 0. N=50. Queue depth 1.
- 제품 채택: Bench-Latency 통과 후에만. 아키텍처 ADR accepted와 제품 채택은 별개 (F9A).

비채택도 정상 결과. 더 좋은 숫자가 나오도록 픽스처·컷을 실행 후 고치지 않는다.

---

## 9. 분기 (Branch)

- Accuracy 실패 → `f9-bench-a-router` 이후 F9C 착수 금지. 컷 완화 금지.
- Reach LLM > 10% → 분포 목표 실패. 40~60%면 Router 재검토 (설계를 다시). F9B로 진행 금지.
- Latency 실패 (p50>90s 또는 p95>120s 또는 overflow>0) → F9 비채택. 폴백은 새 잠금. 임계를 낮춰 통과시키지 않음.
- Latency p50 150s → F9 설계 자체 재검토 (폴백 잠금과 별개).
- 실행 자체 실패 (엔드포인트 무응답, 픽스처 스키마 붕괴) → **벤치 무효**. 결과 해석 금지.
- `scene_json.time`(기존 문자열 6필드) vs `scene.time`(시계) — 이 벤치 범위 밖. 기존 6필드 유지. 시계 키 이름은 F9B가 확정.

---

## 10. 픽스처 스키마 (텍스트는 다음 잠금, 모양만)

Accuracy 케이스:

```json
{
  "id": "A01",
  "bucket": "explicit_name|duty_fit|scene_position|ambiguous",
  "expected_stage": 1,
  "expected_main_speaker_id": "npc_main",
  "forbidden_speakers": ["npc_bg_1"],
  "user_text": "",
  "scene": {},
  "cast": []
}
```

- `user_text` / `scene` / `cast` 본문은 이 잠금에서 채우지 않는다.
- id는 합성 토큰. 라이브 캐릭터 UUID 금지. 서리·카이·`09e7827f`(방) 금지.
- ADR 예시 이름(한소연/유키)은 문서 설명용이다. 라이브 행이 아니다.

raw 결과 위치 (다음 잠금이 만듦, 이번 아님): `app/bench/partyBench/results/<run-id>.json`.

---

## 11. Bench-B / C / D / F (인용만, 이 잠금 밖)

| 벤치 | 측정 대상 | 게이트 |
|---|---|---|
| Bench-B | 10 / 20 / 50턴 후 장면·퀘스트·역할 유지 | PRD §6 long-rp-fixtures-v1 미고정. 야간 |
| Bench-C | 한소연 말투가 유키 말투로 오염되는가 | 문체 지표 + 사람 판정 |
| Bench-D | 이 턴에 발화하면 안 되는 인물 | 배경 NPC 발화 0, 보조 ≤2 |
| Bench-F | A-6 표 각 행 | 정책이 문서에만 있으면 미채택 |

실행 금지. 별도 잠금.

---

## Append log

- 초판 `2026-09-01T14:44:36Z`, token `f9-partybench-prereg`. 사용자 잠금 범위 = 이 파일 + 측정 기준 정의만. 도달 분포 50/30/10/≤10 및 LLM 40~60% → Router 재검토를 잠금. Accuracy n/N, Reach corpus 구성, Latency 컷 초, 대표 프롬프트 크기는 당시 §0.
- `2026-09-01T15:22:25Z` §0 봉인 (사용자 제안, 사후 완화 금지). Accuracy A50/98 B50/90 C50/85 D50 보고용 N=200. Reach INPUT 50/30/10/10 N=100, OUTPUT은 그대로 보고·재구성 금지. Latency N=50 p50≤90s p95≤120s overflow 0, p50 150s면 설계 재검토. Prompt-A/B 구조만. Fallback Rate는 Bench-A 보고 필드(컷 아님). 헤더 Date/HEAD 미재바인드. Bench-A 실행 아님.
