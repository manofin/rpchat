# f9-intervention-necessity-eval 사전등록 (preregistration)

- Token: `f9-intervention-necessity-eval`
- Date: 2026-09-02T11:30:00Z
- HEAD (기준): `v0.0.19-78-g1e827f1-dirty` (`1e827f18c470812c79d022d9c29c71b55165cc7e`)
- 선행 (전부 무수정):
  - `../triggerSupply/preregistration*.md` → `INSUFFICIENT_A` / `INSUFFICIENT` / `INCONCLUSIVE`
  - `../dutyAttribution/preregistration.md` `2bac3a1310d70269…` → `INCONCLUSIVE`, `Q1_SIGNAL_PRESENT`(L0 recall 1.00), L1 홀드아웃 붕괴(recall 0.25, E·F·G 0.00)
- 범위: **측정만.** `apps/**` 0. 마이그레이션 0. 라이브 DB 쓰기 0. 배포·재시작 0. 제품 프롬프트·게이트·`pickSpeaker` 0.
- 실행 전 고정. 정정은 append만. **결과 보고 후 컷 완화·재해석 금지.**

Token 3(지연)·Token 4(F9C) 미개방. B2 미채택. 제품 반영은 어떤 결과에서도 새 이름이 필요하다.

---

## 1. 이 측정이 존재하는 이유

`f9-duty-attribution-eval`이 남긴 병목은 귀속이 아니다. N에서 승인된 17건의 근거는 **전부 그 후보의 실제 속성**이었다:

```
[N01 B] "신규 직원 등록 관리를 담당하므로 출입 승인 절차에 대한 직무상 지식이 있음"
[N02 D] "연구동 운영 보조 직무로서 운영 시간 정보를 제공할 책임이 있음"
```

정확한 귀속 + 과한 결론이다. 따라서 남은 축은 **증분 개입 필요성**이다:

> 그 후보에게 관련 근거가 있다는 사실이, **이번 턴에 주화자 뒤에 한 마디가 더 필요하다**는 것을 뜻하는가.

## 2. 확정된 사실 (원본 JSON 재집계, 이 사전등록의 전제)

```
장면당 승인 수 (L0)   T: {1:20}     N: {0:3, 1:17}
T 방해자 승인          0/20
비정답 승인 17건       전부 N, 실패 장면당 정확히 1명
모델 출력 스키마       score 없음 (claim_type / reason 만)
```

귀결:

- 모델은 후보를 독립 심사하지 않고 **장면당 슬롯 1개를 채운다**(pick-one).
- 따라서 **`K=1` 상한은 기대 효과 0**이다. 이 측정에서 평가하지 않는다.
- 점수 컷(τ)·마진(δ)은 **모델이 점수를 내야 성립**한다. 현재 미측정.

## 3. 주가설 H5

> 모델은 후보의 관련 근거는 안정적으로 찾지만(선행 측정 recall 1.00),
> **주화자의 응답이 이미 충분한지 여부**에 따라 승인을 바꾸지 못한다.

즉 승인은 `관련성`의 함수이고 `증분 필요성`의 함수가 아니다.

## 4. 설계: 짝지은 대조 (paired contrast)

이 가설은 **같은 후보·같은 사건**에서 주화자 응답만 바꿔야 분리된다.

```
조건 SUFFICIENT   : 주화자가 그 논점을 이미 완전히 답함 → 정답은 침묵
조건 INSUFFICIENT : 주화자가 그 논점을 남겨둠           → 정답은 그 후보 승인
```

두 조건은 **후보 명단·속성·사건 문장이 1바이트도 다르지 않고**, 주화자의 직전 대사만 다르다.
따라서 승인 차이는 오직 증분 필요성에서만 나온다.

핵심 지표:

```
necessity_discrimination = approve_rate(INSUFFICIENT) - approve_rate(SUFFICIENT)
```

0에 가까우면 H5 지지(= 모델은 필요성을 보지 않는다). 크면 H5 기각.

## 5. 변형 (프롬프트만 다름. 벤치 안에서만)

| 변형 | 형태 |
|---|---|
| **V1** | 선행 측정과 같은 후보별 approve/reject + 주화자 직전 대사 제공 |
| **V2** | **장면 선행 이진**: 먼저 `extra_needed: yes/no`를 묻고, yes일 때만 누구인지 답하게 함 |

V2는 §2에서 닫힌 `K=1` 대신 열려 있던 항목("장면 선행 이진 결정")을 직접 잰다.
`NONE` 선택지는 V1에 주지 않는다(C-2에서 실패). V2의 `no`는 선택지가 아니라 **질문 순서**로 얻는다.

## 6. 픽스처

`dutyAttribution/fixtures.ts`의 캐스트·사건을 **재사용**한다. 홀드아웃 성격은 이미 소진됐지만,
이 측정의 대조는 픽스처 신규성이 아니라 **조건 간 차이**에서 나오므로 재사용이 타당하다.
새로 만드는 것은 주화자 대사 2종뿐이다.

```
쌍 20개 = dutyAttribution의 T 시나리오 20개
각 쌍마다 SUFFICIENT / INSUFFICIENT 2조건
변형 2개(V1/V2)
총 모델 콜 = 20 × 2 × 2 = 80
```

temperature 0.2 / top_p 0.9 / max_tokens 400.

## 7. 지표

```
necessity_discrimination            변형별. 주지표
approve_rate_SUFFICIENT             낮아야 정상
approve_rate_INSUFFICIENT           높아야 정상
correct_target_rate_INSUFFICIENT    승인했을 때 정답 후보를 골랐는가
extra_needed_yes_rate (V2 전용)     선행 이진의 yes 비율. 조건별로
flip_rate                           같은 쌍에서 조건에 따라 답이 바뀐 비율
malformed_rate / unknown_candidate_rate / primary_reselection_rate
```

**해석 조건 (승계)**: `approve_rate_SUFFICIENT`가 낮다는 것만으로 성공이라 하지 않는다.
`approve_rate_INSUFFICIENT`가 충분히 높아야 한다. 전부 침묵시키면 discrimination도 0이다.

## 8. 판정 (실행 전 고정)

```
H5_SUPPORTED  (= 모델은 필요성을 못 봄)
    두 변형 모두 necessity_discrimination < 0.20

H5_REJECTED   (= 모델이 필요성을 봄)
    어떤 변형이 necessity_discrimination >= 0.40
    AND approve_rate_INSUFFICIENT >= 0.60
    AND approve_rate_SUFFICIENT <= 0.30

INCONCLUSIVE  그 사이 / 한 변형만 충족 / INSUFFICIENT 승인율이 낮아 대조가 성립 안 함
INSUFFICIENT  malformed > 0.10 또는 실행 실패
```

`H5_REJECTED`가 나오면 그 변형은 **증분 필요성을 물을 수 있는 형태**라는 측정 사실이 된다 — 채택은 아니다.
`H5_SUPPORTED`가 나오면 필요성은 이 프롬프트 계열로 접근 불가이고, 다음 축은 프롬프트 밖(서버 상태·대사 대조 등)에 있다.

## 9. 한계 (실행 전 기록)

- 독립 블라인드 라벨 없음. 사건·속성·주화자 대사 2종·정답 라벨 전부 저자 작성.
- 주화자 대사는 저자가 "충분/불충분"을 의도해 쓴 것이다. 그 의도가 사람이 보기에도 그런지 검증되지 않았다.
- 픽스처 재사용이므로 `dutyAttribution` 결과와 독립이 아니다. 이 측정은 **조건 간 대조**만 주장하고, 절대 성능을 주장하지 않는다.
- 단일 모델, 온도 0.2, 1회 실행, 쌍 20개는 소표본.
- V2의 선행 이진은 실험 조작이며 제품 출력 계약 제안이 아니다.
