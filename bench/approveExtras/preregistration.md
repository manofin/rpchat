# f9-extra-approve — τ 사전등록 (실행 아님, 상수 봉인)

- Token: `f9-extra-approve`
- Date: 2026-09-02
- 계약: `Notes_260902_210901.txt` §4.3
- 범위: **상수 봉인만.** 측정 실행 0. 모델 콜 0. 라이브 DB 0. 이 파일은 product code가
  import하지 않는다 — 닿을 수 있는 상수는 조용히 재조정할 수 있는 상수이기 때문이다.

## 1. 이 파일이 존재하는 이유

`approveExtras.ts`의 `EXTRA_SCORE_ENABLED = false`는 출하 기본값이다. 노트 §4 파이프라인
4단계(「extra 신호 — 모델(선택)」)를 켜려면 임계값이 **먼저** 고정돼 있어야 한다.
F4/E1 전례가 같은 실패를 두 번 보여줬다: 결과를 본 뒤 컷을 완화하면 그 측정은 더 이상
측정이 아니다.

## 2. 선행 측정 (전부 무수정, 결과는 디스크에 있음)

```
bench/dutyAttribution/results/2026-09-02T11-06-39-793Z.json
  INCONCLUSIVE · Q1_SIGNAL_PRESENT (L0 recall 1.00) · L1 홀드아웃 recall 0.25
  장면당 승인 수 T:{1:20} N:{0:3, 1:17}  → 모델은 심사하지 않고 슬롯 1개를 채운다
  모델 출력 스키마에 score 없음

bench/necessity/results/2026-09-02T11-29-48-557Z.json
  H5_REJECTED(V1) · necessity_discrimination 0.95
  approve_rate_SUFFICIENT 0.05 / approve_rate_INSUFFICIENT 1.00 / flip_rate 0.95
```

읽는 법: V1은 **증분 필요성 질문이 성립한다**는 사실이지, 모델이 스스로 슬롯을 열어도
된다는 근거가 아니다. `dutyAttribution`의 pick-one 행동이 그 반증이다. 그래서 제품에서는
서버가 그 질문을 하고 서버가 승인한다.

## 3. 봉인된 상수

```
TAU = 0.60          # score(c) >= TAU 만 후보가 된다. 0..1 정규화 가정.
K_EXTRA_MAX = 2     # MAX_EXTRAS. 사후 상향 금지.
SCORE_SCOPE = hard_event가 0건인 턴에만. hard_event가 있으면 score는 실행되지 않는다.
```

**K=1 실험은 재개하지 않는다.** `necessity` §2가 이미 확정: 모델은 장면당 슬롯 1개를
채우므로 `K=1` 상한의 기대 효과는 0이다. 줄이는 것은 상한이 아니라 **슬롯을 열지 않는 조건**이다.

## 4. 켜기 전 필요한 것 (이 토큰 밖)

1. 새 잠금 이름. `f9-extra-approve`를 재사용하지 않는다.
2. `score()` 프롬프트를 `bench/necessity/run.ts`의 `promptV1` 형태로 고정하고, 그 프롬프트가
   0..1 점수를 내도록 하는 변경 자체를 사전등록한다(현재 V1은 이진 승인이지 점수가 아니다).
3. 판정: `approve_rate_SUFFICIENT <= 0.30` AND `approve_rate_INSUFFICIENT >= 0.60`.
   위 §3 상수는 그 실행 **전에** 고정된 값이며, 결과를 본 뒤 바꾸지 않는다.

## 5. 지금 관측할 것 (S5)

먼저 `k_opened === 0`이 라이브에서 실제로 나오는지 본다 (노트 §8-5).
`extra_count` 히스토그램 {0,1,2,3}에서 3은 버그다. 0이 안 나오면 S3 회귀이지 신호 부재가 아니다.
