# OPS — Mano 팀 운영지침 (rpchat)

이미 도는 루프 위에 얹는 규칙 한 장. `grokbot-field-notes`(MIT) 원칙을 **rpchat 라이브 · Hermes 무인운영**에 맞춰 보수적으로 적용한다. 사건이 아니라 원칙만 적는다.

코딩 에이전트(Hermes·Chloe)용 얇은 룰은 `AGENTS.md`. PR 폼은 `.github/PULL_REQUEST_TEMPLATE.md`. 세 문서는 아래 역할·접점·LOCK 우선순위에서 어긋나면 이 파일이 이긴다.

## 0. 대원칙 (5줄)

1. 원칙만 남기고 사건은 지운다.
2. 재현 → 실행 → (플레이) → 증명. 그 다음 머지.
3. source of truth와 라이브러리는 이름으로 지정한다.
4. autonomy는 blast radius로 정한다. prod·돈·권한·시크릿엔 사람 게이트.
5. 토큰은 **빈도**와 **그룹챗**에서 샌다.

## 1. 역할 (한 줄)

- **Aina** (CEO / chief of staff) — 사람 쪽 라우팅·현황, 신규 봇 온보딩. 전문봇의 사람 접점.
- **Chloe** (domain engineer) — **독립 검증**. 이 레포 구현 슬라이스에서 코딩하지 않는다. Hermes가 낸 재현 증거를 다시 확인한다.
- **Easton** (playtester / QA) — 실제 UI 흐름의 PASS/FAIL을 기록한다. 그 기록은 머지 **증거**이지 실행·머지 **승인**이 아니다.
- **Finley** (감각) — 배포 **후** 사람-눈 확인(수치가 못 잡는 것).
- **Dana** (research) — 조사·근거. **링크가 아니라 결론**을 낸다.
- **Bettany** (contents) — 사용자 노출 문구. de-slop 통과 후 반출.
- **Hermes** (실행면) — rpchat 구현·재현 증거 제출. cron·잡 런타임. 사람 아님, **named lock 대상**.

`/verify`는 실제 호출 절차가 확인되기 전까지 **구현된 자동화로 쓰지 않는다.** 당장은 실행한 명령·결과·UI 증거를 PR에 남긴다. 소스 문자열 검사만으로 동작 검증을 대체하지 않는다.

## 2. 사람 접점

- **전문봇**(Chloe·Easton·Dana·Bettany 등)은 **Aina 경유.** 라우팅 맥락이 거기서 생긴다.
- **Hermes는 Mano 직접 DM + named lock 대상.** Aina 유일 접점과 충돌하지 않는다.
- 일상 조율은 **1:1**. 그룹 스레드는 의견 대립을 일부러 볼 때(staff meeting)만, 비용 인지하고.

전역 `ops` 스킬 설치와 봇 라우팅 자동화는 이 레포 계약에 넣지 않는다.

## 3. Autopilot 사다리 (rung을 지시에 명시)

- **Investigate** — 진단·보고, 아무것도 안 건드림. prod / 원인 불명. raw 원인만 갖고 복귀.
- **Draft** (Brief 승인) — PR 열고 사람 대기. **기본값.** Brief → 승인 → 구현.
- **Autopilot** (QA→조건 머지) — 구현·검증·green이면 머지. **web-only 소범위**에만. Chloe 검증 + Easton PASS를 머지 증거로 요구한다. PASS 자체를 실행·머지 승인으로 취급하지 않는다. **서버·인증·migration 변경에는 web-only standing merge를 적용하지 않는다.**
- **Full autopilot** — 계획·구현·머지 전부. throwaway만. **rpchat 라이브엔 안 씀.**

라이브가 되는 순간 **한 칸 내린다.**

## 4. 증거 규율

- **raw 원인 먼저** — 재현 없으면 PR 없음. 증상만 고치지 않는다.
- **fixture / 벤치** — 결정론적 재현. 실패 시 exit non-zero. 명령과 전체 결과를 PR에 붙인다.
- **Chloe 검증** — Hermes 제출물과 독립. 구현자의 요약을 증거로 쓰지 않는다.
- **Easton PASS/FAIL** — 실제 UI. 머지 증거. 승인 아님.
- **Finley 감각** — 배포 후, 사람 눈.
- **dist / PID / SHA** — 무엇을 어디에 올렸는지 **먼저** 댄다.
- 파생 수치는 **한 곳에서** 계산하고 나머지는 표시만.

## 5. 사람 게이트 (루프가 잘 돌아도 유지)

> **migrate · Hermes 배포 · 돈/권한 · LIVE DB 쓰기**

시크릿: 화면 공유 전 모든 설정 페이지에 토큰이 있다고 가정한다.

## 6. LOCK 문법 (이 레포의 작업 계약)

이 저장소가 쓰는 실행 잠금은 아래 네 가지다. 저장소에 정의되지 않은 승인 필드(일반 템플릿의 TOKEN / MODE / SCOPE / BASE 등)를 작업 시작 조건으로 요구하지 않는다.

- **named lock** — 잠글 대상을 이름으로. 지시마다 인용.
- **BASE tip** — 어느 커밋 위에서 작업하는지 고정. push 전 rebase.
- **LIVE_NO_TOUCH** — 라이브 자산 비변경. 데모·배포 중 freeze.
- **비범위** — 이 잡이 건드리지 않는 것을 명시. 범위 밖 = 하지 마.

Hermes 쪽 세칙 스킬(`lock-gated-execution`)은 **축약·대체하지 않고 참조만** 한다. 그 스킬이 이 레포 계약과 충돌하면 **이 파일과 사용자가 명시한 실행 규칙이 이긴다.**

한 named lock = 한 관심사. 코드 커밋과 운영 문서 커밋을 섞지 않는다. 구현·커밋·push·migration·배포는 각 허용 범위의 lock으로 따로 간다.

## 7. 교정 시

고치고 나면 **principle만** 이 파일/`AGENTS.md`에 남긴다. 사건 서술은 금지. 특정 세션에 overfit된 룰은 원칙으로 재작성한다.

## 8. 안티패턴 (이 레포에 해당하는 것만)

1. **autopilot을 라이브 DB에 겨눔** → prod·migration은 사람 게이트. 라이브면 rung 내림.
2. **root cause 전에 PR** → 재현·raw 원인 먼저.
3. **사건을 박은 룰** → 세션 지우고 원칙만.
4. **시계 위에서 자는 에이전트** → 짧은 주기 watchdog. `sleep`으로 정체하지 않음.
5. **VM 브라우저 세션 만료** → 무인 실행은 브라우저보다 connector 우선.
6. **입력이 안 바뀌는데 도는 루틴** → 빈도는 입력이 바뀌는 주기. 기본 1~2회/일, no-op엔 침묵.
7. **파생 수치를 두 곳에서 계산** → 한 소스만 계산.
8. **신뢰 상태가 클라에서 편집 가능** → server-authoritative. 안 도달돼야 하면 클라에 안 실림.
9. **봇이 전부 yes** → 제품이 아닌 것을 이유와 함께 한 번만 학습.
10. **모호한 지시 → 비싼 조회** → ticket/URL 등 hard ID.

## 비범위

- **증거 있으면 자동 머지**(full autopilot 머지) — rpchat 라이브 부적합.
- **전역 ops 스킬 · 봇 라우팅 자동화.**
- **69 roles / 봇 폭증** — 새 봇 전에 skill/routine 먼저.
- **그룹 스레드로 일상 조율.**
- 존재하지 않는 자동화(`/verify` 미확인 호출 포함)나 승인되지 않은 실행을 완료로 표현하는 것.

---

출처: `grokbot-field-notes` (MIT). C층은 `AGENTS.md`.
