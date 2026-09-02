# P1-3c 에피소드 rollup — 설계 확정본 v2 (2026-08-23)

> P1-3 마지막 슬라이스. Claude Code 설계 + hermes 검수(REVIEW-P1-3c.md) 종합 반영.
> 상태: **✅ 구현·검증 완료 (v0.0.14, e8d567a, 2026-08-23)** — 조립 SHA 중립·수명주기 자가치유 경험검증. 설계는 2-A(두 시점 수렴). hermes 지적(오펀 수명주기·좌표 혼선·예산 탈락·recentGuard·태그) 전부 반영.
> 선행: P1-3a 상태(v0.0.11), P1-3b 장면(v0.0.12), P1-6 진단(v0.0.13). **다음 태그 = v0.0.14.**
> 스키마 변경 없음(0005 재사용). 위임 가능(§7 고정 항목 준수 시).

---

## 1. 결정: whole = 2-A (롤링 유지 + episode 중간 tier) — 확정

- 롤링 whole은 summarize/주입의 척추(memory.ts prev+INSERT, builder 최신1건). 무변.
- episode가 메우는 것은 whole이 아니라 **주입 상한(장면 최대 2건) 밖으로 잘리는 옛 장면**. 입도 다름=상보.
- 2-B(whole=rollup 재정의)는 부트스트랩 공백 + 모든 대화 whole 동작 변경 → 리스크 과다. 기각.
- **★ DESIGN-P1-3 §7-4 개정**: "whole=에피소드 rollup, 롤링 폐기" → **"롤링 whole 유지, episode는 신설 중간 tier"** 로 변경. (이 문서가 정본.)
- 유보: whole↔episode 문구 메아리(약모델)는 라이브 미측정 → P1-3c 후 프롬프트 실측으로 관찰.

## 2. 스키마
- **변경 없음.** 0005의 `tier`/`covers_from_message_id`/`rolled_up_into` 재사용. 소스 장면 링크는 `rolled_up_into`(장면→에피소드 id) 자체로 저장(별도 컬럼 불요).

## 3. 에피소드 rollup 설계

### 3-1. 트리거 (수동, §0-8 자동변경 금지)
- 표식: 미접힘(rolled_up_into IS NULL) approved 장면 수 ≥ **THRESHOLD=5**(초기, 데이터 보정).
- 실행: 수동 버튼 "에피소드로 묶기". 자동 실행 없음.

### 3-2. rollup 엔드포인트 (신규)
`POST /api/conversations/:id/rollup-episode`
- 대상 수집: `tier='scene' AND status='approved' AND rolled_up_into IS NULL` 을 **created_at ASC**로, **가장 오래된 THRESHOLD건만**(전부 아님 — 충실도). `?force=1`이면 THRESHOLD 미만도 허용(있는 만큼).
- THRESHOLD 미만 & force 아님 → 400 `{error:'묶을 장면이 부족'}`.
- 모델 1콜: `renderEpisodePrompt(sceneContents[])` = "다음 장면 요약들을 하나의 에피소드로 4~6문장. JSON {\"episode\":\"...\"} 만." 파싱 `lenientJson`.
- INSERT tier='episode' **draft**: covers_from=대상 첫 장면 covers_from(없으면 covers_until), covers_until=대상 마지막 장면 covers_until.
- **★ 대상 장면에 즉시 `rolled_up_into = 새 episode id` 세팅**(정확한 id 집합, 트랜잭션 내). — 좌표 재계산 없음(hermes 지적2 해소).
- 반환: episode draft + 접은 장면 id 목록.

### 3-3. ★ 배제는 "episode approved일 때만" — 자가 치유 (hermes 지적1·3·4 해소)
장면을 rollup 시점에 마킹하되, **주입 배제는 episode가 approved인 경우로 게이팅**한다. 장면 주입 쿼리(builder) 수정:
```sql
SELECT * FROM summaries WHERE conversation_id = ? AND tier = 'scene' AND status = 'approved'
  AND (rolled_up_into IS NULL
       OR rolled_up_into NOT IN (SELECT id FROM summaries WHERE tier='episode' AND status='approved'))
ORDER BY created_at DESC
```
효과:
- episode **draft** 동안: 장면 rolled_up_into 세팅됐어도 episode 미승인 → 장면 **여전히 개별 주입**(조기 은닉 없음).
- episode **approved**: 그 장면들 배제 + episode 주입(대표).
- episode **DELETE/unapprove**: NOT IN(approved) 성립 → 장면 **자동 복귀**(오펀 없음, 자가 치유).
- **DELETE 정리**: episode DELETE 시 `UPDATE summaries SET rolled_up_into=NULL WHERE rolled_up_into=<epId>` (재-rollup 가능하게). PATCH status→draft(unapprove)는 배제쿼리가 자동 처리하므로 정리 불요(단 재rollup 원하면 수동).
- **이중 draft**: rollup이 `rolled_up_into IS NULL`만 수집 → 두 번째 rollup은 첫 draft가 claim한 장면을 못 가져감(중복 방지). 첫 draft DELETE 시 위 정리로 해제.
- PATCH 사이드이펙트 **불요**(범위 재계산·승인시 마킹 없음) — rollup이 이미 마킹, 배제는 쿼리가 판단. PATCH는 기존 content/status만. (hermes 대안보다 단순 — 승인 트랜지션 감지 불필요.)

### 3-4. 주입 (builder) — episode 예산 예약 (hermes 지적3 해소)
순서 state → whole → **episode** → scene → lore. 단 **episode를 whole 뒤 잔여가 아니라 예약분에서** 뽑아 starvation 방지:
```
sumBudget = memory − memEst
stateCap = min(200, sumBudget); state 소비 → stateEst
남은1 = sumBudget − stateEst
episodeCap = min(남은1 * 0.35, episode실토큰)   # 예약: 최신 approved episode 1건
  - episode covers_until ∈ history.slice(-SCENE_RECENT_GUARD)면 스킵(원문 중복 방지, 장면과 동일 guard)
whole cap = 남은1 − episodeEst                    # whole은 예약 후 잔여
sceneBudget = 남은1 − episodeEst − whole실사용    # 장면은 그 후 잔여(기존 로직)
```
- systemParts 표시 순서: `[…, stateText, episodeText, renderSummary(whole), sceneTierText, lore]` 또는 state→whole→episode→scene(표시 순서는 취향; 예산은 위 예약이 핵심). **권장 표시: state → whole → episode → scene**(개요→중거리→세부).
- `renderEpisode(text)` = `### 지난 에피소드\n{text}`. 최신 approved episode 1건만(covers_until DESC or created_at DESC).
- 폴백 결정: episode가 예산 탈락(0)이면 그 자리는 비움(장면은 이미 rolled_up으로 배제됨). ★예약(0.35)으로 탈락 확률 최소화. 폴백으로 접힌 장면 재주입은 **안 함**(복잡도↑, 예약으로 갈음).

### 3-5. UI (SummaryTab)
- 에피소드 카드 tier='episode'(renderCard 재사용, kind '에피소드', 원본 범위 점프).
- 미접힘 approved 장면 ≥ THRESHOLD면 "에피소드로 묶기(N)" 버튼 → rollup 호출 → draft 생성.
- 접힌 장면(rolled_up_into 있고 그 episode approved)은 목록에서 흐리게/접기(선택).
- 렌더 순서: 상태 → 에피소드 → 장면 → 전체.

## 4. P1-6 진단 4번째 tier
- summaryDiag에 episode 항목 추가는 **P1-6 후속으로 분리**(이 슬라이스 제외). 이유: 조립 SHA 게이트와 섞지 않음(diagnostics는 preview-only라 SHA 무영향이지만, 게이트 단순 유지). P1-3c 커밋엔 미포함, 후속 소규모 커밋에서 episode를 summaryDiag에 추가.

## 5. 결정 잠금 (2026-08-23)
1. ✅ whole = **2-A**(롤링 유지 + episode 중간 tier). DESIGN-P1-3 §7-4 개정.
2. ✅ rollup 범위 = **오래된 THRESHOLD(5)건만**, 반복 실행. force=1은 미만 허용.
3. ✅ 오펀 = **Approach X**(rollup 시 마킹 + 배제는 approved 게이팅 + DELETE 정리). 승인시 마킹·범위재계산 폐기.
4. ✅ episode 예산 = **예약 35%**, recentGuard 적용, 폴백 없음.
5. ✅ P1-6 진단 episode = **후속 분리**.
6. ✅ 태그 = **v0.0.14**.

## 6. 게이트 (raw)
1. server/web build exit 0
2. restart · health db:ok
3. **수명주기 시나리오**(임시 __test__ 장면 5건 approved 생성):
   a. rollup 호출 → episode **draft** 생성 확인. **이 시점 장면 5건 여전히 개별 주입**(draft라 배제 안 됨) — prompt-preview로 확인.
   b. episode **승인** → 그 장면 주입에서 사라지고 episode 등장 확인.
   c. episode **DELETE** → 장면 5건 주입 **복귀** 확인(자가 치유), rolled_up_into NULL 정리 확인.
   d. 전량 정화.
4. **조립 회귀**: 에피소드 없는 대화 prompt-preview messages SHA = baseline `b3a19a8b…` 불변.
5. candidate|6 / 기존 whole|approved|1 무접촉 / integrity ok.

## 7. 위임 시 브리프에 고정할 것 (hermes 검수 반영)
1. whole 롤링 유지, summarize INSERT tier='whole' 무변, summarize 출력 스키마(whole/state/scene) 불변.
2. rollup 쿼리 원문(§3-2, created_at ASC, oldest THRESHOLD).
3. 마킹: rollup 트랜잭션서 대상 id에 rolled_up_into=epId. 배제쿼리(§3-3) 원문. PATCH 사이드이펙트 없음.
4. DELETE 핸들러: rolled_up_into=NULL 정리.
5. builder 예산 예약(§3-4) + episode recentGuard.
6. 게이트 §6 수명주기 a~d 필수.
7. 태그 v0.0.14. P1-6 진단 episode는 넣지 말 것(후속).
8. 불변: loreEntryActive/생성경로 진단/candidate|6/기존 whole 무접촉. 브랜치-스코프(getPath head) 부채는 이 슬라이스서 손대지 말 것(단 rollup이 path 위를 걷는지 명시).
