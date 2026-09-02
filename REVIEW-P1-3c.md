# REVIEW-P1-3c

날짜: 2026-08-23T07:09:05Z

근거 범위(읽기만): `BRIEF-P1-3c-review.md`, `DESIGN-P1-3c.md`, `DESIGN-P1-3.md`, `apps/server/src/prompt/builder.ts`, `apps/server/src/routes/memory.ts`. 빌드·DB·git 변경 없음. 라이브 주입/승인 재실행은 하지 않음.

---

## 1. 2-A vs 2-B

**선택: 2-A** (롤링 whole 유지 + episode를 중간 tier로 추가). DESIGN-P1-3c 권장과 같음.

근거:

- **현재 코드의 척추는 롤링 whole이다.** `memory.ts` summarize는 `tier='whole' AND status='approved'` 최신 1건을 `prev`로 읽고(`L130`), 그 content를 프롬프트에 넣고(`L153`), 매번 새 `tier='whole'` draft를 INSERT한다(`L192`). `builder.ts`는 같은 쿼리로 최신 approved whole 1건을 주입한다(`L160–163`, `L175`). 2-B는 이 경로를 멈추거나 재정의한다. 2-A는 무변.
- **에피소드가 메우는 구멍은 whole이 아니라 “주입 안 되는 옛 장면”이다.** 장면 주입은 `rolled_up_into IS NULL` + `covers_until`이 recentGuard(24) 밖 + **최대 2건** (`builder.ts L183–195`). approved 장면이 5건이어도 프롬프트에는 최근 2개만 들어간다. episode 1건(4–6문장)의 주된 이득은 그 잘린 3+건의 중거리 복원이다. whole(6–8문장 개요)과 입도가 다르다.
- **2-B 부트스트랩 공백은 설계가 이미 인정한 실측 리스크다.** episode는 미접힘 approved 장면 ≥5 이후에만 생긴다(DESIGN-P1-3c §3-1, DESIGN-P1-3 §7-3). 그 전까지 2-B가 롤링을 끄면 backbone이 빈다. 메우려면 (i) 첫 episode 전까지 롤링 유지, 또는 (ii) 장면을 더 넣기 — (i)는 사실상 2-A, (ii)는 토큰·중복이 커진다. “중복 제로”는 state/기억과도 겹치는 목표라 이득이 과장되어 있다.
- **잠긴 결정과의 충돌은 숨기지 않는다.** DESIGN-P1-3 §7-4는 “whole = 에피소드 rollup, 롤링 폐기, 기존 whole 1건만 보존·병존 안 함”으로 잠겨 있다. 2-A는 그 잠금을 **명시적으로 푸는 제안**이다. 작은 튜닝이 아니다. 사용자가 §5-1을 확정해야 동결된다.

whole↔episode 의미 중복은 **있다**. 같은 아크를 두 해상도로 말하게 된다. 약모델이면 문구 메아리 가능. 다만 현재 whole은 이미 `sumBudget − stateEst` 전부를 cap으로 쓰고(`builder.ts L175`) 장면은 그 **실사용 잔여**만 받는다(`L178–179`). episode도 같은 잔여를 장면과 나눠 먹는다. 최근 미접힘 장면 0–2건 + episode 1건이 잔여에 들어가면, 지금 버려지던 옛 장면 정보가 생기는 쪽이 중복 비용보다 크다. 중복이 “실제로 문제인지”는 라이브 프롬프트를 안 재측정했으므로 **정량 판정은 불확실**. 구조적으로는 상보가 맞다.

2-B를 고를 조건(지금은 해당 없음): 롤링 whole이 이미 중거리까지 충분히 먹고, episode가 순수 중복이라는 **측정**이 있을 때. 그 측정은 이 리뷰에 없다.

---

## 2. 오펀 방지

**허점 있음.** draft 시점 미마킹(§3-3)은 맞다. 승인 후 수명주기와 범위 좌표가 비어 있다.

확인함:

- 지금 PATCH는 content/status만 갱신한다. 사이드이펙트 없음 (`memory.ts L102–108`). 접기는 아직 없다.
- 장면 생성 시 `covers_until=lastId`, `covers_from=firstId` (`memory.ts L197–198`). episode draft의 covers는 설계상 첫/마지막 **장면의 메시지 id** (DESIGN-P1-3c §3-2).
- 장면 제외 조건은 `rolled_up_into IS NULL` (`builder.ts L185`). 값이 남는 한 개별 주입이 영구 중단된다.
- `rolled_up_into`는 TEXT 컬럼이다(DESIGN-P1-3 §2). FK/ON DELETE 없음. episode DELETE가 장면을 되돌리지 않는다.

허점:

1. **승인 후 DELETE / draft 강등.** §3-3은 “승인 전 reject/delete → 마킹 없음”만 말한다. 승인 후 episode를 지우거나 `status`를 draft로 되돌리면 장면은 `rolled_up_into`가 남은 채 주입에서 사라진다. **진짜 오펀.** PATCH는 이전 status를 보지 않는다.
2. **소스 장면 id를 안 남긴다.** §3-3은 클라가 id를 다시 넘기지 말고 서버가 covers 범위를 재계산하라고 한다. 그런데 같은 절이 `[covers_from, covers_until]`(메시지 id)과 “장면 `created_at` 구간”을 섞는다. 메시지 UUID와 ISO `created_at`은 비교 불가. 구현자가 어느 축을 잡을지 문서만으로는 닫히지 않는다.
3. **승인 사이 끼어든 장면.** rollup 쿼리는 그 순간 `approved AND rolled_up_into IS NULL`만 본다. 그 창에 `created_at`이 들어가 있는 **미승인 draft**를 사용자가 episode 승인 직전에 승인하면, 범위 재계산은 그 장면을 접으면서 모델 입력에는 없던 텍스트를 없앤다. 반대(입력에 있던 장면이 범위 재계산에서 빠짐)도 좌표가 흔들리면 가능하다. 빈도 추정은 **불확실** — 경로 자체는 코드/설계로 존재.
4. **이중 draft 승인.** rollup을 두 번 누르면 겹치는 episode draft 2개가 생긴다. 둘 다 승인하면 같은 장면을 두 번 UPDATE하거나, 두 번째가 0건을 접을 수 있다. 설계 침묵.
5. **스키마 없이 id 고정하려면** 새 컬럼(0006)이거나 episode content에 id 목록을 인코딩해야 한다. 2-A는 스키마 변경 없음(§4). 둘 다 안 하면 범위 근사만 남고 위 3이 남는다.

더 안전한 쪽: rollup 시 대상 장면 id를 episode 행에 **고정**하고, 승인 시 그 id만 `rolled_up_into=episodeId` (이미 approved·NULL인 것만). 승인 후 DELETE/draft 강등 시 그 id들의 `rolled_up_into`를 NULL로 되돌린다. 클라 재전송은 검증용으로만.

---

## 3. 주입 순서

**문제 있음** (치명적이진 않음. 기존 장면과 같은 잔여 패턴 + 접힘 이후 예산 탈락).

확인함 (현재 조립, episode 없음):

```
sumBudget = memory − memEst
stateCap = min(200, sumBudget)          # builder.ts L171
whole cap = sumBudget − stateEst        # L175  — 잔여 전부
sceneBudget = sumBudget − stateEst − whole실사용  # L178–179
systemParts = … state, renderSummary(whole), sceneTier, lore  # L240
```

DESIGN-P1-3c §3-4: state → whole → **episode 1건** → scene(기존, rolled_up_into IS NULL). 예산도 “whole 실사용 후 잔여 → episode → scene”.

문제:

- **whole이 잔여를 먼저 다 먹을 수 있다.** 이미 장면이 그렇게 산다. episode를 그 뒤에 끼우면 장면과 같은 운명이다. DESIGN-P1-3 §4의 “whole = 남은 예산의 대부분”과도 맞지만, episode를 “계층 완성”으로 말하면서 예약을 안 하면 긴 whole 대화에서는 episode가 항상 0일 수 있다. 실측 빈도는 **불확실**(이 대화 whole 137t는 잔여가 남을 가능성이 큼. 일반화 안 함).
- **접힌 뒤 episode가 예산에서 탈락하면 중거리가 통째로 빈다.** 접기는 승인 시점, 주입은 그 다음 턴의 잔여. 장면은 이미 `rolled_up_into`로 제외된다. “episode 없으면 접힌 장면을 폴백”은 설계에 없다. 지금(미접힘)은 장면 최대 2건이라도 남는다.
- **episode에 recentGuard가 없다.** 장면은 `covers_until ∈ history.slice(-24)`면 스킵한다(`L189`). 방금 묶은 episode가 그 창을 포함하면 원문 + 에피소드가 겹친다. THRESHOLD=5면 보통 창 밖일 가능성이 크지만, `?force=1`이나 짧은 대화에서는 겹칠 수 있다.
- **P1-6 진단은 tier 3개 고정 emit** (`builder.ts L199–201`: state/whole/scene). episode를 넣으면 진단 4번째를 안 정한 채 조립만 늘어난다. 조립 SHA 게이트(§6-4, 에피소드 없는 대화)와는 별개. 빠짐이지 주입 순서 버그는 아님.

우선순위 자체(state → whole → episode → scene → lore)는 DESIGN-P1-3 §4와 현 `systemParts` 순서와 맞다. 문제는 순서보다 **접힘×잔여예산 결합**이다.

---

## 4. 빠진 것

- **태그 충돌:** DESIGN-P1-3 §6은 P1-3c = `v0.0.13`. 그 태그는 이미 P1-6(`4a4d88c`)이다. 다음 슬라이스는 `v0.0.14`여야 한다.
- **decision#4 잠금 해제 절차:** 2-A를 쓰려면 DESIGN-P1-3 §7-4를 문서에서 개정해야 한다. P1-3c만 동결하면 두 설계가 모순으로 남는다.
- **승인 후 수명주기:** unapprove / DELETE / 내용만 PATCH / 재승인 시 `rolled_up_into` 되돌림·재접기.
- **소스 장면 id 저장 방법** (스키마 없이 2-A를 지키면서).
- **범위 좌표 단일화:** 메시지 path vs `created_at`. 지금 문서는 둘을 한 문단에 섞음.
- **rollup 창: 미접힘 전부 vs THRESHOLD 단위.** §5-2는 초기 “전부 1개”. 입력이 10–20 장면이면 4–6문장으로 접고 개별 주입을 전부 끈다. 2-A면 최신 episode 1건만 들어가고 옛 구간은 whole이 받치므로 토큰은 버틴다. **충실도는 떨어진다.** 초기값은 “가장 오래된 THRESHOLD건만, 나머지 미접힘 유지, 버튼 반복”이 더 안전하다. 첫 누름이 정확히 5건이면 둘 다 같다.
- **episode 예산 예약 또는 미주입 시 장면 폴백.**
- **episode recentGuard** (또는 “covers_until이 창 안에 있으면 episode도 스킵”).
- **P1-6 진단:** summaries에 `episode`를 항상 emit할지. 기존 3-tuple SHA/게이트와 별도로 정해야 한다.
- **동시 rollup draft 2개.**
- **대화 스코프 vs 브랜치:** summaries는 conversation 단위, `getPath`는 head 브랜치(rpchat-pwa 함정). 장면 covers가 다른 갈래면 범위 재계산이 빗나간다. P1-3a/b와 동일 부채. 이 슬라이스에서 고치지 말 것 — 다만 rollup 범위가 path 위를 걷는다면 **명시**.
- **`force=1`:** 2장면짜리 episode + 그 2장면 주입 중단. 허용하되 게이트에서 기본 경로와 분리.
- **게이트 §6-3:** `__test__` 장면 5건 → rollup → draft → 승인 → 마킹 → 주입 교체 → 정화. 방향은 맞다. 빠진 회귀: (a) draft만 있고 미승인일 때 장면이 **그대로** 주입되는지, (b) episode 승인 후 DELETE 시 장면이 돌아오는지(지금 설계면 실패해야 함 — 그래서 수명주기를 먼저 닫아야 함), (c) 에피소드 없는 대화 messages SHA. (c)는 §6-4에 있음.
- **위임 브리프에 박아야 할 불변:** `loreEntryActive` 무수정, chat 생성 경로 진단 금지, `candidate|6` / 기존 `whole|approved` 무접촉, summarize 출력 스키마(whole/state/scene) 불변(2-A).

없음으로 치지 않음.

---

## 5. 위임

**조건부 가능 — 2-A가 확정되고 아래가 브리프에 숫자/쿼리로 박힌 뒤에만.**

가능 이유: 스키마 없음, summarize/whole 경로 무변, 신규는 엔드포인트 + PATCH 사이드이펙트 + builder 한 칸 + UI. P1-3a/b 패턴 반복.

불가/직접 사유(지금 문서 그대로면):

- §3-3 좌표 혼선(메시지 id vs `created_at`)은 구현자가 설계 판단을 하게 된다. BRIEF 거버넌스는 그걸 STOP으로 둔다.
- 승인 후 DELETE 오펀은 기본값 선택이 필요하다.
- decision#4와 2-A가 동시에 살아 있으면 위임 브리프가 어느 설계를 정본으로 보는지 불명.

위임 전에 브리프에 고정할 것:

1. whole = 롤링 유지. summarize INSERT `tier='whole'` 유지. decision#4 개정 문장.
2. rollup 대상 = `approved AND rolled_up_into IS NULL` 을 **created_at ASC** 로 THRESHOLD건(또는 확정된 “전부”). 쿼리 원문.
3. 소스 장면 id 저장 방식 + 승인 시 `UPDATE … WHERE id IN (…) AND rolled_up_into IS NULL`.
4. PATCH: `tier='episode' AND old.status≠approved AND new.status=approved` 일 때만 접기. 트랜잭션.
5. DELETE/unapprove 시 해당 id로 접힌 장면 `rolled_up_into=NULL`.
6. builder: whole 실사용 후 잔여에서 episode 1건, 실패 시 장면 폴백 여부(예/아니오 한 줄).
7. 게이트: 미승인 시 장면 유지, 승인 시 장면 제외+episode 등장, 에피소드 없는 대화 messages SHA 불변, `__test__` 전량 삭제, `candidate|6`.
8. 태그 `v0.0.14`. P1-6 진단 4번째 항목은 이 슬라이스에 넣을지 **별도 한 줄**(기본 제안: 넣지 말고 P1-6 후속으로 — 조립 불변 게이트와 섞지 않음).

2-B면 위임 불가(DESIGN-P1-3c §5-3과 같음): summarize 계약·전 대화 whole 의미·부트스트랩을 동시에 건드린다.

---

## 확인함 / 확인 안 함

| 항목 | 상태 |
|---|---|
| DESIGN-P1-3c / P1-3 원문, builder 주입·systemParts, memory PATCH/summarize INSERT | 확인함 (파일 읽기) |
| 라이브 prompt-preview에 episode가 없다는 것, SHA, candidate\|6 | 이 리뷰에서 재측정 안 함 (지시: 빌드/DB 금지). 직전 P1-6 기록은 참고일 뿐 이번 증거 아님 |
| whole↔episode 토큰 중복이 체감 메아리인지 | 불확실 |
| 끼어든 장면 레이스의 실제 빈도 | 불확실 |
| 긴 whole이 episode 예산을 0으로 만드는지 | 불확실 (코드상 가능) |

착수 조건: 사용자 §5-1에서 2-A/2-B 확정 + 위 위임 고정 항목. 확정 전 코드 변경 없음.

---

## 6. 2026-08-23 overnight 이후 분류 (문서만, 구현 금지)

원문 §1–5는 설계 시점 리뷰로 보존. 아래는 v0.0.14/15 + 격리 도그푸딩 이후 **관측 vs 아직 잠금 안 된 판단**.

### 구현으로 닫힌 것 (코드 경로, 이 파일이 설계 때 지적한 구멍)

- Approach X, PATCH 마킹 없음, DELETE 시 `rolled_up_into` NULL — P1-3c `e8d567a` / lifecycle 게이트 (PROGRESS).
- episode 예산 예약 35% + `recentGuard` 공유 — `builder.ts` L175–183 (`covers_until`이 최근 24에 있으면 episode 스킵).
- P1-6 진단 4번째 `episode` 항상 emit — `v0.0.15` / `builder.ts` L216. 조립 SHA 게이트와 분리됨.
- 태그: P1-3c = `v0.0.14` (DESIGN §6의 v0.0.13 표기는 구식).
- DESIGN-P1-3 §7-4: 디스크상 2-A로 개정됨 (decision#4 모순은 문서에서 해소).

### 야간 관측 (버그 주장 아님)

- whole↔scene 문장 메아리 없음 (`REPORT-P1-3-dogfood.md`). 사실(장소·약속)은 공유.
- 짧은 격리 대화에서 승인 scene 2건이 preview `used:false` (`해당 장면 없음/제외`) — `SCENE_RECENT_GUARD=24` 기대 동작.
- episode `used:false` / `승인된 에피소드 없음` — 서리 대화에 approved episode 없음. rollup 미실행(장면 2 < 5).

### ✅ 2026-08-23 오후 사람 잠금 완료 — 전부 v0.0.17로 해소 (아래는 과거 기록, 재오픈 금지)

- **episode 예산탈락 폴백**: 최소기준(`MIN_EPISODE_TOKENS=30`) 미달시 생략 채택. 장면 폴백 없음(복잡도 회피). `builder.ts` 로직검증 완료.
- **소스 장면id 스키마화**: 현행(`rolled_up_into` 역참조) 유지 결정. 추가 컬럼 불필요.
- **dual rollup draft**: 코드변경 없음. `ctx.queue` 가드가 이미 차단 — **동시 curl 2건 실측**(하나 409 즉시차단, 하나 200, episode 1건만 생성·중복無) 확인.
- **branch-scope 부채**: `pickOnPath` 가드 추가(whole/state/episode 후보 LIMIT5+경로필터, scene 루프도 동일). 임시대화로 실제 분기(A/B) 만들어 브랜치A 주입→브랜치B 전환시 배제 **실측 검증** 완료. 이게 유일한 진짜 버그였음.
- **긴 whole이 episode를 0으로 만드는지**: 코드 재확인 결과 **구조적으로 불가능** — episode가 `afterState`(상태 이후 잔여) 기준으로 whole보다 **먼저** 35% 예약받고, whole은 `sumBudget-stateEst-episodeEst`로 그 이후 잔여를 받음. whole이 길어도 episode를 굶길 수 없음(반대가 아니라 episode가 우선).

이후 v0.0.18: 기억(memory) evidence_message_ids를 배치 끝(lastId)→시작(firstId)으로 변경 — "원본" 버튼이 항상 최신 대화로 가던 문제 완화(완전한 추적은 아님).

확인 안 함(여전히): Galaxy 카드/점프 실기기, 서리 본편에서 state/scene가 실사용으로 자연 쌓이는지(수동 summarize 1회는 성공), 격리 대화 episode 라이브 rollup(장면 ≥5 필요), lore no-match 라이브(서리 대화에 해당 엔트리 없음).
