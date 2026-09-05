# design-role-tokens — 역할색 semantic token 도입 사양

> **성격: 실행 사양서. 실행 계약이 아니다. 큐·잠금으로 읽지 말 것.**
> `apps/**` 변경 0. 명명 토큰을 받으면 이 문서대로 실행한다.
> 정본 우선순위: 사용자의 현재 메시지 → `git -C app describe --tags` → `RP-Chat-PRD.md` → 이 문서.

- Date: 2026-09-04
- HEAD: `v0.0.19-104-ge2d66a9` (`e2d66a9`, 워킹트리 clean)
- 입력: 사용자 첨부 `StoryForge 새 디자인 추천안` + 사용자 방향 결정(2026-09-04)
- 결정: **KAMI 다크를 기본 정체성으로 유지하고, Coral·Violet·Teal·Gold를 의미 기반 semantic token으로만 도입**
- 범위: 첨부 문서의 구현 우선순위 **1~3단계** (토큰·공통 컴포넌트 / Scene Canvas / World Inspector)
- 보류: 라이트 페이퍼 테마, 라이트·다크 토글 — **별도 슬라이스**

---

## 1. 왜 팔레트를 그대로 옮기지 않는가

첨부 문서의 팔레트(Ink `#201D24` / Paper `#F8F5F0` / Panel `#FFFDF9`)는 StoryForge라는 **라이트 SaaS 제품**을 전제로 한다. rpchat은 `color-scheme: dark`에 `--kami-deep #141413`을 쓰는 야간용 개인 RP 앱이고, 문서 자신이 "서사 본문을 오래 읽는 화면"의 피로도를 경계한다. 그러므로 가져오는 것은 **색값이 아니라 원칙**이다.

> 브랜드 색상 하나로 모든 상태를 표현하지 않는다.

현재 rpchat은 `--accent #7c5cff` 하나가 링크·주 버튼·아바타 배경·스트리밍 커서·예산 바를 전부 겸한다(`app.css` 53·74·109·136·162). 이것이 이 슬라이스가 고치는 실제 결함이다.

## 2. 토큰 사양

**2단 구조다.** 다크 배경 위에서 같은 색을 선/채움과 텍스트에 함께 쓰면 텍스트가 대비 기준에 미달한다. 그래서 역할마다 값을 둘 둔다.

### 2.1 선·보더·채움 (문서 원본값 유지)

| 토큰 | 값 | 용도 |
|---|---|---|
| `--role-coral` | `#E4574F` | 주 CTA, 활성 장면 rail, 위험·전투 |
| `--role-violet` | `#7667C8` | AI 생성·분기·마력·비현실 상태 |
| `--role-teal` | `#2C9C91` | 저장 완료, 정상, 시스템 확인 |
| `--role-gold` | `#C9963E` | 추천 선택지, 중요 정보, 희귀도 |

### 2.2 텍스트 (다크 보정값)

| 토큰 | 값 | 문서 원본 대비 |
|---|---|---|
| `--role-coral-text` | `#EB857F` | `#E4574F` 밝기 상향 |
| `--role-violet-text` | `#A49ADA` | `#7667C8` 밝기 상향 |
| `--role-teal-text` | `#33B4A7` | `#2C9C91` 밝기 상향 |
| `--role-gold-text` | `#CB9944` | `#C9963E` 밝기 상향 |

### 2.3 실측 대비 (WCAG, 2026-09-04)

표면: `--bg #0f1115` · `--kami-deep #141413` · `--kami-charcoal #30302E` · `--kami-surface #3A3935`

**문서 원본값을 텍스트로 쓸 때 — 최악 표면에서 전부 미달 (기준 4.5)**

| 색 | bg | deep | charcoal | surface |
|---|---|---|---|---|
| Coral `#E4574F` | 5.20 | 5.07 | 3.64 | **3.18** |
| Violet `#7667C8` | 4.09 | 3.99 | 2.86 | **2.50** |
| Teal `#2C9C91` | 5.64 | 5.50 | 3.95 | **3.45** |
| Gold `#C9963E` | 7.12 | 6.95 | 4.98 | **4.36** |

**보정값 — 최악 표면(`surface`)에서 전부 4.5 이상**

| 색 | bg | deep | charcoal | surface |
|---|---|---|---|---|
| `--role-coral-text #EB857F` | 7.37 | 7.19 | 5.16 | **4.51** |
| `--role-violet-text #A49ADA` | 7.39 | 7.21 | 5.17 | **4.52** |
| `--role-teal-text #33B4A7` | 7.40 | 7.22 | 5.18 | **4.53** |
| `--role-gold-text #CB9944` | 7.36 | 7.18 | 5.15 | **4.50** |

**선·보더로 쓸 때 (기준 3.0)**: Coral·Teal·Gold는 네 표면 모두 통과. **Violet 원본은 charcoal 2.86 / surface 2.50으로 미달** — 따라서 violet 선은 `deep`·`bg` 위에서만 원본을 쓰고, charcoal·surface 위에서는 `--role-violet-text`를 선 색으로 쓴다. 이 예외는 코드 주석에 남긴다.

### 2.4 틴트 배경

기존 `.banner.*`의 관례(`rgba(...,0.12~0.14)`)를 그대로 따른다. 새 알파 스케일을 만들지 않는다.

## 3. 기존 토큰 매핑

| 현재 | 이후 | 비고 |
|---|---|---|
| `--accent` (링크) | 유지 | 링크는 상태가 아니다. 역할색으로 바꾸지 않는다 |
| `--accent` (`.btn.primary`) | `--role-coral` | 주 CTA |
| `--accent` (`.cursor::after` 스트리밍 커서) | `--role-violet-text` | 생성 중 = AI 상태 |
| `--accent` (`.budget-row .bar i`) | 유지 | 예산 게이지는 의미색이 아니다 |
| `--accent-2` (`.avatar` 그라디언트) | 유지 | 인물 식별이지 상태가 아니다 |
| `--ok` | `--role-teal-text` 로 별칭 | `.banner.ok`, `.dot.ok` |
| `--danger` | 유지 | 삭제·오류는 이미 별도 의미. Coral과 **합치지 않는다** |
| `--warn` | 유지 | |
| `--kami-ink #2D5A8A` (활성/포커스 선) | `--role-coral` (활성 장면·현재 대화) | 문서의 "왼쪽 3px Coral rail" |

`--danger`를 Coral로 흡수하지 않는 이유: 사용자 지침에서 Coral은 "주 CTA·활성 장면"도 겸한다. 삭제 버튼과 주 CTA가 같은 색이 되면 파괴적 동작의 경고성이 사라진다.

## 4. 단계별 적용

### 1단계 — 토큰과 공통 컴포넌트

- `app.css :root`에 §2 토큰 8개 추가. 기존 `--kami-*`는 **삭제하지 않는다**.
- §3 매핑대로 교체. `.btn`에 `focus-visible`·`hover`·`:disabled` 상태를 역할색 기반으로 정리(현재 `.btn:active`만 있음).
- 접근성: 모든 상호작용 요소에 `:focus-visible` 링. 현재 `.chat-list-item:focus-visible`만 있다.

### 2단계 — Scene Canvas (채팅)

| 문서의 요구 | rpchat에서의 구현 |
|---|---|
| 서사 본문 16–18px / 행간 1.8–2.0 | `.beat-narration`, `.msg.assistant .bubble` 을 16px/1.85로. 현재 `body` 15px/1.5, `.bubble` line-height 1.5 |
| 읽기 폭 680–720px | `.chat-main` 이미 720px. 데스크톱 레일 전환 시 `.chat-scroll` 내부 폭 제한 추가 |
| scene divider | `.beat-header`를 좌우 가는 선 + 가운데 라벨로. 현재는 단순 블록 |
| INFO 패널을 한 단계 분리 | `.beat-info`·`.beat-panel` 배경을 본문보다 한 단계 밝은 표면으로. 역할색 채우지 않음 |
| 추천 답변 = 다음 장면의 방향 | `.chip` 기본은 중립 패널 + 얇은 테두리, **추천에만** Gold 왼쪽 accent line. hover/pressed에 옅은 역할색 배경 |
| 모바일 세로 공간 | `.chips`를 가로 스크롤 카드로 (현재 `flex-direction: column`) |

**색 예산(사용자 지침):** 한 턴에 쓰는 역할색은 **최대 2개**. 화자명·시스템 아이콘 등 제한된 지점에만 쓰고, 서술·대사 본문은 중립색을 유지한다. INFO 행마다 다른 색을 주지 않는다.

### 3단계 — World Inspector (우측 드로어)

`ConversationTools`의 섹션 순서를 문서 권고대로 재배치한다. **행 목록(`buildHubItems`)은 건드리지 않는다** — `settingsSheetInventory`가 허브와의 동치를 잠그고 있다.

1. 현재 장면 요약(장소·시간·등장인물)을 상단에
2. 세계관 기억·프로필을 접을 수 있는 섹션으로
3. 상황 이미지·유저 노트 = 창작 보조
4. 출력 길이·모델 = "생성 방식"으로 분리

색: 드로어 배경은 본문보다 한 단계 밝게, 선택 항목은 **Violet 또는 Gold 하나로 통일**, 저장 성공 Teal, 삭제·초기화 Coral, read-only 행은 낮은 명도 중립.

## 5. 게이트

| 게이트 | 조건 |
|---|---|
| `bench/designTokens.test.ts` (신규) | 토큰 8개 존재 · 대비 계산을 벤치에서 재실행해 텍스트 4.5 / 선 3.0 통과 · 하드코딩 hex 증가 없음(현재 `:root` 밖 3개) |
| `bench/chatShellWeb.test.ts` | 기존 11개 유지 + `.msg`/`.bubble` 펜스 유지 |
| `bench/settingsSheetInventory.test.ts` | 14개 유지 (허브 행 동치 불변) |
| `bench/hunterRenderWeb.test.ts` 등 헌터 5종 | 유지 |
| 전체 스위트 | 84/84 (신규 1 포함) |
| typecheck | EXIT 0 |
| `settingsRegression` | `apps/server` diff 0 |

## 6. 하지 않는 것

- 라이트 페이퍼 테마 / 라이트·다크 토글 (별도 슬라이스)
- 전 화면 리브랜딩 — 홈 목록·검색·미디어는 이번 범위 밖
- StoryForge에만 있는 화면(작품 관리, 이미지 스튜디오, 해시태그 검색) 이식
- glassmorphism, 모든 CTA에 Coral, 화자별 색 부여, INFO 행 무지개
- `apps/server` 변경, 빌드·배포·재시작, 라이브 DB 쓰기
- `buildHubItems` 행 추가·삭제
