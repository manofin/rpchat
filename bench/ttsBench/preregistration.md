# F4 TTS(음성) 벤치 사전등록 (preregistration)

> 실행 전 고정. 실행 중 정정은 append만 (날짜 + 사유 명시).
> named lock `F4`(STATUS.md Bucket 3: 첫 합법 단계 = **new preregistration**만.
> forbidden first move = **Gemma 옆 두 번째 모델** — 즉 이번 잠금 범위는 이 문서
> 작성까지이며, §0 미확정 항목의 사용자 확정 전에는 Task 1(실측)에 착수하지 않는다.
> `bench/sketchBench/preregistration.md`와 동형 구조 — 같은 Mac Studio 자원공존
> 질문의 자매 사례.)

## 0. 미확정 — 사용자 확정 대기 (Task 1 착수 전 필수)
1. **후보 목록**(§3) 확정 또는 수정 — 특히 Kokoro-82M을 1순위 후보로 제안한 근거
   (자원 최소)에 동의하는지.
2. **개인 가치 판단**(PRD §8 오픈퀘스천: "이미지·TTS 중 개인 가치는?")은 이 사전등록이
   대신 결정하지 않는다 — 벤치는 "공존 가능한가"만 답하고, "이미지 대신 TTS를 할
   가치가 있는가"는 벤치 결과와 별개로 사용자 판단 몫임을 §1에 명시했다. 이의 없으면
   그대로 유지.
3. **숫자 플레이스홀더**(§4.2) 결과 도착 p95 임계값 — sketchBench는 30초로 확정했으나
   TTS는 통상 이미지보다 훨씬 빠르므로 더 taut한 값(예: 문장당 5초)을 제안. 확정 필요.
4. **TTS 입력 범위**(§4.5 안전) — "최종 확정된 assistant 메시지 텍스트만" 읽는다는
   제안에 동의하는지(진단덤프/시스템프롬프트/로어 원문 낭독 금지).

## 1. 신호 (Signal)
Mac Studio M3 Ultra(96GB)에서 로컬 TTS 모델이 상주 중인 Gemma
(`Gemma-4-Dark-Thoughts-V2-31B.i1-Q4_K_M.gguf` @ `:8083`, 가중치 파일 18.7GB,
Q4_K_M 31B 상주 22–26GB 추정 — sketchBench 실측 문구 재사용)와 **채팅 엔진을
저하시키지 않고 공존하는가**. sketchBench(이미지)와 동일 질문 구조를 음성에 적용한
자매 벤치다.

이 벤치는 "공존 가능한가"만 답한다. "이미지 대신 TTS가 개인적으로 더 가치있는가"
(PRD §8)는 별개의 사용자 판단이며, 이 벤치의 통과/비통과 결과와 논리적으로
독립이다 — 공존 불가 판정이 나온 후보라도 그것이 "이미지가 더 낫다"는 근거가
되는 건 아니고, 단지 그 특정 후보가 이 Mac에서 안 된다는 뜻일 뿐이다.

## 2. 대조군 (Control) — 수정 금지
- TTS 미도입 상태의 채팅 baseline: TTFT p50/p95, tok/s p50. 격리 대화로 N회 반복
  측정 후 고정(§7 표본 크기). `apps/server/src/**` 수정 없음.
- sketchBench가 2026-08-24 같은 조건(같은 Mac, 같은 Gemma 프로세스)에서 이미
  측정한 baseline(`bench/sketchBench/results/chat-baseline-1787541510028.json`,
  TTFT p50=1012ms/p95=5527ms, tok/s p50≈21.40)이 존재한다. **재사용은 Task 1
  착수 시점에 health latency 등으로 드리프트(모델 재시작·업데이트 여부) 확인 후에만
  유효** — 그대로 가져다 쓰지 않고 최소 확인 후 판단(무효면 재측정).

## 3. 후보 (Candidates)
| 후보 | 런타임 | 모델 | 성격 |
|---|---|---|---|
| 후보1 (본 벤치 대상) | 로컬 추론(CPU 또는 MPS) | Kokoro-82M (Apache-2.0, 82M 파라미터) | 극소형 — Gemma 대비 자원 경쟁 최소 가정. 1순위 |
| 후보1-b (동일 벤치, 대체 확인) | 로컬 추론(CPU) | Piper (ONNX, rhasspy) | 더 작고 더 빠르나 자연스러움 낮음 — Kokoro 실패 시 대체 |
| 기준선(무료, 항상 통과) | macOS 시스템 | `say`/AVSpeechSynthesizer | 추가 자원 0(이미 상주) — 캐릭터별 목소리 차별화 없음이 단점. §6 "완전 비채택"이 아닌 폴백으로 남겨둠 |
| 후보2 (후속, 본 벤치 범위 외) | 로컬 추론(GPU 필요) | XTTS-v2 등 음성복제형 | 후보1 가치 확인 **후에만** 별도 벤치. 지금 착수 안 함(sketchBench의 mflux/Flux와 동일한 순차 게이트 구조) |

본 벤치는 **후보1(+대체 후보1-b)만** 채택 판정 대상.

## 4. 성공 기준 (채택 필요조건 — 후보1)

### 4.1 채팅 비저하 (sketchBench §4.1과 동일 임계값 — 일관성 유지)
1. TTS 요청 전후 Gemma TTFT p50 변화 ≤ 10%
2. TTS 생성 동시 구간 Gemma TTFT p95 변화 ≤ 20%
3. tok/s p50 변화 ≤ 10%
4. 채팅 요청 오류율 증가 0%p

### 4.2 음성 UX
1. 합성 요청 접수 응답 ≤ 500ms
2. 합성 중 채팅 블로킹 0건
3. 문장당 첫 오디오 바이트 도착 p95 ≤ [§0-3 확정 대기, 잠정 5초]
4. 실패 시 동일 메시지 재합성 가능
5. 페이지 새로고침 후에도 재생 상태 복구(또는 최소 재요청 가능)

### 4.3 운영 안정성
1. 요청 성공률 ≥ 95%
2. 타임아웃 요청이 채팅에 영향 없음
3. 워커 오프라인 시 빠른 실패 또는 명확한 대기 상태
4. 중복 재생 요청으로 동일 오디오가 다중 생성되지 않음
5. 완료 오디오는 앱의 정적 저장소로 복사된 뒤 제공(또는 스트리밍 — 구현 시점 결정)

### 4.4 Mac Studio 후보 전용
1. 스왑 증가 없음
2. Gemma 모델 축출 또는 재로딩 없음
3. TTS 합성 전후 Gemma TTFT 콜드 스타트 없음
4. TTS 합성 종료 후 메모리가 정상 회수됨
5. TTS 동시 합성 중 TTFT p95 변화 ≤ 20% (4.1-2와 동일 항목, 카테고리 교차 확인용 중복 게재)

### 4.5 안전 (unconditional 게이트 — 성능 기준과 별개 필요조건)
1. **TTS 입력은 최종 확정된 assistant 채팅 메시지 텍스트로 한정한다.** 진단
   덤프(prompt-dump), 시스템 프롬프트, 로어 원문, 요약 원문을 낭독 대상으로
   노출하지 않는다 — 이미 채팅 UI에 노출된 것과 동일 텍스트만 음성화.
   (sketchBench §4.5의 "자유텍스트 금지+서버조립"과 대응되는 안전선 — 이미지는
   생성 입력의 위험을, TTS는 낭독 대상 텍스트의 노출 범위를 제한한다.)
2. 사용자가 요청하지 않은 자동 낭독(예: 백그라운드 자동재생)은 기본값 off — 명시적
   재생 트리거 필요.
3. 캐릭터별 `voice_profile`(이미 예약된 필드, migration 0001) 값은 서버가 검증한
   화이트리스트 보이스 ID만 허용 — 임의 문자열을 런타임 인자로 그대로 전달 금지
   (인젝션·경로탈출 방지, avatar.ts의 매직바이트 검증과 같은 종류의 방어).
**성능 기준(§4.1~4.4) 전부 통과해도 본 절 미충족이면 비채택.**

## 5. 판정 합산 규칙
- 4.1~4.4 **전부 충족**이 후보1 채택 필요조건. 하나라도 불충족 → 후보1-b로 대체
  시도, 그것도 불충족이면 비채택.
- 4.5(안전)는 통과가 확정되기 전까지 별도 unconditional 게이트.
- θ류 사후 조정 금지(P3/sketchBench 계승): 결과 확인 후 임계값 완화·재해석 금지.
- **비채택도 정상 결과**: 자원 경쟁 확인 = 근거 확보 = 후보1 종료. 기준선(macOS
  시스템 TTS)은 이 경우도 여전히 유효한 무비용 폴백으로 남는다.

## 6. 분기 (Branch)
- §4.1~4.4 중 1개라도 불충족(후보1, 후보1-b 모두) → **비채택**. REPORT 작성,
  라이브 코드 미변경. B군 "음성/TTS"는 신경망 후보 경로로는 닫힘 — 시스템 TTS
  폴백만 후속 검토 가능(별도 판단).
- 전부 충족 + §4.5 안전 게이트 통과 → **채택 후보**. 실제 프로덕션 통합은 별도
  ADR + 다음 슬라이스(본 벤치 범위 외) — 즉 F4 잠금 재개방 없이는 라이브 통합 금지.
- 후보1 설치/런타임 실패(모델 다운로드·의존성 불가) → **벤치 무효 선언**, 결과
  해석 금지. 대체 런타임 교체는 본 파일에 append로 정정(근거 명시) 후에만 진행.

## 7. 측정 방법 계약
- 표본 크기: 채팅 baseline N=20회 격리 요청(§2 재사용 또는 재측정), TTS 동시구간
  채팅 N=20회 격리 요청, TTS 합성 자체 N=10회 요청(성공률·p95 산정용).
- 격리 대화/격리 DB 사용, 라이브 대화 무접촉.
- 메모리·스왑 측정: `vm_stat`/`memory_pressure` 등가 CLI, TTS 합성 전/중/후 3점
  스냅샷. macOS Metal 프로세스는 `ps` RSS가 과소표기될 수 있음(이번 세션 실측:
  `llama-server` RSS 2.9GB로 보고되나 실제 모델 파일 18.7GB) — 판정 시 `ps` 단독
  신뢰 금지, `sudo footprint <pid>` 또는 Activity Monitor 병행 확인 필요.

## 8. 경계
- 라이브 무접촉: 실 캐릭터/대화 DB 쓰기 없음. `apps/server/src/**` 수정 없음(벤치는
  격리 스크립트/워커로만 실행).
- **이번 F4 잠금 범위는 이 사전등록 문서 작성까지다.** §0 미확정 항목 사용자
  확정 전에는 Kokoro/Piper 등 어떤 모델도 다운로드·설치·프로세스 기동하지 않는다
  (forbidden first move = "Gemma 옆 두 번째 모델" — 이 Mac에 셸 접근이 있다는
  이유로 임의로 앞서가지 않는다).
- Mac 측 TTS 런타임 설치·모델 다운로드는 §0 확정 후 Task 1 착수 시점에 진행 —
  원격(hermes)에서는 불가, 이 Mac에서 직접(sketchBench의 Draw Things 선례와 달리
  이번엔 원격 제약은 없으나, 그렇다고 사전 확정 없이 앞당기지 않는다).
- git remote 없음(의도, sketchBench 계승), 태그는 벤치 통과 전 부여하지 않음.

---
## Append log
- 초판 2026-08-27, `F4` 잠금(사용자 지명) 하 작성. §0 4건 미확정 — 사용자 확정
  전 Task 1(실측) 착수 안 함.

- 2026-08-30 §0 확정 (사용자 "바로 진행해주십시오", Claude Code 제안 그대로 + 1건 명확화).
  Task 1(모델 다운로드·설치·프로세스 기동)은 **여전히 미착수** — 이 확정은 문서 기록일
  뿐, Task 1은 별도 named lock 필요(F4를 다운로드 토큰으로 재사용 안 함).

  1. **후보 목록 확정**: §3 그대로. Kokoro-82M 1순위, 실패 시 Piper(후보1-b), macOS
     `say` 기준선, XTTS-v2는 벤치 밖. 근거(자원 최소) 그대로 수용 — E1(sketchBench)의
     §4.1 실패 원인이 GPU 자원 경쟁이었는데, Kokoro-82M(82M, CPU/MPS 추론)은 Gemma와
     GPU를 다투지 않을 가능성이 높아 그 실패 지점을 구조적으로 피해간다는 점이
     확정의 근거로 추가됨.
  2. **개인 가치 판단 분리 확정**: §1 그대로 유지. 벤치는 "공존 가능한가"만 답하고,
     "이미지 대신 TTS가 가치 있는가"(PRD §8)는 벤치 결과와 무관한 별도 사용자 판단.
  3. **§4.2-3 첫 오디오 p95 확정: 문장당 5초를 상한으로 고정.** 이 숫자 자체는 근거
     기반 실측치가 아니라 UX 목표치(sketchBench의 30초와 동일한 성격 — "경량 가정"에서
     나온 taut한 사전 상한)임을 명시. 사후조정 금지(§5)는 이 확정에도 그대로 적용 —
     Task 1 실측 후 이 값을 완화하는 것은 금지, Kokoro 실측이 이보다 빠르면 여유(성공),
     넘으면 §6에 따라 후보1-b(Piper)로 전환 시도.
  4. **§4.5-1 입력 범위 확정**: "최종 확정된 assistant 메시지 텍스트만" 그대로. 진단
     덤프(prompt-dump)·시스템 프롬프트·로어 원문·요약 원문 낭독 금지, 자동재생 기본
     off. (참고: 같은 날 E-bytes `[RP-Chat / E-bytes / request-dump]` generate에서
     직접 확인한 `last-request.json` 내용 — 시스템 프롬프트에 유저노트/스토리설정 등이
     실제로 포함되어 있음 — 이 안전선의 구체적 근거로 재확인됨.) §4.5-3 `voice_profile`
     화이트리스트 검증도 그대로 확정(`avatar.ts` 매직바이트 검증과 동일 계열 방어).

  **결론**: §0 4건 전부 확정. §3~§8(성공기준·판정규칙·측정계약·경계) 원문 미수정,
  이 블록은 append-only 기록. 다음 코드/실측 슬라이스는 **Task 1**(이 Mac에서 직접
  Kokoro-82M 설치·기동) — 별도 named lock 필요, 지금 이 확정으로 자동 착수 안 함.

- 2026-08-30 **Post-confirmation 검증 메모** (Claude Code, 1차 출처 직접 fetch). §0 확정
  직후 후보군 재검토 과정에서 한국어 지원 사실관계를 모델 카드/소스 원문으로 직접 대조 —
  중간에 2차 요약 출처(aggregator)를 신뢰한 오류가 있었으나 아래는 전부 1차 아티팩트로
  재확정한 값이다. §3 후보 순위(주 후보)는 바꾸지 않고, 비교군만 명확히 한다.

  **Kokoro-82M 공식 v1.0에는 한국어가 없다(1차 출처 확인).** `hexgrad/Kokoro-82M`
  `VOICES.md` = 9개 언어(미/영English·일·중·스·불·힌·이·브라질포르투갈), **한국어 voice
  없음**. `af_kore`는 "Kore"라는 이름의 **American English** voice이지 한국어가 아니다.
  공식 `kokoro/pipeline.py`의 `LANG_CODES`에도 `k`/`ko` 없음(a/b/e/f/h/i/p/j/z만).
  한국어는 misaki의 한국어 G2P(미병합 PR/커뮤니티 포크 경로)로만 도달 가능하며 공식
  파이프라인에 배선돼 있지 않다 — **공식 지원으로 간주하지 않는다.**
  → 따라서 Kokoro-82M의 §3 1순위 지위는 **한국어 지원 때문이 아니라** 원 확정 근거(82M
  경량 · CPU/MPS 실행 · E1 GPU경쟁 회피 가설 · Apache-2.0)에 **한정하여** 유지한다.
  Task 1 성공 조건을 "한국어 공식 지원 확인"으로 잡지 않으며, Kokoro 측정 시 공식 경로와
  커뮤니티 패치(misaki[ko]) 경로를 구분한다. 한국어 품질은 선험적으로 주장하지 않는다.

  **한국어 품질 비교군 추가 — Qwen3-TTS-12Hz-0.6B-CustomVoice(Sohee).** 공식 카드 확인:
  Sohee는 native language가 Korean인 전용 여성 음색이고, 공식 문서는 각 speaker를 native
  language로 쓸 때 최상 품질을 권장한다(10개 언어 지원, streaming 지원). Kokoro 공식
  배포판이 한국어 전용 voice/pipeline을 제공하지 않으므로, 한국어 native voice를 가진
  Qwen을 **품질 상한 비교군**으로 둔다. **교체 후보가 아니다** — Qwen은 GPU/MPS 경로라
  E1을 침몰시킨 자원 경쟁을 재현할 위험이 있어 주 후보로 승격하지 않는다(Mac 이식에
  커뮤니티 패치 필요 보고됨: FlashAttn2→SDPA, CUDA→MPS 등). 측정 시 MPS 호환성·RSS·
  cold/warm TTFB를 별도로 잡는다. (참고: instruction 기반 voice control은 공식 표에서
  1.7B CustomVoice에만 표시 — 필요 시 1.7B는 참고 상한으로만.)

  **Audio8 0.1B ONNX INT8 — 선택적 CPU/ONNX 비교군(1순위 승격 아님).** 정정: 이 저장소
  (`Audio8/audio8-TTS-0.1B-ONNX-INT8`) 현재 카드는 한국어를 **11개 권장(recommended)
  지원 언어 중 하나로 명시**한다("use one of the 11 recommended languages above") — 앞서
  채팅에서 "experimental only"라 한 것은 오류(Audio8의 여러 저장소 변형을 혼동한 2차
  요약 탓). 다만 전체가 **Preview + INT8 양자화 + 무명 퍼블리셔**라 한국어별 품질·안정성은
  미보증. 승격 근거는 한국어 유무가 아니라 운영 속성(macOS ARM64 공식 테스트 · ONNX CPU ·
  상주 ~0.6GB 제공자값 · streaming PCM/HTTP · PyTorch 불요)이며, 그래도 **주 후보 승격이
  아니라 선택적 비교군**으로만 둔다.

  **정리(후보 구조, §4 성공기준·§5 판정규칙 원문 무수정):**
  1. Kokoro-82M — §3 주 후보 유지(자원격리 가설, 공식 한국어 지원으로 기록 안 함).
  2. Qwen3-TTS 0.6B CustomVoice(Sohee) — 한국어 품질 상한 비교군(교체 아님, 자원경쟁
     위험으로 미승격).
  3. Audio8 0.1B ONNX INT8 — 선택적 CPU/ONNX 비교군(Preview/INT8 위험 명시).
  4. macOS `say` — 무종속 기준선/폴백(§3 그대로).
  5. Piper / MeloTTS-Korean / sherpa-onnx — 필요 시 2차 비교군.

  **이 메모는 다운로드·설치·기동 승인이 아니다.** Task 1(이 Mac에서 어떤 모델이든 실제
  설치·기동)은 여전히 별도 named lock 필요. F4를 다운로드 토큰으로 재사용하지 않는다.

- 2026-08-30 **Task 1 named lock opened** (Hermes Ubuntu session). User literal
  `TTS-T1-MAC-KOKORO-QWEN06-AUDIO8-COMPARE-R1` plus grant sentence. `F4` is not
  reused. This block is append-only: §0–§8 and prior appends unmodified.

  **This lock authorizes Task 1 bench compare only** (not product adoption, not
  ranking auto-change, not `apps/**`). Sub-range log IDs (not independent tokens):
  `KOKORO-OFFICIAL` = `hexgrad/Kokoro-82M` + official `hexgrad/kokoro` only (no
  unmerged Korean PR/fork; official Korean support is not a success criterion;
  official-path Korean failure is recorded as fail). `QWEN06-SOHEE` =
  `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` speaker Sohee / Korean (no 1.7B /
  VoiceDesign / Base; no unofficial MPS patch without a new lock).
  `AUDIO8-ONNX-INT8` = `Audio8/audio8-TTS-0.1B-ONNX-INT8` official onnx_runtime
  + CPUExecutionProvider only (no HTTP/OpenAI service; no FP32 auto-fallback).
  One candidate at a time. No ports / daemons / sudo / Homebrew global.
  Writes only under `<절대경로>/ttsBench/task1-r1/` — the absolute root was a
  placeholder in the grant and is **not filled**.

  **This Ubuntu host does not download or start TTS.** prereg §8: Mac-local only.
  Remaining forks before Mac download (not invented here): (1) fill `<절대경로>`
  (2) fixed identical sentence set (3) fixed Korean quality rubric.

- 2026-08-30 **3개 분기 확정** (사용자, 같은 메시지 결합) — Fork 1/2/3 값 전문 기록.
  Mac 실행은 이 호스트가 하지 않음. 이 Ubuntu 기록은 Mac `KOKORO-OFFICIAL` 설치·기동
  승인이 아니다. §0–§8 및 이전 append 원문 무수정. `F4` 재사용 아님.

  **Fork #1 — Mac 절대경로 (확정)**

```text
WORK_ROOT=/Users/llm/rpchat-ttsbench-task1-r1
ENV_ROOT=/Users/llm/rpchat-ttsbench-task1-r1/envs
CACHE_ROOT=/Users/llm/rpchat-ttsbench-task1-r1/cache
AUDIO_ROOT=/Users/llm/rpchat-ttsbench-task1-r1/audio
LOG_ROOT=/Users/llm/rpchat-ttsbench-task1-r1/logs
RESULT_ROOT=/Users/llm/rpchat-ttsbench-task1-r1/results
TMP_ROOT=/Users/llm/rpchat-ttsbench-task1-r1/tmp

모델별 하위 디렉터리 식별자:
- KOKORO-OFFICIAL: kokoro-official
- QWEN06-SOHEE: qwen06-sohee
- AUDIO8-ONNX-INT8: audio8-onnx-int8

경로 규칙: 심볼릭 링크 아닌 실경로만. `~`/`$HOME`/상대경로/미확장 환경변수 금지.
기존 디렉터리 있으면 삭제 전 소유권·내용 먼저 기록, 임의 삭제 금지. WORK_ROOT 밖
영구 쓰기 금지. 모델별 env/cache/audio/log/result 서로 공유 안 함.
```

  **Fork #2 — 고정 문장 세트 (확정, 10문장 — Option A 8개 + 숫자/시간 1개 + 한영혼합 1개)**

```text
FIXED_SENTENCE_SET=TTS-KO-FIXEDSET-R1
ENCODING=UTF-8
NORMALIZATION=아래 문장을 표시된 그대로 입력하며 사후 수정하지 않는다.

RP01	그는 잠시 시선을 피했다가, 아무 일도 아니라는 듯 가볍게 웃는다. "걱정하지 마. 이번에는 내가 먼저 움직일게."
RP02	한 걸음 뒤로 물러난 그녀가 팔짱을 끼고 고개를 갸웃한다. "정말 그게 최선이라고 생각해?"
RP03	창밖을 바라보던 그는 천천히 몸을 돌린다. "생각보다 늦었네. 그래도 와 줘서 다행이야."
RP04	그녀는 테이블 위의 봉투를 손끝으로 밀어 보내며 낮은 목소리로 말한다. "열어 봐. 네가 찾던 답이 그 안에 있어."
RP05	놀란 표정으로 눈을 크게 뜬 그는 곧 어깨의 힘을 풀며 웃는다. "잠깐, 지금 그 말을 진심으로 하는 거야?"
RP06	문 앞에서 발걸음을 멈춘 그녀가 뒤를 돌아본다. "선택은 네 몫이야. 하지만 오래 기다려 주지는 않을 거야."
RP07	그는 깊게 숨을 들이마신 뒤, 흔들리는 목소리를 애써 가다듬는다. "괜찮아. 아직 끝난 건 아니니까 다시 시작하면 돼."
RP08	그녀는 지도 위의 두 지점을 차례로 가리키며 또렷하게 말한다. "우리는 여기에서 출발해서, 해가 지기 전에 저 다리까지 가야 해."
RP09	그녀는 시계를 확인하고 자리에서 일어난다. "현재 시간은 오후 2시 30분이야. 약속까지 25분 남았어."
RP10	그는 화면에 표시된 파일 이름을 천천히 읽는다. "확인해야 할 파일은 last-request.json이야."
```

  적용 규칙: 각 후보에 동일 UTF-8 문자열 입력, 문장 ID/탭 문자는 TTS 입력에 미포함,
  띄어쓰기·문장부호 변경 금지, 숫자를 한글표기로 바꾸지 않음, 영문약어 대소문자·마침표
  변경 금지, Qwen speaker=Sohee/language=Korean/instruction=빈 문자열 고정, Audio8은
  기본 음성만(음성 등록 없음), Kokoro 공식 경로가 처리 못해도 비공식 한국어 패치 적용
  금지(실패로 기록), 오류·무음·timeout도 결과로 기록, 문장별 독립 요청, 측정 순서/반복
  횟수 전 후보 동일 유지, 측정 시작 후 세트 변경 금지. MED(의료) 카테고리는 RP-Chat
  실제 출력 대표성이 낮다는 이유로 최종 세트에서 명시적으로 제외됨(제거가 아니라 애초
  미포함 결정).

  **Fork #3 — 한국어 품질 rubric (확정, `TTS-KO-QUALITY-R1`)**

```text
QUALITY_RUBRIC=TTS-KO-QUALITY-R1
RUBRIC_VERSION=1.0
LANGUAGE=ko-KR
SCALE=1-5
EVALUATION_MODE=블라인드 청취
POST_HOC_CHANGE=금지

평가 원칙:
1. 평가자는 모델명, 모델 크기, 실행 장치 및 latency 결과를 보지 않는다.
2. 오디오 파일은 후보를 식별할 수 없는 무작위 ID로 제공한다.
3. 모든 후보에 동일한 문장, 음량 정규화 규칙 및 재생 장치를 적용한다.
4. 각 오디오는 원칙적으로 한 번 듣고 평가한다.
5. 발음 확인이 필요한 경우에만 두 번째 재생을 허용하며 이를 기록한다.
6. 세 번째 이상 반복 청취는 허용하지 않는다.
7. 평가 시작 후 항목, 배점, 임계값 및 탈락 조건을 변경하지 않는다.
8. 모델의 알려진 한계를 고려해 점수를 보정하지 않는다.
9. 비공식 후처리, 발음 치환 또는 특정 모델 전용 보정을 적용하지 않는다.
10. 무음, 중단, 잡음 및 합성 실패도 제외하지 않고 평가 결과에 포함한다.

문장별 평가 항목 (1-5점, N/A 가능):
A. 발음 정확성 — 5=오류없음 / 4=경미한 어색함 1회 / 3=명백한 오류 있으나 이해가능 /
   2=여러 오류로 재확인 필요 / 1=이해불가·의미변경
   오류: 음절 누락/추가, 받침·연음 오류, 조사 오독, 외래어/영문약어 오독, 단어 교체,
   불필요한 반복, 존재하지 않는 말 생성
B. 숫자·날짜·시간·단위 정확성 — 동일 5단계. 치명오류 예: 0.25→25, 15.7%→157%,
   오전/오후 반전, 날짜 누락/변경, 용량 오독, "120에 80"을 정수로 읽음. 숫자 없는
   문장은 N/A
C. 한영 혼합 및 약어 명료도 — 동일 5단계. 한영혼합 요소 없는 문장은 N/A
D. 운율·휴지·속도 안정성 — 동일 5단계. 확인: 쉼표마다 과도한 정지, 마침표 무시,
   열거 미구분, 장문 후반 급가속, 마지막 음절 잘림, 비정상 장시간 정지
E. 자연스러움 — 동일 5단계. 음색 성별/높낮이/평가자 선호로 감점 안 함
F. 오디오 무결성 — 동일 5단계. 클릭/잡음/왜곡/무음/잘림/반복 여부

이진 결함 태그(true/false): MISPRONUNCIATION, NUMBER_ERROR, OMISSION, INSERTION,
REPETITION, HALLUCINATION, UNEXPECTED_LANGUAGE_SWITCH, ABNORMAL_PAUSE, RATE_COLLAPSE,
TRUNCATED_START, TRUNCATED_END, LONG_SILENCE, CLICK_OR_POP, DISTORTION, EMPTY_AUDIO,
SYNTHESIS_FAILURE, RATER_REPLAY_USED

문장 점수 = 적용가능한 A~F 점수의 산술평균(원시값 판정, 표시만 소수점 첫째자리 반올림).

합격 기준(QUALITY_PASS_RULE=TTS-KO-QUALITY-PASS-R1):
1. 전체 문장 품질 평균 >= 4.0
2. 전체 문장 품질 중앙값 >= 4.0
3. 발음 정확성 평균 >= 4.0
4. 숫자·날짜·시간·단위 정확성 평균 >= 4.0
5. 한영 혼합 및 약어 명료도 평균 >= 3.5
6. 운율·휴지·속도 안정성 평균 >= 3.5
7. 자연스러움 평균 >= 3.5
8. 오디오 무결성 평균 >= 4.0
9. 합성 실패 0문장 / 빈 오디오 0문장 / 치명적 정보 오류 0문장
   (10문장 고정세트이므로 %가 아니라 절대 0건으로 명시)

Hard-fail(평균과 무관하게 해당 후보 한국어 품질 판정 실패 — 오디오·데이터는 보존,
벤치에서 삭제하지 않음): 숫자/날짜/시간/용량/백분율 의미변경, 핵심 부정표현 누락,
환각 생성, 핵심 문구 누락, 예기치 않은 언어전환, 빈 오디오/합성실패, 시작·끝 절단,
지속 반복, 장시간 무음/심각한 왜곡.

짧은 문장(RP01 등) 중점 확인: 첫/마지막 음절 잘림, 불필요한 앞뒤 무음, 과도한 강세,
비정상적으로 느린 발화.
긴 문장(RP07/RP08) 중점 확인: 후반부 속도 증가, 억양 단조화, 호흡 위치 붕괴, 문장
중간 중단, 반복, 마지막 절 누락. 장문 중 하나라도 2점 이하면 LONG_FORM_INSTABILITY=true.

평가자: 1명이면 REPLAY_LIMIT=2, BLINDING=모델명 비공개, ORDER=randomized-fixed, 속도·
자원 측정 결과를 보기 전에 품질 평가 완료. 3명 이상이면 AGGREGATION=문장별 중앙값,
DISAGREEMENT_TRIGGER=최대-최소 점수차 >=2, 재판정 시 원점수 보존하고 판정점수 별도 기록.

모델 간 비교 규칙: 품질과 latency 판정 분리, 속도/크기로 품질 보정 금지, 음색선호와
발음정확성 구분, Qwen Sohee의 native 지위를 가산점으로 사용 금지, Audio8의 Preview/
INT8 상태를 감점사유로 직접 사용 금지, Kokoro의 공식 한국어 경로 부재를 오디오 품질
점수에 직접 반영 금지(단, Task1 grant 자체가 이미 "공식 한국어 지원 실패는 실패로
기록"이라 명시했으므로 이 규칙은 "품질 점수 자체를 편향시키지 말라"는 것이지 "한국어
부재를 결과에서 숨기라"는 뜻 아님 — 별도 기록됨), 실행 실패는 숨기지 않고 synthesis
failure로 기록, 모델별 전용 text normalization 적용 금지, 모든 원시 오디오·판정 로그
보존.

최종 판정 상태값: PASS / FAIL_QUALITY / FAIL_CRITICAL_ERROR / FAIL_SYNTHESIS /
NOT_EVALUABLE(승인된 공식 경로에서 해당 입력을 합성할 수 없음, 합격 아님, FAIL_QUALITY와
동일시하지 않음) / INCOMPLETE(안전·환경 조건으로 중단, 전체 표본 없음).
```

  **주의(Fork #2+#3 결합 이슈, 이미 해소됨)**: Option A 8문장만 썼다면 B·C 항목이 전
  문장에서 N/A가 되어 §6의 4·5번 합격기준이 정의 불가(0으로 나누기)였음. RP09(숫자·시간)
  + RP10(한영혼합)을 추가해 이 문제를 해소함 — 이제 10문장 세트에서 B는 RP09 1개, C는
  RP10 1개에 대해서만 평가되고 나머지는 N/A. B·C의 "평균"은 그 1개 문장 점수 자체가 됨
  — 표본이 1개뿐이라는 한계는 있으나 §6 조건이 최소한 정의는 됨. 이 한계를 append에도
  그대로 남길 것(사후 은폐 금지).

- 2026-08-31 **KOKORO-OFFICIAL 실행 완료** (Mac Claude Code, 사용자 "설치, 실행 시작"
  승인. lock `TTS-T1-MAC-KOKORO-QWEN06-AUDIO8-COMPARE-R1`, 후보 1/3, one-at-a-time).
  이 블록은 append-only. 원시 오디오·결과 JSON은 grant대로 Mac-local(WORK_ROOT) 보관,
  hermes에 동기화 안 함. 여기엔 방법·결과 요약만 기록.

  **환경(격리, WORK_ROOT 안, sudo/brew전역/포트/데몬 없음)**: `WORK_ROOT=
  /Users/llm/rpchat-ttsbench-task1-r1`. Python 3.11.15 venv(`envs/kokoro-official/venv`).
  공식 pip 패키지 `kokoro==0.9.4`(hexgrad) + `misaki==0.9.4` + `torch==2.13.0` +
  `soundfile==0.14.0`. 모델 `hexgrad/Kokoro-82M`(snapshot `f3ff3571…`, `kokoro-v1_0.pth`,
  313MB) → HF_HOME/PIP/TMP 전부 WORK_ROOT/cache·tmp로 리다이렉트, `~/.cache/huggingface`에
  kokoro 유출 0건 직접 확인. 커뮤니티 한국어 패치(misaki[ko]/미병합 PR) 설치 안 함.

  **공식 한국어 부재 — 설치된 패키지 소스로 직접 확인**: `kokoro/pipeline.py` `LANG_CODES
  = {a,b,e,f,h,i,p,j,z}`(9개, 한국어 없음), `ALIASES`에도 `ko` 없음. 즉 공식 경로엔
  한국어 lang_code가 존재하지 않음 → 강제로 `lang_code='a'`(American English G2P) +
  `voice='af_heart'`로 한국어 10문장(RP01–RP10)을 입력. 이는 "되게 만들려는 시도"가
  아니라 grant가 규정한 "공식 경로를 한국어에 그대로 적용한 정직한 측정"임.

  **기계적 결과(크래시 없음, 그러나 한국어 유효성 아님)**: 10/10 문장 합성 성공(예외 0,
  빈 오디오 0). 합성 지연(첫 문장 워밍업 3.0s 제외) ~0.8–1.1s/문장 — CPU 추론, 빠름.
  E1처럼 GPU 경쟁/웨지 없음(82M CPU 모델).
  **객관적 이상 신호(핵심)**: 생성 오디오가 전 문장 ~3.0–3.5 chars/sec(평균 18.1초/문장,
  총 180.7초). 자연스러운 한국어 TTS는 통상 6–9초/문장(문자 기준 ~5–8 chars/sec)이므로
  **약 2.5–3배 과길이** — 한국어 미지원 상태에서 영어/espeak G2P가 한글을 뭉개/철자화한
  결과로 강하게 추정됨. (지연·길이는 raw 측정, 판정 해석은 아래.)

  **rubric(TTS-KO-QUALITY-R1) 판정 — 미완(사람 블라인드 청취 필요)**: rubric A–F 점수는
  **사람의 블라인드 청취**를 요구하며 Claude Code는 오디오를 들을 수 없어 A–F 점수를
  부여하지 않음. 정직한 상태: 오디오가 생성됐으므로 엄밀히는 `NOT_EVALUABLE`(=공식경로가
  입력을 합성 못함)은 아님. 그러나 (1) 공식 한국어 lang_code 부재(설치 소스 확인) +
  (2) 길이 2.5–3배 이상이라는 객관 신호는 A(발음)·Hard-fail(mispronunciation/hallucination)에서
  `FAIL_QUALITY` 또는 `FAIL_CRITICAL_ERROR`를 강하게 예고함. **최종 상태값은 사용자
  블라인드 청취로 확정**해야 하며, 세 후보 오디오를 무작위 ID로 섞어 듣는 정식 블라인드
  프로토콜은 QWEN06-SOHEE/AUDIO8까지 합성된 뒤 수행하는 게 rubric §평가원칙에 맞음.
  (grant 자체가 "공식 한국어 지원 실패는 실패로 기록"이라 명시 — 이 결과는 그 예고와 일치.)

  **아티팩트(Mac-local)**: 오디오 `audio/kokoro-official/RP01–RP10.wav`(24kHz mono),
  결과 `results/kokoro-official/kokoro-official-r1.json`(문장별 chars/sec·wall_ms·경로·
  lang_code 기록), 로그 `logs/kokoro-official/{install,synth}.log`, 스크립트
  `synth_kokoro_official.py`. 전부 WORK_ROOT 밖 영구쓰기 0.

  **다음**: QWEN06-SOHEE(한국어 native 후보)는 GPU/MPS 경로라 E1 자원경쟁 위험 있음 —
  one-at-a-time 원칙 + 그 위험 때문에 사용자 별도 확인 후 착수. 이 KOKORO-OFFICIAL 실행은
  나머지 두 후보 권한을 넓히지 않음.

- 2026-08-31 **KOKORO-OFFICIAL 사람 블라인드 청취 확정 = FAIL** (사용자 직접 청취:
  "한국어로 전혀 들리지 않는다"). 앞서 기록한 객관 예고(공식 한국어 lang_code 부재 +
  오디오 2.5-3배 과길이)가 사람 청취로 확인됨. rubric 최종 상태값 = **FAIL_QUALITY**
  (오디오는 생성됐으나 한국어로 인식 불가; A 발음 및 Hard-fail mispronunciation 해당).
  **후보 1/3(KOKORO-OFFICIAL) 종료 — FAIL.** grant의 "공식 한국어 지원 실패는 실패로
  기록"과 일치. 원시 오디오·JSON은 WORK_ROOT에 보존(삭제 안 함). 이 결과가 나머지 두
  후보의 권한을 넓히지 않음 — QWEN06-SOHEE/AUDIO8은 여전히 각자 사용자 go 필요.


- 2026-08-31 **AUDIO8-ONNX-INT8 실행 완료** (Mac Claude Code, 사용자 후보 선택 "AUDIO8-ONNX-INT8",
  후보 2/3). append-only. 원시 오디오·JSON은 Mac-local(WORK_ROOT), hermes 미동기화.

  **환경/준수(grant)**: 공식 레포 `github.com/Audio8-AI/Audio8_TTS/onnx_runtime_0_1b_int8`,
  격리 `.venv`(py3.11), 모델 `Audio8/audio8-TTS-0.1B-ONNX-INT8`(int8 slow/fast AR +
  fp16 codec, 886MB) → 전부 WORK_ROOT/{envs,cache}/audio8-onnx-int8, `~/.cache` 유출 0건
  확인. **CPUExecutionProvider only** — `runtime.py`가 `providers=["CPUExecutionProvider"]`
  하드코딩(직접 소스 확인), GPU/CoreML 안 씀 → E1 GPU경쟁 위험 없음. **HTTP/OpenAI 서비스
  미기동**(CLI `arktts_runtime.cli` 직접 호출, run_server.sh 안 씀). **FP32 폴백 없음**
  (precision int8/codec fp16 모델 기본값 유지). setup.sh/register_default_voice.py/cli.py를
  실행 전 직접 읽어 sudo/전역/HTTP의존/외부쓰기 없음 확인.

  **음성 등록 해석 주의(사용자 확인 요망)**: 확정 규칙 #10 "Audio8은 제공된 기본 음성을
  사용하며 음성 등록을 수행하지 않는다"에서, 공식 런타임은 `voices/`에 voice가 있어야
  합성 가능하고 그 "default" voice는 `scripts/register_default_voice.py`로 **모델 자체
  번들 reference_codes.npy**에서 생성됨(외부/커스텀 화자 클로닝 아님, shape (10,110)).
  즉 "제공된 기본 음성 사용"을 위해 이 스크립트 실행이 필수이며 커스텀 음성 등록이 아님 —
  이 해석으로 진행함. 사용자가 더 엄격한 의미였다면 재검토.

  **파라미터**: 공식 CLI 기본 샘플링(temperature 0.7 / top_p 0.9 / top_k 50 / seed 42 /
  threads 5) + `max_new_tokens=1024`(기본 256은 절단 위험 — frame_rate ~21.5Hz라 1024면
  ~47s 캡, 절단 방지용. 실측 전 문장 hit_max=False로 절단 0 확인). sample_rate 44100.

  **결과(10/10 성공, 크래시·빈오디오·절단 0)**:
  | id | audio8 sec | 전체합성 wall s | (참고 Kokoro sec) |
  |---|---|---|---|
  | RP01 | 10.68 | 10.2 | 18.95 |
  | RP02 | 7.89 | 7.7 | 15.75 |
  | RP03 | 7.80 | 7.6 | 15.38 |
  | RP04 | 10.26 | 9.5 | 20.15 |
  | RP05 | 8.73 | 8.3 | 19.95 |
  | RP06 | 10.40 | 9.8 | 18.62 |
  | RP07 | 11.15 | 10.2 | 20.45 |
  | RP08 | 10.12 | 9.5 | 20.60 |
  | RP09 | 9.75 | 9.1 | 17.50 |
  | RP10 | 7.57 | 7.3 | 13.32 |
  | avg | 9.44 | 8.9 | 18.07 |
  Audio8 오디오 길이가 Kokoro의 약 1/2(~4-5 음절/초, 자연스러운 한국어 범위) — Kokoro의
  뭉갬(2.5-3배 과길이)과 반대 지문. **객관적으로 Kokoro보다 훨씬 유망**.

  **판정 미완(사람 블라인드 청취 필요)**: 자연스러운 길이는 필요조건이지 충분조건 아님 —
  실제 발음/명료도는 사람 청취로만 확정. Claude 청취 불가. 대표 3개(RP01/RP09/RP10) 사용자
  전달, 나머지 WORK_ROOT 보관. rubric A-F는 청취 후.

  **§4.2-3 지연 주의(미측정)**: 위 wall 7.3-10.2s/문장은 **비스트리밍 전체 합성 시간**이며,
  §4.2-3의 "첫 오디오 바이트 도착 p95 ≤ 5초"(스트리밍 TTFA)와 다른 지표임. Audio8은
  streaming PCM을 제공하나 이번엔 비스트리밍 CLI로 측정 — 스트리밍 TTFA는 별도 측정 필요.
  또한 이 CPU 측정은 Gemma·writer·Claude 세션 동시 부하 하에서 수행됨.

  **아티팩트(Mac-local)**: `audio/audio8-onnx-int8/RP01-10.wav`(44.1kHz),
  `results/audio8-onnx-int8/audio8-onnx-int8-r1.json`, `logs/audio8-onnx-int8/{setup,synth}.log`,
  `synth_audio8_onnx_int8.py`. WORK_ROOT 밖 영구쓰기 0.
  **다음**: QWEN06-SOHEE(후보 3/3, GPU/MPS=E1위험, 공식 Mac경로 CUDA기반 가능성) 또는
  사용자 청취 후 Audio8 채택 판단. one-at-a-time 유지.

- 2026-08-31 **AUDIO8-ONNX-INT8 사람 청취 확정 = 한국어 정상** (사용자: "한국어로 잘
  들린다"). 앞선 객관 신호(자연스러운 길이, Kokoro의 절반)가 사람 청취로 확인됨 —
  Kokoro(FAIL)와 명확히 대비. 기본 명료도(한국어로 인식됨) 통과. 단 rubric A-F 세부
  점수(발음정확성/숫자/운율/자연스러움/무결성)와 §4.2 지연(스트리밍 TTFA)·§4.1 채팅
  비저하 동시측정은 아직 미완 — Audio8은 "유력 후보"로 잠정 확정, 정식 채택 판정은 후속.
  사용자 요청으로 QWEN06-SOHEE(후보 3/3)도 비교 진행.


- 2026-08-31 **QWEN06-SOHEE 실행 완료** (Mac Claude Code, 사용자 "qwen도 테스트", 후보 3/3
  — R1 세 후보 비교 완료). append-only. 원시 오디오·JSON은 Mac-local(WORK_ROOT).

  **환경/준수(grant)**: 공식 pip `qwen-tts==0.1.1`, 모델 `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
  (2.6GB, WORK_ROOT/cache/qwen06-sohee, ~/.cache 유출 0). speaker=Sohee, language=Korean.
  1.7B/VoiceDesign/Base 안 씀. **비공식 MPS 소스패치 없음** — 로드는 표준 `from_pretrained`
  kwargs만(`device_map='cpu'`, `dtype=float32`, `attn_implementation='eager'`). 이는 소스
  수정이 아니라 공식 transformers API 옵션이며, **패키지 자체가 flash-attn 부재 시 "manual
  PyTorch version"으로 자동 폴백**한다고 임포트 시 명시 → 즉 non-CUDA/non-flash 실행이
  패키지 공식 지원 경로임(패치 아님). **CPU 사용**으로 GPU 미사용 → E1 자원경쟁 위험 없음
  (MPS는 available이나 의도적으로 CPU 선택). 따라서 QWEN06-SOHEE는 **NOT_EVALUABLE 아님**
  (공식 경로가 이 Mac CPU에서 실제 구동됨).

  **결과(10/10 성공, 크래시·빈오디오 0, sample_rate 24000)**:
  | id | Qwen sec | 전체합성 wall s | (Audio8 sec) | (Kokoro sec) |
  |---|---|---|---|---|
  | RP01 | 11.20 | 22.9 | 10.68 | 18.95 |
  | RP02 | 11.44 | 23.8 | 7.89 | 15.75 |
  | RP03 | 10.00 | 20.8 | 7.80 | 15.38 |
  | RP04 | 11.28 | 23.6 | 10.26 | 20.15 |
  | RP05 | 11.44 | 23.8 | 8.73 | 19.95 |
  | RP06 | 10.48 | 21.8 | 10.40 | 18.62 |
  | RP07 | 13.12 | 27.4 | 11.15 | 20.45 |
  | RP08 | 11.76 | 24.3 | 10.12 | 20.60 |
  | RP09 | 12.32 | 25.7 | 9.75 | 17.50 |
  | RP10 | 8.08 | 16.9 | 7.57 | 13.32 |
  | avg | 11.11 | 23.1 | 9.44 | 18.07 |
  Qwen 오디오 길이도 자연스러운 한국어 범위(Kokoro와 명확히 다름). 단 전체합성 wall이
  Audio8(~9s)의 약 2.5배(~23s) — 0.6B 트랜스포머 CPU float32가 Audio8 int8 ONNX보다 무겁기
  때문. (§4.2-3 스트리밍 TTFA 아님, 비스트리밍 전체합성 시간.)

  **판정(사람 블라인드 청취 — 세 후보 모두 합성됨 → 정식 블라인드 프로토콜 적용 가능)**:
  Claude 청취 불가라 A-F 미부여. 대표 3개(RP01/RP09/RP10) 사용자 전달, Audio8과 직접 비교
  요청. 핵심 결정 = Audio8 vs Qwen(둘 다 자연 한국어). 트레이드오프: Qwen=Sohee 한국어
  native 음색(품질 상한 후보, 단 합성 2.5배 느림/GPU 안 쓰면 CPU 느림), Audio8=경량 int8
  CPU로 훨씬 빠름+44.1kHz(단 Preview/INT8). Kokoro는 이미 FAIL 확정.

  **R1 세 후보 비교 상태 요약**:
  - KOKORO-OFFICIAL: **FAIL**(사람확정, 한국어 아님).
  - AUDIO8-ONNX-INT8: 사람확정 "한국어로 잘 들림", 빠름(CPU int8) — 유력.
  - QWEN06-SOHEE: 자연 한국어 길이, native 음색, CPU 구동 확인 — 청취 비교 대기.
  세부 rubric A-F 점수, §4.2 스트리밍 지연, §4.1 채팅 동시 비저하 측정은 R1 이후 별도.
  프로덕션 통합/제품 코드는 이 lock 밖(새 이름 필요).


- 2026-08-31 **R1 최종 사람 판정 = QWEN06-SOHEE 유창함 압도적 우위** (사용자 직접 청취:
  "확실히 유창한 정도는 qwen이 압도적". Audio8 대비 명시적 비교 판단).
  **R1(TTS-T1-MAC-KOKORO-QWEN06-AUDIO8-COMPARE-R1) 세 후보 최종 상태**:
  - KOKORO-OFFICIAL: **FAIL**(사람확정, 한국어 아님) — 공식 한국어 lang_code 부재.
  - AUDIO8-ONNX-INT8: 한국어로 인식됨(사람확정), 빠름(CPU int8 ~9s/문장), 단 유창함은
    Qwen보다 낮음(사람판단, 이번 확정으로 상대순위 정해짐).
  - QWEN06-SOHEE: **사람판단 최유력** — native 화자 Sohee, 유창함 압도적. 단 합성
    ~23s/문장(Audio8의 2.5배, CPU float32 0.6B).
  **R1 종료.** 이 lock의 §1 scope("지정 Mac에서 세 후보 비교만, 제품 도입·순위 자동변경
  아님")대로, 이 사람판정은 "R1 비교에서 Qwen이 이겼다"는 사실 기록이지 자동 제품채택이
  아님 — rubric A-F 세부 수치화, §4.2 스트리밍 지연, §4.1 채팅 동시 비저하 실측, 그리고
  실제 프로덕션 통합은 전부 이 lock 범위 밖(각각 별도 새 이름 필요, grant 원문 그대로).


- 2026-08-31 **R2 named lock opened**: user literal
  `TTS-T2-MAC-CHATTERBOX-COSYVOICE2-OMNIVOICE-S1MINI-VOXCPM2-HIGGS-COMPARE-R2`.
  Grep confirmed: never appeared in working tree or `git log --all -p` before this block
  (genuinely new). HEAD/PID unchanged, no download/install/apps/** yet.

  **Scope — 6 candidates, primary-source verified before naming (WebFetch of each raw
  README, not WebSearch summaries — R1's Kokoro/Audio8 lesson applied)**:
  | 로그ID | repo | 크기 | 라이선스 | 한국어 | Mac 실행가능성(선행판단) |
  |---|---|---|---|---|---|
  | CHATTERBOX | `ResembleAI/chatterbox` | 0.5B | MIT | 공식(23+언어, ko 포함) | device 지정식, CPU 시도 가능(공식 CUDA 강제 문구 없음) |
  | COSYVOICE2 | `FunAudioLLM/CosyVoice2-0.5B` | 0.5B | Apache-2.0 | 공식(9언어) | 하드웨어 제약 명시 없음, 시도 가능 |
  | OMNIVOICE | `k2-fsa/OmniVoice` | 미상 | CC-BY-NC(비상업) | 공식(600+언어, ko) | Apple Silicon 설치 안내 존재(README 자체 언급) |
  | S1MINI | `fishaudio/s1-mini` | 0.5B | CC-BY-NC-SA(비상업) | 공식(13언어, ko) | **gated repo** — 사용자가 HF 토큰 준비(사용자 직접 입력, Claude 미입력) |
  | VOXCPM2 | `openbmb/VoxCPM2` | 2B | Apache-2.0 | 공식(30언어, ko) | ⚠️ 카드가 "CUDA ≥ 12.0" **필수 명시** — 이 Mac 미충족 가능성 높음 |
  | HIGGS | `bosonai/higgs-tts-3-4b` | 4B | 연구/비상업 | 공식(102언어, ko production-tier) | ⚠️ 표준 API가 SGLang-Omni/vLLM-Omni **서버 배포 전제**(H100 기준) — grant의 포트/데몬 금지와 충돌 가능 |

  **R2가 R1과 다른 점(중요)**: R1은 세 후보 중 하나(Kokoro)가 **공식 한국어 지원 자체가
  없어서** 탈락했다. R2의 6개는 전부 모델카드상 한국어를 공식 지원한다 — 즉 R2의 실제
  위험은 "한국어 지원 여부"가 아니라 **"이 Mac(CPU/MPS, CUDA 없음, sudo/포트/데몬 금지)
  에서 공식 경로가 구동되는가"**다. VOXCPM2/HIGGS는 이 축에서 사전에 이미 위험 신호가
  보임(전자는 CUDA 필수 명시, 후자는 서버 배포 전제) — 사용자 승인으로 6개 전부 시도하되,
  안 되면 grant 그대로 NOT_EVALUABLE로 기록하고 소스 패치·서버 기동 강행 안 함.

  **미확정 — 다음 메시지에서 채워야 함(침묵은 채움 아님, R1과 동일 원칙)**:
  1. 절대경로(WORK_ROOT) — 제안: `/Users/llm/rpchat-ttsbench-task1-r2`(R1 결과 오염 방지용
     별도 루트, R1과 동일 서브디렉터리 구조: envs/cache/audio/logs/results/tmp ×
     6개 로그ID)
  2. 고정 문장 세트 — 제안: `TTS-KO-FIXEDSET-R1`(RP01–RP10) 그대로 재사용(R1과 직접
     비교 가능)
  3. 한국어 품질 rubric — 제안: `TTS-KO-QUALITY-R1` 그대로 재사용
  4. 실행 제약 — 제안: R1과 동일(one-at-a-time, WORK_ROOT 안, sudo/포트/데몬 없음, 공식
     경로만, 소스패치 금지, 안 되면 NOT_EVALUABLE) + HIGGS 특칙(서버 배포가 유일 경로면
     시도 없이 NOT_EVALUABLE)

  다운로드·설치·기동·apps/** 전부 0. 이 이름으로 아직 아무것도 실행되지 않음.


- 2026-08-31 **R2 4개 분기 확정** (사용자: "hf에 이미 로그인 되어있고 gate도 내가 승인해서
  접근 가능할거야. s1mini 먼저 확인해보자. R1과 동일한 제약으로 순차적으로 진행."). 제안된
  기본값 4개를 사용자가 그대로 채택(침묵이 아니라 "R1과 동일한 제약"으로 명시적 확인):
  1. WORK_ROOT = `/Users/llm/rpchat-ttsbench-task1-r2` (R1과 별도 루트, 동일 서브디렉터리
     구조: envs/cache/audio/logs/results/tmp × 6개 로그ID)
  2. 문장 세트 = `TTS-KO-FIXEDSET-R1`(RP01–RP10) 그대로 재사용
  3. 품질 rubric = `TTS-KO-QUALITY-R1` 그대로 재사용
  4. 실행 제약 = R1과 동일(one-at-a-time, WORK_ROOT 안, sudo/포트/데몬 없음, 공식 경로만,
     소스패치 금지, 안 되면 NOT_EVALUABLE) + HIGGS 특칙(서버 배포가 유일 경로면 시도 없이
     NOT_EVALUABLE) 유지

  **자격증명 처리 예외(사전 고지)**: S1MINI(gated repo)만, HF_HOME을 WORK_ROOT로 리다이렉트
  하지 않음 — 기존 전역 `~/.cache/huggingface/token`(사용자가 이미 로그인·gate 승인)을
  그대로 사용해 인증하되, 실제 모델 가중치 파일은 `hf download --local-dir`로 WORK_ROOT
  하위(`cache/s1mini/checkpoints/...`)에 격리 저장. Claude는 토큰 값을 읽거나 출력하지
  않음 — `hf auth whoami`(user=manoffin 확인)와 토큰 파일 존재/권한(`-rw-------`, 37bytes)
  만 확인, 내용은 미열람. 다른 5개 후보는 기존 R1 패턴대로 HF_HOME 전부 WORK_ROOT 리다이렉트.

  진행 순서: 사용자 지시대로 S1MINI를 6개 중 최우선으로 실행.


- 2026-08-31 **S1MINI(fishaudio/openaudio-s1-mini) 실행 완료** (Mac Claude Code, R2 후보
  1/6). append-only. 원시 오디오·JSON은 Mac-local(WORK_ROOT `/Users/llm/rpchat-ttsbench-task1-r2`).

  **중요한 기술적 발견 — 코드 버전 고정 필요(소스패치 아님)**: fish-speech GitHub `main`
  브랜치(최신 HEAD)는 이 체크포인트를 못 돌린다. 원인 분석:
  - `main`은 최근 "S2 beta"로 재작성됨(커밋 `daa9b4f`/`b72bcb3`, 2026-03-10). 이 재작성이
    `fish_speech/tokenizer.py`의 `FishTokenizer`를 `transformers.AutoTokenizer.from_pretrained`
    기반으로 바꿈. 그런데 openaudio-s1-mini 체크포인트는 순수 tiktoken 파일
    (`tokenizer.tiktoken` + `special_tokens.json`)만 제공 — HF AutoTokenizer가 인식하는
    형식이 아니라서 `tokenizer=None`이 되고, 이후 `tokenizer.encode(...)` 호출에서
    `AttributeError: 'NoneType' object has no attribute 'encode'` 로 크래시. (모델 가중치
    자체는 `main`에서도 100% 매치 — "All keys matched successfully" — 깨진 건 토크나이저
    로딩 한 곳뿐.)
  - 대안으로 태그 `v1.5.1`(2025-05-27, 마지막 안정 릴리즈)을 확인 — 이쪽은 tiktoken 기반
    tokenizer.py라 형식은 맞지만, `v1.5.1`은 `fish_speech/models/dac/`(modded_dac 코덱)이
    아직 도입되기 전이라(도입은 커밋 `9735644`, 2025-06-03) 구형 firefly-gan-vq 코덱만
    지원 — 우리 체크포인트의 `codec.pth`(modded_dac_vq 아키텍처) 구조와 안 맞음.
  - `git log`/`git show`로 커밋 이력을 직접 조사해 두 요구사항(① tiktoken 기반
    tokenizer.py, ② dac/modded_dac_vq 코덱 지원)을 **동시에** 만족하는 지점을 확인:
    커밋 `781bf1c`("Finetune support of OpenAudio-S1 #1115", 2025-10-20) — dac 코덱 도입
    이후, S2 재작성 이전의 `main` 브랜치 실제 이력상의 커밋. **소스 수정이 아니라
    이 특정 체크포인트 포맷과 실제로 대응하는 공식 히스토리상의 커밋으로 버전을 고정한
    것** — R1에서 세운 "공식 경로만, 패치 금지" 원칙과 동일 기준으로 검증(파일별 존재
    확인 `git show 781bf1c:fish_speech/models/dac/inference.py`,
    `git show 781bf1c:fish_speech/tokenizer.py` 직접 조회, 코드 한 줄도 수정 안 함).
    이 커밋을 별도 clone(`envs/s1mini/fish-speech-781bf1c/`)에 체크아웃해 사용, 원래
    `main` clone(`envs/s1mini/fish-speech/`)은 그대로 보존(비교 기록용).

  **환경/준수(grant)**: venv `envs/s1mini/venv`(python3.11.15), `torch==2.8.0`/
  `torchaudio==2.8.0`(공식 pyproject 핀, MPS 표준 지원 확인 `torch.backends.mps.is_available()`
  =True). `pyaudio`만 설치 실패(portaudio 시스템 라이브러리 부재, brew 설치는 grant의
  "no global-Homebrew" 위반이라 미실행) — 그러나 `pyaudio`는 `tools/api_client.py`(마이크
  입력 데모)에서만 쓰이고 우리가 실행하는 `text2semantic/inference.py`·`dac/inference.py`
  어디에도 안 씀(grep 확인) → `pip install --no-deps -e .` + 개별 의존성 설치로 우회,
  fish-speech 자체 소스는 무수정. **공식 CLI 두 단계, `--device mps`**(공식 노출 옵션,
  기본값 cuda지만 일반 `torch.device()` 처리라 하드코딩 CUDA assert 없음 — 패치 아님):
  ① `text2semantic/inference.py --text ... --checkpoint-path <ckpt> --device mps --seed 42`
  → `codes_0.npy`, ② `dac/inference.py -i codes_0.npy --checkpoint-path <ckpt>/codec.pth
  --device mps`(config-name 기본값 `modded_dac_vq`, 체크포인트와 일치 확인) → `fake.wav`.
  **레퍼런스 오디오 없음**(공식 문서 "randomly choose a voice timbre면 이 단계 생략 가능"
  경로 사용) — 10문장 전부 동일 `--seed 42`로 음색 일관성 근사(공식 보장 아님, 명시적
  고지). sudo/포트/데몬/전역설치 0.

  **결과(10/10 성공, 크래시·빈오디오 0, sample_rate 44100)**:
  | id | S1MINI sec | 전체합성 wall s | (Qwen sec) | (Audio8 sec) | (Kokoro sec) |
  |---|---|---|---|---|---|
  | RP01 | 7.012 | 30.6 | 11.20 | 10.68 | 18.95 |
  | RP02 | 5.201 | 27.0 | 11.44 | 7.89 | 15.75 |
  | RP03 | 5.666 | 27.7 | 10.00 | 7.80 | 15.38 |
  | RP04 | 6.966 | 29.7 | 11.28 | 10.26 | 20.15 |
  | RP05 | 6.594 | 29.2 | 11.44 | 8.73 | 19.95 |
  | RP06 | 6.362 | 28.6 | 10.48 | 10.40 | 18.62 |
  | RP07 | 7.848 | 31.2 | 13.12 | 11.15 | 20.45 |
  | RP08 | 7.291 | 30.0 | 11.76 | 10.12 | 20.60 |
  | RP09 | 6.269 | 28.6 | 12.32 | 9.75 | 17.50 |
  | RP10 | 4.551 | 25.8 | 8.08 | 7.57 | 13.32 |
  | avg | 6.376 | 28.85 | 11.11 | 9.44 | 18.07 |
  S1MINI 오디오 길이도 자연스러운 한국어 범위(Kokoro의 뭉갬 패턴과 다름). 전체합성 wall은
  Qwen(~23s)보다 약간 빠르고 Audio8(~9s)보다는 3배 이상 느림 — text2semantic(0.6B급
  dual_ar transformer, ~10-14s) + dac decode(~15-20s) 두 서브프로세스 합산, MPS 사용.
  (§4.2-3 스트리밍 TTFA 아님, 비스트리밍 전체합성 시간, 두 subprocess 합.)

  **판정 미완(사람 블라인드 청취 필요)**: Claude 청취 불가, 자연스러운 길이는 필요조건이지
  충분조건 아님. 대표 3개(RP01/RP09/RP10) 사용자 전달 예정, 나머지 WORK_ROOT 보관. rubric
  A-F는 청취 후.

  **아티팩트(Mac-local)**: `audio/s1mini/RP01-10.wav`(44.1kHz),
  `results/s1mini/s1mini-r2.json`, `logs/s1mini/{pip-install,pip-install-2,hf-download,synth-run}.log`,
  `synth_s1mini.py`, 코드 clone `envs/s1mini/fish-speech-781bf1c/`(원본 `main` clone
  `envs/s1mini/fish-speech/`도 비교기록용 보존). WORK_ROOT 밖 영구쓰기 0(단, 위 고지된
  전역 HF 토큰 읽기전용 사용 제외).
  **다음**: 사용자 청취 후 S1MINI 판정, 또는 R2 후보 2/6 CHATTERBOX(ResembleAI, MIT,
  공식 CUDA 강제 문구 없음 — 우선 조사 예정)로 진행. one-at-a-time 유지.


- 2026-08-31 **S1MINI 사람 청취 판정 = 대체로 양호하나 RP10 결함** (사용자: "s1mini도 괜찮긴
  한데, rp10의 json 파일명이 나오지 않는걸 보니 짤리거나 오류가 있었는 모양이야. 일단
  넘어갈게."). RP10 원문은 영문 파일명+확장자 혼합 문장(`"확인해야 할 파일은
  last-request.json이야."`) — B/C(숫자·영문혼합) 차원 N=1 대상 문장, R1 때부터 알려진
  취약 케이스.

  **객관 신호로 교차확인**: RP10만 chars/sec **13.18**로 나머지 9개(8.54–10.01, 평균 ~9.3)
  대비 뚜렷한 이상치 — 사람 판정(파일명 부분 누락/뭉갬)과 방향이 일치. Claude는 청취 불가라
  이 duration-이상치는 사전 신호일 뿐이었으나, 사람 확인으로 **RP10 결함이 실제로 확정**됨.
  나머지 9문장(RP01–09)은 이번 청취에서 결함 지적 없음 — S1MINI는 "부분 결함
  있음"(전면 FAIL 아님, Kokoro와 다른 유형)으로 잠정 기록. rubric A-F 세부 점수는 부여
  안 함(사용자가 세부평가 없이 다음 후보로 진행 지시).

  **판정(사용자 지시)**: 세부 rubric 평가 보류, R2 후보 2/6 CHATTERBOX로 진행. S1MINI는
  "대체로 양호 + 영문/파일명 혼합 케이스 취약"으로 결과 확정, 재시도·재합성 없음.

  **아티팩트**: 변경 없음(기존 `audio/s1mini/RP01-10.wav`,
  `results/s1mini/s1mini-r2.json` 그대로 보존).
  **다음**: R2 후보 2/6 **CHATTERBOX**(`ResembleAI/chatterbox`, 0.5B, MIT, 공식 CUDA
  강제 문구 없음) 조사·실행 착수.


- 2026-08-31 **CHATTERBOX(ResembleAI/chatterbox) 실행 완료** (Mac Claude Code, R2 후보
  2/6). append-only. 원시 오디오·JSON은 Mac-local(WORK_ROOT `/Users/llm/rpchat-ttsbench-task1-r2`).

  **환경/준수(grant)**: 공식 pip `chatterbox-tts==0.1.7`(PyPI, GitHub clone 불필요 — S1MINI와
  달리 버전 고정 이슈 없음), venv `envs/chatterbox/venv`(python3.11.15), `torch==2.6.0`
  (패키지 자체 핀, MPS 표준 지원 확인). 한국어는 `ChatterboxMultilingualTTS`(기본
  `ChatterboxTTS`는 영어전용, 모델카드에 명시) — `from_pretrained(device='mps')` +
  `generate(text, language_id='ko')`, 공식 README가 직접 `device = "cuda" # or "cpu" /
  "mps"`로 Mac/MPS 지원을 명시(S1MINI처럼 git 고고학 불필요, 가장 매끄러운 셋업).
  레퍼런스 오디오 없음(`audio_prompt_path` 생략 — 공식 기본 내장 음성 경로).

  **비모델 의존성 수정 1건(소스패치 아님)**: `resemble-perth` 패키지의 워터마커
  임포트가 `pkg_resources`(setuptools 81+에서 제거된 레거시 API) 부재로 조용히
  `PerthImplicitWatermarker=None`이 되고(패키지 자체의 `try/except ImportError` 폴백,
  perth 소스 그대로) 사용 시 크래시 — `pip install "setuptools<81"`로 해결(생태계 전반의
  알려진 pkg_resources 폐기 이슈, chatterbox/perth 소스 무수정, 표준 패키징 대응).

  **결과(10/10 성공, 크래시·빈오디오 0, sample_rate 24000)**:
  | id | Chatterbox sec | wall ms | chars/sec | (S1MINI sec) | (Qwen sec) | (Audio8 sec) |
  |---|---|---|---|---|---|---|
  | RP01 | 5.52 | 12315 | 11.59 | 7.01 | 11.20 | 10.68 |
  | RP02 | 6.48 | 10541 | 7.87 | 5.20 | 11.44 | 7.89 |
  | RP03 | 5.12 | 7806 | 9.77 | 5.67 | 10.00 | 7.80 |
  | RP04 | 7.04 | 11317 | 9.23 | 6.97 | 11.28 | 10.26 |
  | RP05 | 6.36 | 9701 | 9.59 | 6.59 | 11.44 | 8.73 |
  | RP06 | 6.44 | 9719 | 9.47 | 6.36 | 10.48 | 10.40 |
  | RP07 | 7.68 | 12367 | 8.72 | 7.85 | 13.12 | 11.15 |
  | RP08 | 8.12 | 13395 | 8.99 | 7.29 | 11.76 | 10.12 |
  | RP09 | 6.36 | 9520 | 9.28 | 6.27 | 12.32 | 9.75 |
  | RP10 | 7.20 | 12108 | 8.33 | 4.55(결함확정) | 8.08 | 7.57 |
  | avg | 6.63 | 10879 | 9.28 | 6.38 | 11.11 | 9.44 |
  chars/sec 전 구간 7.87–11.59로 자연스러운 범위(Kokoro류 뭉갬 패턴 아님), RP10도 이번엔
  이상치 아님(S1MINI가 RP10에서 결함났던 것과 대비됨). 전체합성 wall이 6개 후보 중
  가장 빠름(avg ~10.9s/문장, Audio8 다음으로 빠른 축).

  **객관 신호(사람 청취 전 예비 관찰, 확정 아님)**: 모델 자체의
  `alignment_stream_analyzer`가 10문장 중 **3문장에서 토큰 반복(2x repetition) 감지 →
  강제 EOS**를 로그에 남김(RP01/RP03/RP09). 이는 모델이 자체적으로 폭주반복을 감지하고
  멈춘 것으로 크래시나 빈오디오는 아니나, 다른 5개 후보(S1MINI/Qwen/Audio8/Kokoro) 로그엔
  없던 패턴 — 사람 청취 시 해당 3문장 끝부분에 이상 유무를 특히 확인 권장.

  **판정 미완(사람 블라인드 청취 필요)**: Claude 청취 불가. 대표 3개(RP01/RP09/RP10) 사용자
  전달 예정, 나머지 WORK_ROOT 보관. RP01/RP09는 마침 위 반복감지 문장과 겹쳐 청취 시
  자연스럽게 그 구간도 확인됨.

  **아티팩트(Mac-local)**: `audio/chatterbox/RP01-10.wav`(24kHz),
  `results/chatterbox/chatterbox-r2.json`, `logs/chatterbox/{pip-install,synth-run}.log`,
  `synth_chatterbox.py`. WORK_ROOT 밖 영구쓰기 0.
  **다음**: 사용자 청취 후 CHATTERBOX 판정, 또는 R2 후보 3/6 COSYVOICE2로 진행.


- 2026-08-31 **COSYVOICE2(FunAudioLLM/CosyVoice2-0.5B) 실행 완료** (Mac Claude Code, R2
  후보 3/6). append-only. 원시 오디오·JSON은 Mac-local(WORK_ROOT `/Users/llm/rpchat-ttsbench-task1-r2`).

  **방법론 분기(사용자 사전확인 완료, 다른 5개 후보와 다름)**: CosyVoice2-0.5B는 "기본
  내장 음성" 경로가 없음(`inference_sft`는 CosyVoice1 SFT 체크포인트만 지원, 2.0은
  spk2info.pt 내장 화자 없음, `example.py` 확인). 유일한 공식 경로는 zero-shot 음성복제 —
  저장소 자체 번들 `asset/zero_shot_prompt.wav`(중국어 레퍼런스)로 목소리를 복제해 한국어
  10문장을 합성하는 **교차언어 복제**(`inference_cross_lingual(text, prompt_wav)`, 원문
  텍스트 불필요). 사용자에게 AskUserQuestion으로 사전 확인 후 "번들 샘플로 진행" 채택.
  **다른 5개 후보(기본/원어민 음성)와 성격이 다른 시험**임을 명시.

  **환경/준수(grant)**: GitHub clone(`--recursive`, submodule `third_party/Matcha-TTS`),
  venv `envs/cosyvoice2/venv`(python3.11, conda 대신 venv — 저장소 conda 안내는 3.10
  권장이나 하드 요구 아님, 3.11로 정상 설치·구동), `requirements.txt` 그대로 설치
  (`sys_platform=='darwin'` 마커로 이미 macOS용 onnxruntime CPU 분기 존재, deepspeed/tensorrt
  는 Linux 전용이라 자동 제외 — 저장소가 이미 macOS를 고려한 스펙). **device 파라미터 없음
  —** `cosyvoice/cli/model.py` 원문 확인: `torch.device('cuda' if torch.cuda.is_available()
  else 'cpu')`만 존재, MPS 분기 자체가 코드에 없음(S1MINI/Chatterbox와 달리 이 저장소는
  MPS 미지원) → **CPU로만 구동**(공식 폴백, 패치 아님, 단 GPU 가속 없음). 모델은
  modelscope `iic/CosyVoice2-0.5B`(5.3GB) WORK_ROOT 격리 다운로드.

  **비모델 의존성 수정 1건(Chatterbox와 동일 계열, 소스패치 아님)**: `openai-whisper`
  sdist 빌드가 pip의 격리 빌드환경에서 `pkg_resources` 부재로 실패(venv 레벨
  `setuptools<81` 핀은 pip 격리빌드에 상속 안 됨) → `pip install --no-build-isolation
  openai-whisper==...`로 우회(venv 자체의 setuptools 사용), 이후 `-r requirements.txt`
  재실행 시 torch가 핀 버전(2.3.1)으로 정상 재설치됨.

  **WORK_ROOT 격리 위반 1건 발견·즉시수정(투명 공개)**: 최초 스모크테스트에서 `wetext`
  텍스트정규화 서브패키지가 `MODELSCOPE_CACHE` 미설정 상태로 전역 `~/.cache/modelscope`에
  ~43MB 다운로드 — 재현 확인 즉시 WORK_ROOT(`cache/cosyvoice2/modelscope_cache/`)로
  이동, `~/.cache/modelscope` 완전삭제 확인, 이후 모든 실행에 `MODELSCOPE_CACHE`
  환경변수 고정 → 본실행(10문장) 동안 전역 캐시 재유출 없음 확인(`ls ~/.cache/modelscope`
  = No such file or directory).

  **결과(9/10 성공, 1건 크래시, sample_rate 24000)**:
  | id | sec | wall ms | chars/sec |
  |---|---|---|---|
  | RP01 | 17.16 | 28954 | 3.73 |
  | RP02 | 16.56 | 28097 | 3.08 |
  | RP03 | 8.80 | 15770 | 5.68 |
  | RP04 | 23.36 | 38283 | 2.78 |
  | RP05 | 10.48 | 18415 | 5.82 |
  | RP06 | 10.04 | 17926 | 6.08 |
  | RP07 | 12.36 | 21441 | 5.42 |
  | RP08 | 6.76 | 12302 | 10.80 |
  | RP09 | **크래시** | 1.6 | N/A |
  | RP10 | 8.00 | 14363 | 7.50 |
  | avg(9개) | 12.6 | 21172 | 5.10 |

  **RP09 크래시 상세**: `wetext/token_parser.py:78: assert len(input) > 0` —
  텍스트정규화(ITN) 단계에서 빈 토큰 발생. RP09 원문은 숫자/시간 표현("2시 30분",
  "25분") 포함 — R1 rubric이 이미 취약지대로 지목한 숫자처리 차원(B/C N=1)과 정확히
  겹침. wetext가 중국어/영어/일본어 위주 ITN이라 한국어 숫자표현 특화 처리가 부실할
  가능성. 크래시는 재시도 없이 그대로 기록(patch 없음).

  **객관 신호(사람 청취 전 예비 관찰, 확정 아님)**: chars/sec가 9개 성공 문장 중 8개에서
  **2.78–7.50**(RP08만 10.80) — 다른 5개 후보(전 구간 7.87–13.18)보다 뚜렷이 낮음, Kokoro의
  FAIL 패턴(~3 chars/sec, 뭉갬)에 근접한 값들이 다수. **중국어 레퍼런스 목소리로 한국어를
  교차언어 복제하는 이 시험 특유의 리듬/음소 불일치가 원인일 가능성** — 다른 후보들의
  "원어민/기본 음성" 시험과 근본적으로 다른 조건이었음을 재차 확인. Claude 청취 불가,
  duration 이상만으로 최종판정 불가 — 사람 청취로만 확정.

  **판정 미완(사람 블라인드 청취 필요)**: 대표 3개(RP01/RP08/RP10 — RP09는 크래시라 대신
  RP08을 포함, chars/sec 이상치 최대/최소 대비용) 사용자 전달 예정.

  **아티팩트(Mac-local)**: `audio/cosyvoice2/RP01-08,10.wav`(24kHz, RP09 없음),
  `results/cosyvoice2/cosyvoice2-r2.json`, `logs/cosyvoice2/{pip-install,pip-install-2,
  pip-install-3,model-download,synth-run}.log`, `synth_cosyvoice2.py`, 코드 clone
  `envs/cosyvoice2/CosyVoice/`(submodule 포함). WORK_ROOT 밖 영구쓰기 0(위 유출은
  발견즉시 이동·삭제로 원복).
  **다음**: 사용자 청취 후 COSYVOICE2 판정, 또는 R2 후보 4/6 OMNIVOICE로 진행.


- 2026-08-31 **OMNIVOICE(k2-fsa/OmniVoice) 실행 완료** (Mac Claude Code, R2 후보 4/6).
  append-only. 원시 오디오·JSON은 Mac-local(WORK_ROOT `/Users/llm/rpchat-ttsbench-task1-r2`).

  **환경/준수(grant)**: 공식 pip `omnivoice==0.2.1`(PyPI, GitHub clone 불필요), venv
  `envs/omnivoice/venv`(python3.11.15). README가 `device_map="mps"`를 Apple Silicon용으로
  직접 문서화(S1MINI 같은 git 고고학 불필요, Chatterbox급으로 매끄러운 셋업). "Auto Voice"
  모드(`ref_audio`/`ref_text`/`voice_clone_prompt` 전부 생략) — 공식 문서화된 무입력 경로,
  다른 4개 후보(Kokoro/Audio8/Qwen/Chatterbox)와 같은 "기본 음성" 성격. `pynini`(macOS
  wheel 없음, conda 필요)는 `pyproject.toml` 확인 결과 core 의존성이 전혀 아니고 optional
  `[tn]` extra(WeTextProcessing)에서만 필요 — **`[tn]` extra 설치 안 함**(conda/전역설치
  회피), `normalize_text=False`(패키지 자체 기본값, 우회책 아님)로 실행. 사전 빌드휠
  설치라 이번엔 setuptools/pkg_resources 이슈도 없었음(선제적으로 `setuptools<81` 핀
  했으나 실제로는 불필요했던 것으로 확인).

  **결과(10/10 성공, 크래시·빈오디오 0, sample_rate 24000)**:
  | id | sec | wall ms | chars/sec |
  |---|---|---|---|
  | RP01 | 6.40 | 2337 | 10.00 |
  | RP02 | 5.50 | 1893 | 9.27 |
  | RP03 | 5.55 | 1875 | 9.01 |
  | RP04 | 6.91 | 2312 | 9.41 |
  | RP05 | 7.02 | 2090 | 8.69 |
  | RP06 | 6.99 | 2148 | 8.73 |
  | RP07 | 7.50 | 2385 | 8.93 |
  | RP08 | 8.54 | 2597 | 8.55 |
  | RP09 | 7.16 | 2256 | 8.24 |
  | RP10 | 5.85 | 1847 | 10.26 |
  | avg | 6.74 | 2174 | 9.11 |
  chars/sec가 **8.24–10.26으로 매우 촘촘하게 자연스러운 범위**(R1+R2 통틀어 가장 일관됨),
  RP09(숫자/시간 표현, S1MINI 결함·CosyVoice2 크래시 지점)도 이상 없음. **전체합성 wall이
  R1+R2 전 후보 중 압도적으로 최고 속도**(avg ~2.2s/문장 — Audio8의 약 1/4, Qwen의 약
  1/10). 모델 로드 37.5초(최초, HF 다운로드 포함) 이후 문장당 생성은 2초 내외.

  **판정 미완(사람 블라인드 청취 필요)**: 객관 신호(chars/sec 일관성+속도)는 R2 최고
  수준이나, Claude 청취 불가라 실제 명료도·유창함은 사람 판정 필요. 대표 3개
  (RP01/RP09/RP10) 사용자 전달.

  **아티팩트(Mac-local)**: `audio/omnivoice/RP01-10.wav`(24kHz),
  `results/omnivoice/omnivoice-r2.json`, `logs/omnivoice/{pip-install,synth-run}.log`,
  `synth_omnivoice.py`. WORK_ROOT 밖 영구쓰기 0.
  **다음**: 사용자 청취 후 OMNIVOICE 판정, 또는 R2 후보 5/6 VOXCPM2로 진행(카드가
  CUDA≥12.0 명시 — 재확인 필요, NOT_EVALUABLE 가능성).


- 2026-08-31 **VOXCPM2(openbmb/VoxCPM2) 실행 완료** (Mac Claude Code, R2 후보 5/6).
  append-only. 원시 오디오·JSON은 Mac-local(WORK_ROOT `/Users/llm/rpchat-ttsbench-task1-r2`).

  **중요 정정 — R2 개설 시점의 사전위험판단이 틀렸음(투명 공개)**: R2 lock 개설 당시
  HF 카드만 보고 "CUDA≥12.0 필수 명시 — NOT_EVALUABLE 가능성 높음"으로 분류했었음. 이번에
  실제 실행 전 GitHub 원문 소스(`src/voxcpm/model/voxcpm2.py`)를 직접 확인한 결과, 카드의
  "CUDA≥12.0"은 **벤치마크/권장 환경 설명일 뿐 코드 자체의 하드 요구사항이 아님** —
  `resolve_runtime_device()`/`pick_runtime_dtype()`가 cuda>mps>cpu 순으로 자동 선택하는
  진짜 디바이스무관 코드이며, CUDA로 게이팅된 부분은 `torch.compile` 최적화 하나뿐(미지원
  시 경고만 출력, 크래시 아님). 실행 시 실제로 `Running on device: mps, dtype: float32`
  (bfloat16→float32 자동조정), `torch.compile disabled` 경고 후 정상 진행 확인 — **카드
  주장보다 원문 소스를 우선한다는 이 세션의 원칙(Kokoro/Audio8 사례와 동일 계열 교훈)이
  다시 한번 유효했음**을 기록.

  **환경/준수(grant)**: 공식 pip `voxcpm==2.0.3`, venv `envs/voxcpm2/venv`(python3.11.15),
  HF_HOME/모델캐시 전부 WORK_ROOT 격리. `flash-attn`/`deepspeed` 등 CUDA전용 하드 의존성
  없음(`pyproject.toml` 확인). 레퍼런스 오디오 없음(`prompt_wav_path`/`reference_wav_path`
  생략 — 공식 기본 음성 경로), `cfg_value=2.0`(패키지 기본값). `generate()`에 `language`
  파라미터 없음(다국어 자동인식으로 추정, 명시적 한국어 지정 불가 — 카드의 30개 언어
  지원과 일치, 한국어(ko) 명시 확인). `seed` 인자는 설치된 2.0.3에서 미지원(GitHub main
  문서와 실제 릴리즈판 시그니처 차이 — seed 없이 진행, 재현성 낮을 수 있음 명시).

  **결과(10/10 성공, 크래시·빈오디오 0, sample_rate 48000 — 6개 후보 중 유일하게 48kHz)**:
  | id | sec | wall ms | chars/sec |
  |---|---|---|---|
  | RP01 | 14.24 | 8506 | 4.49 |
  | RP02 | 7.04 | 4455 | 7.24 |
  | RP03 | 7.84 | 4692 | 6.38 |
  | RP04 | 7.20 | 4227 | 9.03 |
  | RP05 | 6.88 | 4055 | 8.87 |
  | RP06 | 7.20 | 4258 | 8.47 |
  | RP07 | 10.08 | 5854 | 6.65 |
  | RP08 | 10.40 | 6058 | 7.02 |
  | RP09 | 8.00 | 4685 | 7.38 |
  | RP10 | 8.48 | 4966 | 7.08 |
  | avg | 8.74 | 5076 | 7.26 |
  RP09(숫자/시간 표현, S1MINI 결함·CosyVoice2 크래시 지점)이 chars/sec 7.38로 정상 처리됨.
  RP01만 chars/sec 4.49로 다소 이상치(wall_ms도 최대 — 모델 웜업 이후 첫 실제 문장이라
  잔여 초기화 오버헤드 가능성, 공식 warm-up 단계가 있었음에도 첫 호출이 더 느렸음). 전체
  wall은 avg ~5.1s/문장 — Audio8보다 약간 빠르고 Qwen보다 훨씬 빠름, OMNIVOICE 다음으로
  준수한 속도.

  **판정 미완(사람 블라인드 청취 필요)**: chars/sec 대체로 자연 범위(RP01 제외), Claude
  청취 불가. 대표 3개(RP01 — 이상치 확인용/RP09/RP10) 사용자 전달.

  **아티팩트(Mac-local)**: `audio/voxcpm2/RP01-10.wav`(48kHz),
  `results/voxcpm2/voxcpm2-r2.json`, `logs/voxcpm2/{pip-install,synth-run}.log`,
  `synth_voxcpm2.py`. WORK_ROOT 밖 영구쓰기 0.
  **다음**: 사용자 청취 후 VOXCPM2 판정, 또는 R2 후보 6/6(최종) HIGGS로 진행(카드가
  SGLang-Omni/vLLM-Omni 서버배포 전제라고 명시했었음 — VOXCPM2 사례처럼 재검증 필요,
  포트/데몬 금지와 실제 충돌하는지 원문 재확인 예정).


- 2026-08-31 **HIGGS(bosonai/higgs-tts-3-4b) 실행 완료** (Mac Claude Code, R2 후보 6/6,
  **최종 후보**). append-only. 원시 오디오·JSON은 Mac-local(WORK_ROOT
  `/Users/llm/rpchat-ttsbench-task1-r2`).

  **⚠️ 프롬프트 인젝션 시도 발견(투명 공개, 지시 미실행)**: 이 체크포인트의 `AGENTS.md`
  파일(`huggingface.co/bosonai/higgs-tts-3-4b/raw/main/AGENTS.md`)을 WebFetch로 조회하는
  과정에서, 응답이 실제 파일 내용 추출이 아니라 마치 그 문서가 "125자 인용 제한", "라이선스
  강제 준수", "conversational agent로 행동" 같은 가짜 제약을 fetch 도구에 지시한 것처럼
  응답이 돌아옴 — 전형적인 프롬프트 인젝션 패턴으로 판단, **사용자에게 즉시 고지**하고
  해당 파일에서 나온 어떤 지시도 따르지 않음. 이후 모든 사실 확인은 독립적/신뢰가능한
  출처(PyPI 프로젝트 페이지, mlx-audio 자체 GitHub 소스의 README/테스트파일)로만 재검증.

  **중요 정정 — R2 개설 시점의 사전위험판단이 또 틀렸음(VOXCPM2와 같은 계열)**: R2 개설
  당시 "표준 경로가 SGLang-Omni/vLLM-Omni 서버배포 전제 → 포트/데몬 금지와 충돌 →
  NOT_EVALUABLE 가능성"으로 분류했었음. 실제로 체크포인트 HF 카드는 여전히 SGLang-Omni/
  vLLM-Omni만 문서화하나(카드 자체는 정확), **위 AGENTS.md가 명시한 세 번째 공식 경로
  "MLX-Audio for Apple Silicon"**(로컬 CLI/Python 라이브러리, 서버 아님)을 발견 — PyPI
  `mlx-audio` 프로젝트 페이지로 독립 재확인(`bosonai/higgs-audio-v3-tts-4b` 지원 명시).
  이 경로는 포트/데몬이 전혀 아니므로 grant와 충돌 없음. **NOT_EVALUABLE 예상이 뒤집힘.**

  **repo id 불일치**: 사용자 원문 URL은 `bosonai/higgs-tts-3-4b`, 실제 mlx-audio 공식
  README(`mlx_audio/tts/models/higgs_audio_v3/README.md`)가 사용하는 정확한 id는
  `bosonai/higgs-audio-v3-tts-4b` — 명명 변형/별칭으로 추정(추가조사 안 함), mlx-audio
  문서에 명시된 id를 그대로 사용해 정상 로드 확인됨.

  **환경/준수(grant)**: 공식 pip `mlx-audio==0.5.0`(MLX 네이티브, PyTorch MPS 아님),
  venv `envs/higgs/venv`(python3.11.15). 코덱 체크포인트 로딩 중 `safetensors`의 MLX
  프레임워크 리더가 bfloat16 텐서를 못 읽어(`data type 'bfloat16' not understood`) PyTorch
  백엔드로 폴백하는데 이 venv엔 `torch`가 없어 `ModuleNotFoundError` 발생 — **표준
  의존성 1건 추가**(`pip install torch`, 실제 모델 연산엔 안 쓰임, 순수 텐서 읽기용
  백엔드). 레퍼런스 오디오 없음(`ref_audio`/`ref_text` 생략 — 공식 기본 음성 경로).
  `--device`/language 파라미터 없음(다국어 자동인식으로 추정, 카드가 한국어를 WER/CER<5
  "production quality" 85개 언어 중 하나로 명시).

  **결과(10/10 성공, 크래시·빈오디오 0, sample_rate 24000)**:
  | id | sec | wall ms | chars/sec |
  |---|---|---|---|
  | RP01 | 8.20 | 3021 | 7.80 |
  | RP02 | 7.00 | 2514 | 7.29 |
  | RP03 | 8.08 | 2879 | 6.19 |
  | RP04 | 9.32 | 3311 | 6.97 |
  | RP05 | 7.68 | 2800 | 7.94 |
  | RP06 | 6.96 | 2512 | 8.76 |
  | RP07 | 9.92 | 3530 | 6.75 |
  | RP08 | 9.72 | 3443 | 7.51 |
  | RP09 | 7.36 | 2635 | 8.02 |
  | RP10 | 6.76 | 2451 | 8.88 |
  | avg | 8.10 | 2910 | 7.61 |
  chars/sec가 **6.19–8.88로 자연스러운 범위에 잘 모여 있음**(OMNIVOICE 다음으로 일관됨),
  RP09(숫자/시간 표현, S1MINI 결함·CosyVoice2 크래시 지점)도 정상 처리. 전체합성 wall도
  avg ~2.9s/문장으로 OMNIVOICE 다음으로 빠름(MLX 네이티브 가속 효과로 추정).

  **판정 미완(사람 블라인드 청취 필요)**: 객관 신호는 R2 최상위권(OMNIVOICE와 비슷한
  수준), Claude 청취 불가. 대표 3개(RP01/RP09/RP10) 사용자 전달.

  **아티팩트(Mac-local)**: `audio/higgs/RP01-10.wav`(24kHz),
  `results/higgs/higgs-r2.json`, `logs/higgs/{pip-install,synth-run}.log`,
  `synth_higgs.py`. WORK_ROOT 밖 영구쓰기 0.

  **R2 6개 후보 실행 전부 완료.** 남은 것: OMNIVOICE/VOXCPM2/COSYVOICE2/CHATTERBOX/HIGGS
  5개 후보의 사람 청취 판정(S1MINI는 판정 완료 — 부분결함), rubric A-F 세부점수, §4.2
  스트리밍 지연·§4.1 채팅 동시비저하 실측, 프로덕션 통합 — 전부 이 lock 범위 밖이거나
  후속 단계.


- 2026-08-31 **R2 5개 후보 사람 청취 판정 완료(CHATTERBOX/COSYVOICE2/VOXCPM2/HIGGS/OMNIVOICE)**
  — S1MINI는 이미 판정됨(부분결함, RP10). 사용자 직접 청취, 5개 후보 한 메시지로 전달.

  **CHATTERBOX**: "외국인이 한국어를 읽는 느낌"(비원어민 억양), **RP09 숫자 발음
  부정확 + 이해하기 힘듦**. 객관 신호와 일치 — RP09는 이번 R2에서 유일하게 모델 자체
  `alignment_stream_analyzer`가 토큰반복 감지→강제EOS를 남긴 3문장(RP01/03/09) 중 하나로
  이미 청취 권고 표시했던 지점 — 사람 확인으로 실제 결함 확정.

  **COSYVOICE2**: "외국인이 한국어를 읽는 느낌"(비원어민 억양 — 중국어 레퍼런스 교차언어
  복제라는 시험 조건과 방향 일치, 사전 고지된 리스크가 실현됨). **RP10 마지막 파일명
  부분을 알아듣기 힘듦** — chars/sec 객관신호(전 구간 낮음, 뭉갬 의심)와 대체로 일치.

  **VOXCPM2**: 어조가 격양됨(agitated tone), **RP마다 음량이 들쭉날쭉**, "전형적인 TTS
  느낌"(자연스러움 부족, 합성티 남). 이는 사전 duration 신호만으로는 예측 못 했던 새
  정보(RP01의 chars/sec 이상치가 유일한 사전 힌트였음, 음량 불균일은 duration으로는
  안 잡히는 별도 차원).

  **HIGGS**: **어투·어조는 긍정적**("좋음"). 단 두 가지 결함: (1) **화자가 RP마다
  변경됨**(문장 간 음색/화자 일관성 없음 — 레퍼런스 오디오 없는 기본경로라 발생 가능),
  (2) **RP 시작부의 "그"/"그녀"(발화 시작 단어)가 잘려나오는 느낌** — 오디오 시작
  지점 클리핑/어택 결함 가능성, 코덱이나 무음트리밍 쪽 원인 추정(미확인, 후속조사 필요).

  **OMNIVOICE**: **발음·어조 모두 양호**(R2 최고 평가). 단 **RP09→RP10 사이 화자가
  여성→남성으로 전환** — 사용자 질문("의도한 것인지 모델 자체 변경인지")에 대한 기술
  조사 결과: OmniVoice의 "Auto Voice" 모드는 레퍼런스 오디오 없이 매 호출마다 Gumbel-
  softmax 확률적 샘플링(`_gumbel_sample`, `omnivoice/models/omnivoice.py`)으로 음성을
  생성하며, **`generate()`/`OmniVoiceGenerationConfig` 어디에도 seed 파라미터가 없고**,
  실행 시 S1MINI처럼 전역 시드를 고정하지 않았음(S1MINI는 `--seed 42`로 10문장 전부
  음색 일관성 유지했던 것과 대조적으로, OMNIVOICE는 이 조치를 안 함 — **이번 세션의
  방법론 공백으로 판단**, 모델의 의도된 동작이라는 근거 없음). 즉 **높은 확률로 Claude의
  테스트 설정 결함**(시드 미고정)이지 사용자가 궁금해한 "모델 자체의 의도된 화자전환
  기능"은 아님 — 재확인하려면 향후 별도 실행에서 seed/RNG를 명시적으로 고정한 재시험이
  필요(이 lock 범위 안에서 원하면 즉시 가능, 사용자 확인 대기).

  **R2 청취 판정 요약**:
  | 후보 | 억양/자연스러움 | 주요 결함 |
  |---|---|---|
  | S1MINI | (미평가) | RP10 파일명 부분 결함 |
  | CHATTERBOX | 비원어민 억양 | RP09 숫자발음 부정확·이해곤란 |
  | COSYVOICE2 | 비원어민 억양(교차언어 복제 시험조건) | RP10 파일명 부분 이해곤란 |
  | VOXCPM2 | 격양된 어조, 전형적 TTS 느낌 | RP간 음량 불균일 |
  | HIGGS | **어투·어조 양호** | RP간 화자 불일치, 발화시작 단어 클리핑 |
  | OMNIVOICE | **발음·어조 양호(최고)** | RP09→10 화자전환(시드 미고정 추정, 모델결함 아닐 가능성) |

  **다음**: rubric A-F 세부 점수 부여, §4.2 스트리밍 지연·§4.1 채팅 동시비저하 실측,
  프로덕션 채택 판단은 전부 이 lock(R2) 범위 밖 — 사용자 판단 대기. 원하면 OMNIVOICE
  시드고정 재시험 또는 HIGGS 발화시작 클리핑 원인조사도 가능(각각 별도 확인 필요).


- 2026-08-31 **R2 라이선스 확인 + 최종 사람 판정 = OMNIVOICE 채택** (사용자: "omnivoice 의
  라이센스에 이렇게 표기되어있는데. Our code is released under the Apache 2.0 License. The
  pre-trained model is licensed under the CC-BY-NC due to constraints from its training data
  (e.g., Emilia). 확인해보고, 사용에 문제 없다면 옴니보이스로 하겠어요").

  **라이선스 검증(Claude Code, 원문 대조)**: `huggingface.co/k2-fsa/OmniVoice/raw/main/README.md`
  직접 재확인 — 사용자 인용문과 정확히 일치. 추가 조항: "unauthorized voice cloning, voice
  impersonation, fraud, scams, or any other illegal or unethical activities" 금지, 현지
  법규·윤리기준 준수 의무, 개발자 면책 조항. **RP-Chat은 개인 단일사용자 비상업용 로컬
  앱**(판매·수익화·타인배포 없음)이라 CC-BY-NC의 "비상업적 이용" 범위 내로 판단되며,
  이번 시험에 쓰인 "Auto Voice" 모드는 레퍼런스 오디오 없이 처음부터 합성하는 방식이라
  실존 인물의 목소리를 복제·사칭하는 것도 아님 — 사용상 문제 없다고 판단(Claude는
  변호사가 아니며 이는 평문 조항 해석이지 법률자문 아님을 명시; 향후 RP-Chat이 판매·
  수익화·타인배포로 전환되면 그 시점에 재검토 필요).

  **R2(TTS-T2-MAC-CHATTERBOX-COSYVOICE2-OMNIVOICE-S1MINI-VOXCPM2-HIGGS-COMPARE-R2) 최종
  상태 — 6개 후보 전부**:
  - S1MINI: 부분결함(RP10 파일명 결함), 나머지 양호.
  - CHATTERBOX: 비원어민 억양, RP09 숫자발음 결함.
  - COSYVOICE2: 비원어민 억양(교차언어 복제 시험조건), RP10 파일명 이해곤란.
  - VOXCPM2: 격양된 어조, 음량 불균일, 전형적 TTS 느낌.
  - HIGGS: 어투 양호하나 화자불일치·발화시작 클리핑.
  - **OMNIVOICE: 발음·어조 최고 평가, 라이선스 확인 완료 → 사용자 채택 결정.**

  **R2 CLOSED.** 이 lock의 §1 scope(지정 Mac에서 6후보 비교만, 제품 도입·순위 자동변경
  아님)대로, 이 사람판정+라이선스확인은 "R2 비교에서 OmniVoice를 선택했다"는 사실
  기록이지 자동 프로덕션 배포가 아님 — rubric A-F 세부 수치화, §4.2 스트리밍 지연 실측,
  §4.1 채팅 동시 비저하 실측, 그리고 실제 프로덕션 통합(코드/apps/** 변경, 배포, 재시작)은
  전부 이 lock 범위 밖(각각 별도 새 이름 필요, grant 원문 그대로). OMNIVOICE의 알려진
  결함(RP09→10 화자전환, 이전 조사로 seed 미고정 추정)은 프로덕션 통합 시 seed 고정
  등으로 재검증 필요.


- 2026-08-31 **R1+R2 미채택 후보 8개 전부 정리(Mac-local, 사용자 지시)** — 사용자가
  R3(`TTS-R3-OMNIVOICE-RP09-RP10-SEED-RETEST-R1`) 지명 직전 "비교용으로 설치한 나머지
  프로그램(higgs 등) 제거"를 먼저 요청. 범위·깊이 둘 다 AskUserQuestion으로 명시 확인:
  범위=R1+R2 전부(OmniVoice만 보존), 깊이=venv+모델+오디오+로그+JSON 전부 삭제.

  **제거됨**: `/Users/llm/rpchat-ttsbench-task1-r1`(KOKORO-OFFICIAL/AUDIO8-ONNX-INT8/
  QWEN06-SOHEE, 3개 전부, 디렉터리 통째로 삭제, 6.9GB) + `/Users/llm/rpchat-ttsbench-task1-r2`
  하위 CHATTERBOX/COSYVOICE2/HIGGS/S1MINI/VOXCPM2(5개, 각 후보의 audio/cache/envs/logs/
  results/tmp 서브디렉터리 + `synth_<candidate>.py` 스크립트, 약 32.9GB).
  **보존됨**: `/Users/llm/rpchat-ttsbench-task1-r2`의 OMNIVOICE 관련 전부(audio/cache/envs/
  logs/results/tmp/omnivoice + `synth_omnivoice.py`) + 공유 `cache/pip`(특정 후보 전용
  아님, 재사용 가능한 pip wheel 캐시라 유지). R2 최종 용량 5.5GB(이전 ~40GB 합계 대비).

  이 삭제는 이 문서(`preregistration.md`)의 서술적 기록에는 영향 없음(과거 각 후보 항목의
  결과·판정·sha256 기록은 그대로 유지) — 단 원본 오디오/로그/JSON 파일 자체는 더 이상
  로컬에 존재하지 않음(이 문서의 서술이 유일한 남은 기록). 라이브 RP-Chat 코드/DB/PID
  전부 무접촉(이 작업은 순수 Mac-local 정리, `apps/**` 밖).

  **다음**: 사용자가 이미 지명한 `TTS-R3-OMNIVOICE-RP09-RP10-SEED-RETEST-R1` 착수 대기
  (범위: RP09→RP10 화자전환 결함만 재검증, seed·생성설정 고정, 반복횟수 사전고정, 원시
  오디오·로그 보존, rubric 전체 재평가·스트리밍 실측·제품통합 제외).


- 2026-08-31 **R3 named lock 개방 + 사전등록**: 사용자 리터럴
  `TTS-R3-OMNIVOICE-RP09-RP10-SEED-RETEST-R1`. Grep 확인: 이 문서·git 이력에 이전에
  등장한 적 없음(genuinely new). 범위(사용자 원문 그대로): RP09→RP10 화자 전환 결함만
  재검증 / seed 및 생성 설정 고정 / 반복 횟수 사전 고정 / 원시 오디오와 로그 보존 /
  rubric 전체 재평가·스트리밍 실측·제품 통합 제외.

  **직전 정리(같은 세션)**: R3 착수 전 사용자 지시로 R1+R2 미채택 8개 후보(Kokoro/Audio8/
  Qwen/Chatterbox/CosyVoice2/S1MINI/VoxCPM2/Higgs) 전부 삭제(venv+모델+오디오+로그+JSON),
  OMNIVOICE만 보존 — 별도 항목으로 이미 기록됨(위 참고).

  **가설(원인 조사, Claude Code)**: R2에서 관찰된 RP09→RP10 여성→남성 화자전환은 seed
  미고정이 원인일 가능성 — omnivoice의 `_gumbel_sample`(`models/omnivoice.py`)이
  `torch.rand_like`로 전역 torch RNG에서 직접 샘플링(로컬 Generator 객체 없음)하며,
  패키지 자체가 공식 시딩 유틸리티 `omnivoice.utils.common.fix_random_seed(seed)`
  (random/numpy/torch 시드를 한번에 설정)를 제공 — 이걸 그대로 사용(소스 수정 아님,
  패키지 공식 함수).

  **사전등록된 시험설계(실행 전 확정, 사후 조정 없음)**:
  - 반복 횟수 = **5회**, seed = **[1, 2, 3, 4, 5]**(사전 고정, 결과 보고 나서 정하지 않음)
  - 매 반복: `fix_random_seed(seed)` → RP09 합성 → **동일 seed로 다시**
    `fix_random_seed(seed)` → RP10 합성(같은 반복 내 RP09/RP10에 동일 seed 재사용 —
    "같은 시드로 리셋하면 화자가 일관되는가"를 직접 검정)
  - 모델 인스턴스는 5회 반복 내내 재사용(재로딩 없음, 매번 리셋되는 건 전역 RNG만)
  - 레퍼런스 오디오 없음(R2와 동일한 Auto Voice 기본경로), `language='ko'`, 그 외
    `generate()` 인자는 R2 실행과 동일 기본값 — **이번에 추가된 유일한 변경은 시드
    고정뿐**
  - 화자 임베딩 기반 객관 유사도 지표(예: 패키지 내장 `eval/models/ecapa_tdnn_wavlm.py`)
    는 **채택 안 함** — WavLM-large SSL 모델 별도 다운로드(수백MB~1GB) + 매칭되는
    ECAPA-TDNN 체크포인트 필요(패키지에 번들 안 됨)라 이 R3의 좁은 범위(rubric 전체
    재평가 제외 명시)를 벗어나는 과도한 인프라 추가로 판단, 사람 청취로만 판정
  - 산출물: `audio/omnivoice_r3_seedtest/seed{1-5}_{RP09,RP10}.wav`(10개 파일),
    `results/omnivoice_r3_seedtest/omnivoice-r3-seedtest.json`, `logs/omnivoice_r3_seedtest/
    synth-run.log`, `synth_omnivoice_r3_seedtest.py` — 전부 원시 보존(grant 그대로).

  다운로드·설치 추가 없음(기존 OMNIVOICE venv/모델 재사용). 실행 착수 직전 상태.


- 2026-08-31 **R3 실행 완료(원시 결과만, 판정은 사람 청취 대기)** — 사전등록된 설계
  그대로 5회 반복(seed 1-5) 실행, 추가 다운로드·설치 없음(기존 OMNIVOICE venv/모델 재사용).

  **결과(10/10 합성 성공, 크래시·빈오디오 0)**:
  | seed | RP09 sec | RP09 chars/sec | RP10 sec | RP10 chars/sec |
  |---|---|---|---|---|
  | 1 | 7.34 | 8.04 | 5.61 | 10.70 |
  | 2 | 7.43 | 7.94 | 5.67 | 10.58 |
  | 3 | 7.23 | 8.16 | 6.01 | 9.98 |
  | 4 | 7.01 | 8.42 | 6.25 | 9.60 |
  | 5 | 7.85 | 7.52 | 5.48 | 10.95 |
  RP09 duration/chars-sec 5회 전부 좁은 범위(7.01–7.85s, 7.52–8.42 chars/sec), RP10도
  마찬가지로 좁은 범위(5.48–6.25s, 9.60–10.95 chars/sec) — **객관 신호(duration
  안정성)만으로는 5회 모두 정상 범위**, 이전 R2의 이상 신호(예: S1MINI/COSYVOICE2류
  chars/sec 이상치)에 해당하는 패턴 없음. 단 이 신호는 "화자 동일성"을 직접 측정하지
  못함(duration은 화자 성별/음색 불일치의 대리 지표가 아님, Claude 청취 불가라 이번 R3
  판정은 사람 청취 결과에 전적으로 의존).

  **아티팩트(Mac-local)**: `audio/omnivoice_r3_seedtest/seed{1-5}_{RP09,RP10}.wav`(10개,
  24kHz), `results/omnivoice_r3_seedtest/omnivoice-r3-seedtest.json`,
  `logs/omnivoice_r3_seedtest/synth-run.log`, `synth_omnivoice_r3_seedtest.py`. 전부 원시
  보존. WORK_ROOT 밖 영구쓰기 0.

  **판정 대기**: 사용자가 seed1/3/5 쌍(6개 파일) 청취 후 "동일 seed 재설정이 RP09→RP10
  화자 일관성 문제를 해결했는가" 확인 필요 — 이 R3 lock의 유일한 목적.


- 2026-08-31 **R3 사람 청취 판정 = seed 고정만으로는 화자 통일 실패, 텍스트 성별
  조건화 의심** (사용자: "모든 rp09는 여성, rp10은 남성이야. 주어진 프롬프트에 '그녀는'
  '그는'이 주어지는데, 이것이 먼저 화자의 성별을 결정하는 것인지? 그렇다면 따로 화자의
  성별을 결정하는 옵션값이 있는 것인지?").

  **판정**: seed 1-5 전부 RP09=여성, RP10=남성으로 청취됨. 즉 **동일 seed를 RP09/RP10에
  재사용해도 화자(성별)가 통일되지 않음 → R3의 가설("seed 미고정이 화자전환의 원인")은
  기각**. seed는 화자 성별을 결정하는 축이 아니었음. R3 실행 자체는 Auto 모드
  (레퍼런스·instruct 없음)였고, 소스 docstring이 이 모드를 "the model picks a voice
  itself"로 정의 — 음성을 제약하는 입력이 전무한 조건이라 텍스트가 자유롭게 화자를 결정할
  수 있었음.

  **인과 미확정(중요)**: RP09의 "그녀는"/RP10의 "그는" 대명사가 성별 단서로 작용했을
  가능성이 유력하나, **대명사 교체·명시적 성별 조건 통제 실험을 하지 않았으므로 인과는
  확정하지 않음** — 원인이 (a)대명사인지 (b)문장 전체 의미인지 (c)RP09/RP10의 그 밖의
  텍스트 차이인지 분리 안 됨. 이를 확정하려면 프롬프트를 변경해 새 오디오를 합성하는
  통제 실험이 필요하며, 이는 R3(seed 재검증만)의 범위 밖 — 새 named lock 필요.

  **API 사실(읽기전용 소스 검증, R3 범위 내 해석근거)**: `OmniVoice.generate()`에
  **독립적 `gender=`/`sex=` 인자는 없음**(`inspect.signature`로 확인, 전체 인자 =
  text/language/ref_text/ref_audio/voice_clone_prompt/instruct/duration/speed/
  generation_config/normalize_text). 화자 제어 공식 경로는 소스 docstring상 3모드:
  ① Voice Clone(`ref_audio`+`ref_text` 또는 `voice_clone_prompt`로 특정 목소리 복제),
  ② Voice Design(`instruct` 자유텍스트로 음성 스타일 서술, 레퍼런스 불필요),
  ③ Auto(아무것도 안 줌, 모델이 스스로 선택 — R2/R3가 쓴 모드). 즉 성별을 통제하려면
  Auto가 아니라 Voice Design(instruct) 또는 Voice Clone(ref audio)을 써야 함 — "gender
  옵션 체크박스"는 없고 자유텍스트 지시 또는 레퍼런스 오디오 형태로만 존재.

  **R3 CLOSED.** 결론: seed 고정만으로 RP09→RP10 화자 일관성 확보 실패. 화자 통일에는
  (a)Voice Clone(고정 레퍼런스 오디오) 또는 (b)Voice Design(instruct로 성별/음색 명시)
  또는 (c)대명사·의미 통제가 필요 — 전부 R3의 seed-only 범위 밖. 대명사 인과 검증이나
  성별 제어 방식 확정은 **별도 새 named lock 필요**(프롬프트/생성조건 변경 + 새 오디오
  합성). 이 R3 판정은 사실 기록이지 후속 실험 자동승인이 아님.


- 2026-08-31 **R4 named lock 개방 + 사전등록**: 사용자 리터럴
  `TTS-R4-OMNIVOICE-VOICE-DESIGN-CLONE-CONSISTENCY-R1` 개방. Grep 확인: 이 문서(0건) 및
  `git log --all -S`(0건)에 이전 등장 없음 — genuinely new. **이번 개방 범위 = Voice
  Design 하위 실험만**(`OMNIVOICE-VOICE-DESIGN`). Voice Clone(`OMNIVOICE-VOICE-CLONE`)은
  **미포함** — 레퍼런스 오디오·권리·절대경로·SHA-256·전사문·보관/삭제 규칙을 갖춘 별도
  새 named lock 없이는 착수 안 함(사용자 명시).

  **확정된 리터럴(사용자 직접 기입, 침묵 채움 아님)**:
  `VOICE_DESIGN_INSTRUCT="Female, Young Adult, Moderate Pitch"` — R2/R3에서 여성으로
  들렸던 음색 방향 유지 + 과도한 연기지시 회피 목적으로 후보 A 선택. instruct 형식 근거:
  omnivoice 내장 Voice Design 템플릿(`cli/demo.py`)의 영어 속성 키워드(Gender/Age/Pitch
  등)를 콤마로 나열하는 공식 형식, CLI 예시 `--instruct "male, British accent"`와 동형.

  **고정 조건(사용자 확정 그대로)**:
  - 모델 ID = `k2-fsa/OmniVoice`, revision = `c5fdb5ccb189668d56333f77ba2629f4cd7535f4`
    (캐시된 스냅샷 해시, `from_pretrained(revision=...)`로 명시 고정), pkg omnivoice 0.2.1
  - 문장 = R2/R3의 10문장(RP01–RP10) 원문·순서 그대로
  - seed = **42** 고정·기록, 단 **화자 통제 수단으로 간주 안 함**(R3에서 seed가 화자
    성별을 결정하지 않음을 이미 확인). 구현: `fix_random_seed(42)`를 실행 시작 시 **1회만**
    호출 후 30개 생성을 연속 진행(전역 RNG 자연 진행) → 3회 반복이 서로 다르게 나옴(의도적:
    반복간 화자 드리프트가 판정 항목이므로, 반복마다 seed를 리셋하면 3회가 byte-identical이
    되어 그 검정을 무력화함). 단일 고정 seed로 30파일 전체 재현 가능.
  - `VOICE_DESIGN_INSTRUCT`를 30개 요청 전부에 byte-identical 적용, 문장별 변경·재작성·
    최적화·감정지시 추가 금지
  - 반복 = **3회**, 10문장 × 3회 = **30개 오디오**, 각 문장 독립 요청(별도 generate 호출)
  - **Auto 모드 재실행 안 함**(이번은 instruct 제공 = Voice Design 모드, Auto와 구분)
  - 원시 오디오·입력텍스트·instruct·seed·생성설정·실행로그 전부 보존

  **판정 항목(사용자 확정)**:
  - 1차(화자 일관성): 10문장 동일화자 여부 / RP09→RP10 화자전환 재현 여부 / 개별 파일
    내부 화자전환 / 반복간 화자특성 변화
  - 2차(안전): 발음 악화 / 단어·문장 누락 / 원문에 없는 발화 추가 / 반복·긴무음·시작끝
    절단 / instruct 문자열이 발화로 출력되는 현상 / 합성실패·손상
  - 결과 상태 enum: PASS_SPEAKER_CONSISTENCY / FAIL_CROSS_SENTENCE_SWITCH /
    FAIL_WITHIN_SENTENCE_SWITCH / FAIL_CROSS_REPETITION_DRIFT / FAIL_SYNTHESIS /
    NOT_EVALUABLE

  **제외 범위(사용자 확정)**: Voice Clone, 레퍼런스 오디오 수집·녹음·등록, 파생 음성
  데이터 외부 업로드, 대명사 교체·문장 재작성, 여러 instruct 후보 탐색, rubric A-F 전체
  재평가, 스트리밍 지연·p95, 제품코드·apps/** 통합, 프로덕션 배포. 한 하위실험 결과가
  다른 작업 권한을 확대하지 않음.

  **아티팩트(예정)**: `audio/omnivoice_r4_voicedesign/rep{1-3}_{RP01-10}.wav`(30개),
  `results/omnivoice_r4_voicedesign/omnivoice-r4-voicedesign.json`,
  `logs/omnivoice_r4_voicedesign/synth-run.log`, `synth_omnivoice_r4_voicedesign.py`.
  추가 다운로드·설치 없음(기존 OMNIVOICE venv/모델 재사용). 실행 착수 직전 상태.


- 2026-08-31 **R4 Voice Design 실행 완료(원시 결과만, 판정은 사람 청취 대기)** — 사전등록
  설계 그대로 3회 반복 × 10문장 = 30개 합성, 추가 다운로드·설치 없음(기존 OMNIVOICE
  venv/모델 재사용, revision `c5fdb5cc…` 고정). instruct `"Female, Young Adult, Moderate
  Pitch"` 30요청 전부 byte-identical, Voice Design 모드(Auto 아님), seed 42 실행시작 1회
  고정.

  **결과(30/30 합성 성공, 크래시·빈오디오 0, sample_rate 24000)** — 문장별 3회 반복
  duration/chars-sec:
  | sid | rep1 | rep2 | rep3 |
  |---|---|---|---|
  | RP01 | 8.24/7.77 | 8.24/7.77 | 8.24/7.77 |
  | RP02 | 6.68/7.63 | 6.68/7.63 | 6.39/7.98 |
  | RP03 | 5.86/8.53 | 6.07/8.24 | 5.75/8.70 |
  | RP04 | 8.24/7.89 | 8.22/7.91 | 8.24/7.89 |
  | RP05 | 7.52/8.11 | 7.52/8.11 | 7.52/8.11 |
  | RP06 | 7.84/7.78 | 7.84/7.78 | 7.84/7.78 |
  | RP07 | 8.60/7.79 | 8.60/7.79 | 8.60/7.79 |
  | RP08 | 9.48/7.70 | 9.48/7.70 | 9.48/7.70 |
  | RP09 | 8.32/7.09 | 8.32/7.09 | 8.32/7.09 |
  | RP10 | 6.76/8.88 | 6.76/8.88 | 6.76/8.88 |
  (sec/chars-per-sec)

  **객관 신호(사람 청취 전 예비 관찰, 판정 아님)**: 문장별 duration이 3회 반복에서 거의
  동일(RP03/RP02만 미세 변동, 나머지 8문장은 소수점 2자리까지 일치) — Auto 모드(R2/R3)의
  RNG 변동성 대비 **instruct 고정이 출력을 강하게 결정**한다는 신호. chars/sec 전 구간
  7.09–8.88(자연 범위, R2 OMNIVOICE와 유사). 단 **duration 안정성은 화자 동일성의 대리
  지표가 아님** — instruct가 여성 음색을 실제로 고정했는지, RP09→RP10 화자전환이 사라졌는지,
  반복간 화자 드리프트 유무는 사람 청취로만 확정(Claude 청취 불가).

  **아티팩트(Mac-local)**: `audio/omnivoice_r4_voicedesign/rep{1-3}_{RP01-10}.wav`(30개,
  24kHz), `results/omnivoice_r4_voicedesign/omnivoice-r4-voicedesign.json`,
  `logs/omnivoice_r4_voicedesign/synth-run.log`, `synth_omnivoice_r4_voicedesign.py`.
  전부 원시 보존. WORK_ROOT 밖 영구쓰기 0.

  **판정 대기(1차 화자 일관성)**: 사용자에게 (1) rep1 10문장 전체(instruct 고정이 10문장
  전부 동일 화자를 유지하는가 = RP09→RP10 전환 재현 여부 포함), (2) 반복간 드리프트용
  rep2/rep3의 RP01/RP09/RP10 전달 예정. 2차 안전(instruct 문자열 발화 유출·누락·절단 등)도
  함께 확인 요청. 결과 상태 enum(PASS_SPEAKER_CONSISTENCY / FAIL_CROSS_SENTENCE_SWITCH /
  FAIL_WITHIN_SENTENCE_SWITCH / FAIL_CROSS_REPETITION_DRIFT / FAIL_SYNTHESIS /
  NOT_EVALUABLE)는 사용자 청취 후 부여.


- 2026-08-31 **R4 사람 청취 판정 = 혼합(화자일관성 해결 + 별도 합성신뢰성 결함 발견)**
  (사용자 원문: "rep1 04는 말이 안나와. rep1 06, 07도 말이 안나오네. rep1 09도 말이
  안나오는데... rep2 01도 아무 말이 없는 노이즈야. rep2 09에서 약속까지 25분 나스마써
  이렇게 뭉개지네. rep3 01도 의미없는 노이즈소리. rep3 10은 노이즈낀 라디오소리같이
  들리는 목소리야. 전반적으로 목소리가 인식되는 파일은 여성 화자이며 대개 비슷한 목소리와
  어조였어.").

  **파일별 상태(30개 중 사용자가 명시 지적한 8개)**:
  | 파일 | 상태 |
  |---|---|
  | rep1_RP04 | 무음(발화 없음) |
  | rep1_RP06 | 무음(발화 없음) |
  | rep1_RP07 | 무음(발화 없음) |
  | rep1_RP09 | 무음(발화 없음) |
  | rep2_RP01 | 노이즈만, 발화 없음 |
  | rep2_RP09 | 부분 뭉개짐("남았어"→"나스마써"로 왜곡, 그 외는 청취 가능) |
  | rep3_RP01 | 노이즈만, 의미없음 |
  | rep3_RP10 | 노이즈 낀 라디오 음질(발화는 있으나 품질 저하) |
  나머지 22/30(명시 언급 안 됨)은 정상 — 사용자 확인: "전반적으로 목소리가 인식되는
  파일은 여성 화자이며 대개 비슷한 목소리와 어조".

  **혼합 판정(사용자 확정, AskUserQuestion으로 명시 확인)**:
  1. **1차 화자일관성 판정 = 사실상 PASS**(정상 합성된 22개는 일관된 여성 화자·유사한
     음색/어조 — R2/R3에서 관찰된 RP09→RP10 여성→남성 전환이, 이번엔 **합성이 정상
     진행된 경우** 재현되지 않음. instruct 고정이 대명사 기반 성별전환을 억제하는 것으로
     보임).
  2. **단, 별도의 새 결함 = FAIL_SYNTHESIS(부분)**: 8/30(~27%)에서 무음·노이즈·부분뭉개짐
     발생 — 이는 R3/R4가 원래 찾던 "화자 전환" 문제가 아니라 **합성 자체의 신뢰성 문제**
     (2차 안전판정 카테고리인 "긴 무음"·"발음 악화"·"단어 누락"에 해당). 이 비율(~27%)은
     프로덕션 신뢰성 관점에서 무시하기 어려운 수준.
  단일 enum으로 압축하지 않고 두 측면을 병기하는 것으로 확정(사용자 선택: "혼합 판정").

  **R4(sub-experiment: OMNIVOICE-VOICE-DESIGN) CLOSED.** 결론: Voice Design instruct
  고정이 화자일관성 문제는 해결하는 것으로 보이나, 합성 신뢰성(무음/노이즈/뭉개짐 비율)이
  새로운 병목으로 확인됨. 이 결함의 원인 규명(같은 instruct·seed·문장인데 왜 특정 반복·
  문장에서만 실패하는지), 재현성 확인, 원인별 대응(예: retry 로직, instruct 재조정,
  다른 생성 파라미터)은 전부 **이 lock 범위 밖** — 별도 새 named lock 필요. Voice Clone
  하위실험(레퍼런스 오디오 필요)도 여전히 별도 lock 대기 상태.


- 2026-08-31 **R5 named lock 개방 + 사전등록**: 사용자 리터럴
  `TTS-R5-OMNIVOICE-VOICE-DESIGN-RELIABILITY-REPRO-R1`. Grep 확인: 이 문서(0건)·git 이력
  (0건) 모두 이전 등장 없음 — genuinely new. 범위는 사용자가 R4 종료 메시지에서 제시한
  "권장 범위"를 그대로 채택(R4와 동일 revision/instruct/seed/문장/생성설정, R4의 8개
  결함표본을 문장ID·반복번호로 고정, 정상표본 일부 대조군 포함, 무음/노이즈/뭉개짐 분리
  기록, 파일크기·duration·peak/RMS·NaN/Inf·실행로그 보존, 원인규명 전 재시도·파라미터
  조정·문장변경 금지, 제품통합·Voice Clone 제외). **반복 횟수(사용자 미명시 공백)를
  AskUserQuestion으로 확인 → 3회 채택**(R4와 동일 횟수로 직접 비교 가능).

  **사전 점검(중요, 실행 전 발견, 투명 공개)**: R4의 8개 결함파일과 정상파일 표본의
  peak/RMS/silence_ratio를 직접 계산해 비교한 결과, **단순 진폭 기반 객관지표로는 결함
  파일과 정상 파일이 명확히 구분되지 않음**(예: 일부 정상파일의 silence_ratio가 결함파일
  보다 오히려 높음, RMS 범위 상당부분 겹침, NaN/Inf는 전부 없음, peak는 거의 전부 0.5000
  천장값). 즉 이 지표들은 사용자 요청대로 기록은 하되, **재현 여부의 최종 판정은 이번에도
  사람 청취가 필요**함을 사전에 명시.

  **사전등록된 시험설계(실행 전 확정)**:
  - 3회의 **독립 실행**(run1/run2/run3, 각각 별도 fresh 프로세스로 모델 재로딩 —
    프로세스 내부 상태 잔존 배제, 재현성 검정을 최대한 엄격하게)
  - 매 run: `fix_random_seed(42)` 1회(run 시작 시) → R4와 동일한 3반복×10문장=30회
    `generate()` 호출을 **동일 순서**로 실행(rep 1→2→3, 각 rep 내 RP01→RP10) — R4의
    seed 체제(런 시작 1회 고정, 이후 전역 RNG 자연 진행)를 그대로 재현
  - instruct·모델revision·언어(ko)·기타 generate() 인자 전부 R4와 동일, 변경 없음
  - 매 파일: file_size_bytes, audio_seconds, peak, rms, silence_ratio(임계값=max(peak*0.02,
    1e-4) 미만 비율), has_nan, has_inf 계산·기록 + R4 당시 어느 위치가 결함으로 지적됐는지
    (`was_defective_in_r4`) 라벨 부착
  - 재시도·파라미터조정·문장변경 없음(그대로 30회 순서 실행, 실패해도 재시도 안 함)
  - 산출물: `audio/omnivoice_r5_repro/run{1-3}_rep{1-3}_{RP01-10}.wav`(90개, R4 원본
    30개는 무접촉 보존), `results/omnivoice_r5_repro/omnivoice-r5-repro-run{1-3}.json`,
    `logs/omnivoice_r5_repro/run{1-3}.log`, `synth_omnivoice_r5_repro.py`
  - 제외: 제품통합, Voice Clone, 문장 재작성, instruct 탐색, rubric 재평가, 스트리밍 실측

  추가 다운로드·설치 없음(기존 OMNIVOICE venv/모델 재사용). 실행 착수 직전 상태.


- 2026-08-31 **R5 실행 완료 + 결정적 재현성 확정(사람 청취 불필요, 객관 증거로 확정)**
  — 3회 독립 실행(run1/2/3, 각각 fresh 프로세스로 모델 재로딩) 전부 완료, 각 30개씩 총
  90개 오디오 생성. 추가 다운로드·설치 없음, R4 원본 30개는 무접촉 보존.

  **결정적 발견**: 사전등록된 대로 peak/RMS/silence_ratio 등 진폭 지표를 R4 원본과
  run1/2/3 사이에 비교하려 했으나, 8개 결함위치 + 2개 정상대조군 전부에서 지표가
  소수점까지 완전히 일치 — 이에 **더 엄격한 검증으로 sha256 파일해시 직접 비교**를
  수행(원래 계획에 없던 추가 확인이나, 통계적 일치가 너무 정확해 문자 그대로 동일 파일인지
  결정적으로 확인할 가치가 있다고 판단, 문장·seed·설정 변경 없이 순수 검증만 추가한 것이라
  R5의 "재시도·파라미터조정·문장변경 금지" 원칙 위반 아님). 결과:

  **8개 결함위치(rep1_RP04/06/07/09, rep2_RP01/09, rep3_RP01/10) + 2개 정상대조군
  (rep1_RP01, rep2_RP05) 전부, R4 원본과 run1/run2/run3 사이 sha256 완전 일치.**
  이어서 R4의 전체 30개 위치 × 3회 실행(90회 비교) 전부 재확인 → **90/90 전부 sha256
  완전 일치, 불일치 0건.**

  **결론**: 동일 seed(42, 실행시작 1회) + 동일 모델revision + 동일 instruct + 동일
  30회 호출순서 조건에서, 이 Mac(MPS)의 OmniVoice 파이프라인은 **완전히 결정론적**
  (bit-for-bit 재현) — 사전등록 문서에서 세운 "MPS/Metal 부동소수점 비결정성" 가설은
  **기각**됨. 따라서 R4에서 관찰된 8개 결함(무음/노이즈/부분뭉개짐)은 **무작위적/일회성
  불운이 아니라, 그 특정 (seed, 시퀀스상 위치, 텍스트) 조합에 결정론적으로 귀속되는
  구조적 결함**임이 객관적으로 확정됨. 파일이 bit-identical이므로 새로 청취할 필요
  없음(같은 바이트 = 같은 소리, 수학적으로 보장) — 사람 청취 판정은 R4에서 이미 확보된
  것으로 충분.

  **아티팩트(Mac-local)**: `audio/omnivoice_r5_repro/run{1-3}_rep{1-3}_{RP01-10}.wav`
  (90개), `results/omnivoice_r5_repro/omnivoice-r5-repro-run{1-3}.json`,
  `logs/omnivoice_r5_repro/run{1-3}.log`, `synth_omnivoice_r5_repro.py`. R4 원본 30개
  무접촉 보존 확인(sha256 비교 자체가 원본 무변경의 증거). WORK_ROOT 밖 영구쓰기 0.

  **R5(OMNIVOICE-VOICE-DESIGN-RELIABILITY-REPRO) CLOSED.** 결론: R4의 8개 결함은
  100% 재현 가능한 결정론적 결함 — seed·모델·instruct·문장이 고정된 한 항상 같은
  위치에서 같은 방식으로 실패함. 결함의 **근본 원인**(왜 하필 이 위치들인지 — 시퀀스
  누적효과·특정 텍스트 조합·모델 내부 상태 등)과 **완화책**(다른 seed 선택, retry 로직,
  파라미터 조정, instruct 재검토 등)은 전부 이 lock 범위 밖 — 사용자가 이미 로드맵으로
  제시한 `TTS-R5-OMNIVOICE-VOICE-DESIGN-RELIABILITY-MITIGATION-R1` 등 별도 새 named
  lock 필요. Voice Clone 하위실험도 여전히 미착수.
