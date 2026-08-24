# long-rp-v1 runner — 사전등록 (실행 전 고정)

잠금: 2026-08-24. 정정은 이 파일 **append만**. θ 사후 조정 금지.

## 한 경계

격리 대화에서 라이브 `POST /api/conversations/:id/messages` 로 사용자 100턴을 생성하고,
horizon 30/60/100에서 OOC probe 9개를 같은 경로로 물어 **hold_rate를 측정**한다.

제품 코드(`apps/**`) 무수정. 신규 테이블/메모리 자동승인/요약 호출 없음.
95%는 목표가 아니다. 이번 런의 채택 게이트가 아니다.

## 신호

- `hold_rate[h] = held_facts[h] / scored_facts[h]`
- 사실 f가 horizon h에서 **scored**: 그 horizon probe 중 `fact_ids`에 f가 있는 경우.
- 사실 f가 **held**: 해당 probe가 전부 pass.
- probe pass: `score-keys-v1.json` 의 `must` 전부 부분문자열 적중 **그리고** `forbid` 없음.
  정규화: NFC + 소문자 + 공백압축.
- scored가 아닌 due fact는 `unscored`로만 보고. hold_rate 분모에 넣지 않는다.

## 대조군

- 라이브 Fastify 생성 경로 재사용 (`run-chat-baseline.ts`와 동일 HOST/HEADER).
- 요약/기억 approve 안 함 → 윈도우+카드만으로 버티는 baseline.
- 캐릭터 카드에 gold fact를 넣지 않는다(이름·장소만). F01 직업은 beat 2에서 도입.

## 성공기준 (러너 유효성만)

양방향이 아닌 **측정 러너 게이트** (채택 θ 없음):

- `VALID` iff `story_complete == 100` AND `probe_complete == 9` AND 모든 story/probe `status==complete`.
- 그 외 `INVALID`. hold_rate는 VALID일 때만 보고. INVALID면 hold_rate를 판정에 쓰지 않음.

## 분기

- VALID + 수치 기록 = 이번 칸 종료. 비채택/저hold는 정상 결과.
- INVALID = 벤치 무효. 재실행은 같은 사전등록. 게이트 재설계 금지.
- 사용자 활성 생성이 있으면 시작하지 않고 중단 (`/api/health` `generation.active` 비어 있을 것).

## 오염 방지

- 대화 제목 `[TEST-longrp-v1]`. 캐릭터명 `린-longrp-v1`.
- 서리 `09e7827f-c2c4-4db8-89c0-e37aea2fe62d` 금지.
- probe는 `(OOC)` 로 묻고, 각 probe의 user 메시지를 DELETE 해 head를 스토리 잎으로 되돌린다.
- 종료 시 대화 DELETE + `generation_log` 해당 conv 삭제. 캐릭터는 archive.

## 확인함 / 확인안함 (실행 전)

확인함: messages POST = 생성 경로. OOC 정규식. message DELETE cascade+head. sketchBench ~5s/짧은 턴.
확인안함: 100턴 후 dropped_messages, Galaxy 동시사용, 카드 누수가 hold를 얼마나 올리는지.

## Append 2026-08-24 first run (게이트 불변)

- `VALID`. `bench/longRp/results/long-rp-1787582894376.json` sha256 `456e1489ebb87ca18e2e562505201a0fdcab1915048d1f7bf152e2e0107f75da`
- hold_rate 30=0/6 · 60=4/6 · 100=3/7. 재추출은 REPORT.md.
- score-keys / θ 변경 없음.

## Append 2026-08-24 frost guard (채점 불변)

- 서리 character_id = `f89ace9b-8684-4d97-96dc-e00c4b25a819`. `09e7827f-…` 는 그 캐릭터의 대화 하나(그 방 messages 55). 서리 전체 대화 메시지 합은 별도.
- `FROST_ID`(대화 UUID) 는 캐릭터 가드가 되지 않음. `FROST_CHARACTER_ID` + 라이브 `conversations.character_id` 집합 + cleanup refuse.
- `npx tsx bench/longRp/verify-frost-guard.ts` → `FROST_GUARD_OK`.
