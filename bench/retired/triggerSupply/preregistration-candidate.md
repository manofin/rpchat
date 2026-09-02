# f9-aux-candidate-supply-eval 사전등록 (preregistration)

- Token: `f9-aux-candidate-supply-eval`
- Date: 2026-09-02T09:15:00Z
- HEAD (기준): `v0.0.19-78-g1e827f1-dirty` (`1e827f18c470812c79d022d9c29c71b55165cc7e`)
- 선행:
  - `preregistration.md` (`f9-trigger-supply-a-eval`, sha256 `8ed4dce00a7419cbc55e11c6b6083118a22bc7b1b7d148d33605024e623f2e1d`) → `INSUFFICIENT_A`, `recall_T 0.000`, 트리거 0건
  - `preregistration-aprime.md` (`f9-trigger-supply-aprime-eval`, sha256 `da3cd78c2e8993a1cb303909e8dd7720c95ebf883afc5fd5796c53d38c556738`) → `INSUFFICIENT`, 키 40/40, A′-2 트리거 32건 **전부 주화자 지목**, `recall_T 0.000`
  이 두 파일과 그 결과 파일을 수정하지 않는다.
- 범위: **측정만.** `apps/**` 0. 마이그레이션 0. 라이브 DB 쓰기 0. 배포·재시작 0.
  제품 프롬프트·게이트·`pickSpeaker` 변경 0 — 변형은 벤치 안에서만 만든다.
- 실행 전 고정. 정정은 append만. **결과 보고 후 컷 완화·재해석 금지.**

이 파일은 B / B1 / B2 / 혼합안을 **채택하지 않는다.** Token 3(지연)·Token 4(F9C)를 열지 않는다.

---

## 1. 측정하는 질문

A′-2의 실패는 키 미사용이 아니라 **주화자 재선택**이었다(32/32). 가설은 두 가지이고, 이 측정이 가르는 것은 그 둘이다.

- **H1 (얇은 정보 부족)**: 모델에게 **주화자가 누구인지** 알려주기만 하면 주화자 재선택이 사라진다.
- **H2 (열린 질문 자체가 문제)**: 주화자를 알려줘도 열린 이름 생성이면 실패하고, **닫힌 후보 집합 + 후보별 판정**이라야 한다.

## 2. 측정 대상 범위 (B1까지. B2는 측정하지 않음)

후보 공급은 **구조적 열거만** 한다:

```
현재 참석 AND 주화자 아님 AND 배경 역할 아님
```

duty·장소·위험도로 **관련성을 걸러내지 않는다.** 그 필터링(B2)은 `role_relevant` v1에서 제외하기로 한 규칙 엔진 성격이므로 이 잠금에서 열지 않는다.
서버가 올리지 않은 인물은 모델이 승인할 수 없다는 구조적 상한도 그대로 둔다 — 본 측정은 그 상한을 없애려는 것이 아니라, 상한 안에서 판정이 안정적인지만 본다.

## 3. 변형 (프롬프트만 다름. 벤치 안에서만 구성)

| 변형 | 모델에게 주는 것 | 출력 형태 |
|---|---|---|
| **C-1** | A′-2 문구 + **`primary_speaker` 명시** + "주화자는 후보가 아니다" | 기존 `secondary_triggers`(열린 이름 배열) |
| **C-2** | C-1 + **닫힌 후보 목록**(id·이름·직무) | 후보별 `candidate_decisions`(approve/reject + reason) |

기준선은 동결된 A(`recall_T 0.000`, 트리거 0)와 A′-2(`recall_T 0.000`, 주화자 재선택 32/32)다. 재실행하지 않는다.

## 4. 픽스처

동일한 **T20 / N20**(`fixtures.ts`, 수정 금지). 유효성 필터(주화자=한소연) 40/40 통과 기확인.

**벤치 로컬 캐스트 확장.** 라이브 캐스트는 한소연·유키 2명뿐이라 후보 집합이 1명이 되고, 그러면 C-2의
`primary_reselection_rate`는 구조적으로 0이 되어 정보가 없다. 따라서 벤치 안에서만 세 번째 인물
**`직원B`**(secondary, 참석, duty 없음)를 추가한다. 라이브 DB에는 쓰지 않는다.
이로써 후보 집합 = {유키, 직원B}가 되고, `직원B` 승인 여부가 무분별 승인의 지표가 된다.

총 콜 = 2 변형 × 40 = **80**. temperature 0.2 / top_p 0.9 / max_tokens 300(C-2는 후보별 판정이라 A′보다 여유).

## 5. 지표

변형별:

- `primary_reselection_rate` = 주화자(한소연)를 지목·승인한 비율 / 40 ← **A′-2의 32/32와 직접 비교되는 축**
- `recall_T` = T에서 **유키**를 승인한 비율 / 20
- `fp_N` = N에서 아무나 승인한 비율 / 20
- `irrelevant_approval_rate` = `직원B`(duty 없음) 승인 비율 / 40
- `unknown_candidate_rate` = 후보 집합에 없는 이름을 낸 비율 / 40
- `malformed` = JSON 파싱 실패 + 형식 위반 / 40
- `base_version_ok` / 40

**`fp_N` 해석 규칙 (A의 설계 결함 교정 승계).** 승인 총량이 0이면 `fp_N`은 기계적으로 0이 되어 판별력이 없다.
따라서 **총 승인 수 > 0일 때만** 판정에 쓰고, 아니면 `UNINTERPRETABLE`로 보고하고 ADOPT 판정에서 제외한다.

## 6. 판정 (실행 전 고정)

두 변형 중 하나라도 충족하면 그 변형 이름과 함께:

```
ADOPT_SUPPLY   : recall_T >= 0.60  AND  primary_reselection_rate <= 0.05
                 AND  malformed <= 0.10  AND  unknown_candidate_rate <= 0.05
                 AND (fp_N <= 0.20  OR  fp_N == UNINTERPRETABLE)
INSUFFICIENT   : max(recall_T) < 0.30
INCONCLUSIVE   : 그 사이
```

**가설 판정(별도, 컷 아님)** — `primary_reselection_rate`로 H1/H2를 가른다:

```
C-1에서 이미 0에 가깝다        → H1 지지 (주화자만 알려주면 됨)
C-1은 높고 C-2에서만 떨어진다  → H2 지지 (닫힌 후보 집합이 필요)
둘 다 높다                     → 둘 다 부족. 원인은 이 측정 밖
```

`base_version_ok < 0.95`이면 판정과 무관하게 회귀 경고로 보고한다.

## 7. 격리

라이브 DB `readonly` 읽기만. 모델 추론만. 결과는 `bench/triggerSupply/results/candidate-<ISO>.json`에 기록하고 sha256을 보고한다.
`fixtures.ts`·기존 사전등록·기존 결과 파일 수정 0.

## 8. 한계 (실행 전 기록)

- 앞선 두 사전등록의 §7/§8 한계 전부 승계: 단일 모델, 온도 0.2 1회 실행, 저자 작성 픽스처, 독립 라벨 없음.
- `직원B`는 벤치 로컬 가공 인물이다. 라이브 캐스트가 아니므로 실사용 분포를 대표하지 않는다.
- 후보 집합이 2명이라 소규모다. 후보가 많아질 때의 거동은 측정하지 않는다.
- C-2의 출력 형태는 현행 제품 계약(`secondary_triggers`)과 다르다. **ADOPT가 나와도 채택이 아니라 측정 사실이며**, 제품 반영은 새 이름이 필요하다.
- 본 측정은 B2(관련성 규칙 엔진)의 필요 여부를 답하지 않는다.
