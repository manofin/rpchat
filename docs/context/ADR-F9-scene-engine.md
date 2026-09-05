# ADR-F9 — Scene Engine (GM 기반 다중 화자 RP)

- Status: accepted (아키텍처 결정만. 제품 채택은 Bench-Latency 게이트)
- Date: 2026-09-01T10:41:15Z
- HEAD (기준): `v0.0.19-78-g1e827f1-dirty` (`1e827f18c470812c79d022d9c29c71b55165cc7e`; `git -C /home/hermes/rpchat/app describe --tags --always --dirty` + `git -C /home/hermes/rpchat/app rev-parse HEAD`). dirty는 이 슬라이스와 무관한 기존 leftover(E-bytes `index.ts`/`adapter.ts`/`chat.ts`/`requestDump.ts` 등). 이후 describe가 바뀌어도 이 줄을 「현재」로 고쳐 쓰지 않는다.
- Author: Hermes, token `scene-engine-adr`
- Source: `/home/hermes/rpchat/Notes_260901_193454.txt` (F9 설계서 겸 실행 계획). §A-3~§A-6은 설명이 아니라 계약이다.
- Predecessor: `planning_documents/ADR-F5-world.md` (Status **accepted-A**, 정의 4, sha256 `de683800addec0ce9135af686b329201e4567200a38105178b63a5fb3f161cf9`). `ADR-F8-story.md` / `ADR-F8b-story-inject.md` / `ADR-F8c-story-authoring.md`. **이 파일은 F5·F8 계열을 대체하지 않는다.** ADR-F5 §4가 「`character_id NOT NULL` 유지, 변경은 별도 후속 ADR에서만」으로 명시한 그 후속 ADR이다.
- 범위: 이 문서 1개. `apps/**` 0. 마이그레이션 0. 라이브 DB 쓰기 0. 침묵은 어떤 코드 슬라이스도 아니다.

F9~F9H 잠금명 사전 검색 (`grep -rn "F9" planning_documents/ app/PROGRESS.md`, 작업 디렉터리 `/home/hermes/rpchat`, EXIT 1, 출력 0행): 미사용.

---

## 1. Decision needed

**Scene RP는 GM 기반인가 — YES.**

F9 전체가 여기서 갈린다. 장면 전진·상태 변경·침묵 결정의 책임은 개별 NPC가 아니라 엔진에 있다. NPC 카드는 「누구인가」만 담고 「언제 말하는가」는 담지 않는다.

이것은 멀티 캐릭터 채팅이 아니다. PRD §5.3 C | 다중 캐릭터 장면 | 💭 | 구조 변경 큼 으로 등재된 C군 신규 제품이다. Story(F8)나 World(F5)의 연장이 아니다.

예시 화면이 요구하는 것은 시간줄·장소 채널·배경 이미지·여러 NPC의 독립 발화·하단 유저 HUD를 한 화면에 두는 것이지만, 실제로 일어나는 일은 「여러 NPC가 말한다」가 아니라 로비 → 등록 중 → 측정실 예약 전이라는 장면이 전진하는 것이며, 그 전진을 주관하는 GM이 있다. 화자 라우팅은 그 엔진의 한 부품일 뿐이다.

설계 축 넷 (1차 범위 F9A~F9F가 가리키는 엔진 축; Prompt/UI는 전달 슬라이스):

1. Scene State — 서버 정본. 모델은 제안만.
2. Scene Progression — GM. 장면이 전진한다.
3. Speaker Router — 누가 말하는가. 카드가 아니라 엔진이 고른다.
4. Multi Speaker — 메인 1 + 보조 최대 2. 배경 NPC 발화 금지.

아키텍처: **User → Scene Engine → Speaker Router → NPC.**

### 확정된 결정

| 항목 | 결정 |
|---|---|
| 아키텍처 | GM 기반. User → Scene Engine → Speaker Router → NPC |
| 1차 설계 범위 | F9A ~ F9F — Scene State · Scene Progression · Router · Multi Speaker · Prompt/UI |
| 발화 방식 | 라우터 + 화자별 개별 콜 (기본안). 1콜 2채널은 명시된 폴백 |
| 발화 인원 | 메인 1명 + 보조 최대 2명. 배경 NPC 발화 금지 |
| 상태 정본 | 서버. 모델은 제안(delta/patch)만 하고 수치를 렌더하지 않음 |
| 이미지 | asset_id 허용목록 · 로컬 자산만. 모델 URL 생성 금지 유지 |

---

## 2. 현재 지형 (raw 검증, 2026-09-01T10:41:15Z)

작성 시점 명령: `git -C /home/hermes/rpchat/app describe --tags --always --dirty` → `v0.0.19-78-g1e827f1-dirty`; `rev-parse HEAD` → `1e827f18c470812c79d022d9c29c71b55165cc7e`. 디스크 마이그레이션 `0001`–`0009`. `0010_*.sql` 없음.

| 사실 | 근거 (디스크) |
|---|---|
| 1:1이 DB 불변식 | `migrations/0001_init.sql:82` `character_id TEXT NOT NULL`. ADR-F5 §4 「1:1 불변 — 변경은 별도 후속 ADR에서만」 |
| 프롬프트가 캐릭터 1행 하드와이어 | `prompt/builder.ts:151-152` `SELECT * FROM characters WHERE id = ?` + 없으면 throw |
| 화자 개념 없음 | `messages`에 speaker 컬럼 없음 (`0001_init.sql:99-110`). `role`은 `'user' \| 'assistant'`뿐 (`types.ts:131`) |
| 「오직 {{char}}만 연기」 | `prompt/templates.ts:49` `renderRules` 전문. HARD_RULES 배열 2번(정체성·말투, `:15`)이 아님 |
| 장면 상태는 읽기 전용, 정본 자동 쓰기 없음 | PRD §3.4 (`RP-Chat-PRD.md:98`) / §4 원칙 4 (`:135`). `summaries.tier='state'`는 draft로만 삽입 후 승인 |
| 휴면 배관 | `story_characters`가 이미 N:M + role/sort_order (`0008_stories.sql:15-23`). zod `z.literal('main')` (`routes/stories.ts:38-41`). `buildPrompt`는 이 테이블 미조회 |
| 조연 블록·예산 선례 | `renderStory`/`storyCastLine` (`templates.ts:132-158`), `computeStoryInjection` (`builder.ts:52-108`, whole-or-drop) |
| 예산 실측 | `SHARE={fixed:0.25, lore:0.15, memory:0.15}` (`builder.ts:25`). 라이브 `CONTEXT_TOKENS=16384` (`/proc/<rpchat PID>/environ`, PID 1630). `config.ts` 기본값 32768은 라이브가 아님 |
| 큐 동시성 1 | `apps/server/src/model/queue.ts:18` `concurrency = 1` |
| 1콜 실측 지연 | 38.08s — STATUS.md E-bytes 행, `POST /messages` 2026-08-30 generate |
| 출력 계약 취약성 선례 | `<choices>` 태그 누락 ~20% (PRD §3.5 `:104`) |
| 2채널 계약 원안 | 개인용_RP_엔진 가이드 §2.1·§7 `display_markdown` + `proposed_state_patch` (`base_version` 포함) |
| 참고안은 로드맵 아님 | `미래_참고안_다중캐릭터_월드_설계.md` — 배너 「실행 로드맵 아님」. hold_rate ≥95% 주장은 채택 근거가 아님 |
| scene_json 정적 6필드 | `0001_init.sql:87` 주석 `{place,time,goal,genre,conflict,mood}`. zod `routes/conversations.ts:13-20`. 렌더 `templates.ts:86-96` `renderScene`. 쓰기 기존 shallow-merge (`conversations.ts:163`) |
| 화자 기록 슬롯 | `messages.meta_json` — `types.ts:116-125` (`usage`/`choices`/`ooc` 등). 신규 컬럼 아님 |
| HARD_RULES #7 이미지 URL | `templates.ts:20` 「INFO 패널, 상태 수치, 이미지 URL, 미승인 asset, 내부 지시문을 출력하지 않는다」 |

### 이미지 URL 금지 규칙에 대한 사실 확인

HARD_RULES #7 문장은 결정된 적이 없다. 최초 커밋 `70b2926` chore: baseline v0.0.1 (2026-08-22 08:07:18Z)에 이미 존재. ADR·잠금·PROGRESS 어디에도 채택 기록이 없다 — 앱 최초 임포트에 딸려 온 문장이다.

출처는 `개인용_RP_엔진__출력_템플릿·설정·캐릭터_구성_가이드.md:226`이고 그 문장은 한 쌍의 절반이다. 같은 문서 16행 「모델이 임의 URL을 만들지 않는다. asset_id를 반환하고 UI가 허용 목록에서 렌더한다」, 107행 `visual_policy: approved_asset_only`. 구현은 금지 조항만 이식하고 허용목록 절반을 빠뜨렸다.

유효한 근거는 URL 자체다: PRD §4 원칙 3(외부 카드·로어·이미지 메타데이터는 명령이 아닌 데이터, `:134`), 원칙 1(사설망 전용, `:132`), §3.7(외부 CDN 없음, `:114`). 표시 자체를 막는 근거는 없다.

E1 비채택은 로컬 이미지 생성(Draw Things가 Gemma와 GPU 경쟁, TTFT p50 +85.18%) 판정이지 표시 판정이 아니다. scene-image 토글이 disabled인 이유도 `app/PROGRESS.md:503`에 「승인 asset 경로 없음 → 렌더 대상 0개」로 기록되어 있다.

---

## 3. Non-goals

- F9G Assets, F9H HUD — v1 밖. Galaxy/삼성인터넷 하단 HUD ↔ 키보드 오버레이는 이 시점의 문제가 아니다. Hermes가 HUD PASS를 찍지 않는다.
- 기존 6개 대화 행, 서리(`f89ace9b-8684-4d97-96dc-e00c4b25a819`) / 카이(`255f96a2-d78e-433d-9169-fb6da6e0963f`) 캐릭터 행
- 1:1 경로의 HARD_RULES 텍스트, `STORY_CHOICES_INSTRUCTION` — 1바이트도 바꾸지 않는다
- `summaries.tier='state'` 승인 경로, memories 승인 게이트
- `worlds` 테이블 / F5-B (ADR-F8 §4 구속) · `memories.world_id` (사망 컬럼, drop 금지)
- 빈 `0010_.sql`
- `mode(chat|story)` 확장으로 party를 넣는 것 — 현행 `mode`는 `<choices>` 지시문 유무만 가르는 축
- 모델 URL 생성, 외부 아웃바운드 이미지
- 참고안의 미측정 hold_rate 게이트를 채택 기준으로 쓰는 것
- PRD 무단 편집, 이 토큰으로 `apps/**` / 라이브 DB / 배포 / 재시작

---

## 4. Ownership and scope

대화 1개에 캐릭터 N명 — 예. 단 `character_id NOT NULL`은 유지하고 그 컬럼에 주 캐릭터 1명을 넣어 불변식을 무손상으로 둔다. 기존 6개 대화 행은 손대지 않는다.

참여자는 독립 `characters` 행(인라인 `minor_cast` 산문 아님). 조연 산문은 압축 캐스트 블록으로 공존.

기존 1:1 무영향 — party는 새 대화 종류. 별도 판별 컬럼(현행 `mode`가 아님).

토큰 예산 — 활성 화자만 full card, 나머지는 압축 캐스트 블록.

HARD_RULES — party 프롬프트에서만 `renderRules` 전문(「오직 '{{char}}' 역할만 연기한다」, `templates.ts:49`)을 화자 한정 문구로 대체. 1:1 경로의 규칙 텍스트는 1바이트도 바꾸지 않는다. #7의 「INFO 패널·상태 수치」 조항은 F9H가 서버 정본 구조를 세운 뒤에만 손댄다.

이미지 방향 — 허용목록 복원 · 로컬 자산만. 기존 아바타 패턴(`media/avatar.ts` 2MB·매직바이트 스니프, 명시 라우트)을 복제해 `media/assets`로 수동 임포트. 외부 아웃바운드 0. (구현은 F9G, v1 밖.)

### 4.1 State Authority Matrix (A-3) — 계약

F9E는 PRD §4 원칙 4 및 §3.4(「장면 상태 읽기 전용, 정본 자동 쓰기 없음」)를 정면으로 건드린다. 해소책은 **모델은 제안만 하고 서버가 정본을 계산한다**이며, 가이드 원문도 같다: 「patch는 서버 검증 전에는 사실이 아니다.」

이 표는 설명이 아니라 계약이다. **여기 없는 필드는 기본 거부다.**

| 필드 | 정본 소유자 | 모델이 낼 수 있는 것 | 서버 검증 | 실패 시 |
|---|---|---|---|---|
| scene.time | server | `advance_minutes`: int 제안만 | 0 ≤ n ≤ 상한 | 시간 불변 |
| scene.weather | server | enum 값 제안 | enum 허용목록 | 불변 |
| scene.location | GM 제안 + 서버 검증 | 등록된 location id | id 허용목록 | 불변 |
| scene.stage | GM 제안 + 서버 검증 | 현재 arc에 속한 stage id | arc-stage 매핑 | 불변 |
| scene.arc | GM 제안 + 서버 검증 | 파티 정의에 선언된 arc id | arc 허용목록 | 불변 |
| scene.flags.* | GM 제안 + 서버 검증 | 선언된 flag key의 boolean | key 허용목록 + 타입 | 해당 키만 무시 |
| inventory | server | delta 제안만 | 재고·부호 검사 | 불변 |
| hp | server | delta 제안만 | 범위 clamp | 불변 |
| money | server | delta 제안만 | 음수 잔액 거부 | 불변 |
| relationship | **user approval required** | 후보 제안만 | 승인 큐 적재 | 후보로만 남음 |
| memories | user approval required | 후보 제안만 | 기존 candidate 경로 | 기존과 동일 |
| summaries.tier='state' | existing approval path | — (party가 쓰지 않음) | 기존 draft 경로 | 기존과 동일 |
| 메시지 본문 | model | 자유 서술 | — | — |

핵심 두 줄:

- party 장면 상태는 summaries의 state 티어와 **별개 저장소**다. 기존 승인 경로를 한 줄도 건드리지 않는다.
- **관계(relationship)는 자동 적용하지 않는다.** 수치가 자동으로 오르는 친밀도는 개인용_RP_엔진 가이드:160-170이 명시적으로 안티패턴으로 지목한 것이다. user approval required. 자동 적용 안 됨.

이름 충돌 (F9B가 갈라야 함): 기존 `scene_json.time`은 자유 문자열 6필드 중 하나(`conversations.ts:15`, `renderScene` 「시간」). 매트릭스의 `scene.time`(시계, `advance_minutes`)과 키가 같다. **기존 6필드는 그대로 둔다.** 시계는 별도 optional 키로 두는 쪽이 6필드 바이트 불변과 맞다. 키 이름은 F9B가 확정한다. 이 ADR은 매트릭스 필드명을 계약으로 유지하되, 저장 키 충돌을 F9B 게이트로 남긴다.

### 4.2 Scene State Lifetime (A-4) — 계약

`scene_json`은 장면 상태이지 영구 사실이 아니다. 초기화 시점이 없으면 `power_scan_pending: true` 같은 플래그가 입학식 한 달 뒤까지 살아남는다.

- **flags**: 선언 시 소유 stage를 함께 갖는다 (`{"key": "power_scan_pending", "owner_stage": "registration"}`). **소유 stage 전환 시 그 flag는 소멸**한다. 소유가 없는 flag는 arc 종료까지 유지.
- **stage**: **arc 전환 시 초기화**한다.
- **장면 종료 = archive.** 신규 테이블 0. 장면 종료 턴의 assistant 메시지 `meta_json`에 직전 `scene_json` 스냅샷을 남긴다. `summaries`를 재사용하지 않는다(그 경로는 승인 게이트가 걸려 있어 의미가 다름).
- **장기 기억으로 자동 승격하지 않는다.** 승격이 필요하면 기존 memory 승인 경로(사용자 승인)를 탄다. 이 한 줄이 요약 시스템과의 충돌을 막는다.

---

## 5. Options and pick — Turn Pipeline (A-5)

이 시스템 전체는 이 순서 하나로 정의된다. **불변식**이며 슬라이스 벤치가 순서를 어설션한다.

기본안: 라우터 + 화자별 개별 콜. 1콜 2채널(`display_markdown` + `proposed_state_patch`)은 명시된 폴백이지 기본이 아니다.

노트 원문의 단계 목록 `코드` 자리표시는 비어 있다. 아래 9단은 같은 파일의 아키텍처 문장(User → Scene Engine → Speaker Router → NPC), 「5가 2~4보다 뒤」, F9E/F9C/F9D 슬라이스 문장에서 조립했다. 번호에 다른 원문이 있으면 그 원문이 이긴다.

| # | 단계 | 하는 일 |
|---|---|---|
| 1 | User ingest | 사용자 메시지 기록 |
| 2 | Delta Proposal | GM STEP 1. 상태 변경 **제안**만 (`proposed_state_patch` / delta). 아직 사실이 아님 |
| 3 | Validate | A-3 매트릭스: 타입·허용목록·범위 |
| 4 | Apply or no-op | A-6. 통과한 키만 서버가 정본에 반영. 실패 키는 불변. 턴은 계속 |
| 5 | Speaker Routing | 4단계 점수. 앞 단계에서 결정되면 뒤로 가지 않는다. LLM은 최후 수단 |
| 6 | Slot / budget | 메인 1 + 보조 ≤2. 배경 NPC 발화 금지. 캐스트 예산 whole-or-drop (`computeStoryInjection` 재사용) |
| 7 | Main generate | 주화자 개별 콜 |
| 8 | Aux generate | 보조 화자 개별 콜. 큐 동시성 1이라 직렬 |
| 9 | Persist | `messages.meta_json.speaker_character_id`. 부분 실패여도 응답은 남긴다 |

**5가 2~4보다 뒤에 와야 한다.** 순서가 뒤집히면(Speaker Routing → Delta Proposal) NPC가 옛 상태를 기준으로 말한다 — 등록을 마쳤는데 여전히 로비 기준으로 안내하는 응답이 나온다. 이것이 F9에서 가장 조용하게 터지는 버그다.

Speaker Routing이 Delta Proposal보다 뒤에 와야 하는 이유: 라우팅 점수는 **갱신된** 장면(stage/location/flags)을 입력으로 쓴다. 제안이 적용되기 전에 고르면 침묵·발화 대상이 한 턴 늦다.

옵션:

- **P — 9단 파이프라인 + 화자별 콜 (채택).** 위 표. 벤치가 순서 어설션.
- Q — Speaker Routing을 Delta보다 앞. 거부 (조용한 스테일-스피치).
- R — 처음부터 1콜 2채널. 거부 (기본안이 아님). Bench-Latency 탈락 시에만 §8 폴백.

**Pick: P.**

라우터 출력은 단일 id가 아니라 점수다. 보조 화자 선택과 침묵 판정에 그대로 쓰인다: `{ "han_soyeon": 95, "yuki": 20 }`.

라우터 4단계 (Bench-A 픽스처와 동일 축; 앞 단계에서 결정되면 뒤로 가지 않음):

1. 명시 호명
2. 업무 적합성
3. 장면 위치
4. 모호 → LLM (최후 수단)

1~3단계는 `prompt/pickSpeaker.ts` 순수함수(DB 쿼리 0). `prompt/resolveStory.ts`가 같은 패턴의 선례. 역할 태그는 `characters.tags_json` 재사용 검토.

프롬프트 지시가 아니라 서버에서 강제한다 — 라우터 점수 상위 N만 발화 슬롯을 받고 나머지는 캐스트 블록으로만 존재. 지시만으로 강제하지 않는 근거는 `<choices>` 20% 누락 실적이다.

허용 예: 한소연 10줄 / 유키 2줄. 금지 예: 한소연 6 / 유키 5 / 경비원 4 / 청소부 3.

---

## 6. Failure Policy (A-6) — 독립 섹션

F9는 1:1보다 실패 지점이 훨씬 많다. 공통 원칙 한 줄:

**어떤 실패도 턴을 죽이지 않는다. 상태는 보수적으로(변경 없음), 응답은 계속 생성한다.**

이는 `extractChoices`가 파싱 실패 시 본문을 보존하는 것과 같은 자세다 (`templates.ts:173-184`).

| 실패 지점 | 조건 | 정책 | 대응 벤치 |
|---|---|---|---|
| 라우터 | 모든 score 0 / 후보 0 | main character 폴백 | Bench-F |
| 라우터 LLM | timeout·파싱 실패 | 1~3단계 최고점, 없으면 main | Bench-F |
| delta 스키마 | `{"location": null}` 등 타입 위반 | 해당 키만 무시. 상태 유지, 응답 계속 생성 | Bench-F |
| delta 키 | 허용목록 밖 키 | 해당 키만 drop + 진단 기록 | Bench-F |
| base_version | `base_version=12` vs 현재 13 | patch 전체 discard, response continue | Bench-F |
| 보조 NPC 생성 | 유키 응답 timeout | 주화자만 출력 | Bench-F |
| 주화자 생성 | timeout·에러 | 기존 1:1 실패 경로와 동일 (`status='error'` 행) | Bench-F |
| 화자 태그 | 응답에 화자 태그 누락 | 전체를 주화자 발화로 귀속 | Bench-F |
| 캐스트 예산 | 16K 초과 | whole-or-drop (`computeStoryInjection` 재사용) | Bench-F / Bench-Latency |

각 행은 대응하는 벤치 케이스를 갖는다. **정책이 문서에만 있고 테스트가 없으면 채택하지 않는다.**

---

## 7. Consequences

- **지금 (`scene-engine-adr`):** 이 문서만. `apps/**` 0. 마이그레이션 0. 라이브 DB 0.
- party 장면 상태는 summaries state 티어와 분리된다. 기존 승인 경로는 한 줄도 안 건드린다.
- relationship / memories는 후보만. 자동 친밀도는 없다.
- 1:1 `HARD_RULES` 텍스트 불변. party 분기에서만 전문을 화자 한정으로 바꾼다.
- `character_id NOT NULL` 유지. 주 캐릭터 1명이 그 컬럼에 남는다.
- 지연: 현행 1콜 실측 38.08s, 큐 동시성 1, 라우터도 같은 Gemma-31B(모델은 하나뿐). 통상 턴 = 2콜 ≈ 76s. 라우터가 LLM까지 가면 3콜. Bench-Latency에서 탈락할 가능성이 실질적으로 있다. 「경량 라우터 = 무료」로 가정하지 않는다 (짧은 JSON이어도 prefill은 남는다).

---

## 8. Review conditions

아래가 관측되면 이 ADR의 기본안을 재검토한다. 사후 완화로 임계를 낮추지 않는다.

1. **Bench-Latency 탈락** — F9 전체의 채택 게이트. 폴백은 STEP1+STEP2를 1콜 2채널(`display_markdown` + `proposed_state_patch`)로 합치는 것. 개인용_RP_엔진 가이드 §2.1이 이미 규정한 설계. 전환은 새 잠금 이름.
2. 기존 1:1 대화의 `GET /api/conversations/:id/prompt-preview` system 블록 바이트가 party 분기 추가로 달라짐 — 슬라이스 실패. 롤백.
3. relationship이 승인 없이 수치 적용됨 — 계약 위반. 채택 철회.
4. flag가 소유 stage 종료 뒤에도 남음 / 장면 종료가 summaries 승인 경로로 승격됨 — lifetime 위반.
5. Turn Pipeline에서 Speaker Routing이 Delta Apply보다 앞 — A-5 위반. 벤치가 막아야 한다.
6. 빈 `0010_.sql` 또는 `character_id NOT NULL` 해제 시도 — 금지. 이 ADR이 허용하지 않는다.

---

## 9. 게이트된 슬라이스

실행 순서 (재배치 확정):

**ADR → Bench-A → Bench-Latency → F9B → F9E → F9C → F9D → F9F**

Bench-A와 Bench-Latency는 제품 코드 없이 실행 가능하다. 그래서 스키마보다 먼저 온다.

**Bench-Latency는 F9 전체의 채택 게이트다.** 임계는 사전등록에서 확정하고 사후 완화하지 않는다 (F4/E1 전례).

각 슬라이스는 별도 잠금명, 소스 1개 + 벤치 1개. 침묵은 다음 슬라이스가 아니다.

### 벤치 (F9A 직후, 제품 코드 0)

사전등록: `app/bench/partyBench/preregistration.md`. 채택 기준을 먼저 못박는다. 전부 격리 실행 — 라이브 DB 무접촉.

| 벤치 | 측정 대상 | 게이트 |
|---|---|---|
| Bench-A 화자 선택 정확도 | 고정 픽스처(명시 호명 / 업무 적합성 / 장면 위치 / 모호)에 라우터만 태워 정확도 + 단계별 도달 분포 | 4단계 중 LLM까지 가는 비율이 지연의 직접 원인 |
| Bench-Latency | 턴당 실지연(콜 #1 + 콜 #2 직렬, 큐 동시성 1) + 16K 예산 초과 0 | **F9 전체의 채택 게이트.** 임계는 사전등록에서 확정 |
| Bench-B 스토리 연속성 | 10 / 20 / 50턴 후 장면 상태 유지 · 퀘스트 목표 유지 · NPC 역할 유지 | 실제 RP 품질의 본체. PRD §6 long-rp-fixtures-v1이 미고정이므로 이 벤치가 그 세트를 고정하는 기회. 50턴 × 2콜 × 38s ≈ 1시간+ → 야간 (`app/OVERNIGHT-BRIEF.md` 전례) |
| Bench-C NPC 혼선 | 한소연 말투가 유키 말투로 오염되는가 | 멀티캐릭터 고유 실패 모드. 캐릭터별 고정 문체 지표 + 사람 판정 |
| Bench-D 침묵 정확도 | 말해야 할 사람보다 말지 말아야 할 사람을 지키는가 | 픽스처에 「이 턴에 발화하면 안 되는 인물」을 정답 라벨로. 객관 프록시 = 배경 NPC 발화 0, 보조 화자 ≤2 |
| Bench-F 실패 정책 | A-6 표의 각 행 | 정책이 문서에만 있고 테스트가 없으면 미채택 |

### 코드 슬라이스 (Bench-Latency 통과 후)

- **F9B — Scene State (스키마).** `scene_json` additive 확장. 신규 `scene_clock` 테이블 없음. Scene / Quest / Narrative 세 계층은 저장소를 나누지 않고 의미로 분리한다 — arc(narrative) / stage·flags(quest) / time·location·weather(scene). 기존 6필드는 그대로, 새 키는 전부 optional → 기존 대화 6개의 `scene_json` 무변경. zod는 `routes/conversations.ts:13-20`, 렌더는 `templates.ts:86-96` `renderScene`, 쓰기는 기존 shallow-merge (`conversations.ts:163`) 재사용. 마이그레이션은 `0010_<slug>.sql` (디스크 0001–0009, 빈 파일 금지). §4.1 시계 키 충돌을 여기서 확정.
- **F9E — Scene Progression.** STEP 1의 출력은 A-3 매트릭스 + A-6 실패 정책을 통과해야만 반영된다. 이것이 없으면 영원히 로비에 갇힌다. 실행 순서상 라우터(F9C)보다 앞.
- **F9C — Router.** 4단계. `prompt/pickSpeaker.ts` 순수함수. 출력은 점수.
- **F9D — Multi Speaker.** 서버가 슬롯을 강제. `meta_json.speaker_character_id`.
- **F9F — Prompt 구조 · UI 렌더러.** party 경로 한정 블록 계약(1:1의 `###` 헤더 형식 무변경). `<current_goal>`이 특히 필요하다 — 아카데미 등록 완료 → 측정실 이동 같은 목표를 턴 너머로 유지. 계약 자체는 이 ADR에서 확정하고 F9B/F9D가 점진 구현한다(F9D가 동작하려면 블록이 먼저 있어야 하므로 이 슬라이스를 F9D 뒤로 미룰 수 없다). 이 슬라이스가 만드는 것은 클라이언트 렌더러 — 화자별 아바타 + 이름 + 대사 + 지문. 기존 MessageView/Avatar/renderContent 재사용, 말풍선 구조 유지, 화자 헤더만 추가.
- **F9G Assets / F9H HUD** — v1 밖.

### 각 슬라이스 검증 (코드가 열릴 때)

- 슬라이스별 격리 벤치 신규 + 인접 회귀 스윕 — 특히 `bench/builderBudget.test.ts`, `builderDifferential.test.ts`, `storyInject.test.ts`, `rpEngineR1.test.ts`(`<choices>` 계약), `summarizeContract.test.ts`
- 서버 + 웹 typecheck EXIT 0
- 마이그레이션 적용 전 sqlite3 `.backup` + `PRAGMA integrity_check` / `foreign_key_check` 전후 대조
- 1:1 무영향 증명: 기존 대화 1개에 `GET /api/conversations/:id/prompt-preview`를 슬라이스 전후로 실행해 system 블록 바이트 동일 확인
- Turn Pipeline 순서 어설션: 라우팅이 상태 갱신 뒤에 일어나는지를 벤치가 직접 검사 (A-5)
- 실동작은 party 대화 1턴 `POST /api/conversations/:id/messages`. 단 라이브 배포·재시작·generate는 각각 별도 명명 토큰 필요

이 토큰(`scene-engine-adr`)의 검증: 파일 존재 + sha256을 STATUS.md F9 행에 기록. 이 쓰기가 `apps/**` diff를 늘리지 않음 · 마이그레이션 0 · 라이브 DB 쓰기 0.
