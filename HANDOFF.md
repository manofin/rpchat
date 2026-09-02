# RP-Chat PWA — 핸드오프 v2.2 (2026-08-27 배너 재실측, HEAD = v0.0.19-57-ga9114b2)

> **2026-08-27 인수인계 정본:** `/home/hermes/rpchat/planning_documents/HANDOFF-2026-08-27.md` — 후임은 그 파일을 먼저 연다. 이 파일 §3 이하는 2026-08-23 역사.
> 이 문서 하나로 맥락을 복원한다. 원본 설계근거는 `RP-Chat_ClaudeCode_핸드오프.md`(Mac) 참조.
> **2026-08-24: HEAD를 태그 팁(v0.0.19)에서 실측 describe로 갱신.** v0.0.19 이후 27커밋(태그 미생성) = P3 임베딩 벤치(비채택 확정) + P4 sketch 벤치 하니스 + 백업/복구 정비 + long-rp-v1 측정 + orphan/reconnect 수정. §3 이하는 2026-08-23 세션의 역사적 기록으로 보존.

---

## 0. 거버넌스 (불변 — 모든 실행 주체 동일 준수)

1. **증거 원칙**: "완료" 서술만으로 통과 없음. git/ls/wc/sqlite3/curl raw 출력으로만 판정.
2. **원칙 0**: live DB(`/home/hermes/rpchat/data/rpchat.db`)·승인 memories·백업본 파괴적 쓰기 금지. 마이그레이션은 임시경로 우선, live 반영은 명시 승인 후.
3. **판정은 diff 실물로** — 버전 숫자·서술 아님.
4. **최소 풋프린트**: 한 번에 하나, 대상만 최소 변경.
5. **마이그레이션 전 백업 필수**: `backups/rpchat-pre-XXXX.db` 스냅 → 트랜잭션 → `foreign_key_check` → 실패 시 롤백.
6. **테스트는 임시행으로**: 기존 memories 6행 무접촉. 마커(`__test__`) 임시행 생성·검증·정화.
7. **게이트 통과 전 다음 단계 착수 금지.**
8. **규칙/모델은 진실을 독단 교체하지 않음** — 충돌·중복은 플래그일 뿐, 실제 채택/병합은 사용자 결정.

---

## 1. 토폴로지·상수 (실측 확정)

```
[추론] Mac Studio M3 Ultra — llama.cpp launchd 상시화
  Gemma-4-Dark-Thoughts-V2-31B.i1-Q4_K_M.gguf @ 8083 (tailnet 100.97.170.121)
[앱/DB] Ubuntu 미니PC(hermes) tailnet 100.121.186.117
  Fastify + SQLite @ 8787 (127.0.0.1 loopback) + Tailscale Serve(443)
[클라] Galaxy PWA (단일 오리진)
```

- 상수: `INFER_PORT=8083`, `MODEL_ALIAS=rpchat-writer`, Ubuntu tailnet `100.121.186.117`
- 인증: `AUTH_MODE=tailscale`, 헤더 `Tailscale-User-Login: manofin@github`
- health: `/api/health`(JSON). `/health`는 SPA 폴백 — 검증에 쓰지 말 것.
- API=camelCase(`conversationId`), DB=snake(`conversation_id`). zod는 unknown strip.
- **`model_profiles.summary.max_tokens = 1000`** (2026-08-23 600→1000 조정, 원인: P1-3a/b가 JSON 출력에 state+scene 추가했는데 예산 안 늘려서 memories 배열 중간 절단→502 "JSON 해석 실패". 실측 후 상향, rollup-episode도 같은 프로필 공유해 동반 개선.
- **git root** = `/home/hermes/rpchat/app`. remote 없음(로컬 전용).

### 마이그레이션 넘버링 규칙 (2026-08-24 기록, YAGNI)
다음 마이그레이션 파일명 = `0006_<slug>.sql`. `schema_migrations`에 name 등록 + `deploy/schema-compat.json`의 required_migrations에 추가. `PRAGMA user_version`은 계속 미사용(0 유지). 스키마 변경 없이 "번호 정리"용 빈 마이그레이션을 만들지 않는다. 현재 required_migrations = 0001–0005.

### ★ node 이중화 함정 (2026-08-23 실측, 반드시 준수)
- SSH 기본 셸 node = `/usr/bin/node` **v20.20.2 (ABI 115)**
- rpchat 서비스 node = `/home/hermes/.local/bin/node`→`.hermes/node/bin/node` **v22.23.2 (ABI 127)**
- **네이티브 관련 npm 작업(ci/rebuild)은 반드시 v22로:**
  ```
  cd /home/hermes/rpchat/app && PATH=/home/hermes/.local/bin:$PATH npm rebuild better-sqlite3
  ```
  안 그러면 서비스 기동 시 `ERR_DLOPEN_FAILED` (NODE_MODULE_VERSION 115 vs 127). web 빌드(tsc+vite)는 node 무관.

---

## 2. 버전 상태 (태그 이력)

| 태그 | 커밋 | 내용 |
|---|---|---|
| v0.0.1~v0.0.4 | … | baseline·search 회수·memory scope·superseded |
| v0.0.5 | 45e9edb | 규칙기반 conflict 감지(dup/conflict/new, CAL_CUT=0.35) |
| v0.0.6 | 6dc2546 | conflict 규칙 억제(dup-only), P3 임베딩 이월 |
| v0.0.7 | d6f7dd5 | ChatDrawer duplicate 병합 UX (P1-2c) |
| v0.0.8 | 3d55d6e | evidence 출처 점프 (P1-5) — hermes 수행·Claude Code 검증 |
| v0.0.9 | e3d4d93 | ⚠️라벨"P1-6" 실체=BudgetReport 기본목록 노출+DebugList UI (**P1-6a 일부만**). 무해·보존 |
| v0.0.10 | 2e9707e | ⚠️라벨"P1-3a" 실체=요약 covers_until 점프(P1-5 요약판). **상태트래커 아님.** 무해·보존 |
| v0.0.11 | 0929225 | P1-3a 상태 트래커(migration 0005+state 생성·주입·UI) — hermes·CC 검증완료 |
| v0.0.12 | f0751fb | P1-3b 장면(scene) 생성·주입(밀려난 구간, guard 24)·UI — hermes·CC 검증완료 |
| v0.0.13 | 4a4d88c | P1-6 프롬프트 디버거 — 조립 진단(로어 match/no-match, 요약 tier, preview-only). hermes·CC 검증완료 |
| v0.0.14 | e8d567a | P1-3c 에피소드 rollup(수동 묶기, Approach X 승인게이팅 자가치유, 예약35%+guard). 조립 SHA 중립 경험검증. hermes·CC 검증완료 |
| v0.0.15 | eaf835d | P1-6 후속: preview 진단 summaries에 episode 4번째 tier 항상 emit. 조립 SHA=v0.0.14. hermes 수행 |
| v0.0.16 | 3c18b56 | fix: 스토리 선택지(chips)가 다음 턴에도 안 사라지던 버그 — `isLastAssistant` 게이팅 추가. baseline 이후 기존 결함, 오늘 작업과 무관. Claude Code 직접 수정·검증 |
| v0.0.17 | 4bb24fb | fix: REVIEW-P1-3c 잠금 4항목 해소 — ①branch-scope 가드(pickOnPath, 다른 가지 요약 오염 차단, 실측검증) ②episode 예산탈락 가비지 가드(MIN_EPISODE_TOKENS=30) ③소스id 스키마화=불필요(rolled_up_into로 충분, 코드무변) ④dual rollup=이미 ctx.queue로 차단(동시요청 실측: 409+200, 중복無) |
| v0.0.18 | 91b9595 | fix: 자동추출 기억의 evidence_message_ids가 항상 배치의 끝(lastId)을 가리키던 것 → 시작(firstId)으로. "원본" 버튼이 항상 최신 대화로만 가던 문제 해소(완전한 원본 추적은 아니고 더 나은 근사) |
| **v0.0.19** | **93dcd56** | **feat: 장면상태 체크포인트+복원(PRD 순서6). `POST /api/summaries/:id/restore` 신규(append-only, git-revert 원리). SummaryTab에서 state 최신=현재/나머지=접이식 이력+복원버튼. 실측 검증 완료** |
| (태그 없음) | e2de9c9 | **현재 HEAD = v0.0.19-27-ge2de9c9** — 태그 팁 이후 27커밋, 미태그. 내역: P3 임베딩 벤치(a775c01~85c4b6e, **최종 판정 NOT ADOPTED**), PRD 1.2 phase-2 게이팅 문서(d2a279d, 54c4260), P4-sketch 벤치 하니스 6커밋(45e409d~457f978, Task 1 Draw Things는 Mac 로컬 게이트), 백업/복구 ops 정비 3커밋(13e694f~86823b6), orphan 스트리밍+PWA poll reconnect 수정(3fb2fa5), long-rp-v1 gold facts+100턴 측정+frost 가드(1309694~e2de9c9). |
> 각주 정정: 그 줄의 "현재 HEAD = v0.0.19-27-ge2de9c9"는 2026-08-24 기록. 라이브 HEAD는 배너의 describe.

> **PRD A트랙 로드맵(RP-Chat-PRD.md v1.1, §5.1) — 순서 0~7 전체 종료**: 0~1(기준선·생존성) 완료, 2(로어 2차키워드) 실측완료(오발동2/3→0/3, 실적용은 보류), 3(기억출처+중복)=P1-2b/c/5, 4(요약출처·버전)=P1-3, 5(장면상태 읽기전용)=P1-3a, 6(장면상태 체크포인트)=v0.0.19, **7(임베딩 벤치)=비채택 확정**(2026-08-23 저녁, `bench/embeddingBench/`, git root 밖 아님 — app/ 안, 커밋 a775c01~85c4b6e). H1(MiniLM)·H2(e5-small) 둘 다 성공기준1 불충족(H1 과소발화 must_fire 0/10, H2 과대발화 false_trigger 10/10 — 서로 다른 코사인 스케일 실패, AND게이트 로직은 정상). `conflict.ts`/`loreMatch.ts` 미변경. Claude Code 독립 검증: raw JSON 재대조, hermes 최초 Task3 오독(원인 반대로 보고)을 raw 대조로 정정시킴 — REPORT.md에 "보고 정정 기록"으로 투명히 남음. P3-v2(문체격차 완화·퍼센타일 상대컷)는 아이디어만, 별도 사전등록 필요 시작 안 함.
>
> **PRD A트랙 순서 0~7 전체 완료.** 남은 것: B/C군(아바타·삽화·TTS·월드생성·다중캐릭터, 무일정 후보), 별도계보 Phase2(인증), Galaxy 실기기, 기술부채.

> **⚠️ 태그 라벨 주의**: v0.0.9/v0.0.10은 설계 전 hermes 임의 구현(라벨↔실체 불일치, 무해·보존). **실제 P1-3a=v0.0.11, P1-3b=v0.0.12, P1-6=v0.0.13, P1-3c=v0.0.14, episode-diag=v0.0.15**(PROGRESS.md).
> **✅ P1-3 계층 요약 4계층 완성. P1-6 진단 4-tier emit. Phase 1 명시 항목(P1-2 기억·P1-3·P1-5·P1-6) 전부 완료.**
> 잔여: 설계판단(폴백·소스id 등, REVIEW-P1-3c 하단). 이월: 인증 토큰세션(Phase2), conflict 임베딩(P3), Mac 2차사본 자동화, 재부팅 소요 측정, Galaxy 실측.
> whole 처리는 2-A 확정(DESIGN-P1-3 §7-4 개정 = 롤링 유지+episode 중간tier).

작업트리: clean (단 `apps/web/dist.bak/` untracked = §6-1 롤백 백업 / `PROGRESS.md`·`DESIGN-*.md`·`BRIEF-*.md` untracked = 워킹 문서).

---

## 3. 이번(2026-08-23) 세션 완료 내역 — 전부 실측 검증됨

1. **P1-2b-fix (b) 검증** — v0.0.6이 이미 (b) 구현(conflict 도달→`kind:'new'`+`conflict-suppressed` reason, XOR·개체겹침 로직 보존, '죽' 마커 제외). 게이트 재실측:
   - A 기존6행 상호 conflict 0 / B duplicate(자카드) 검출 / C "서리는 과거를 모두 기억한다"→new+suppressed reason / D 무관→new / E 정화 `candidate|6`+integrity ok
2. **§6-1 web 빌드 복구** — `@babel/compat-data/data/plugins.json` 부재 → `npm ci`(456pkg) + better-sqlite3 **v22 재빌드** → `npm run build --workspace apps/web` exit 0 → restart → health `db:ok`. (추적2 해소)
3. **P1-2c duplicate 병합 UX** (`v0.0.7`):
   - `types.ts`: `MemoryVerdict` 추가, `Memory`에 `conflict?`·`evidence_message_ids?`·`superseded` 상태
   - `ChatDrawer.tsx` MemoryTab: duplicate 플래그 후보 아래 안내패널(사유+기존기억 내용) + **[병합]**(canonical pin + dup reject)/**[무시]**(경고 숨김). 채택·버림 항상 유지.
   - conflict 선택지 UI는 P3 보류(§6-2). 검증: tsc+build exit 0, 데이터계약(conflict.kind=duplicate+withMemoryId)·병합 end-state(canonical→pinned, dup→rejected) 실측, `candidate|6` 복귀.

4. **P1-5 출처 추적** (`v0.0.8`, hermes 수행 · Claude Code 검증): MemoryTab 승인대기·고정 양쪽에 `evidence_message_ids[0]` 있으면 "원본" 버튼 → `navigate('/chat/:id?jump=<eid>')`(커스텀 `../lib/router`) + onClose. 같은 대화 점프는 onClose의 setDrawer(false) 리렌더로 ChatPage가 `?jump=` 재계산해 발동(검증됨). 게이트: build exit 0 / 서빙 `index-f1F6cImh.js` / health db:ok / candidate|6 / integrity ok 전부 실측 통과.

**P1-2 기억 시스템 = 사실상 완결** (candidate→pinned 승인 + 중복 병합 + 출처 점프 + pinned 프롬프트 주입 코드 완비). 실가동은 사용자가 후보 승인 시 시작(현재 6행 전부 candidate = 주입 0건).

---

## 4. 남은 작업 (2026-08-25 갱신 — 다음 착수 후보)

> **기본 경로 (2026-08-27 서류 정리 후):** 제품 잠금이 없으면 새 코드 없음.
> 현황 색인: `/home/hermes/rpchat/planning_documents/STATUS.md`.
> Track A–C of `2026-08-25_020352` = executed. D1 executed. D2 executed. Gate 5 items 2–6 executed (item 1 Galaxy last).
> F5 ADR **accepted-A** (정의 4). Do not invent F5-B. Galaxy UNCHECKED. E1 / F1 / F3 / F4 / F6 locked. F2 isolated apply closed; live lore PATCH not opened.
> - **다음 프로덕트 = 사용자 잠금 필요 (E1 P4 Mac / F1 Phase2 / F2-live lore PATCH / F3 아바타 / F4 TTS·삽화 / F6 자동승인 / `PRD` 중 하나). F5 재레터 금지.**
> - `planning_documents/미래_참고안_다중캐릭터_월드_설계.md`는 참고 아키텍처일 뿐 실행 로드맵 아님.
> - long-rp-v1 hold 30=0/6, 60=4/6, 100=3/7은 측정값. score keys·θ 사후 조정 금지.

P1-3 / P1-6은 **코드 슬라이스 완료**. 여기 다시 “착수 P1-3a”로 돌아가지 말 것.

### ✅ 사람 잠금 완료 (2026-08-23) — 전부 v0.0.17로 해소
- episode 예산 탈락 시 폴백: **최소기준 미달시 생략** 채택(장면 폴백 없음)
- 소스 장면id 스키마화: **현행(rolled_up_into) 유지**, 추가 불필요
- dual rollup draft: **코드변경 없음**, ctx.queue 가드로 이미 차단(동시요청 실측)
- branch-scope: **경로소속 가드 추가**(pickOnPath), 실측(브랜치A/B 전환) 검증 완료

### 관측·기기 (코드 불필요 또는 사용자 기기)
- Galaxy: P1-5 원본 점프, 상태/장면 카드 실측
- 격리 대화 episode 라이브(장면 ≥5 + rollup) — 모델 예산 큼, 실대화 금지
- lore no-match 라이브: 현재 서리 대화에 해당 엔트리 없음

### Phase 2 / P3
- §5 표. 이 창에서 시작 금지.

---

## 5. 이월 추적 (비블로킹)

| # | 항목 | 해결 시점 |
|---|---|---|
| 1 | 인증 헤더 위조(tailnet 한정) | Phase 2 토큰 세션 |
| 2 | ~~web 빌드 결함~~ | ✅ 2026-08-23 해소 |
| 7 | P1-5 원본 점프: Galaxy 기기 실측 미완(hermes 미결) — 근거 메시지가 현재 브랜치 밖이면 조용히 무동작(설계상 허용) | 사용자 기기 확인 시 |
| 3 | conflict 규칙 천장 → 의미유사도 필요. conflict.ts XOR로직·near-miss 로그가 전환 baseline | **P3 임베딩** |
| 4 | Mac 2차사본 자동화(수동 1회) | Phase 0 후속 |
| 6 | Mac 잠금해제~health200 소요 미측정 | 다음 재부팅 시 date 측정 |

---

## 6. hermes 위임 브리프 템플릿 (텔레그램 붙여넣기용)

> P1-5는 이 템플릿으로 위임되어 v0.0.8로 완료됨. 다음 위임 시 아래 골격을 채워 사용.
> **위임 적합**: 범위가 좁고 게이트가 명확한 프론트/조회 작업. **위임 부적합**: 설계 판단·스키마 변경·live DB 쓰기(→ Claude Code 직접).

```
작업: RP-Chat <작업ID> <한 줄 목표>. 거버넌스(증거 원칙·최소 풋프린트·§0) 준수, raw 증거로만 보고.
위치: /home/hermes/rpchat/app  (git root, HEAD 확인: git log --oneline -1)

구현: <파일·함수·정확한 변경. 기존 패턴 재사용처 명시>

node 함정: web 빌드(tsc+vite)는 node 무관. 단 npm ci/rebuild 하면 반드시 PATH=/home/hermes/.local/bin:$PATH (서비스는 v22, SSH 기본은 v20 → ABI 불일치).

게이트(raw 필수):
1. npm run build --workspace apps/web → exit 0
2. systemctl --user restart rpchat ; curl -s localhost:8787/api/health | head -c 80 → db:ok
3. curl -s localhost:8787/ | grep -oE 'index-[A-Za-z0-9_-]+\.js' → 새 해시
4. sqlite3 /home/hermes/rpchat/data/rpchat.db "SELECT status,count(*) FROM memories GROUP BY status;" → candidate|6 무변
셋 이상 참이어야 통과. 통과 시 git add <파일> ; git commit -m "<msg>" ; git tag <다음태그>.
실패 시 git checkout -- <파일> 로 되돌리고 중단, 사유 보고.

**설계 판단이 필요하거나 서버/DB/스키마를 건드려야 하면 진행 말고 §7 PROGRESS.md 에 질문만 남길 것.**
```

---

## 7. 진행 로그 규약 (hermes ↔ 인계용)

hermes는 작업 결과를 반드시 아래 파일에 append(덮어쓰기 금지):
```
/home/hermes/rpchat/app/PROGRESS.md
```
형식(각 세션):
```
## [ISO시각] P1-5 by hermes
- 한 일: (변경파일, 커밋해시, 태그)
- 게이트 raw: build exit / health / candidate count
- 미결·질문: (설계 판단 필요분)
```
다음 Claude Code 세션은 재개 시 **①§8 체크리스트 ②`cat PROGRESS.md` ③`git log --oneline -5`**로 hermes 진행분을 인계받아 검증 후 이어간다.

---

## 8-1. ★ 야간 위임 (2026-08-23 17:00 → 08-24 10:00, OVERNIGHT-BRIEF.md)

**상태: 수행됨 (hermes 자가보고).** 재검증은 아래 raw + `OPERATOR-NOTE.md`. 새 야간 작업 만들지 말 것.

위임 내용(기록):
- **Task 1**: 격리 테스트 대화에서 real-model state/scene/whole → `REPORT-P1-3-dogfood.md`, 정화. 코드 없음.
- **Task 2**: P1-6 진단 episode 4번째 → `v0.0.15` / `eaf835d`.

**08-24 10:00 재개 시 §8 체크리스트에 추가로 확인:**
```bash
cat REPORT-P1-3-dogfood.md OPERATOR-NOTE.md
git log --oneline -5 ; git describe --tags --always   # v0.0.15
grep -A8 'overnight' PROGRESS.md | tail -20
sqlite3 /home/hermes/rpchat/data/rpchat.db "SELECT count(*) FROM conversations WHERE title LIKE '%TEST-dogfood%';"  # 0
```
발견 시 Claude Code가 raw로 독립 재검증 후 사용자에게 보고(hermes 자가보고 그대로 신뢰 금지).

## 8. Claude Code 재개 체크리스트

```bash
cd /home/hermes/rpchat/app
whoami; hostname                 # hermes@hermes
git log --oneline -5 ; git tag   # HEAD·태그 확인 (v0.0.8 이상)
git status --short               # dist.bak/ 외 clean 기대
cat PROGRESS.md 2>/dev/null      # hermes 진행분 인계
sqlite3 /home/hermes/rpchat/data/rpchat.db "SELECT status,count(*) FROM memories GROUP BY status;"  # candidate|6
systemctl --user is-active rpchat ; curl -s localhost:8787/api/health | head -c 80  # active / db:ok
```
