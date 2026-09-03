# RP Chat

로컬 LLM 기반 **개인용 RP 캐릭터 채팅 PWA**. Mac Studio 의 모델을 Ubuntu 백엔드가 감싸고, Galaxy 에서 사설망(Tailscale) 안의 모바일 웹앱으로 대화한다. 단일 사용자·사설망 전용으로 설계되었으며 공개 인터넷에 노출하지 않는다.

```
Galaxy(PWA) ──내부 HTTPS── Ubuntu(앱: Fastify+SQLite) ──OpenAI 호환── Mac Studio(모델)
                         모두 같은 tailnet · 공개 포트 없음
```

## 핵심 기능
- **캐릭터 카드 + 페르소나 + 장면 + 로어북(키워드 발동)** 을 예산 안에서 조립하는 프롬프트 파이프라인. 이번 턴의 실제 토큰 배분과 조립된 프롬프트 원문을 화면에서 그대로 확인 가능.
- **파티 비트 엔진**: 스토리에 `party:` 태그 캐릭터가 2명 이상이면 1:1 대화 대신 한 유저 입력 → 헤더/서술/포커스 대사/속마음/조연 대사(최대 2)/UI 패널로 이루어진 한 "비트"를 서버가 조립. 포커스(누가 응답할지)는 별표 지문·호명을 보는 결정적 규칙이며 모델이 아니라 서버가 정한다.
- **SSE 스트리밍** 응답. 클라이언트가 끊겨도 서버 생성은 지속·저장(모바일 백그라운드 대응), 명시적 "중단"만 취소.
- **메시지 트리**: 재생성/스와이프(형제 응답), 사용자 메시지 편집 후 분기 재생성, 활성 분기(head)만 프롬프트 반영.
- **기억·요약**: 모델이 만든 요약·기억은 항상 **후보 → 사용자 승인** 후에만 프롬프트에 주입. 대화별/캐릭터 공용 범위. 4단계 롤링 요약 + 에피소드 롤업.
- **스토리 모드**: 배경/조연 캐스트를 가진 스토리를 캐릭터와 묶어 대화를 시작. 응답과 함께 선택지(칩) 생성, 파싱 실패 시 본문만 표시로 폴백.
- **OOC**: `(OOC: …)` 로 캐릭터 밖 지시, 이후 맥락에서 자동 제외.
- **검색**: 캐릭터/대화/메시지 전문 검색.
- **모바일 우선 PWA**: 홈 화면 설치, Android 키보드(visualViewport) 대응, 앱 셸만 캐시(SSE/API 는 캐시 안 함).
- **토큰 추정 자동 보정**: 실측 usage 로 EMA 보정, 한글 계수 반영.
- **인증 3모드**: Tailscale 신원 헤더 / 접근 토큰+쿠키 / none(로컬 개발).

## 빠른 시작 (로컬 개발)
```bash
npm install
# 서버 (모델 서버가 127.0.0.1:8080 에 있다고 가정)
MODEL_BASE_URL=http://127.0.0.1:8080/v1 AUTH_MODE=none npm run dev --workspace @rpchat/server
# 웹
npm run dev --workspace @rpchat/web        # http://127.0.0.1:5173
```
배포(Ubuntu, Docker/Node)와 사설망 구성은 아래 문서 참고.

## 문서
- [docs/SETUP.md](docs/SETUP.md) — 설치(Docker/Node), 첫 기동, 환경변수
- [docs/NETWORKING.md](docs/NETWORKING.md) — Tailscale Serve 사설망·인증·모델 서버 게시
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — 컨텍스트 조립·기억 워크플로·튜닝·백업·문제 해결
- [docs/GALAXY-CHECKLIST.md](docs/GALAXY-CHECKLIST.md) — 실기기(Galaxy) PWA 점검 체크리스트

## 구조
```
apps/
  server/          Fastify(TS) 단일 API. SQLite(WAL). SSE 스트리밍.
    src/
      config.ts        환경설정·검증, PROMPT_VERSION
      db/              스키마 마이그레이션, 트리(분기) 헬퍼, 시드
      model/           OpenAI 호환 어댑터(SSE 파서), 동시성 1 생성 큐
      media/           캐릭터 자산(outfit×emotion 이미지)·아바타 업로드
      prompt/          토큰 추정·보정, 템플릿, 예산 기반 빌더(1:1),
                        파티 비트 파이프라인(composeBeat·resolveFocus·
                        approveExtras·renderBeat·sceneCatalog 등)
      routes/          characters·stories·conversations·chat(생성,
                        1:1+비트 두 경로)·memory·settings·search·media·health
    migrations/        0001_init.sql … 0012_scene_beat.sql (순차 적용)
  web/             React+TS+Vite PWA (의존성 최소, 자체 라우터)
    src/
      lib/             api(fetch+SSE), router, viewport(키보드)
      pages/           Home·Character·Story·Chat(+useChat,ChatDrawer)·
                        Conversation*(Profile/Style/Guide/Memory/UserNote)·
                        Search·Settings·Login
      components/      ui(시트/토스트/확인)·view(비트 블록 렌더)·
                        CharacterEditor·StoryEditor·settings
content/           샘플 캐릭터(서리·카이)·페르소나(여행자) — 빈 DB 일 때만 적재
bench/             출하 경로 격리 테스트 (`npx tsx bench/<파일>.test.ts`)
deploy/            Dockerfile용 compose, systemd 유닛, 백업/복원, env 예시
docs/              설치·네트워크·운영·Galaxy 체크리스트 문서
```

## API 개요 (사설망 내부, `/api`)
- 인증: `GET /auth/me`, `POST /auth/login|logout|logout-all` (token 모드)
- 캐릭터/로어: `GET|POST /characters`, `POST /characters/import`, `GET|PUT|DELETE /characters/:id`, `POST /characters/:id/avatar`, `.../lore`, `PUT|DELETE /lore/:id`, `POST /lore/:id/clone`
- 페르소나: `GET|POST /personas`, `PUT|DELETE /personas/:id`
- 스토리: `GET|POST /stories`, `GET|PUT|DELETE /stories/:id`, `POST /stories/:id/characters`
- 대화: `GET|POST /conversations`, `GET|PATCH|DELETE /conversations/:id`, `.../prompt-preview`, `.../export`
- 생성(SSE, 1:1 또는 파티 비트는 서버가 자동 판단): `POST /conversations/:id/messages | regenerate | branch`, `POST /generations/:id/abort`, `GET /generations/active`
- 메시지: `GET|PATCH|DELETE /messages/:id`, `POST /messages/:id/select`
- 기억/요약: `GET /conversations/:id/memories|summaries`, `POST /conversations/:id/summarize`, `POST /conversations/:id/rollup-episode`, `POST /memories`, `PATCH|DELETE /memories/:id`, `PATCH|DELETE /summaries/:id`, `POST /summaries/:id/restore`
- 검색: `GET /search`
- 미디어: `GET /media/assets/:characterId/:outfit/:file`
- 프로필/설정/상태: `GET /profiles`, `PUT /profiles/:name`, `GET|PUT /settings`, `GET /health`, `GET /generation-log`, `GET /export/all`

## 설계 원칙
- 사설망 전용. `funnel`·포트포워딩 금지. 앱은 `trustProxy=false`.
- 브라우저는 Ubuntu 백엔드만 호출. 모델 서버 주소·키는 서버에만.
- OpenAI 호환 `chat/completions` 어댑터만 사용 → 모델 런타임 교체가 쉬움.
- 자동화가 사용자 동의 없이 장기 상태(기억)를 바꾸지 않음.
- 파티 비트에서도 헤더·UI·포커스 판정은 서버 소유. 모델은 대사/서술 문장만 만든다 — 이미지 URL·수치·시간 진행을 모델이 지어내지 않는다.

## 미확정 항목 (착수 전 결정 필요)
계획서 기준 다음 4가지는 배포 전 확정 권장: **①모델 런타임/모델 선택, ②접근 범위(본인 단독/소수), ③콘텐츠 경계(일반/성인 수위), ④외부 캐릭터 카드 가져오기 지원 여부.** 현재 구현은 ①을 OpenAI 호환이면 무엇이든 되게 추상화했고, ②는 3가지 인증 모드로, ③은 설정의 콘텐츠 지침(+상시 안전 규칙)으로 대응하되 기본은 보수적이다. ④는 캐릭터 카드 JSON 가져오기(`POST /characters/import`)로 부분 지원한다.

## 라이선스
개인용. 별도 명시 없음.
