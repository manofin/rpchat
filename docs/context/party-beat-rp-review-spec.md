# 파티 비트 RP — 구현 사양서 (리뷰용, 2026-09-03)

> **성격: 리뷰용 사양서. 실행 계약이 아니다. 큐로 읽지 말 것.**
> 다른 에이전트가 현재 구현을 읽고 개선점을 제안하기 위해 쓴다. 승인·잠금·배포 지시가 아니다.
> 정본 우선순위: `STATUS.md` F9 행 · `f9-catalog-write-lock.md` · `Notes_260902_210901.txt` · 이 문서.
> `planning_documents/f9-beat-catalog-school.md`는 **무효**. 교실 캐스트를 라이브 DB에 넣는 토큰은 중지.

- Date: 2026-09-03
- Git: `git -C /home/hermes/rpchat/app` 브랜치 `f9-beat-seal` HEAD `554ef08` (`v0.0.19-93-g554ef08`)
- `master`: `1e827f1` 미이동
- 라이브 PID (이 문서를 쓴 시점): `130631` @ 8787. **이 브랜치의 최근 커밋은 라이브에 재시작되지 않았다.** 라이브는 봉인 시점 코드일 수 있다.
- 제품 SoT: `/home/hermes/rpchat/RP-Chat-PRD.md`
- 파티 경로 계약: `/home/hermes/rpchat/Notes_260902_210901.txt`

---

## 0. 리뷰어에게

이 앱은 개인용 로컬 RP 채팅 PWA다. 공개 마켓·결제·Crack/CaveDuck 클론이 아니다.

사용자가 원한 것은 **교실 멀티캐 샘플과 같은 형식**이 한 유저 입력 → 한 비트로 나오는 것이다. 샘플 대본을 한 글자씩 재현하는 것이 목표가 아니다.

리뷰 산출물로 받고 싶은 것:

1. 계약과 코드의 불일치
2. 포커스/extra/속마음/UI의 실패 모드
3. 1:1 경로를 건드리지 않고 고칠 수 있는 결함
4. 테스트가 출하 경로를 실제로 도는지 (재구현·하드코딩 기대값)

받지 말 것: 라이브 학교 시드, `silu.uk` fetch, extra 상한 완화, `EXTRA_SCORE_ENABLED=true`, 1:1 `HARD_RULES`/`PROMPT_VERSION` 변경, F9 펜스 파일 수정.

---

## 1. 저장소 지형

| 경로 | 역할 |
|---|---|
| `/home/hermes/rpchat/app` | Git 루트. 서버·웹·벤치 |
| `/home/hermes/rpchat/planning_documents` | STATUS, ADR, 잠금. Git 밖 |
| `/home/hermes/rpchat/data/rpchat.db` | 라이브 SQLite. 교실 캐스트 삽입 금지 |
| `/home/hermes/rpchat/Notes_260902_210901.txt` | 파티 비트 계약 (헤더·슬롯·UI, extra 0~2) |

서버: `app/apps/server/src`  
웹: `app/apps/web/src`  
벤치: `app/bench/*.test.ts` (`npx tsx bench/<file>.test.ts`)

인증: 라이브 `AUTH_MODE=tailscale`. 격리 테스트는 hook 없이 라우트만 등록하거나 `AUTH_MODE=none` + `HOST=127.0.0.1`.

---

## 2. 두 경로

### 2.1 1:1 (기본)

`story_id`가 없거나 스토리 호스트 캐릭터 중 `party:` 태그가 **2명 미만**이면 `buildPrompt` + 단일 스트림.

건드리지 말 것: `builder.ts` 조립 순서, `templates.ts` `HARD_RULES` / `renderRules`, `PROMPT_VERSION = '2026.08.22-r1+story'`.

### 2.2 파티 비트

`conversations.story_id`가 있고, 그 스토리의 `story_characters` ∩ `party:` 태그가 **2명 이상**이면 `generateBeat`.

`castFromCharacters` (`tagsCatalog.ts`): `party:` 태그 행이 2 미만이면 `null` → 1:1.

태그 문법 (모두 선택):  
`party:role=` `party:duty=` `party:alias=` `party:place=` `party:home=` `party:talkative=` `party:locked=` `party:outfit=` 등.

---

## 3. 한 비트의 계약 (Notes §1·§6)

한 유저 입력 → 서버가 블록을 조립한다. 모델은 말투만 만든다.

| 블록 `block_kind` | 누가 만드나 | 내용 |
|---|---|---|
| `header` | 서버 `renderHeader` | 일차 · 요일 · `HH:MM` · 날씨 · 장소. 없는 필드는 생략. 날짜 `8/20`, ⌛ 아이콘, 아침/날씨 이모지는 **아직 없음** |
| `narration` | Pass N (모델) | 서술·군중. 대사 슬롯 아님 |
| `line` | Pass F (포커스, 스트림) + Pass E (extra) | 이름 있는 발화. 초상은 `meta.image_url` = 로컬 `outfit×emotion` 또는 없음 |
| `thought` | Pass F를 `속마음:` 로 분할 | **포커스만**. extra/ambient 속마음 블록 없음 |
| `ui` | 서버 `renderUi` | JSON: `location_badge`, `user_sheet` (hp/money/gear/inventory/traits), `roster[]` `{name, chip, locked, in_room}`, `intent_hint` |

직렬화 순서 (`serializeBeat`):  
HEADER → N* → LINE(focus) → N* → THOUGHT → N* → LINE(extra)* → N* → UI

Extra 대사 슬롯 **최대 2** (`MAX_EXTRAS = 2`). 기본 승인 0. 열리는 조건은 `hard_event` (flag `owner_duty` / stage `closer_duty`). 루나·유라·미르는 계약상 **ambient 서술**이지 기본 슬롯이 아니다.

이미지: `/media/assets/{id}/{outfit}/{n}.webp`. 없으면 이름만. `silu.uk` 금지, 모델이 URL을 만들지 않음.

---

## 4. 턴 파이프라인 (출하 `generateBeat`)

파일: `apps/server/src/routes/chat.ts` `generateBeat`  
순수 계획: `apps/server/src/prompt/composeBeat.ts` `planBeat` / `finishBeat`

1. 장면 델타 제안 (모델 `complete`, 실패해도 턴 계속). 적용은 `applySceneDelta` (서버 allow-list).
2. `resolveFocus` — 서버만, 무작위·LLM 없음.
3. `eligibleExtras` → `approveExtras` (기본 0, cap 2).
4. `ambientPicks` — 서술 포인트만.
5. Pass N `complete` (실패 → 서술 블록만 생략).
6. Pass F `stream` (실패 → 턴 실패). `속마음:` 으로 line/thought 분할.
7. 승인 extra마다 Pass E `complete` (실패 → 그 extra만 생략).
8. `finishBeat` + 메시지 행 persist (`block_kind`, `beat_seq`, speaker, `image_url`).
9. `conversations.scene_json` 커밋 (`last_beat` 포함).

SSE: 사용자 행 `aux` → header/narration `aux` → focus `start`+`token`*+완료 → thought/extra `aux` → ui `aux` → `done`.

---

## 5. 포커스 규칙 (지금 코드)

`apps/server/src/prompt/resolveFocus.ts`

우선순위:

1. **별표 지문** `*...*` 안에서 이름이 **하나**면 그 사람이 겨냥. 지문에 둘이면 침묵. 지문에 0이면 전체 문장으로.
2. 전체 문장에서 이름/별칭/@/id가 **하나**면 겨냥. **둘 이상이면 침묵** (추측 금지).
3. 2인칭만 + 직전 `last_beat.focus_id` → 그 사람 재확인. 직전 포커스 없으면 생성하지 않음.
4. 직전 `unresolved`가 하나면 그 사람.
5. 장소 `default_focus`.
6. 없으면 포커스 없음 = 서술만.

토큰: 공백·구두점·`*` 분리. 조사 제거 (`을/를/에게/의` …). 부분문자열 금지 (세라 ≠ 세라핌).

예시 (구현됨):

| 유저 입력 | 포커스 |
|---|---|
| `나리, 네 이야기 말인데.` | 나리 |
| `*나리의 귓가에 낮게 속삭이며*` | 나리 (`*`가 이름을 가리지 않음) |
| `*하연을 향해 씩 웃으며* … 나리 씨랑 친해지겠습니다` | **하연** (지문 우선, 말 속 나리는 화제) |
| `세라, 하연, 둘 다 들어.` | 없음 |

---

## 6. 스토리 시작 장면 시드

`apps/server/src/prompt/initScene.ts` `initialBeatScene`  
호출: `POST /api/conversations` 에 `storyId`가 있을 때 (`conversations.ts`).

StoryPage는 `{ characterId, storyId, mode }`만 보내고 `scene: {}`다. 시드 없으면 헤더/UI가 비었다.

`party:` 캐스트 ≥ 2일 때만 채움. 1:1 스토리는 overlay 그대로.

채우는 것 (클라이언트가 준 키는 이김):

- `location` ← 카탈로그 첫 장소
- `weather` ← 첫 날씨
- `arc` / `stage` ← 카탈로그
- `clock_minutes` ← 기본 `9*60+38` (09:38)
- `day_index` ← 1
- `present_ids` ← `party:place`가 비었거나 location과 같은 행
- `roster[id].outfit` ← 태그 또는 카탈로그 첫 outfit (감정은 기본 안 넣음)
- `user_sheet` ← `{ hp: 100, money: 0, gear:[], inventory:[], traits:[] }`

`weekday`, 달력 날짜, 샘플의 💰10,000 / 장비 문구는 시드하지 않음.

페르소나: `personaId`가 있으면 생성 시 스냅샷 고정 (`6fff0bb`). PATCH와 동일.

---

## 7. UI 렌더 (웹)

`apps/web/src/components/view.tsx`

- `BeatHeader` / `BeatNarration` / `BeatThought` (💭) / `BeatUiPanel`
- `line`은 기존 말풍선 + `SpeakerHeader` + `meta.image_url`
- `block_kind` 없는 메시지는 1:1 말풍선 (구 대화 재해석 금지)
- UI 통계: `HP n · ₩ n · 장비 … · 보유 … · 특수 …`
- `intent_hint` ← `scene.beat_goal` (`composeBeat`가 복사). 샘플 「합동 과제(나리)…」는 **장면 필드가 있을 때만**. 모델 산문에서 추출하지 않음.

`POST /api/stories/:id/characters`의 `role` 스키마는 현재 `z.literal('main')`만 허용. 파티 판정은 이 컬럼이 아니라 캐릭터 `party:` 태그를 본다.

---

## 8. 최근 커밋 (이 사양서가 다루는 델타)

브랜치 `f9-beat-seal`, 부모 봉인 `c1a0c5b` 이후 관련:

| 커밋 | 내용 |
|---|---|
| `6e79818` | `scene_catalog` 쓰기 = 파서 (사후 잠금 `f9-catalog-write`) |
| `d78d887` | `school.json` fixture revert (중복·유해) |
| `58ecc69` | catalog-school 계획서 무효 기록 |
| `6fff0bb` | 대화 생성 시 페르소나 스냅샷 |
| `341dbd9` | 스토리 시작 장면 시드 + UI 장비/보유/특수 |
| `4911d0c` | `*` 토큰 분리 (별표 지문 속 이름) |
| `554ef08` | 별표 지문 겨냥이 말 속 이름보다 우선 + `beat_goal`→UI |

라이브 배포/재시작은 이 델타에 포함되지 않는다.

---

## 9. 사용자 샘플 vs 제품 (의도적 차이)

세 샘플 턴 (자리 앉기 / 귓속말 / 하연 과제)은 **형식 증인**이다. 골든 트랜스크립트가 아니다.

| 샘플 | 제품 |
|---|---|
| 루나·유라·하연이 한 턴에 모두 대사 | extra ≤ 2, 루나/유라는 기본 ambient |
| 유라💭 / 미르 대사 | thought는 포커스만. locked/미르는 슬롯 없음 |
| `⌛9｜8/20[목] 아침 09:40🌥️` + 장소 2행 | `1일차 · 목 · 09:38 · 맑음 · 교실` 한 줄 (요일은 장면 필드가 있을 때) |
| `silu.uk/h/나리/👕/n.webp` | 로컬 경로 또는 생략 |
| 교복(깃 그을음), 합동 과제 힌트가 산문으로 생김 | 서버 상태만. 모델 문장에서 gear/beat_goal를 파싱하지 않음 |
| 시계 09:38→09:39→09:40 | `advance_minutes` 델타가 허용되면 변함. 턴마다 +1분은 자동이 아님 |

§7 교실 표의 증인은 격리 벤치 `focusResolve` / `eligibleExtras` / `approveExtras` / `ambient` (나리·세라·하연·유라·루나·미르, 어설션 ~95). 라이브 서리/카이 스토리 catalog는 비어 있어 `k_opened=0`이 구조적으로 정상이다.

---

## 10. 테스트 (출하 경로)

```text
cd /home/hermes/rpchat/app
npx tsx bench/focusResolve.test.ts
npx tsx bench/partyBeatFormat.test.ts
npx tsx bench/partyBeatPersist.test.ts
npx tsx bench/composeBeat.test.ts
npx tsx bench/beatRender.test.ts
npx tsx bench/beatRenderWeb.test.ts
npx tsx bench/eligibleExtras.test.ts
npx tsx bench/approveExtras.test.ts
npx tsx bench/ambient.test.ts
npx tsx bench/settingsRegression.test.ts   # git diff HEAD -- apps/server 가 비어야 함. 펜스 파일을 고치지 말 것
```

- `partyBeatFormat`: 교실 픽스처 + 출하 `planBeat`/`finishBeat`/`renderHeader`/`renderUi`. 합성 id. 서리/카이 없음.
- `partyBeatPersist`: 임시 DB + 실제 Fastify 라우트 + fake model. 스토리 시작 시드, 3회 `POST /messages`, 장면 location/clock 유지, 3번째 전송은 하연 겨냥+나리 언급.

`settingsRegression` 펜스: `git diff HEAD -- apps/server` empty. 커밋이 조건을 참으로 만든다. 파일 수정 금지 (F7-settings 증거).

---

## 11. 금지 (STATUS F9 · catalog-write 잠금)

- 교실 캐스트를 **라이브** DB에 삽입 (`f9-school-seed` 등)
- `silu.uk` fetch / 외부 이미지 호스트
- `EXTRA_SCORE_ENABLED = true`, K=1 실험, party legacy (`pickSpeaker`/`auxGate`/`composePartyTurn` 삭제됨)
- 1:1 `buildPrompt` / `HARD_RULES` / `PROMPT_VERSION` 변경
- `scene_catalog` default 되돌리기, `stories.ts`에 두 번째 catalog 파서
- `settingsRegression` 펜스 수정
- ADR-F9 본문 재작성
- 무효된 `f9-beat-catalog-school.md`를 열린 슬라이스로 읽기

롤백: 파티 레거시 플래그 없음. 코드 롤백 = `1e827f1` 또는 해당 커밋 checkout.

---

## 12. 리뷰어가 보면 좋은 갭 (미결, 실행 지시 아님)

아래는 **관찰 후보**다. 이 문서가 수리를 승인한 것이 아니다.

1. **헤더 형식** — 샘플의 날짜/요일 괄호/아침/이모지/2행 장소 vs 지금 ` · ` 한 줄.
2. **시계** — 턴마다 1분 증가가 없음. 델타 `advance_minutes`만.
3. **UI 힌트·장비 변화** — `beat_goal`/gear는 서버 상태. 하연이 “합동 과제”를 말해도 자동 기입되지 않음.
4. **포커스 외 속마음** — 유라💭는 포커스가 하연이면 블록이 안 생김. Pass N 서술로만 가능.
5. **미르 한 줄** — locked이거나 extra 미승인이면 슬롯 없음. 서술은 ambient.
6. **`story_characters.role`** — API가 `main`만 받음. 파티는 태그로 동작하지만 저작 UX와 어긋남.
7. **라이브 미배포** — HEAD `554ef08` ≠ 프로세스 `130631`이 로드한 dist.
8. **1:1 무영향** — 파티 변경이 `buildPrompt` system 바이트를 건드렸는지 (`onePointOneBaseline` / 6개 `story_id IS NULL`).
9. **별표 지문** — 대사 속 `*강조*`에 이름이 있으면 겨냥으로 오인할 수 있음.
10. **조사 `씨`** — `나리씨`(붙여 쓰기)는 조사가 아님. `나리 씨`는 공백으로 분리됨.

---

## 13. 핵심 파일

```text
apps/server/src/routes/chat.ts              generateBeat, SSE
apps/server/src/routes/conversations.ts     생성, 인사, 페르소나 스냅샷, 장면 시드
apps/server/src/prompt/composeBeat.ts       planBeat / finishBeat
apps/server/src/prompt/renderBeat.ts        header / ui / serialize / assetPathFor
apps/server/src/prompt/resolveFocus.ts      겨냥
apps/server/src/prompt/approveExtras.ts     extra 0~2
apps/server/src/prompt/eligibleExtras.ts
apps/server/src/prompt/ambient.ts
apps/server/src/prompt/passes.ts            Pass N/F/E, 속마음:
apps/server/src/prompt/initScene.ts         스토리 시작 시드
apps/server/src/prompt/tagsCatalog.ts       party: 태그
apps/server/src/prompt/sceneCatalog.ts      stories.scene_catalog 파서
apps/web/src/pages/ChatPage.tsx             block_kind 분기
apps/web/src/components/view.tsx            Beat* 렌더러
apps/web/src/pages/useChat.ts               aux/start/token/done
```

---

## 14. 리뷰 답변 형식 (제안)

각 이슈마다:

- 심각도 (차단 / 계약 불일치 / UX / 테스트 구멍)
- 파일:줄 또는 함수명
- 재현 (입력 한 줄 + 기대 블록)
- 제안이 F9 금지 열을 건드리는지
- 1:1 경로 바이트가 변하는지

코드 패치를 이 문서에 넣지 말고, 사용자가 리뷰를 가져온 뒤 별도 잠금/슬라이스로 적용한다.
