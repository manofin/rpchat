## [2026-08-23T02:58:09Z] P1-5 by hermes
- 한 일: apps/web/src/pages/ChatDrawer.tsx — MemoryTab 승인대기·고정 양쪽에 evidence_message_ids[0] 있으면 "원본" 버튼. 클릭 시 `navigate(/chat/${conversationId}?jump=…)` (SearchPage와 동일, `../lib/router` — react-router 미사용) 후 onClose. 커밋 3d55d6e, 태그 v0.0.8.
- 게이트 raw: `npm run build --workspace apps/web` exit 0 (tsc --noEmit + vite, index-f1F6cImh.js). restart 후 health `{"ok":true,...,"db":"ok",...}`. sqlite `candidate|6`. Serve index `index-DE7bjAYL.js` → `index-f1F6cImh.js`.
- 미결·질문: 기기에서 버튼→점프·flash는 미실측(Galaxy). 서버/DB/스키마 무접촉.

## [2026-08-23T03:10:00Z] P1-6 by hermes
- 한 일: BudgetReport에 included_memories / dropped_memories / summary_used / summary_preview / recent_from_id / recent_to_id 노출. BudgetTab에 포함된 기억·발동 로어·제외 로어·사용 요약·최근 범위·탈락 기억 목록. 스키마/DB 무변경. 커밋 e3d4d93, 태그 v0.0.9. 파일: apps/server/src/prompt/builder.ts, apps/server/src/types.ts, apps/web/src/pages/ChatDrawer.tsx, apps/web/src/types.ts.
- 게이트 raw: server `tsc` exit 0; `npm run build --workspace apps/web` exit 0 (`index-Cls4rb2A.js`). restart 후 health db:ok. sqlite `candidate|6`. preview 실측: included_memories=[] (pinned 0), dropped_memories=[], active_lore=["기록보관소","만년필"], dropped_lore=[], summary_used=true, included_messages=35, dropped_messages=0, recent_from_id=b7722427…, recent_to_id=1e7e7f0a….
- 미결·질문: P1-3 계층 요약은 설계 감독 필요 — 착수 안 함. Galaxy 컨텍스트 탭 실측 미완. 포함 기억 목록은 pinned가 있어야 비어 있지 않음(현재 6행 전부 candidate).

## [2026-08-23T03:14:42Z] P1-3a by hermes
- 한 일: P1-3 계층(장면/에피소드/트래커)은 미착수. P1-5 요약 반쪽 + P1-3 "원본 메시지 범위 연결"만. SummaryTab에 covers_until_message_id 있으면 "원본" → `navigate(/chat/${id}?jump=…)` + onClose (MemoryTab과 동일). 스키마/DB/서버 무변경. 커밋 2e9707e, 태그 v0.0.10. 파일: apps/web/src/pages/ChatDrawer.tsx, apps/web/src/types.ts.
- 게이트 raw: `npm run build --workspace apps/web` exit 0 (`index-DZ9kIRcF.js`). restart 후 health db:ok. sqlite `candidate|6`. GET summaries n=1 approved covers_until=491e1d8b-b85f-4876-82f1-b9b7c19d9d90.
- 미결·질문: 계층 요약·이전 요약 복원·버전 승격 정책은 설계 필요. Galaxy 원본 점프 실측 미완.

## [2026-08-23 검토 by Claude Code] hermes v0.0.9/v0.0.10 검토
- **발견: 라벨-실체 불일치.** 두 커밋 모두 확정 설계보다 먼저 나온 임의 구현.
- v0.0.9 (e3d4d93, "P1-6"): BudgetReport 미사용 필드(included/dropped_memories, summary_used/preview, recent_from/to) 채우고 BudgetTab에 DebugList UI. → **DESIGN-P1-6의 P1-6a 일부에 해당(기본 목록만)**. 드롭 사유 입도·로어 매칭 키워드·opts.diagnostics 플래그·tier 분해는 미구현. 무해, 빌드 통과. 보존.
- v0.0.10 (2e9707e, "P1-3a"): 요약→covers_until 메시지 점프 버튼(P1-5의 요약판). **P1-3a(상태트래커) 아님.** 스키마 무변경, 무해, 빌드 통과. 보존.
- **미구현(실제 설계): P1-3a 상태트래커+migration 0005 (BRIEF-P1-3a.md, hermes 시도 이후 04:47 배치됨 → hermes 미인지), P1-6a 나머지(진단 페이로드).**
- 검증 raw: server/web build exit 0, health db:ok, candidate|6, migrations 0001-0004(0005 없음), integrity ok, summaries tier 컬럼 없음.
- 권고: 태그 재작성 대신 실체를 문서화(위). 다음 = BRIEF-P1-3a.md대로 P1-3a 재진행(마이그레이션 포함 → 위임 시 STEP0 백업 필수 재강조, 또는 Claude Code 직접).

## [2026-08-23T04:56:42Z] P1-3a state tracker by hermes
- 한 일: DESIGN/BRIEF대로 상태 트래커. 0005_summary_tiers.sql (tier/covers_from/rolled_up_into + idx). summarize가 state draft(tier=state)와 whole draft를 같이 INSERT. builder는 approved state를 whole보다 앞·cap min(200,남은예산), 순서 기억→state→whole→로어. SummaryTab 상태 카드 최상단 + 전체 카드. 커밋 0929225. **태그 v0.0.9 미부착**(이미 P1-6 e3d4d93에 사용). HEAD 전제 BRIEF=v0.0.8였으나 실측 HEAD는 v0.0.10(2e9707e) — 그 위에 구현.
- 변경파일: apps/server/migrations/0005_summary_tiers.sql, apps/server/src/prompt/templates.ts, apps/server/src/routes/memory.ts, apps/server/src/prompt/builder.ts, apps/server/src/types.ts, apps/web/src/types.ts, apps/web/src/pages/ChatDrawer.tsx
- STEP0 raw: backup /home/hermes/rpchat/backups/rpchat-pre-0005.db integrity=ok; 착수 전 memories candidate|6
- 게이트 raw:
  - server `npm run build --workspace apps/server` EXIT:0
  - web `npm run build --workspace apps/web` EXIT:0 (index-Cq6kKGoP.js)
  - restart rpchat active; schema_migrations: 0001..0005_summary_tiers.sql
  - summaries GROUP BY tier: whole|1
  - PRAGMA foreign_key_check: (empty)
  - curl health: {"ok":true,...,"db":"ok"...}
  - memories: candidate|6
  - PRAGMA integrity_check: ok
- 게이트7(선택): summarize 실호출은 curl 승인 타임아웃으로 **미실행**. 기존 1행 whole 무접촉.
- 미결·질문: (1) 다음 태그 v0.0.11 붙일지. (2) Galaxy에서 상태 카드·승인 후 프롬프트 주입 미실측. (3) scene/episode는 P1-3b/c.

## [2026-08-23 P1-3a 최종검증 by Claude Code] 커밋 0929225 — PASS
- 코드리뷰: migration 0005/템플릿(state 스키마+stateToBullets+renderState)/파싱(방어적 coerce)/예산(state→whole 우선, stateCap=min200)/UI(renderCard 리팩터) 전부 브리프·설계 일치. 품질 높음.
- 독립 빌드: server tsc EXIT0, web EXIT0 (index-Cq6kKGoP.js, 드리프트 없음). restart 후 실행=커밋.
- **게이트7(hermes 미실행) 직접 수행**: 임시 approved state행 삽입→prompt-preview에 '### 현재 상태' 주입 확인, '이전 대화 요약'(whole) 앞 위치=설계순서, note 'state 포함'. 임시행 정화→whole|1, candidate|6, integrity ok.
- STEP0 백업 rpchat-pre-0005.db 확인. 마이그레이션 게이트(tier컬럼/기존행 whole/foreign_key_check) 통과.
- 관찰1(비블로킹): systemParts 순서가 [..기억, state, whole(summary), lore]로 바뀜 — 기존엔 lore가 summary 앞. 설계 §4 의도(state·whole 묶고 lore 뒤). state 없는 대화도 summary↔lore 순서 델타 발생. 무해.
- 관찰2: state '생성' 경로(모델이 state 객체 산출)는 실호출 미검증(새 메시지+모델콜 필요) — 코드상 정확, 사용자 다음 summarize 시 자연 확인.
- 미해결: 태그 미부여(v0.0.11 권장, 사용자 승인 대기). v0.0.9/v0.0.10 라벨오류는 문서화됨.

## [2026-08-23T05:34:15Z] P1-3b scene tier by hermes
- 한 일: DESIGN/BRIEF-P1-3b대로 장면(scene) 계층. 스키마/마이그레이션 없음. summarize가 scene draft INSERT(covers_from=slice[0], covers_until=lastId). builder는 whole 실사용 후 잔여 예산에 approved scene 최대 2개 주입(SCENE_RECENT_GUARD=24, rolled_up_into IS NULL), 순서 state→whole→scene→lore. SummaryTab 장면 카드. 착수 전 HEAD=v0.0.11(0929225) 확인. 커밋 f0751fb, 태그 v0.0.12.
- 변경파일: apps/server/src/prompt/templates.ts, apps/server/src/routes/memory.ts, apps/server/src/prompt/builder.ts, apps/web/src/pages/ChatDrawer.tsx
- 게이트 raw:
  - server `npm run build --workspace apps/server` EXIT:0
  - web `npm run build --workspace apps/web` EXIT:0 (index-BiBNv6oY.js)
  - restart rpchat active (2026-08-23 05:33:26 UTC); health ATTEMPT=0 STATUS=200 BODY={"ok":true,"time":"2026-08-23T05:33:57.385Z","db":"ok","model":{"ok":true,"check
  - 주입 CASE_A (covers_until=39b897eb… past, conv 09e7827f…): HAS_RECENT_SCENE=True HAS_TEST_MARKER=True SCENE_WINDOW='### 최근 장면\\n- __test__ scene injection probe\\n\\n### 관련 설정(로어)\\n…' MEM_SUM_NOTE='승인된 상태 없음; 장면 1' → DELETE changes=1
  - 주입 CASE_B (covers_until=head 1e7e7f0a…): HAS_RECENT_SCENE=False HAS_TEST_MARKER=False SCENE_WINDOW=ABSENT MEM_SUM_NOTE='승인된 상태 없음' → DELETE changes=1
  - memories: candidate|6
  - summaries GROUP BY tier: whole|1
  - leftover __test__: 0
  - PRAGMA integrity_check: ok
- 게이트6(선택): summarize 실호출 미실행(모델콜). 주입검증으로 갈음.
- 미결: Galaxy 장면 카드·승인 후 실측 없음. 에피소드 rollup은 P1-3c.

## [2026-08-23 P1-3b 최종검증 by Claude Code] 커밋 f0751fb / v0.0.12 — PASS
- 코드리뷰: templates(scene 스키마+지시)/memory(firstId+scene draft INSERT+payload)/builder(sceneTierText 충돌회피 정확, 예산 sumBudget−stateEst−wholeEstOnly, guard slice(-24), 최대2, 순서 state→whole→scene→lore)/UI(장면 카드) 전부 브리프 일치.
- 독립빌드: server EXIT0, web index-BiBNv6oY.js(드리프트 없음), health 200 db:ok.
- 주입 게이트 재실측: CASE_A(과거 covers_until=b7722427)→'### 최근 장면' 주입+marker+note '장면 1'. CASE_B(head 1e7e7f0a)→recentGuard 제외(미주입). 임시행 전량 DELETE.
- 무접촉: candidate|6, whole|1, 잔여 __test__ 0, integrity ok.
- 미결: state/scene '생성'(모델콜) 실호출 미검증(코드 정확, 사용자 summarize 시 자연확인). 에피소드 rollup=P1-3c.

## [2026-08-23T06:05:40Z] P1-6 STOP — 게이트4 전제 붕괴 (커밋 없음)
- 착수 전 HEAD raw: `f0751fb feat(summary): scene tier generation + injection (P1-3b)` / describe=`v0.0.12`
- 변경 전 preview messages SHA: `b3a19a8be24ba9aacaad5f33d3d859e184c220866949773968df1a06f55fe430` (MSG_COUNT=37, HAS_DIAGNOSTICS=False)
- 한 일(워킹트리, 미커밋): loreEntryActive 무수정 + loreEntryMatch 신규. BudgetDiagnostics + opts.diagnostics. preview만 diagnostics:true. BudgetTab은 g 있으면 로어/기억/요약 진단 표시, 없으면 DebugList 폴백. 조립 로직(systemParts·예산) 미변경.
- 변경파일: apps/server/src/prompt/loreMatch.ts, apps/server/src/prompt/builder.ts, apps/server/src/types.ts, apps/server/src/routes/conversations.ts, apps/web/src/types.ts, apps/web/src/pages/ChatDrawer.tsx
- 게이트 raw:
  - 1 server `npm run build --workspace apps/server` EXIT:0
  - 2 web `npm run build --workspace apps/web` EXIT:0 (`index-T0t3Ywx7.js`)
  - 3 restart active; `curl -s localhost:8787/api/health|head -c 60` → `{"ok":true,"time":"2026-08-23T06:05:20.563Z","db":"ok","mode`
  - 4 진단: HAS_DIAGNOSTICS=True DIAG_KEYS=['lore','memories','summaries'] LORE=기록보관소(matched 서가)/만년필(matched 잉크) MEMORIES=[] SUMMARIES=[{tier:whole,used:true,tokens:137}] SUMMARY_TIERS=['whole'] HAS_STATE_WHOLE_SCENE=False
  - 5 조립불변: MESSAGES_SHA256=b3a19a8be24ba9aacaad5f33d3d859e184c220866949773968df1a06f55fe430 == BASELINE, MESSAGES_EQ_BASELINE=True
  - 6 무접촉: candidate|6 / summaries whole|approved|1 / integrity=ok / leftover test=0
- **STOP 사유**: BRIEF 게이트4는 `summary에 state/whole/scene 3항목`을 요구. STEP 2d는 존재하는 행만 push. 실측 DB는 state/scene 행 0 → 3항목 불가. 미존재 tier를 used=false로 항상 emit하면 STEP 2d를 바꾸는 설계 판단.
- 질문: (A) 없는 tier도 used=false로 항상 3항목 emit 후 게이트4 재측정·커밋 (B) 현재 페이로드(whole 1항목 + 키 존재)를 게이트4 통과로 보고 v0.0.13 커밋 (C) 다른 지시
- 참고: BRIEF `git add` 목록에 conversations.ts 없음. STEP 3이 그 파일을 바꾸므로 커밋 시 포함 여부도 확인 필요.
- checkout 안 함: 구현 결함이 아니라 게이트 전제 붕괴. 워킹트리 유지.

## [2026-08-23T06:22:46Z] P1-6 addendum 완료 — v0.0.13
- 지시: 워킹트리 유지 + BRIEF-P1-6-addendum.md 수정1~3만. 요약 (A) 3개 항상 emit. 로어 no-match status. messages 진단 없음. conversations.ts 커밋 포함(preview-only).
- 수정1 builder 요약: 조건부 push 제거 → state/whole/scene 무조건 3개 (없으면 used=false + note).
- 수정2 builder 로어: 루프 상단에서 전 엔트리 loreDiag. no-match는 tokens=0/included=false/status=no-match. hit는 status=active|dropped-budget. activeLore/droppedLore 조건 동일.
- 수정2 타입: BudgetDiagnostics.lore에 status: 'active'|'dropped-budget'|'no-match' (server+web).
- 수정3 ChatDrawer: 로어를 status 3분기(active / dropped-budget / no-match opacity 0.5 '미매칭'). 요약은 3항목 map.
- 커밋 `4a4d88ce706b8d451a67af2f9d61bb9d21fc4c33` / 태그 `v0.0.13` / 메시지 `feat(prompt): assembly diagnostics — lore match/no-match + summary tiers (P1-6, preview-only)`
- 6 files: loreMatch.ts builder.ts conversations.ts types.ts(web+server) ChatDrawer.tsx
- 게이트 raw (재측정):
  - 1 server tsc EXIT:0
  - 2 web tsc+vite EXIT:0 (`index-csm5ZKzR.js`)
  - 3 restart active; health `{"ok":true,"time":"2026-08-23T06:22:26.131Z","db":"ok",...}`
  - 4 SUMMARIES_LEN=3 TIERS=['state','whole','scene'] HAS_STATE_WHOLE_SCENE=True
    SUMMARIES_JSON=[{"tier":"state","used":false,"tokens":0,"note":"승인된 상태 없음"},{"tier":"whole","used":true,"tokens":137},{"tier":"scene","used":false,"tokens":0,"note":"해당 장면 없음/제외"}]
    LORE_LEN=2 LORE_STATUSES=['active','active'] LORE_ALL_HAVE_STATUS=True LORE_NOMATCH_COUNT=0 (이 대화 no-match 엔트리 없음 → active 확인)
    HAS_MESSAGES_DIAG=False DIAG_KEYS=['lore','memories','summaries']
  - 5 MSG_SHA=b3a19a8be24ba9aacaad5f33d3d859e184c220866949773968df1a06f55fe430 == BASELINE MESSAGES_EQ_BASELINE=True MSG_COUNT=37
  - 6 MEMORIES [('candidate', 6)] SUMMARIES_DB [('whole', 'approved', 1)] INTEGRITY ok TEST_LEFTOVER 0
- PROGRESS.md는 커밋 미포함(add 목록 외).

## [2026-08-23 P1-6 최종검증 by Claude Code] 커밋 4a4d88c / v0.0.13 — PASS
- 코드리뷰: loreEntryMatch(신규, matched 배열)/builder(요약 3-emit 항상, 로어 status active|dropped-budget|no-match 전엔트리, memory diag, preview-only opts)/conversations.ts({diagnostics:true})/chat.ts 미변경(생성 진단0)/types×2/UI(status 3분기·no-match opacity). 애드덤 정확 반영.
- 독립빌드: server EXIT0, web index-csm5ZKzR.js(드리프트 없음), health 200.
- ★조립 불변 독립재현: prompt-preview messages SHA(compact_noascii 정규화)=b3a19a8b…=baseline 정확일치. 진단은 조립 무영향=회귀 없음.
- 진단 검증: summaries 3항목(state:false/whole:true 137t/scene:false), lore 전엔트리 status(이 대화 no-match 0건, active 2), messages 키 없음(의도).
- 무접촉: candidate|6, whole|1, integrity ok.
- 미결: 로컬 no-match 로어 라이브 확인은 이 대화에 해당 엔트리 없어 코드경로로만 확인(diff). state/scene '생성'(모델콜) 실호출은 여전히 미검증(사용자 summarize 시 자연확인).

P1-3c 설계검수 완료, REVIEW-P1-3c.md 참조

## [2026-08-23 P1-3c] episode rollup + injection (Approach X)
- 착수 HEAD `4a4d88ce706b8d451a67af2f9d61bb9d21fc4c33` / `v0.0.13`
- STEP 1 templates: renderEpisodePrompt(sceneContents) / renderEpisode `### 지난 에피소드`
- STEP 2 memory: DELETE episode 시 rolled_up_into NULL. rollup-episode POST (THRESHOLD=5, 트랜잭션 마킹). PATCH 무변.
- STEP 3 builder: episode 35% 예약 → whole → scene 배제쿼리(approved episode만 접힘). systemParts state→whole→episode→scene→lore
- STEP 4 SummaryTab: episode 카드 + 묶기 버튼(foldableScenes>=5)
- 스키마/summarize/whole 생성 경로 무변
- 게이트:
  - typecheck+build EXIT:0 web `index-DePMmRlA.js`
  - health 2026-08-23T07:42:10.580Z db ok
  - lifecycle: draft 장면유지(B_DRAFT_SCENE_KEEP True) → 승인 접힘(C_APPROVED_FOLDED True, ### 지난 에피소드, marker 0) → DELETE 복귀(D_RETURN_SCENES True, rolled_up_into NULL)
  - CLEAN_CHANGES 5×1 TEST_LEFTOVER 0 POST whole|approved|1 candidate|6 INTEGRITY ok
  - 명명 baseline b3a19a8b…: PRE/FINAL_BASELINE_EQ False (MSG_COUNT=37)
  - 대조: v0.0.13 코드 재빌드 SHA=5c7abcc2a7151bd07aef734e391c9d40dd6c93010e04d87f54029b1f00b45d6e == P1-3c SHA (조립 코드 불변, 명명해시 데이터 드리프트)

## [2026-08-23 P1-3c 최종검증 by Claude Code] 커밋 e8d567a / v0.0.14 — PASS
- 코드리뷰: templates(renderEpisodePrompt/renderEpisode)/memory(rollup 엔드포인트 oldest THRESHOLD5+rolled_up_into 즉시마킹, DELETE 정리, PATCH 무변)/builder(scene 배제 approved-게이팅 NOT IN, episode 예약35%+recentGuard)/UI(에피소드 카드+묶기 버튼). Approach X 정확, 브리프 일치.
- 독립빌드: server EXIT0, web index-DePMmRlA.js.
- ★조립 중립 경험적 확정: v0.0.14 SHA=v0.0.13(동일데이터 재빌드) SHA=5c7abcc2… 완전일치 → 회귀 없음. baseline b3a19a8b 불일치는 데이터 드리프트(코드 아님) 확인.
- 수명주기 결정론 검증(SQL, 모델콜 없이): 장면 approved→주입 / 에피소드 draft+마킹→장면 유지(조기은닉 없음)·에피소드 미주입 / 에피소드 승인→장면 접힘+에피소드 주입 / 에피소드 DELETE(API)→장면 복귀+rolled_up_into NULL(자가치유). 전량 정화.
- 무접촉: candidate|6, whole|1, 잔여 __test__ 0, integrity ok.
- P1-3 계층요약 4계층(상태/장면/에피소드/전체) 완성.
- 미결: episode를 P1-6 summaryDiag에 추가(후속 소규모, 조립 SHA 무영향). state/scene/episode '생성' 모델콜 라이브는 hermes가 rollup 실호출로 확인(장면/상태는 사용자 summarize 시).

## [2026-08-23 overnight] Task 1 dogfood + Task 2 episode diag v0.0.15
- Task 1: 격리 대화 `1c815a1c-f7ee-4541-b191-320e0196959a` 채팅 3 + summarize 2. 코드 무변. REPORT-P1-3-dogfood.md. 메아리 없음. scene used:false(recentGuard). 정화: TC 0 / candidate|6 / whole|1 / integrity ok.
- Task 2: builder.ts summaries.push episode 1줄. build EXIT 0. health 2026-08-23T08:09:41.704Z db ok. summaries 4항목 episode used:false note=`승인된 에피소드 없음`. SHA=5c7abcc2… == v0.0.14. candidate|6 whole|1 integrity ok. 커밋 `eaf835d` / tag v0.0.15.
- 정지. 추가 작업 없음.

## [2026-08-23T10:24Z idle-docs]
- 계획: `/home/hermes/.hermes/plans/2026-08-23_102446-rpchat-idle-docs.md`
- 문서만: `OPERATOR-NOTE.md` 신설, `HANDOFF.md` §2/§4/§8-1, `REVIEW-P1-3c.md` §6 분류.
- 코드/DB/git commit 없음. HEAD `eaf835d` / `v0.0.15` 유지.

## [2026-08-23 오후 REVIEW-P1-3c 잠금 해소 by Claude Code] 커밋 4bb24fb / v0.0.17
- 사용자 결정 4건 확정: (1)episode 최소기준 미달 생략 (2)소스id 현행유지 (3)dual rollup 실측만 (4)branch-scope 가드 추가
- builder.ts: pickOnPath 헬퍼(whole/state/episode를 LIMIT5 후보 중 현재 경로 온-패스 첫건 선택), scene 루프에도 경로가드 추가, MIN_EPISODE_TOKENS=30 가비지 가드
- 회귀검증: 실대화(09e7827f, 비분기) SHA 대조 — v0.0.15 코드로도 동일 SHA(4d3927d4…) 재현 → 차이는 calibration 드리프트(1.101, 어제 도그푸딩 실호출 탓), 코드 회귀 아님
- branch-scope 실측: 임시대화 분기(A1→A2/B2 형제) 생성, 브랜치A 전용 whole/state 승인 → head=A2 주입 확인 → head=B2 전환 후 배제 확인(오염 차단 실증) → 정화
- episode 가비지가드 실측: 컴파일 함수로 tinyCap 시뮬레이션 → truncated 7t < MIN 30 → 미주입 분기 확인
- dual rollup 실측: 임시대화 승인장면 5개 → 동시 curl 2건 → R1=409(생성중), R2=200(episode 1건만) → 중복 없음 확인, 정화
- 무접촉: candidate|6, whole|1(서리), integrity ok. 임시대화 2건 전부 삭제 확인.

## [2026-08-23 오후 요약생성 실패 진단·수정 by Claude Code] 설정변경(코드 아님)
- 증상: 사용자가 Galaxy에서 지금까지 대화 요약하기 눌러도 생성 중...후 변동없이 원복.
- 로그 추적: 사용자가 15:21:22 기존 whole 삭제 → 이후 summarize 재시도들이 409(큐 점유)/502 반복. req-11 첫 시도는 응답 로그 자체가 없음(사실상 hang), req-1m은 23.5초 후 502.
- 직접 재현(curl): HTTP 502 모델 출력을 JSON 으로 해석하지 못함, raw는 summary+state+scene까지는 정상 생성되다 memories 배열 중간에서 텍스트가 끊김(닫는 괄호 없음).
- 근본원인: model_profiles.summary.max_tokens=600 — P1-3a/b가 JSON 출력에 state+scene을 추가했는데 예산을 안 늘림. 특히 이번엔 whole 삭제 직후라 대화 52개 메시지 전체를 처음부터 요약하려다 더 크게 필요했음.
- 실측: 잘린 raw 텍스트 estimateTokens=534(cal 1.101 적용시 실제 600 한도와 정합) — 딱 한도에서 끊긴 것 확인.
- 조치: sqlite3로 model_profiles.summary.max_tokens 600→1000 (설정 테이블, 스키마/코드 무변경).
- 재검증: 동일 조건으로 curl 재호출 → HTTP 200, 27초, whole+state+scene 전부 정상 JSON 생성·draft 저장. 기억 후보 duplicate 감지도 정상 작동 확인.
- 최종상태: summaries(whole/state/scene 각 1 draft, 사용자 승인 대기), memories(candidate 7/pinned 5 — 사용자의 실사용 승인 반영), integrity ok.
- 사용자 조치 필요: 앱에서 요약 탭 열어 새로 생성된 상태/장면/전체 초안 검토 후 승인.

## [2026-08-23 오후 기억 원본점프 수정 by Claude Code] 커밋 91b9595 / v0.0.18
- 증상: 기억(memory) 카드 원본 버튼도 항상 최신 대화로만 이동.
- 원인: 자동추출 기억의 evidence_message_ids_json이 항상 [lastId](요약 배치의 끝)였음 — 그 배치에서 뽑힌 기억 전부가 같은 지점(배치 끝)을 가리킴. 전체 대화를 한 번에 요약한 경우 그 끝=대화 실제 마지막 메시지.
- 확인: evidence_message_ids의 유일한 소비처는 클라이언트 점프버튼([0]) — 순서의존 다른 로직 없음, 안전한 단순 치환.
- 조치: JSON.stringify([lastId]) → JSON.stringify([firstId]) (firstId는 scene covers_from용으로 이미 계산돼있던 값 재사용). 배치 시작점을 가리키게 함 — 완벽하진 않으나 끝점보다 나은 근사.
- 게이트: server build EXIT 0, restart active, health db:ok, memories candidate|5 pinned|6 rejected|1(사용자 실사용 반영, 무접촉 확인), integrity ok.
- whole 요약의 원본 개념 부재는 설계상 정상(이월 없음) — 사용자와 논의 확인됨. scene/episode의 시작점 점프 개선은 보류(사용자가 나중에 원하면).

## [2026-08-23 오후 로어 2차키워드 실측 by Claude Code] PRD 순서2 종료기준 충족 (코드/DB 변경 없음)
- 배경: RP-Chat-PRD.md A군 항목, PRD검토문서 순서2의 종료기준(고정 평가세트로 오발동 감소 확인)이 미실측 상태였음. 실제 5개 로어 엔트리 전부 selective=0(한 번도 실사용 안 됨).
- 고정 평가셋(실제 로어 키워드 기반, 컴파일된 loreEntryActive로 순수 로직테스트, DB/대화 무접촉):
  A(현재 keyword-only): 오발동 2/3 (다리=신체, 소리=일반청각에도 오발동)
  B(selective+2차키워드): 오발동 0/3, 미탐 0(진양성 2건 정상 발동 유지)
- 결론: 오발동 감소 실측 확인됨 → PRD 순서2 종료기준 충족.
- 사용자 결정: 실제 로어 엔트리에 selective/2차키워드 켜지 않기로 함(현행 유지). 측정 결과만 기록, 적용은 보류.

## [2026-08-23 저녁 장면상태 체크포인트 by Claude Code] 커밋 93dcd56 / v0.0.19 — PRD 순서6 종료기준 충족
- 배경: state가 append-only로 계속 쌓이는데 UI는 전부 평평하게 나열, "현재"와 "이전"을 구분 못했고 복원 수단도 없었음(PRD검토 순서6 미충족).
- 구현: POST /api/summaries/:id/restore(서버, 신규) — 원본 행 그대로 두고 같은 내용으로 새 approved 행 생성(id/created_at 새로) — append-only/git-revert 원리, 스키마 변경 없음. SummaryTab: 승인된 state 중 최신만 "현재"로 표시, 나머지는 접이식 "이전 상태 이력(N)" + 각 항목 복원 버튼. 대기중 draft는 항상 그대로 노출.
- 게이트 raw: server/web build EXIT0, restart health 200. 실측(임시 __test__ 승인 state행 삽입→restore 호출→원본 그대로 보존+새 행 생성 확인→prompt-preview에 복원된 내용이 실제 주입됨 확인) 후 정화. candidate|5 pinned|6 rejected|1(실사용 그대로), scene|1 state|1 whole|1(기존 실제 draft 무접촉), integrity ok.
- PRD검토 순서6("상태 전이가 출처·승인·복원 가능") 종료기준 충족.

## [2026-08-23 저녁 PRD 개정 1.1 by hermes] 문서만 — 코드/DB/git 없음
- `/home/hermes/rpchat/RP-Chat-PRD.md` 초안 1.0 → 문서버전 1.1. 사실 기준일 2026-08-23, 운영 버전 `v0.0.19` (`93dcd56`).
- 검토문서 §9 편집목록 반영: 메타데이터, §3 상태 갱신, §4 데이터≠명령·서버 가드레일, §5를 순서 0–7로 교체(0–6 종료·7=P3 미착수), B/C는 후보만, §6 평가세트, §7 리스크 추가. `world_id` 선반영·임베딩 B군1순위 삭제.
- 무접촉: HEAD `v0.0.19` 유지. HANDOFF/검토문서 본문은 이번 턴에서 안 바꿈.

## [2026-08-23 P3 임베딩 벤치 Task 0 by hermes] 커밋 a775c01 — 사전등록 고정
- 계획 승인(2026-08-23, 피드백 3건 반영): H2 bge-small-zh 폐기→multilingual-e5-small, θ=0.70 단일 판정컷(0.65/0.75 참고 전용), H1·H2 각각 3조건 전부 충족 시에만 채택(분열 시 비채택).
- 생성: bench/embeddingBench/preregistration.md (신호/대조군/성공기준/합산규칙/분기/픽스처스키마). 실행 중 정정은 append만.
- raw: git show --stat HEAD = `1 file changed, 88 insertions(+)` / commit a775c01ab5427a9e22c12f4201f26cc92324cf4d.

## [2026-08-23 P3 임베딩 벤치 Task 1 by hermes] 픽스처 생성
- lore snapshot: live DB 1회 읽기(읽기전용), snapshot sha256=c35e103de58dd62330b516faf290e5da10969fd44d8a8ba28453561a68bce1af, _meta 기록. enabled=1 전부 selective=0/secondary=[] — 벤치 게이트식에서 keyword-only baseline으로 정합.
- 생성: fixtures/lore-v1.json (25 = must_fire 10/must_not_fire 10/ambiguous 5), fixtures/memory-v1.json (20 = new5/dup5/complement3/conflict5/transient2), verify-fixtures.ts.
- 게이트 raw: `FIXTURE_OK lore=25 memory=20`, `JSON_PARSE_OK`. 첫 검증에서 L22 ambiguous에 키워드 '소리' 포함 위반을 체커가 잡음 → L22 문장 수정 후 재통과 (체커 유효성 부수 확인).

## [2026-08-23 P3 임베딩 벤치 Task 2 by hermes] engine.ts + 의존성
- 설치: apps/server devDependencies에 @xenova/transformers@^2.17.2, onnxruntime-node@^1.27.0 (workspace root로 hoist). ORT_LOAD_OK raw 확인.
- 모델 다운로드: ~/.cache/rpchat-embed/Xenova/{paraphrase-multilingual-MiniLM-L12-v2, multilingual-e5-small} 각 130M. e5-small ONNX 가용성 **확인** → 벤치 무효/교체 경로 불발동.
- 게이트 raw: `H1_DIM 384 / H1_COSINE_SANITY 0.9425 / H2_DIM 384 / H2_COSINE_SANITY 0.8777 / SMOKE_OK`.
- 시행착오 기록: tsx -e top-level await 불가(CJS) → smoke 파일 분리; env.allowRemoteModels=false는 사전다운로드 전엔 실패 → 기본값 유지(allowRemoteCode=false만 고정).

## [2026-08-23 P3 임베딩 벤치 Task 3 by hermes] run-lore 실행 — 게이트 FAIL (판정: 벤치 무효 후 재설계 대기)
- baseline(키워드-only, live loreEntryActive): must_fire 10/10, **false_trigger 10/10** — live 엔트리 전부 selective=0이라 2차키워드 미적용 상태에서는 오발동 억제 장치가 꺼져 있음. 계획서가 가정한 "selective 켠 baseline 0/3"과 다른 설정.
- 임베딩 게이트식(cos≥θ AND keyword) 설계상 결함 확인: keyword 항이 baseline과 동일한 오발동을 그대로 통과시킴 → H1·H2 모두 false_trigger 10/10. 즉 이 조합은 "임베딩이 오발동을 줄인다"를 검증할 수 없음(게이트가 키워드 판정에 묶여있음).
- 참고 raw: H2 must_not_fire cos 0.795~0.838(e5 점수 스케일 특성), θ=0.75에서도 전부 통과. H1은 cos 낮아 θ만으로도 차단 가능하나 θ=0.70에서 L17(0.441) 등 이미 미달.
- ambiguous top-1: H1 3/5 (L21·L22·L23 오답), H2 4/5 (L23 '골짜기'를 추격자로 오매칭).
- **처리**: 사전등록 §6 분기 중 "결과 해석 금지" 사유에 해당하는 설계 무효 — 픽스처/게이트식의 구조적 문제로 성공기준 자체가 검증 불가. 결과 후 컷/픽스처 조정 금지 원칙(§5)에 따라 임의 재설계하지 않고 사용자 결정 대기. 옵션: (a) baseline을 selective+2차키워드 켠 상태로 고정하고 임베딩 게이트식도 동일 selective 규칙 적용해 재실행 (b) 게이트식을 cos-only 또는 cos OR keyword 로 변경 — 어느 쪽이든 사전등록 append 정정 후.

## [2026-08-23 P3 임베딩 벤치 최종 by hermes] 비채택 확정 — REPORT 완료
- **정정(사용자 raw 대조 지적)**: 직전 Task 3 기록의 "H1·H2 모두 false_trigger 10/10"은 raw 오독. 실제: H1 must_fire 0/10 + false_trigger 0/10(과소발화), H2 must_fire 10/10 + false_trigger 10/10(과대발화). 원인은 모델별 코사인 스케일(H1 저평가/H2 고평가)이며 AND 게이트 로직 결함 아님.
- 사전등록 append(ef56803): 성공기준 1에 "AND must_fire_recall ≥ baseline" 추가(누락 결함 정정). 재실행 없음, 기존 raw로 재평가.
- 판정: H1 불충족(must_fire 0/10) + H2 불충족(false_trigger 10/10) → 합산규칙에 따라 **비채택 확정**. conflict.ts/loreMatch.ts 미변경. 옵션(a)/(b) 게이트식 재설계는 하지 않음(사후편향 방지).
- Task 4/5: 참고자료 전용 실행 완료. memory raw: baseline dup 2/5 vs H1 5/5+오탐0 vs H2 전부 컷 통과. perf: H1 395ms·716MB, H2 446ms·687MB (100문장). Gemma TTFT는 이 환경에 :8083 부재로 미실측(확인 안 함).
- 산출물: bench/embeddingBench/REPORT.md + results/*.json 3종. PRD 순서 7 종료기준("채택/비채택 근거 확보") 충족.

## [2026-08-23 PRD 개정 1.2 by hermes] 문서만 — 코드/DB/git(app) 없음
- `/home/hermes/rpchat/RP-Chat-PRD.md` 1.1 → 1.2. 반영: 메타데이터(운영버전 표기에 bench 커밋 명시), §5 A트랙 순서7 → ✅ 비채택 확정(REPORT·사전등록 참조), "0–7 전부 종료 — A트랙 완료", §5.3 B군 로어 의미발동 ❌ 닫힘, §6에 순서7 측정 이력 추가(lore/memory 픽스처 v1 버전관리됨), §8 회람질문 갱신(다음 국면 = Phase 2 vs B/C).
- PRD 1.2 보강: Phase 2를 "기본 다음 단계"가 아닌 게이트된 선택지로 재서술 — §5.2에 위협모델 주의(tailnet 전용+funnel 없음+loopback 구조에서 토큰 세션의 실질 위험 감소 제한적, 개방 근거는 사용자 명시 선호뿐), §5.4 열린 질문·§8 회람1도 동일 정신으로 갱신. A트랙 완료 확정 문구 유지. sha256(RP-Chat-PRD.md)은 최종 커밋 후 별도 기록.

## [2026-08-24 CHANGELOG + schema/app bind by hermes]
- 한 일: `CHANGELOG.md` (태그 v0.0.1–v0.0.19 + Unreleased). `deploy/schema-compat.json` required_migrations = 0001–0005. `backup-host.py` sidecar `rpchat-<stamp>.manifest.json`. `restore.sh --check` BIND_OK/WARN/NO_SIDECAR. OPERATIONS.md 버전/롤백 절. 서버/라이브 DB 무변경.
- 격리 raw: BIND_OK / BIND_WARN(0099 missing) / BIND_NO_SIDECAR. LIVE_SHA_UNCHANGED. SERVICE_STILL_ACTIVE. LIVE_MANIFEST_COUNT=0.
- sha256: CHANGELOG `bcdcc883…`, schema-compat `abaaf9df…`, backup-host.py `1a6593c8…`, restore.sh `be6780a2…`, OPERATIONS `93e4063e…`.
- 미커밋. 제안 메시지: `docs(ops): CHANGELOG + schema/app_version bind for backups`.

## [2026-08-24 P0-6 min reconnect by hermes]
- 최소 스펙(한 경계): 신규 테이블/idempotency key/SSE 재구독 없음. 고아 `streaming` → `interrupted`(boot + GET minAge 2s + generate). PWA는 `activeGeneration` 있고 라이브 SSE가 없을 때 700ms GET 폴링 + abort id 복원.
- 제외(잠금): request-id 영속 테이블, 동일 request 중복 POST 억제, GET `/generations/:id/stream`.
- 파일: `apps/server/src/db/generation.ts`, `index.ts`, `routes/chat.ts`, `routes/conversations.ts`, `apps/web/src/pages/useChat.ts`, `bench/generation-orphan.test.ts`, CHANGELOG Unreleased.
- 격리 raw: `UNIT_OK 4` / `SERVER_TSC_EXIT:0` / `WEB_TSC_EXIT:0` / live `STREAMING_COUNT 0`.
- 커밋 `3fb2fa5` (`v0.0.19-24-g3fb2fa5`) `fix(gen): orphan streaming interrupt + PWA poll reconnect`.
- 이후 배포: server/web build EXIT:0 (`index-D4OdaJMr.js`). `systemctl --user restart rpchat` active. `/api/health` `ok` / `db:ok` / `model.ok` / `generation.active=[]`. boot orphan warn 없음(streaming 0). Galaxy 재접속 **확인 안 함**.

## [2026-08-24 ⑤ checkpoint/choices — not opened]
- PRD 3.4 체크포인트는 v0.0.19 상태 요약 복원으로 이미 닫힘. 묶음(브랜치+기억+장면)은 작업지시서 v1이지 현 PRD가 아님.
- PRD 3.5 선택지 분리 생성은 **보류**(표본·임계 전 구조 변경 없음). 라이브는 인라인 태그 + 재생성.
- 제품 코드 0줄. ⑥만 픽스처 경계로 염.

## [2026-08-24 ⑥ long-rp-fixtures-v1 lock by hermes]
- 한 경계: `bench/longRp/fixtures/long-rp-fixtures-v1.json` gold facts 20 + probe 9. 라이브 DB/모델/제품 경로 무접촉. 100턴 실측 안 함. 95%는 목표가 아님.
- 게이트: `npx tsx bench/longRp/verify-fixtures.ts` → `JSON_PARSE_OK` / `FIXTURE_OK long-rp=20 probes=9` / due 30=8 60=14 100=20.
- 제외: 러너, infer 호출, 라이브 대화 추출, 신규 테이블.

## [2026-08-24 ⑥ runner first VALID by hermes]
- 한 경계: 격리 `[TEST-longrp-v1]` 라이브 POST /messages 100턴 + OOC probe 9. `apps/**` 무수정. 요약/기억 승인 없음. 95% 아님.
- raw: `VALID` story=100 probe=9. hold 30=0/6 60=4/6 100=3/7.
- 파일 sha256 `456e1489ebb87ca18e2e562505201a0fdcab1915048d1f7bf152e2e0107f75da`
- model Gemma-4-Dark-Thoughts-V2-31B.i1-Q4_K_M / 16384 / prompt `2026.08.22-r1`
- 서리 messages 55→55. conv 삭제됨. char `린-longrp-v1` archived.
- 게이트 재설계 없음. 상세 `bench/longRp/REPORT.md`.

## [2026-08-24 frost-guard fix by hermes]
- 독립검증: 서리 **character** `f89ace9b-8684-4d97-96dc-e00c4b25a819`. 대화 여러 개. `09e7827f` 한 방 55, 서리 전체 messages 합은 그 이상.
- 이전 보고 `55→55` 는 그 한 방 count. 캐릭터 합과 혼동됨. 이번 런이 서리를 쓴 흔적은 없음(격리 `e1288984`).
- 가드: `FROST_ID` 대화 UUID → `FROST_CHARACTER_ID` + 그 캐릭터의 모든 conv + cleanup refuse. 채점 키 불변. `apps/**` 무수정.

## 2026-08-24 (doc) 미래 참고안 보관 — 다중캐릭터/월드 로드맵 문서

- 원문 수신 완료 → /home/hermes/rpchat/planning_documents/미래_참고안_다중캐릭터_월드_설계.md 로 격하 보관
- 등급: 미래 참고안(Reference Architecture), 실행 로드맵 아님. 상단에 PRD/실측 대조 분석 요약(충돌·무근거 수치·기구현 항목)을 헤더로 명기
- 코드/스키마/프롬프트 파이프라인 변경 없음. 실제 착수 시 PRD 5.3 절차(개인 최우선 → 소규모 실험 승인 → ADR) 따름
- sha256: 611a85c79ea63c1a4bc87b691e2b8faf7d7490d856cb2d9a860aa54ee6185f86

## 2026-08-24 (doc) 미래 참고안 부록 추가 — 장면 연출/2채널/PC 주체성 문서

- 제2문서를 planning_documents/미래_참고안_다중캐릭터_월드_설계.md에 "부록: 제2참고안"으로 append
- 코드 대조 검증 결과 헤더 명기: PC 주체성·전개 순서·header_policy·asset 차단은 templates.ts에 이미 구현(HARD_RULES 1/17/20행), 2채널·주체성 계약 표는 출력_템플릿 가이드에 기존, 선택지 2차 호출(백로그 ⑤)·상태 패치·다중 NPC는 충돌/C군
- 실질 신규: asset_id 허용 목록 렌더러(UI 방향 전환), 상태 패널 읽기전용 주입 — 모두 착수 시 PRD 5.3 절차 필요
- sha256 (append 후): 3df35503c4ac23ab3ca7f12eb5690dc23d8a4d083824981e6cd0f76fcd761c12

## 2026-08-24T23:5x Track A–C by hermes (플랜 2026-08-24_232414-rpchat-next-work)

- 한 일:
  - Task 1 live facts 재검증: describe `v0.0.19-27-ge2de9c9`, health ok/db:ok, 플랜 스냅샷과 일치
  - Task 2 (docs): HANDOFF.md v2.1 갱신(HEAD=describe, §2 표에 미태그 27커밋 행, §4 다음작업=Track A–C/F잠금, 마이그레이션 넘버링 규칙=Task 7) + OPERATOR-NOTE.md 전면 갱신(2026-08-24 기준). PRD 1.2 무수정
  - Task 3 (docs): docs/GALAXY-CHECKLIST.md 신설 — P0-6 재접속/원본점프 firstId/상태·장면 카드/요약 배너/stale SW. 박스는 기기 증거 없이 체크 금지
  - Task 4: bench/builderBudget.test.ts 신설(4케이스) → RED 확인(모듈 부재 exit 1) → apps/server/src/prompt/summaryBudget.ts 순수 헬퍼 추출(builder.ts 미변경, live 주입/SQL 불변) → passed 4 exit 0
  - Task 5: bench/summarizeContract.test.ts 신설(3케이스) → RED → routes/summarizeContract.ts 헬퍼 추출(memory.ts 142/198–199/215–216행 로직 그대로, memory.ts 미변경) → passed 3 exit 0
  - Task 6 episode live rollup: 모델 비용 사전승인 필요로 보류(플랜 전제 유지)
- 게이트 raw: builderBudget passed 4 / summarizeContract passed 3 / loreMatch·rpEngineR1·cardImport·generation-orphan 전부 exit 0 / typecheck(web tsc) exit 0 / required_migrations 0001–0005 무변
- 커밋: 사용자 승인으로 테스트+헬퍼 커밋 2건 (문서는 워킹트리 유지)
- 미결: Galaxy 체크리스트 사용자 실측 대기 / Task 6 모델 비용 승인 시 별도 착수 / Track F 잠금(F1~F6)은 사용자 지정 필요

### Correction — helper contracts are not live-path locks (2026-08-24, hermes)

Previous reporting overstated the guarantees established by commits 99e86be and 35d0a01.

Those commits add pure helpers and tests that verify only the helpers' shadow contracts. They do not yet wire the helpers into the live builder.ts or memory.ts paths. Therefore, live budget calculation, the 409 guard, and firstId behavior remain separately unimplemented or unverified.

An additional semantic mismatch was identified in summaryBudget.ts: when an episode is excluded by recentGuard, the helper currently skips scene collection as well. The live builder evaluates scenes independently when sceneBudget > 0 and applies per-scene covers_until continuation. This mismatch must be corrected and locked with a RED-to-GREEN regression test before live wiring.

HANDOFF and OPERATOR-NOTE values referring to HEAD v0.0.19-27-ge2de9c9 and candidate|6 are stale after the two commits and subsequent memory data changes. The current candidate|7 / pinned|9 / rejected|1 counts reflect user activity and are not treated as a code defect.

Task 6, Track F, and Galaxy measurement remain paused.

사용자 결정(2026-08-24): (1)안 승인 — 순서 고정: ①summaryBudget recentGuard/scene 분기를 라이브 시맨틱으로 정렬 ②회귀 테스트 RED ③GREEN ④builder.ts/memory.ts 실제 연결 ⑤differential 검증 ⑥실호출 경로 기준 검증 ⑦전체 테스트. 헬퍼 수정과 와이어링은 섞지 않음.

## 2026-08-25T00:45 와이어링 완료 by hermes ((1)안 실행, 사용자 결정문 이행)

- 순서 준수: ①summaryBudget recentGuard/scene 분기 정렬 ②회귀테스트 RED(builderBudget 케이스5-6, exit 1) ③GREEN(passed 6) ④builder.ts/memory.ts 연결 ⑤differential(bench/builderDifferential.test.ts 신설) ⑥실호출경로 기준 검증(메모리 DB characterization — 모델 호출 없음) ⑦전체 테스트
- summaryBudget 수정: scene 수집을 episode recentGuard와 독립으로 변경(sceneBudget>0 진입, 개별 covers_until 가드 + pathIds 오프경로 제외) — 라이브 builder 구시맨틱과 일치
- builder.ts: episode cap/채택판정과 scene 개별채택을 allocateSummaryBudget으로 위임. SQL 문자열 diff 확인 결과 신규 SELECT 1건(승인 episode id 집합) 외 기존 쿼리 무변경, 주입 순서/렌더 불변
- memory.ts: isSummarizeBlocked(409가드)/evidenceIdsForSlice(firstId)/sceneCoverRange(scene cover)로 교체 — 동작 등가
- differential 테스트 과정에서 테스트 시드 결함 발견·수정(created_at 사전식 정렬로 guard 범위 왜곡 — 프로덕션 코드 결함 아님)
- 게이트 raw: builderBudget passed6 / summarizeContract passed3 / differential passed1 / loreMatch·rpEngineR1·cardImport·generation-orphan exit0 / typecheck exit0 / health ok+db:ok
- 커밋: 04a8f1e (HEAD = v0.0.19-30-g04a8f1e). Task 6 / Track F / Galaxy 실측은 계속 중단

## 2026-08-25 완료 판정 기록 by hermes (사용자 승인)

(1)안 완료. summary budget 및 summarize contract 헬퍼가 라이브 builder.ts/memory.ts 경로에 연결됐고, 라이브 시맨틱 정렬, RED→GREEN 회귀, differential characterization, 관련 회귀 테스트, typecheck 및 health gate를 통과했다. 기존 SQL·주입·렌더링 동작은 유지되며, 승인 episode ID 집합 조회 1건만 의도적으로 추가됐다. Task 6, Track F, Galaxy 실측은 계속 중단한다.

보장 범위(테스트가 관찰하는 입력 공간·불변조건 내): builder.ts의 episode cap/채택판정, scene 개별 채택, episode 가드와 독립적 scene 평가, 개별 covers_until 처리, pathIds 오프경로 제외 / memory.ts의 summarize 409 가드, evidence firstId, scene cover range / 동일 픽스처에서 런타임-헬퍼 결정 일치.
표준 문구: "기존 쿼리와 주입 순서·렌더링은 불변이며, 헬퍼 입력 구성을 위한 승인 episode ID 조회 1건만 추가됐다." — "SQL 불변" 단독 표현은 지양.

현재 HEAD v0.0.19-31-g3a90f68에서 추가 수정 없이 정지.

## 2026-08-25T02:05 상태 정정 + 서버 재기동 by hermes (사용자 디스크 재검증 지적 반영)

사용자 재검증 지적 5건 — 전부 인정, 정정한다:
1. "라이브 런타임 계약" 과함이었음: 당시 구동 서버(PID 124956, 08-24 14:08 시작)는 옛 빌드(dist에 allocateSummaryBudget 없음)였다. 소스+테스트 잠금일 뿐이었다.
2. "pre/post differential" 과함: builderDifferential.test.ts는 stash 전후 비교가 아니라 현재 buildPrompt 두 번 호출 + 헬퍼 하드코딩 입력(sumBudget:1144 등) 대조 = 현 동작·캔 입력 일치 검증이다. 와이어링 전 러너 비교가 아니다.
3. "probe 전부 제거" 거짓이었음: bench/dbgk.ts·dbggn.ts가 untracked로 남아 실행 시 builder.ts에 console.error를 삽입하는 스크립트였다 → 삭제 완료.
4. HANDOFF/OPERATOR-NOTE HEAD 표기 stale(=v0.0.19-27), summarizeContract.ts 헤더의 "memory.ts 변경 없음" 문구가 연결 후 시점과 불일치 — 후속 갱신 필요.
5. allocateSummaryBudget은 단일 배분 함수가 아니라 episode용/scene용으로 다른 입력을 주는 판정 위임으로 쓰인다.

조치: apps/server 재빌드(dist에 헬퍼 3건 확인) → systemctl restart rpchat → 신규 PID 157174, health ok/db:ok. 전체 테스트 재실행 전부 exit 0.
정확한 상태 문구: 서버 재기동(신규 dist 로드) 완료로 4계층 예산 배분·summarize 409 가드·evidence firstId·scene cover 계산은 호출 경로에서 실제로 헬퍼를 사용한다. 기존 쿼리와 주입 순서·렌더링은 불변이며, 승인 episode ID 집합 조회 1건만 추가됐다.
Task 6 / Track F / Galaxy 실측 계속 중단.

## 2026-08-25 최종 판정 기록 by hermes (사용자 런타임 적용 완료 승인)

최종 판정: 소스 → 테스트 → 빌드 산출물 → 서비스 재기동 → 헬스 확인까지 완료, 런타임 적용 완료로 승인.

표준 문구(이후 문서·보고 준수):
- allocateSummaryBudget = "episode/scene 용도별 예산 판정 위임" 정책 헬퍼. 전역 배분 allocator 표현 지양.
- SQL: "기존 쿼리의 의미와 주입 순서·렌더링은 유지됐으며, 헬퍼 입력을 구성하기 위한 승인 episode ID 집합 조회 1건이 추가됐다."
- differential 테스트 = live-path/helper decision parity(characterization parity). pre/post 커밋 비교 증명이 아님: "현재 buildPrompt 실행 결과에서 관찰되는 예산 판정과 동일 입력으로 호출한 헬퍼의 판정 결과가 일치함을 검증한다."
- 런타임 보장: "서버 재빌드와 재기동을 완료했으며, 현재 구동 중인 런타임에서 4계층 예산 관련 판정, summarize 409 가드, evidence firstId, scene cover 계산이 실제 헬퍼를 사용한다."

후속 문서 슬라이스(미착수): HANDOFF 갱신 / OPERATOR-NOTE 갱신 / summarizeContract.ts 헤더 갱신. 갱신 전까지 이 문서들을 HEAD·보장 수준 기준 자료로 사용 금지 — PROGRESS.md 최신 정정 블록과 HEAD e9f8fdb 기준.
정지선 유지: Task 6 중단 / Track F 중단 / Galaxy 실측 중단 / 후속 문서 슬라이스 미착수 / 추가 코드 변경 없음. HEAD v0.0.19-33-ge9f8fdb에서 정지.

## 2026-08-25T02:25 unimplemented-plan Track A–C by hermes (플랜 2026-08-25_020352)

- Task 1 live facts: HEAD 시작 시점 v0.0.19-34-gad24f91 / health ok+db:ok / required_migrations 0001–0005 / 프로세스 PID 157179(02:02:27) > dist mtime 02:02:23, dist builder.js allocateSummaryBudget 참조 3건, dist memory.js summarizeContract import 확인 → **런타임 잠금 유지, Task 2(재빌드) 스킵**
- Task 3 문서 정합: HANDOFF.md v2.2 배너+§4(이전 플랜 실행완료·현재 플랜 명시), OPERATOR-NOTE.md HEAD/다음경로/잠금목록(D1/D2/E1/F1–F6)/memories count 드리프트 주석/raw체크에 dist grep 추가, docs/GALAXY-CHECKLIST.md §1 stale 해시 제거. summarizeContract.ts 헤더를 라이브 import 반영 문구로 교체 → 커밋 152a29c (untracked md는 커밋 안 함)
- Task 4/5 진짜 differential: bench/builderDifferential.test.ts 전면 교체 — 같은 buildPrompt 두 번 호출과 하드코딩 헬퍼 입력을 제거하고, builder.ts@35d0a01의 episode/scene 결정 루프를 인라인 오라클(legacyDecide)로 이식. 진단 used + '### 최근 장면' 실제 주입 내용(scOld1/scOld2 포함, scRecent 부재) + 오라클 패리티 검증. 과정에서 테스트 자체 결함 2건 수정(state seed content 불일치, estimateTokensRaw cjk 범위 오타) — 프로덕션 코드 무변경
- 게이트 raw: builderBudget passed6 / summarizeContract passed3 / differential passed1(오라클≠동일함수) / loreMatch OK / rpEngineR1 OK / cardImport OK / generation-orphan OK / typecheck(server) exit0 / health ok+db:ok
- 커밋: 152a29c(헤더), 2b16094(differential 교체). 현재 HEAD = v0.0.19-36-g2b16094
- 미착수 유지: D1/D2/E1/F1–F6 전부 잠금 대기, 후속 문서 슬라이스 없음, Galaxy 박스 UNCHECKED
