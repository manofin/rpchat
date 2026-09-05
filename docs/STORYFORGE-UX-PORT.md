# StoryForge UX → rpchat `apps/web` 이식 계획

> 작성: 2026-09-05 (KST)  
> 범위: **UI only** — `apps/web` (Vite + React). StoryForge(`/workspace/storyforge`)는 **참고(reference)만**.  
> 비목표·제외·가드가 이 문서의 계약이다. 슬라이스 밖 작업은 PR에 넣지 않는다.

---

## 1. 목표 / 비목표

### 목표

- StoryForge의 **모바일·데스크톱 UX 패턴**(셸, 드로어, 턴 크롬, 추천 칩, 유틸 패널, 디스커버리 톤)을 rpchat `apps/web`에 **이식**한다.
- 기존 스택 유지: **Vite + React** (`apps/web`). Next.js로 재작성하지 않는다.
- 기존 서버 계약·스트림·분기 API를 **그대로** 소비한다. UI가 엔진을 바꾸지 않는다.
- 1:1 채팅과 F9 파티/씬 비트 경로의 **분리**를 유지한다. UI 포팅이 prompt/beat 조립을 건드리지 않는다.

### 비목표

| 항목 | 이유 |
|------|------|
| Next.js monorepo / App Router 이식 | rpchat web은 Vite. StoryForge의 `app/` 구조는 참고만. |
| Mock API / fixture 백엔드 | StoryForge `data/fixtures.ts`·`app/api/chat` 모킹을 가져오지 않는다. 실서버만. |
| 서버 prompt / beat / scene-engine 경로 변경 | F9 ADR·party beat와 1:1 분리는 서버 계약. UI PR에서 `apps/server` diff = 0을 기본으로 한다. |
| 새 서버 INFO 필드·스키마 추가 | 칩·중단·형제 분기는 이미 `meta.choices` / `useChat`에 존재. |
| Image studio / 내작품 / 크레딧 제품화 | StoryForge 제품 표면; rpchat 범위 밖 (§6). |
| StoryForge 컴포넌트 파일 그대로 복붙 | 토큰·라우터·API가 다름. **패턴 매핑** 후 rpchat 파일에 맞게 재구현. |

---

## 2. 역할

| 레이어 | 역할 | 이 작업에서의 권한 |
|--------|------|-------------------|
| **`apps/server`** | 엔진 (스트림, regenerate/branch/stop, choices meta, memory/summary, F9 beat) | **읽기·계약 준수만.** 포팅 PR에서 수정 금지(서버 가드). |
| **`apps/web`** | UI 타깃 | StoryForge UX를 여기만 반영. Vite/React/PWA 유지. |
| **`/workspace/storyforge`** | 참고(reference) | 룩앤필·인터랙션·카피 톤. 런타임 의존·공유 패키지·모노레포 병합 금지. |

원칙: **server = engine, web = UI target, storyforge = reference only.**

---

## 3. 재발명 금지 — 이미 있는 축에 붙인다

StoryForge에서 보이는 동작을 **새 훅/새 API로 다시 만들지 않는다.** rpchat에 이미 있는 심볼에 UX만 얹는다.

| StoryForge 패턴 | rpchat에 이미 있는 축 | 이식 시 할 일 |
|-----------------|----------------------|---------------|
| `RecommendationChoices` (칩 + 연필→편집) | `ChatPage`의 `ChoiceChips` + `m.meta.choices` | 칩 UX만 정렬: 탭=전송, **연필=composer에 텍스트 주입**(즉시 send 아님). 서버 choices 스키마 변경 금지. |
| 생성 중 / 중단 | `useChat`: `generating`, `stop`, `streamingId` | 로딩 카피·중단 버튼 위치·시각만 StoryForge에 맞춤. `stop` 계약 유지. |
| 재생성 / 분기 편집 / 형제 | `useChat`: `regenerate`, `branchEdit`, `selectSibling` | 메시지 크롬(스와이프·⋯메뉴) 폴리시. 새 엔드포인트 금지. |
| 좌측 세션 목록 / 우측 도구 | `ChatListRail`, `ChatDrawer`, `OverlayDrawer`, `ConversationTools` | 모바일 좌·우 드로어 셸을 **우선** 맞춘다 (S1). |
| 뷰포트 / 테마 | `lib/viewport.ts`, `lib/theme.ts`, `lib/useDesktopLayout.ts`, `lib/chatLayout.ts` | safe-area·키보드·다크/라이트·데스크탑 레일 모드 재사용. 새 layout 엔진 금지. |
| 대화 설정 허브 | `ConversationTools` + `Conversation*Page` leafs | UtilitiesPanel 톤을 **오버플로/허브 패널**로 매핑 (S3). 설정 API 재발명 금지. |

가드 문장(PR 체크리스트에 복사):

> Do not reinvent: map onto `ChoiceChips`/`meta.choices`, `useChat` (`stop`/`generating`/`regenerate`/`branchEdit`/`selectSibling`), `ChatDrawer`/`ChatListRail`/`OverlayDrawer`, `ConversationTools`, `viewport`, `theme`.

---

## 4. 매핑 표 — StoryForge 컴포넌트 → rpchat 파일

| StoryForge (reference) | rpchat 타깃 | 비고 |
|------------------------|-------------|------|
| `components/MobileShell.tsx` | `App.tsx` + `lib/useDesktopLayout.ts` + `components/OverlayDrawer.tsx` | 좌/우 상호배타 open, body scroll lock. |
| `components/MobileDrawer.tsx` | `components/OverlayDrawer.tsx` | side=`left`\|`right`, overlay/rail. |
| `components/TopNav.tsx` / `navTabs.ts` | `App.tsx` 네비 / 페이지 헤더 | 탭 IA는 rpchat 라우트에 맞게만. |
| `components/StorySidebar.tsx` | `pages/ChatListRail.tsx` | 캐릭터별 대화 목록 레일. |
| `components/ChatPanel.tsx` | `pages/ChatPage.tsx` + `pages/useChat.ts` | 턴 리스트·composer·stop·regenerate. |
| `components/RecommendationChoices.tsx` | `pages/ChatPage.tsx` → `ChoiceChips` | 연필→composer draft 주입. |
| `components/UtilitiesPanel.tsx` | `pages/ConversationTools.tsx` (+ leaf pages) | aside/drawer variant 정렬. |
| `components/ModelPicker.tsx` | `pages/ConversationProfilePage.tsx` / settings | 프로필·모델은 기존 API. |
| `components/CharacterDiscovery.tsx` | `pages/HomePage.tsx` + `pages/CharacterPage.tsx` | 디스커버리 톤만; fixture 데이터 금지. |
| `components/CharacterDetail.tsx` | `pages/CharacterPage.tsx` + `components/CharacterEditor.tsx` | 상세/편집 분리 유지. |
| `components/CharacterChatClient.tsx` | `pages/ChatPage.tsx` | 1:1 채팅 셸. |
| `components/StoryPageClient.tsx` | `pages/StoryPage.tsx` + `ChatPage` | 스토리/파티는 기존 라우트. F9 UI는 별 슬라이스. |
| `components/SearchResults.tsx` | `pages/SearchPage.tsx` | 검색 UX 폴리시 (S4). |
| `components/AvatarBadge.tsx` | `components/view.tsx` (`Avatar`) | 배지 스타일만. |
| `components/ImageStudio.tsx` | — | **제외** (§6). |
| `components/WorksPage.tsx` / `app/works` | — | **제외** (내작품). |
| `app/api/chat/route.ts`, `data/fixtures.ts` | — | **제외** (mock). 실 API: `lib/api.ts`. |
| Tailwind 토큰 (`surface-*`, brand) | `app.css` / `font.css` / `lib/theme.ts` | 토큰을 CSS 변수로 흡수; Tailwind 필수 도입 아님. |

---

## 5. 슬라이스 S0–S5

각 슬라이스 = 독립 PR 후보. **의존 방향: S0 → S1 → S2 → S3 → S4 → S5.**  
서버 diff 기본값: **0** (특히 S1).

### S0 — docs / guards

- 본 문서 (`docs/STORYFORGE-UX-PORT.md`) 확정.
- PR 템플릿/체크리스트에 가드 문구 추가:
  - `apps/server` 변경 없음 (예외는 별 ADR/브리프).
  - mock API·fixture 금지.
  - F9 prompt/beat 경로 비접촉.
  - 재발명 금지 표(§3) 준수.
- `docs/GALAXY-CHECKLIST.md`에 UX 포팅 후속 관측 항목 자리만 예고 (실측은 S5).

**완료 조건:** 문서 merge만으로 OK. 런타임 변경 0.

### S1 — App shell + mobile drawers ⭐ **PRIORITY / First PR**

- StoryForge `MobileShell` + `MobileDrawer` 패턴을 `OverlayDrawer` / 채팅 레이아웃에 이식.
- 모바일: 좌측 = 대화 목록 (`ChatListRail`), 우측 = 도구/설정 진입 (`ConversationTools` 또는 기존 drawer 진입점).
- 좌·우 동시 open 금지, 스크롤 잠금, Escape/백드롭 닫기, focus trap 유지·강화.
- 데스크톱: 기존 rail/overlay 모드 (`useDesktopLayout`)와 충돌 없이 정렬.
- **서버 diff = 0.** API·스트림 손대지 않음.

**완료 조건:** Galaxy/좁은 뷰포트에서 좌·우 드로어가 StoryForge와 같은 제스처 언어로 동작. 회귀: 기존 채팅 송수신 무변.

### S2 — Chat turn chrome

- 로딩/생성 중 카피·스피너 톤을 StoryForge `ChatPanel`에 맞춤.
- `stop` 버튼 배치·시각 (생성 중 composer 대체).
- `ChoiceChips`: 칩 탭 = send; **연필(✎) = composer에 해당 문구 주입** 후 사용자가 수정·전송.
- 메시지 액션: regenerate / branchEdit / selectSibling 노출을 StoryForge 크롬에 가깝게 (기존 핸들러만 연결).

**완료 조건:** `meta.choices` 있는 턴에서 칩+연필 동작; stop이 `useChat.stop`만 호출.

### S3 — Utilities / overflow panel

- `UtilitiesPanel`의 aside/drawer·토글 행 톤을 `ConversationTools` 허브에 반영.
- 오버플로(⋯)에서 메모리·가이드·프로필·스타일·유저노트 leaf로 기존 라우팅 유지.
- Image/크레딧 토글 등 StoryForge 전용 항목은 **넣지 않음**.

**완료 조건:** 모바일 우측 드로어 = 도구 허브; 데스크톱 aside와 정보 구조 일치.

### S4 — Discovery (Home / Character)

- `HomePage` / `CharacterPage` / `SearchPage`의 카드·필터·빈 상태 톤을 `CharacterDiscovery` 참고로 폴리시.
- **실 API 데이터만.** fixtures·가짜 likes 랭킹 금지.
- 캐릭터 → 대화 시작 CTA는 기존 `navigate` / conversation create 흐름 유지.

**완료 조건:** 홈·캐릭터·검색이 시각적으로 한 제품처럼 읽힘. 서버 스키마 변경 없음.

### S5 — Polish / README / Galaxy checklist

- 여백·타이포·포커스 링·safe-area 최종 패스 (`viewport` / `theme`).
- `README.md`에 「StoryForge UX 참고, Vite web이 정본」 한 절.
- `docs/GALAXY-CHECKLIST.md`에 S1–S4 실기기 항목 추가 (드로어, stop, 칩+연필, 도구 패널, 디스커버리).
- 잔여 CSS 부채·dead class 정리.

**완료 조건:** Galaxy 체크리스트에 증거 슬롯이 생기고, hermes가 기기 증거 없이 PASS 선언하지 않는 규칙 유지.

---

## 6. Exclusions (명시적 제외)

다음을 이 포팅 트랙에 **포함하지 않는다.**

| 제외 | 이유 |
|------|------|
| Image studio (`ImageStudio`, `/image`) | 별 제품 표면; rpchat 스케치/벤치와 혼동 금지. |
| 내작품 (`WorksPage`, `/works`) | StoryForge 창작 허브; rpchat 범위 밖. |
| Credits / 과금 UI | 제품·결제 미도입. |
| 새 서버 INFO 필드·마이그레이션 | choices·generation은 기존 계약으로 충분. |
| Next monorepo / StoryForge를 패키지로 흡수 | 참고만. 빌드·라우팅 이원화 금지. |
| Mock chat API / fixtures를 web에 심기 | dogfood는 실서버. |
| F9 prompt·beat·speaker-router 서버 경로 | ADR-F9; UI 포팅과 분리. |
| StoryForge Tailwind 강제 도입 | CSS 변수/`app.css`로 흡수 가능하면 그걸로. |

---

## 7. Risks

| 위험 | 영향 | 완화 |
|------|------|------|
| 셸 PR이 `ChatPage`·스트림까지 한꺼번에 건드림 | 리뷰·회귀 폭발 | **First PR = S1 only.** S2는 후속. |
| StoryForge 파일을 복붙하며 Next/`use client`/lucide 의존 유입 | Vite 빌드·번들 오염 | 패턴만 이식; 아이콘은 기존 이모지/CSS 또는 최소 추가. |
| 칩 연필을 새 API로 구현하려 함 | 서버 범위 침범 | composer local state에 문자열만 set. |
| 좌우 드로어와 `BottomSheet`(`ChatDrawer`) 제스처 충돌 | 모바일 사용성 저하 | z-index·상호배타·한 번에 하나 오버레이 규칙 문서화·테스트. |
| F9 파티 화면을 1:1 셸에 억지로 맞춤 | beat UX 회귀 | 1:1 채팅 셸만 S1–S3 대상. 파티는 별 브리프. |
| CSS 토큰 대규모 rename | 전역 시각 회귀 | 변수 alias 추가 후 점진 치환; 한 PR에 전면 rename 금지. |
| Galaxy 미검증 PASS | 실기기 버그 방치 | S5 체크리스트; 기기 증거 없으면 PASS 금지. |
| 「참고」폴더를 submodule/복사로 런타임 연결 | 배포·라이선스·드리프트 | `/workspace/storyforge`는 개발자 로컬 참고 경로로만. |

---

## 8. First PR = S1 only

**첫 PR 제목 예:** `web(ui): StoryForge-style mobile shell drawers (S1)`

### 포함

- `OverlayDrawer` / 채팅 레이아웃 / `ChatListRail`·도구 진입의 **모바일 셸** 정렬.
- `useDesktopLayout`·`chatLayout`과 모순 없는 좌·우 상호배타.
- S0 가드가 아직 메인에 없으면 문서 링크만 PR 본문에 명시 (또는 S0를 같은 날 docs-only로 선행).

### 제외 (이 PR에 넣지 말 것)

- ChoiceChips 연필, stop 카피 개편, regeneratePanel 톤, Home/Character 디스커버리, README/Galaxy 본문 대량 수정.
- `apps/server/**` 모든 변경.
- StoryForge 파일 트리 복사.

### 검증 (S1)

- [ ] `apps/web` typecheck / build 통과.
- [ ] `git diff --stat`에 `apps/server` 없음.
- [ ] 좁은 뷰포트: 좌 목록 · 우 도구 · 동시 open 불가 · Escape/백드롭 닫힘.
- [ ] 기존 메시지 전송·스트림·재생성 스모크 (동작 회귀 없음).

### 후속

S1 merge 후 → S2 (turn chrome) → S3 → S4 → S5.  
각 PR 본문에 이 문서 §5 슬라이스 ID를 명시한다.

---

## 부록 A — 빠른 경로 치트시트

```
참고:  /workspace/storyforge/components/*
타깃:  /workspace/rpchat/apps/web/src/{pages,components,lib}/*
엔진:  /workspace/rpchat/apps/server   ← 손대지 않음 (기본)
문서:  /workspace/rpchat/docs/STORYFORGE-UX-PORT.md  (본 파일)
체크:  /workspace/rpchat/docs/GALAXY-CHECKLIST.md   (S5에서 항목 추가)
```

## 부록 B — `useChat` 계약 (S2가 붙을 표면)

이미 export되는 것 — **재발명 금지:**

- `generating`, `streamingId`
- `send`, `stop`
- `regenerate`, `branchEdit`, `selectSibling`
- `editMessage`, `deleteMessage`, `toggleBookmark`, `updateConversation`

Choices는 메시지 `meta.choices?: string[]` (types). UI는 표시·composer 주입만.

---

*이 문서는 이식 계약이다. 슬라이스 범위·제외·First PR=S1을 바꾸려면 문서를 먼저 고친다.*


---

## 상태 (S0–S5)

| 슬라이스 | 커밋 | 비고 |
|----------|------|------|
| S0 docs/guards | `4c89943` | `docs/STORYFORGE-UX-PORT.md` |
| S1 mobile shell + drawers | `6854b73` | `apps/server` diff 0 |
| S2 turn chrome | `7dfe30f` | stop / chips+pencil |
| S3 tools hub | `ce5e391` | ConversationTools overflow |
| S4 discovery | `23f6e16` | Home / Character / Search |
| S5 polish / README / Galaxy | `a57133e` | 체크리스트 슬롯 = 수동 확인; PASS≠증거 없음 |

*S5까지 이식 트랙 완료. Galaxy 실기기 PASS는 위 체크리스트 증거 후에만.*
