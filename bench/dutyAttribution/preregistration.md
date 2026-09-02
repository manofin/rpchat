# f9-duty-attribution-eval 사전등록 (preregistration)

- Token: `f9-duty-attribution-eval`
- Date: 2026-09-02T11:00:00Z
- HEAD (기준): `v0.0.19-78-g1e827f1-dirty` (`1e827f18c470812c79d022d9c29c71b55165cc7e`)
- 선행 (전부 무수정):
  - `../triggerSupply/preregistration.md` `8ed4dce00a7419cb…` → `INSUFFICIENT_A`
  - `../triggerSupply/preregistration-aprime.md` `da3cd78c2e8993a1…` → `INSUFFICIENT`, 주화자 재선택 32/32
  - `../triggerSupply/preregistration-candidate.md` `c4340d05153b7194…` → `INCONCLUSIVE`, C-2 `recall_T 0.700` / `fp_N 1.000`
- 범위: **측정만.** `apps/**` 0. 마이그레이션 0. 라이브 DB 쓰기 0. 배포·재시작 0. 제품 프롬프트·게이트·`pickSpeaker` 0.
- 실행 전 고정. 정정은 append만. **결과 보고 후 컷 완화·재해석 금지.**

Token 3(지연)·Token 4(F9C)를 열지 않는다. B2(관련성 규칙 엔진)를 채택하지 않는다.

---

## 1. 주가설 H1

> 닫힌 비주화자 후보에 대해 모델이 생성한 개입 사유가 **해당 후보의 실제 속성에 귀속되는지** 서버가 검증하면,
> 무관 후보 승인은 감소하고 정답 secondary의 recall은 실질적으로 유지된다.

부수 질문:

```
Q1. 모델의 정답 신호가 새 데이터에서도 존재하는가       → L0(검사 없음) recall로 답한다
Q2. 귀속 검사가 오귀속만 선택적으로 제거하는가            → L1~L3 비교로 답한다
```

## 2. 과적합 차단 (이 사전등록의 존재 이유)

직전 백테스트(`fp_N 1.00 → 0.00`, recall 유지)는 **규칙을 만들게 한 그 데이터로 규칙을 평가한 것**이라 성능 주장이 성립하지 않는다. 따라서:

- **캐스트를 전부 교체한다.** 한소연·유키·직원B를 쓰지 않는다.
- **사건 문장을 전부 새로 쓴다.** `triggerSupply/fixtures.ts`를 재사용하지 않는다.
- `duties=[]`로 갈리는 사례에 의존하지 않는다. 아래 8유형을 의도적으로 심는다.
- 규칙을 표면 형태(`부분문자열 없으면 reject`)가 아니라 **층(L1/L2/L3)**으로 사전등록하고 층별 성능을 따로 본다.

## 3. 반드시 포함하는 후보 유형

| 유형 | 내용 | 이 유형이 검출하는 것 |
|---|---|---|
| A | 직무 있으나 사건과 무관 | 공란 제거 규칙의 한계 |
| B | 어휘만 겹치고 의미는 다름 | 부분문자열 매칭의 오탐 |
| C | 부정어 포함(“권한 없음”) | 단어 경계·부정 처리 |
| D | 주화자와 유사 직무 | 관련성≠독립 개입 근거 |
| E | 직무 없으나 정당(유일 목격자) | **`duties=[] → reject` 과적합 검출** |
| F | 관계 기반(보호자·동료) | DUTY 외 귀속 출처 |
| G | 현재 행동 기반(이미 경보 조작 중) | DUTY 외 귀속 출처 |
| H | 관련 직무 있으나 주화자가 이미 충분히 답함 | relevance ≠ 슬롯 필요성 |

E·F·G는 **정답 쪽**이다. 이들이 체계적으로 탈락하면 H1은 기각이다.

## 4. 픽스처

신규 캐스트 8명 + 신규 사건. 각 시나리오 = (사건 문장, 주화자, 닫힌 후보 3~4명, 정답 라벨).

```
T 시나리오 20개 : 정당한 secondary가 정확히 1명 존재 (정답 유형: DUTY / E / F / G 섞음)
N 시나리오 20개 : 정당한 secondary가 0명 (유형 A·B·C·D·H 방해자만)
```

총 모델 콜 = **40** (시나리오당 1콜, 후보 전원 일괄 판정). temperature 0.2 / top_p 0.9 / max_tokens 400.
후보 수준 판정은 약 140건.

프롬프트는 C-2 형태(닫힌 후보 + 후보별 approve/reject + reason)를 그대로 쓴다 — 그것이 유일하게 신호를 낸 형태이기 때문이다. `NONE` 선택지는 주지 않는다(C-2에서 실패).

## 5. 귀속 검사 층 (사후에 적용. 모델 호출은 1회)

같은 모델 출력에 네 수준을 각각 적용하고 지표를 층별로 낸다.

```
L0  검사 없음                     = 모델 승인 그대로 (기준선, Q1 답)
L1  단순 부분문자열 겹침           = 백테스트가 쓴 그 규칙
L2  단어경계 + 부정어 처리          = "권한 없음"을 겹침으로 세지 않음
L3  구조화 속성 범주 일치           = reason이 후보의 어느 속성 필드에 귀속되는지
```

L3의 허용 귀속 출처:

```
DUTY · AUTHORITY · RELATIONSHIP · EXCLUSIVE_KNOWLEDGE · CURRENT_ACTION · DIRECT_ADDRESS · DIRECT_OBSERVATION
```

모든 층에 공통으로 **층 1 결정론적 불변조건**(주화자 아님 / 참석 / 배경 아님 / 후보 집합 내 id)을 먼저 적용한다. 이 부분은 의미 판단이 아니다.

## 6. 지표 (층별)

```
correct_secondary_recall_T
fp_N                         N에서 아무나 승인한 비율
no_approval_rate_N           N에서 승인 0명 (합법 침묵)
irrelevant_candidate_approval_rate
false_silence_rate_T         정답을 침묵시킨 비율
nonduty_legit_retention      E·F·G 정답 유지율   ← 과적합 검출 축
type_pass_rate[A..H]         유형별 통과율
primary_reselection_rate / unknown_candidate_rate / malformed_rate
```

**해석 조건 (앞선 교훈 승계)**: `fp_N`은 해당 층의 총 승인 > 0이고 `correct_secondary_recall_T > 0`일 때만 판정에 쓴다.
귀속 검사가 전부를 침묵시켜 `fp_N`을 얻는 것을 막기 위해 recall 하한을 함께 건다.

## 7. 판정 (실행 전 고정)

```
Q1_SIGNAL_PRESENT : L0 correct_secondary_recall_T >= 0.50
Q1_ABSENT         : L0 correct_secondary_recall_T < 0.30      → 이 경우 H1은 평가 불가(INSUFFICIENT)

SUPPORT_H1 : 어떤 층 L ∈ {L1,L2,L3} 가 전부 충족
   - irrelevant_candidate_approval_rate 가 L0 대비 50% 이상 감소
   - fp_N 이 L0 대비 50% 이상 감소
   - correct_secondary_recall_T 손실이 L0 대비 절대 0.15 이하
   - nonduty_legit_retention >= 0.50        ← E·F·G가 살아남아야 함

REJECT_H1  : 어떤 층도 위를 만족하지 못하고, 다음 중 하나가 성립
   - fp를 줄인 모든 층에서 recall 손실 > 0.15
   - 직무 있는 무관 후보(A·B·C·D)가 계속 통과
   - nonduty_legit_retention < 0.25         ← duties=[] 과적합 확인

INSUFFICIENT  : L0 recall < 0.30 이거나, 유효 승인 표본 부족, 실행 실패
INCONCLUSIVE  : 그 외 (fp는 줄었으나 recall도 크게 감소 / 특정 유형에서만 효과 / L1과 L3 효과 분리 불가)
```

`SUPPORT_H1`도 **제품 채택이 아니라 후속 설계 후보로 검토할 근거**다.

## 8. 격리

라이브 DB `readonly` 읽기만(실제로는 캐스트를 새로 만들므로 DB 조회도 하지 않는다). 모델 추론만.
결과는 `bench/dutyAttribution/results/<ISO>.json`, sha256 보고.
`triggerSupply/**` 전부 무수정.

## 9. 한계 (실행 전 기록)

- **독립 블라인드 라벨이 없다.** 정답 라벨·후보 속성·사건 문장을 전부 저자(Claude)가 작성했다.
  §3의 유형 배치도 저자 의도이므로, 이 측정은 **저자가 설계한 반례에 대한 성능**이지 실사용 분포가 아니다.
- 귀속 검사 L1~L3도 저자 구현이다. L3의 범주 매핑은 규칙 엔진의 축소판이며 B2와 경계가 얇다.
  본 측정은 B2를 채택하지 않으며, L3가 이겨도 그것은 측정 사실이다.
- 단일 모델, 온도 0.2, 1회 실행. 40 시나리오는 소표본이고 유형별로는 더 작다.
- H4(서버 기본 침묵)는 측정하지 않는다. 본 측정은 검사 층의 선택성만 본다.
- 이전 백테스트 수치(`fp_N 1.00→0.00`)는 **비교 대상이 아니다.** 데이터·캐스트가 다르다.
