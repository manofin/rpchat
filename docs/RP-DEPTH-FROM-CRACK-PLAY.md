# RP 밀도 개선 계획 — Crack 실플레이 → rpchat PWA

> 작성: 2026-09-09 (KST)  
> HEAD 기준(문서 작성 시점): `b44fbbb` (`master`, pull 후)  
> 근거: (1) Crack 실플레이(`/workspace/crack-play`, `/workspace/crack-rp-positive`, `/workspace/crack-rp-yuanying`) (2) 사용자 첨부 PWA 샷(유키-smoke / 첸 파티형) (3) 이미 선적된 rpchat 축(SSE·F9·메시지 트리·기억 동의·ConversationTools·StoryForge UX S1–S5·테마·필드 한도)  
> 원칙: **불확실하면 존재한다고 쓰지 않는다.** 「Crack play 대비 갭」으로 적는다.  
> 가드: 슬라이스가 **1:1 프롬프트 경로 바이트**를 건드리면 안 된다는 표기를 명시한다. 파티/씬 경로만 서버를 만질 때에도 `bench/onePointOneBaseline` 게이트를 전제로 한다.

---

## 0. 한 줄 진단

**크롬(턴 로딩·칩·스톱·일차 구분·HP/₩ 스트립)은 이미 Crack 감각에 가깝고, 밀도(읽기 타이포 + 살아 있는 상태창 + 턴을 넘는 진행 규칙)가 아직 얇다.**

---

## 1. Crack 실플레이에서 느낀 핵심 루프 (what made it feel dense)

실플레이(선협「원영기」스토리 + 캐릭터챗)에서 밀도를 만든 것은 긴 문장이 아니라 **루프의 층**이었다.

### 1.1 턴 루프 (매 입력마다)

1. 유저 행동이 즉시 말풍선/행으로 올라감  
2. **「세계관에 반영…」** 류의 명시적 로딩 + 전송→중단(스퀘어) 전환  
3. 스트림으로 서술·대사가 쌓임  
4. 턴 끝에 **INFO/상태 블록**(경지·수명·체력·영력·소속 등)이 갱신되는 느낌  
5. **추천 3칩 + 연필→편집**으로 다음 행동을 고르거나 다듬음  

→ 「채팅」이 아니라 **한 박자마다 세계가 한 칸 전진**하는 감각.

### 1.2 읽기 루프 (시선)

- **서술 = 옅은 회색**, **대사 = 진한 본문 + `이름 | 「…」`** 같은 화자 표식  
- 캐릭터챗은 버블·아바타, 스토리는 소설형 단락 — 모드별 타이포가 다름  
- INFO는 본문과 **한 단계 분리된 표면**(어두운 카드)이라 메타 정보가 서술을 덮지 않음  

### 1.3 조향 루프 (플레이어 에이전시)

- `*` / `/` 단축·추천답변으로 **톤·금기·진행 속도**를 빠르게 틀 수 있음 (실플레이에서 negative-prompt식 조향으로 체감)  
- 추천칩은 「계속」이 아니라 **장면 안의 구체 행동/대사**  

### 1.4 진행 루프 (마찰이 밀도)

- 경지·체력·영력·수명이 **턴을 넘어 누적**되는 듯 보임  
- 빠른 파워업을 AI가 자주 거절/지연 → **마찰이 스토리 긴장**이 됨 (다만 Crack은 규칙이 프롬프트/모델 쪽에 가깝고, 플레이어에게는 불투명)  
- 호감/관계·계약류 수치가 INFO에 붙으면 「세계가 기억한다」는 느낌이 강해짐  

### 1.5 모드 분기

- **스토리/에피소드**: INFO + 소설형 + 추천칩 중심  
- **캐릭터챗**: 버블·아바타·온디맨드 추천 생성  
- **파티챗 탭**은 IA상 존재하나, 이번 실플레이 밀도 감각의 중심은 스토리 INFO 루프였음  

---

## 2. 현재 PWA 샷 기준 강점 / 빈칸

대상 샷: **유키-smoke / 첸** 파티형 채팅 (다크 PWA). 헤더에 캐릭터명·프로필(`rp-balanced · 페르소나`), 햄버거/⋯.

### 2.1 이미 보이는 강점 (샷 + 코드 교차)

| 관측 | rpchat 축 (확인된 것) |
|------|----------------------|
| 서술(배경 텍스트) + 화자 버블 혼재 | F9 beat `block_kind` (`narration` / `line` …) + `BeatNarration` / 버블 |
| `1일차 · 09:38` 구분선 | beat header / day·time 렌더 |
| `HP 100 · ₩ 0` + 로스터 칩(잠금 아이콘) | `BeatUiPanel` ← `ui` 블록 JSON (`user_sheet`, `roster[].locked`) |
| 추천 칩 + 왼쪽 연필 | `ChoiceChips` (`meta.choices`, S2) |
| `세계관에 반영 중…` + 점 애니메이션 | `ChatPage` `gen-status` |
| 생성 중 ■ 스톱 / 유휴 ↑ 전송 | `useChat.stop` / SSE 생성 계약 |
| 메시지 편집·즐겨찾기·삭제 아이콘 | 메시지 크롬 (트리/분기와 별개 액션 노출) |

### 2.2 선적된 제품 강점 (샷 밖, 이미 있는 것)

- **SSE 스트리밍** + 중단/재개 폴링 계약  
- **1:1 vs 파티 beat (F9)** 경로 분리, 서버 정본 `scene_json`  
- **메시지 트리** (regenerate / branch / sibling)  
- **기억 동의(후보→승인)** 흐름  
- **ConversationTools** 허브 (가이드·프로필·메모리·노트 등)  
- **StoryForge UX 포트 S1–S5** (셸 드로어·턴 크롬·도구·디스커버리·폴리시)  
- **테마 토글**, **캐릭터 필드 한도 + 카운터**  

### 2.3 샷 기준 빈칸 / 얇은 지점 (Gap vs Crack play)

| 빈칸 | 메모 (단정 금지) |
|------|------------------|
| 서술↔대사 **타이포 대비**가 Crack보다 약함 | 샷에서는 따옴표/이탤릭에 의존. Crack의 회색 서술 + `「」` 대비만큼 읽히지 않음 |
| 상태 UI가 **한 줄 스트립** | Crack INFO(경지·수명 바·소속) 대비 정보량·시각 위계 부족. `dialog`/`hunter` INFO 시트·`BeatInfoSheet`는 코드에 있으나, **이 샷의 유키-smoke 세션에 그 카드가 보인다고 단정하지 않음** |
| 호감/계약/경지 등 **관계·수련 축** | 샷에 ❤️😐💢·경지 행 없음 → Crack play 대비 갭 |
| `*` `/` **단축 조향** UI | 샷의 composer에 Crack형 단축 칩 없음 → 갭(서버 지원 여부는 이 문서에서 미검증 = 갭으로만) |
| 추천칩 **품질/장면 적합성** | UX는 있음. 「장면 안 구체 행동」인지는 모델·프롬프트 품질 이슈 — 훅만 R2에 적음 |
| 멀티 화자 **포커스/잠금 가독성** | 잠금 칩은 있으나 Crack/파티 의도의 「지금 누가 말하나」 포커스가 한눈에 약한 편 |
| 진행 **마찰의 서버 소유** | HP/₩는 `user_sheet`로 서버 정본 가능. 경지 파워업 거절 같은 규칙은 Crack처럼 모델 임기에 맡기면 불투명 — rpchat은 서버 규칙을 택할 여지 |

---

## 3. 갭 매트릭스 (Crack play → rpchat 상태 → 우선순위 P0–P2)

범례: **있음** = 제품에 실재 / **부분** = 축은 있으나 밀도·노출 부족 / **갭** = Crack에서 체감했으나 rpchat에 없거나 미확인.

| # | Crack play 체감 | rpchat 상태 | 우선 | 비고 |
|---|-----------------|-------------|------|------|
| G1 | 서술/대사 시선 분리 | **부분** (`beat-narration` vs bubble; 대비·「」 폴리시 약함) | **P0** | R1 |
| G2 | 일차·시각 구분으로 장면 호흡 | **있음** (헤더/구분선) | P1 | R1 폴리시 |
| G3 | INFO 상태창(경지·바·소속) | **부분** (HP/₩ 스트립 + format별 INFO 렌더러; 샷·기본 파티에 밀도 부족) | **P0** | R1 스트립 1급화 → R3 시트 |
| G4 | 세계관 반영 로딩 + 스톱 | **있음** | P2 | R2 체감 정렬 |
| G5 | 추천 3칩 + 연필 편집 | **있음** | P1 | R2 품질 훅 |
| G6 | 단축/`*` `/` 조향 | **갭** (샷 미관측; 구현 단정 금지) | P2 | R2 이후 검토 |
| G7 | 관계가 수치로 남는 느낌 | **갭** (affinity UI/스키마 미확인) | P1 | R3 |
| G8 | 경지/퀘스트가 턴을 넘김 | **부분** (`hunter.quest`·`user_sheet` 등 서버 필드 존재; 선협 경지 규칙·UI는 갭) | **P0→P1** | R4 |
| G9 | 빠른 파워업 거절 마찰 | **갭** (모델 임기 vs 서버 규칙 — rpchat은 후자 권장) | P1 | R4 |
| G10 | 파티 다중 화자·잠금 | **부분** (roster lock 칩; 포커스 화자 강조 약함) | P1 | R5 |
| G11 | 모바일 밀도·safe-area | **부분** (S1/S5 선적; 헤더 밀도·칩·오프라인 셸은 추가 여지) | P2 | R6 |

---

## 4. 로드맵 슬라이스 (R1–R6)

공통 가드:

- **First PR = R1 only** (§6).  
- 기본: `apps/server` diff = 0. 서버가 필요하면 표에 **yes** + **1:1 프롬프트 비접촉**을 적는다.  
- F9/파티만 만질 때: `story_id IS NULL` 1:1 경로 바이트·`HARD_RULES`/`builder` 1:1 조립 **무변경**을 PR 체크리스트에 복사.

### R1 — Chat readability (첫 PR)

**목표:** 샷에 이미 있는 블록을 「읽히는 RP」로 올린다. 새 시스템 없음.

- 서술 vs 대사 타이포: `.beat-narration` 대비·행간; `line`/버블 안 대사 강조(따옴표/`「」` 폴리시 — **표시만**, 프롬프트 출력 형식 강제 금지)  
- 일차·시각 구분선 시각 위계(Crack식 호흡)  
- **status strip 1급 UI**: `BeatUiPanel`의 HP/₩/roster lock을 본문과 분리된 고정 위계로 (scene/beat `ui` 블록에 묶인 채)  
- 헤더(캐릭터+프로필)와 스크롤 본문의 밀도만 조정 — API 변경 없음  

| | |
|--|--|
| **Success** | 유키-smoke/첸 표본에서 서술·대사·스트립·구분선이 한 눈에 역할이 갈림. 기존 SSE/칩/스톱 회귀 없음. |
| **Server-touch** | **no** |
| **1:1 prompt** | **비접촉** (web CSS/컴포넌트만) |

### R2 — Turn chrome parity

**목표:** 이미 있는 세계관 반영 카피·스톱·칩·연필·스트림 체감을 Crack 턴 루프에 맞춘다.

- 로딩/스톱/칩 비활성 타이밍 폴리시 (S2 재점검)  
- 추천 답변 **품질 훅**: 클라이언트는 기존 `meta.choices`만 소비. 품질 개선이 필요하면 **파티 beat choices 생성 경로만** 후속 브리프 — 이 슬라이스에서 1:1 choices 프롬프트를 바꾸지 않음  
- (옵션, P2) composer 단축 UI는 **표시/주입만**; 서버 명령 체계를 새로 만들지 않음  

| | |
|--|--|
| **Success** | 생성 중 ■·`세계관에 반영 중…`·칩+연필이 Galaxy에서 Crack과 같은 제스처로 읽힘. |
| **Server-touch** | **no** (품질 훅이 서버면 별 PR; 그 PR도 1:1 prompt path 금지) |
| **1:1 prompt** | **비접촉** |

### R3 — Living world state

**목표:** Crack INFO에 해당하는 **압축 상태**를 유저가 읽고·고칠 수 있게.

- 호감 ❤️😐💢·계약·경지/수련 등 → **기존** `scene_json` / beat `header`·`ui`·`info`/`hunter` 필드에 **매핑** (새 테이블 금지 기본)  
- 없는 키는 **갭으로 남기고** ADR/마이그레이션 없이 UI만 假로 만들지 않음  
- 유저 가시 **시트**(읽기 + 명시적 편집) — ConversationTools 또는 시트 패널. 모델이 수치를 렌더하지 않는 F9 원칙 유지  

| | |
|--|--|
| **Success** | 파티 세션에서 상태 시트가 턴 사이에 유지·표시. 편집이 `scene_json` 정본에 반영. 1:1 대화 화면·프롬프트 바이트 무변. |
| **Server-touch** | **maybe → yes** (scene 필드 노출/패치 API가 없을 때만). **1:1 prompt path 금지.** |
| **1:1 prompt** | **비접촉** |

### R4 — Progression systems

**목표:** 경지·호감·퀘스트가 **플레이버 텍스트가 아니라 턴 생존 상태**가 되게.

- 서버 소유 규칙: 허용된 delta만 적용 (기존 `user_sheet` / applySceneDelta 패턴 확장 검토)  
- Crack의 「AI가 빠른 파워업을 거절」을 **불투명 모델 거절**로 복제하지 않음 → **서버 규칙**(상승 조건·쿨다운·비용)으로 마찰을 설계  
- 퀘스트/경지는 `hunter.quest` 등 **이미 있는 슬롯**을 우선 재사용  

| | |
|--|--|
| **Success** | 동일 시나리오 리플레이에서 수치/퀘스트가 헤드 분기를 따라 일치. 불법 상승 제안은 커밋되지 않음. |
| **Server-touch** | **yes** (scene commit / delta allow-list). **1:1 prompt path 금지.** party/beat 경로만. |
| **1:1 prompt** | **비접촉** (필수) |

### R5 — Multi-speaker party UX

**목표:** 샷의 잠금 칩을 「캐스트 상태」로 읽히게.

- block kind 시각 구분 강화 (`header` / `narration` / `line` / `thought` / `ui` / `info`)  
- **포커스 화자** 강조 (`last_beat.focus_id` 등과 연결 — 필드 존재는 types에 있음; UI 미연결이면 갭→연결)  
- locked cast 인디케이터를 샷의 자물쇠와 동일한 언어로  

| | |
|--|--|
| **Success** | 유키+첸 표본에서 누가 말하는지·누가 잠금인지 스크롤 중에도 유지. |
| **Server-touch** | **no** 기본 (표시만). 포커스 메타가 부족할 때만 party 경로 yes. |
| **1:1 prompt** | **비접촉** |

### R6 — Mobile PWA polish

**목표:** S1/S5 이후 잔여 모바일 밀도.

- 헤더 밀도, safe-area, 칩 연필 터치 타깃  
- 오프라인 셸(기존 vite-plugin-pwa 전제 — **캐시 전략 과대 공언 금지**, 셸 가용성만)  

| | |
|--|--|
| **Success** | Galaxy 체크리스트에 R1–R5 잔여 모바일 항목 증거 슬롯. |
| **Server-touch** | **no** |
| **1:1 prompt** | **비접촉** |

---

## 5. 명시적 비목표

| 비목표 | 이유 |
|--------|------|
| Crack 브랜드·카피·크레딧샵·Cracker 잔액 UI 복제 | 제품·결제 축 아님. StoryForge 포트 §6과 동일 |
| HyperChat 등 외부 모델 티어 메뉴 복제 | rpchat 모델/프로필 계약 유지 |
| Image studio / 내작품 / 상황이미지 CDN | 별 표면; F9 asset 허용목록 전제 미성숙 |
| Crack의 「모델이 파워업을 임의 거절」 UX를 그대로 흉내 | 불투명. **서버 규칙**으로 대체(R4) |
| 1:1 프롬프트/`HARD_RULES`/builder 1:1 조립 변경으로 밀도 만들기 | F9 ADR·바이트 안정 계약 위반 |
| 새 INFO 필드를 UI에 하드코딩해 서버 정본 우회 | 모델·클라이언트가 수치를 발명하는 길 |
| 이 문서를 구현 PR에 몰아넣기 | **문서만**. 커밋은 사용자 결정 |

---

## 6. 제안 첫 PR = R1 only

**제목 예:** `web(ui): RP readability — narration/speech, day rule, status strip (R1)`

### 포함

- `apps/web` 타이포·구분선·`BeatUiPanel`/관련 CSS만  
- Galaxy/좁은 뷰포트에서 유키-smoke형 파티 스크롤 가독성  

### 제외

- `apps/server`  
- choices 품질·affinity 스키마·경지 규칙·오프라인 정책  
- 1:1 메시지 버블 의미 변경(파티 `block_kind` 없는 메시지는 기존 버블 유지)

### 검증

- 수동: 첨부 샷과 같은 파티 대화에서 서술/대사/스트립/구분선 위계  
- 회귀: 전송·SSE·스톱·칩+연필·1:1 채팅 무변  
- 서버 diff = 0  

### 다음

R1 merge → R2 → R3…  
R3/R4에서 서버가 필요해지면 **별 브리프** + 1:1 baseline 게이트.

---

## 부록 A — 근거 경로

| 종류 | 경로 |
|------|------|
| Crack 턴 UX 노트 | `/workspace/crack-play/FINDINGS.md` |
| Crack 모바일 | `/workspace/crack-mobile/FINDINGS.md` |
| 선협 실플레이 샷 | `/workspace/crack-rp-positive/*`, `/workspace/crack-rp-yuanying/*` |
| PWA 샷(유키-smoke/첸) | 사용자 첨부(2026-09-09) — 헤더·버블·`1일차`·HP/₩·잠금·칩·`세계관에 반영 중…`·■ |
| UX 포트 계약 | `docs/STORYFORGE-UX-PORT.md` (S1–S5 완료 표기) |
| F9/scene 정본 | `docs/context/ADR-F9-scene-engine.md`, `apps/server/src/types.ts` `Scene` |
| UI 블록 | `apps/web/src/components/view.tsx` (`BeatUiPanel`, `BeatNarration`, `BeatInfoSheet`) |
| 턴 크롬 | `apps/web/src/pages/ChatPage.tsx` (`세계관에 반영 중…`, `ChoiceChips`, stop) |

## 부록 B — 서버/프롬프트 바이트 안정 체크리스트 (매 PR)

```
[ ] apps/server diff = 0  (R1/R2/R6 기본)
[ ] 1:1 prompt path (builder/templates HARD_RULES 1:1) 바이트 무변
[ ] party/beat만 변경 시 onePointOneBaseline 통과
[ ] scene_json 새 키는 optional + 기존 행 바이트 정체 유지
[ ] 모델이 HP/경지/호감을 프로즈로 출력하도록 시키지 않음 (서버 정본)
```

---

*이 문서는 개선 계약이다. 범위·비목표·First PR=R1을 바꾸려면 문서를 먼저 고친다. 커밋/푸시는 하지 않는다 — 사용자 결정.*
