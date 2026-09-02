# P4 장면 삽화 벤치 — Mac 세션 핸드오프 (2026-08-24)

> Task 1(Draw Things 활성화)은 Mac 로컬 작업이라 hermes(Ubuntu, 이 세션)가 원격으로 할 수
> 없다. 이 문서 하나로 맥락 복원 + 착수 가능해야 한다.
> 원본 사전등록(잠금 완료): `bench/sketchBench/preregistration.md`
> 이 저장소의 **git root는 hermes 쪽 하나뿐**(`/home/hermes/rpchat/app`, remote 없음).
> Mac에 별도 클론을 새로 만들지 말 것 — SSH로 같은 저장소를 직접 편집한다(§4).

---

## 0. 거버넌스 (그대로 계승, `HANDOFF.md` §0 동일)
1. **증거 원칙**: "됐다" 서술 금지. curl/포트 확인/스크린샷 등 raw 증거로만 판정.
2. **사전등록 불변**: `preregistration.md` §4(성공기준)는 잠금 완료 — 결과 보고 전 수정 금지.
   정정이 꼭 필요하면 append-only(날짜+사유), 기존 절 조용히 덮어쓰기 금지.
3. **최소 풋프린트**: Task 1 범위만. 프로덕션 통합 코드 착수 금지(본 벤치는 채택/비채택
   판정용, ADR 전까지 라이브 미반영).
4. **라이브 무접촉**: hermes의 live DB(`/home/hermes/rpchat/data/rpchat.db`)·실 캐릭터/대화
   건드리지 않음. 벤치는 격리 스크립트로만.
5. **네트워크 노출 최소**: funnel 없음. Draw Things API는 기본적으로 loopback만 — 굳이
   tailnet에 열 필요 없음(§3 설계 참고).

---

## 1. 토폴로지 (실측 확정, 2026-08-24)

```
[Mac Studio M3 Ultra, 96GB]  tailnet 100.97.170.121 (hostname: macstudio-llm)
  llama.cpp launchd 상시화 — Gemma-4-Dark-Thoughts-V2-31B.i1-Q4_K_M.gguf @ :8083
  Draw Things — 설치 확인 필요, API 서버 현재 비가동(§2 실측)

[Ubuntu 미니PC hermes]  tailnet 100.121.186.117 (hostname: hermes)
  Fastify+SQLite @ 8787 (loopback) + Tailscale Serve
  git root: /home/hermes/rpchat/app (remote 없음, 로컬 전용)
```

- Gemma `:8083/health` — **hermes→Mac tailnet 경로 200 OK 확인됨** (34ms, 2026-08-24).
  채팅 baseline 측정(Task 2)은 hermes에서 원격으로 돌릴 수 있다.
- Draw Things API 포트 7860/8000/8080 — hermes에서 **전부 미연결** 확인됨(2026-08-24).
  즉 아직 설치 안 됐거나 API 서버가 꺼져 있음 — Task 1이 이걸 켜는 작업.

---

## 2. 지금까지 상태 (Task 0 완료)

`bench/sketchBench/preregistration.md` 잠금 완료. 핵심 결정 요약(전문은 파일 참조):
- **후보1(본 벤치 대상)**: Draw Things + SDXL 또는 경량(turbo/lightning) 모델, 동시성 1.
- **후보2(후속, 범위 외)**: mflux + Flux — 후보1 가치 확인 **후에만** 별도 승인.
- **채택 필요조건**: §4.1 채팅 비저하(TTFT p50 변화≤10%, p95≤20%, tok/s p50≤10%, 오류율
  증가 0) + §4.2 이미지 UX(접수≤500ms, 결과도착 p95≤30초 등) + §4.3 운영 안정성(성공률
  ≥95% 등) + §4.4 Mac 전용(스왑 증가 없음, Gemma 축출/재로딩 없음, 콜드스타트 없음).
- **§4.5 안전 게이트 (unconditional, 성능 통과와 별개 필요조건)**: 삽화 프롬프트는 사용자
  자유 텍스트를 받지 않는다 — 서버가 장면 상태(state JSON)/요약에서 조립. 조립 결과에
  금칙 패턴 필터 적용. 레드팀 픽스처(프롬프트 인젝션 포함) 100% 차단. **성능 기준 다 통과
  해도 이거 미충족이면 비채택.**

---

## 3. Task 1 — Mac에서 할 일 (Draw Things 활성화)

1. **Draw Things 설치·모델 확인**
   - 앱 설치 여부 확인. 없으면 App Store에서 설치.
   - 모델: SDXL 계열 또는 turbo/lightning류 경량 체크포인트 로드(후보1 사전등록 조건).
   - 정확한 모델명·버전·파일 크기를 기록해둘 것(§4.4 스왑/메모리 판정에 필요).

2. **API 서버 활성화**
   - 설정에서 HTTP/API 서버 옵션을 켠다. **포트를 확인**(고정값 추정 금지 — 실제 설정 화면에
     표시되는 값을 그대로 기록).
   - 기본 요청으로 살아있는지 로컬에서 확인:
     ```bash
     curl -sS http://127.0.0.1:<실제포트>/  # 또는 앱이 안내하는 헬스/버전 엔드포인트
     ```

3. **바인딩 설계 — loopback 유지 권장**
   - `docs/NETWORKING.md`의 기존 패턴(모델 서버는 `127.0.0.1`에만 바인딩 후 필요시만 Serve로
     노출)을 따른다.
   - **권장**: Draw Things는 tailnet에 열 필요 없음. Task 3(동시측정)에서 이미지 생성
     트리거는 **Mac 로컬 스크립트**가 `127.0.0.1`로 직접 호출하고, 동시구간 채팅 부하는
     hermes에서 tailnet으로 Gemma `:8083`을 때리는 구조로 분리 — Draw Things API를 굳이
     tailnet에 노출할 이유가 없다(공격 표면 최소화, §0-5).
   - 만약 hermes에서 직접 Draw Things를 호출해야 할 사정이 생기면(예: 하니스를 hermes에
     전부 몰아서 짤 경우) 그때만 `docs/NETWORKING.md` 패턴대로 Tailscale Serve로 열 것 —
     지금 미리 열지 말 것.

4. **기록 — append로만**
   - 확인된 실제 포트·엔드포인트·모델명·바인딩 상태를 `bench/sketchBench/preregistration.md`
     의 Append log 절에 아래 형식으로 추가:
     ```
     - 2026-08-2X Task 1 완료(Mac): Draw Things API 포트 <N>, 모델 <name>, 바인딩
       <127.0.0.1만 / Serve 노출>. curl 헬스 raw: <출력>.
     ```
   - **§4(성공기준)는 건드리지 않는다.** 그건 판정 기준, 이건 실행 환경 기록.

---

## 4. hermes로 이어가는 법 (SSH)

같은 저장소를 그대로 편집한다 — 별도 클론 금지(remote 없음, 두 곳에 상태 나뉘면 사전등록
불일치 위험).

```bash
# tailnet IP로 접속 (확정 경로)
ssh hermes@100.121.186.117
# MagicDNS 켜져 있으면 아래도 될 수 있음(안 되면 위 IP 사용)
ssh hermes@hermes

cd /home/hermes/rpchat/app
git log --oneline -3          # 현재 HEAD 확인 (v0.0.19-14-g54c4260 이후 변동 있을 수 있음)
git status --short            # bench/sketchBench/ 가 untracked 로 보이면 정상(아직 커밋 전)
cat bench/sketchBench/preregistration.md   # Task 1 append 반영됐는지 확인
```

**node 이중화 함정** (`HANDOFF.md` §1 계승): SSH 기본 셸 node는 v20(ABI 115), rpchat 서비스
node은 v22(ABI 127). 네이티브 모듈 관련 npm 작업(ci/rebuild)을 SSH에서 할 경우 반드시:
```bash
PATH=/home/hermes/.local/bin:$PATH npm rebuild better-sqlite3
```
Task 2(채팅 baseline 하니스, TS 스크립트 작성/실행)는 네이티브 리빌드가 필요 없으면 이 함정과
무관하다.

Task 1 raw 증거(포트·curl 출력)를 append한 뒤, 이어서 **Task 2(채팅 baseline, hermes에서
이미 원격 가능 확인됨)** 또는 **Task 3(Draw Things 어댑터 + 동시측정 하니스)**로 진행할 수
있다. 순서·세부 스크립트 계약은 `preregistration.md` §7 참조.

---

## 5. 하지 말 것
- §4 성공기준·판정 합산 규칙 수정 (사후편향 금지, P3 계승 원칙).
- Draw Things를 funnel/공개 노출.
- 프로덕션 코드(`apps/server/src/**`) 착수 — 이건 벤치 채택 판정 + 별도 ADR 이후.
- 라이브 DB·실 대화 접촉.
- 이 저장소를 Mac에 별도로 클론 — SSH로 hermes 원본을 직접 편집.
