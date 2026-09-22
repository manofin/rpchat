# 벤치 복구 검증 — 2026-09-22

최종 BASE `7a48f448cc4a6978a318c2fff5931f9cfdd09292`, 검증한 코드 커밋 `bebf62a5b5178e9b178dd38f7a8c8321a9a233a7`, Node v22.16.0. 최초 재현 기준은 `aad9268`이다. 작업 중 PR #41–43이 upstream에 병합되어 재배치한 뒤 전체 검증을 다시 실행했다. Tailscale fixture 수정은 #43에 이미 반영되어 이 PR의 중복 diff에서 빠졌다.

제품 소스·packages·migration을 변경하지 않고, 최신 제품 계약과 맞지 않던 fixture 및 과거 구현 형태에 묶인 검사를 복구했다. `settingsRegression.test.ts` 전체 파일은 BASE와 동일하고, 원본 서버 청결 fence 블록은 `2bfc555`와 바이트 동일하다.

## 재현과 수정

| 벤치 | 수정 전 재현 | 유지·보강한 검증 |
|---|---|---|
| budgetKind, builderDifferential, personaResolve, storyInjectBuild, storyOpening, summaryWatermarkCompaction, userNoteInject | 수동 메모리 DB에 `rel_character_id` 누락 | 실제 0022 SQL을 메모리 fixture에 적용. 기존 budget·persona·주입 단언 유지 |
| tailscaleIngress | migration을 하지 않는 `openDb`로 fixture를 생성하여 테이블 누락 | `openMigratedDb`로 임시 DB를 명시 초기화; 인증 계약 유지 |
| discoveryWeb | 과거 navigation label 고정 | 실제 NAV_TABS와 route 매칭 검사; 누락·중복·금지 route 반례 |
| episodeRelationWrite | 이미 승인된 relation builder 변경을 과거 파일 해시로 거절 | draft/approved/rejected 주입 제어, 관계 stamp, 외부 장면 입력 제외, transaction rollback |
| characterChatWebGuards | catch 변수명 및 과거 send 호출 인자 형태 고정 | 실제 전송 callback의 중복 POST 차단·실패 복구·재시도·composer/choice/inject body |
| characterPlayGuide | 0021이 항상 마지막 migration이라고 가정 | 0021 번호 유일성·ALTER 유지, 전체 migration 후 실제 DB 제약·NULL 거절 |
| contextInspectorEntry | drawer 열기 호출 4개 고정; 장면 진입점 추가 뒤 실패 | 기존 진입점과 새 장면 진입점의 실제 tab/open callback, 잘못된 tab/open 반례 |
| shellRoomsNav | label helper로 이동한 story 이름을 페이지 소스에서 직접 요구 | 실제 ChatsPage 함수 SSR, label·중복 방지·preview·클릭/Enter/Escape 경로 |
| storyPeerCastFocus | planner로 이동한 필드 전달을 composeBeat 내부 문자열로 요구 | 실제 planBeat 결과의 story/1:1 fallback·snapshot 화자 경계 |
| storyEndingConditions | unrelated 0021 migration이 없어야 한다고 가정 | 조건의 endings_json 저장과 별도 조건 schema 없음, 기존 API roundtrip |
| characterPromptPreview, storyEndingConditionsUi | 특정 호스트의 ast-grep/tgrep 부재 | 설치된 TypeScript AST 사용, 주석·문자열·중첩·raw pass-through 반례 |
| characterEditorTabs | ast-grep 실패를 매칭 0개로 처리하여 잘못 통과 | 외부 CLI 의존성 제거, 실제 JSX와 decoy 구분 |

위 앞부분의 공통 실패 16개와 Mac에서 추가 확인한 CLI 의존 실패 2개를 재현했다. 과거 사용자 검증의 원본 로그는 확보하지 못했으므로 이전의 “16개” 목록과 동일하다고 주장하지 않는다. 이번 결과는 파일별 명단을 보존한다.

`builderDifferential`은 스키마 문제 뒤에 가려졌던 oracle 불일치도 수정했다. 상태 지침의 실제 토큰 비용과 fixture 장면 본문·정렬을 반영하고, 비동기 검사가 끝나기 전에 성공을 출력하던 문제를 제거했다. 상태 지침·recent guard·await 후 실패 반례를 검출했다.

`explicitMigrationLifecycle`의 운영 DATA_DIR 문자열은 임시 센티널로 교체했다. 모든 CLI 호출 후 센티널 디렉터리가 비어 있음을 검사한다. `episodeRelationBuild`의 관찰 보고서는 추적 파일 대신 별도 artifact로 기록한다.

## 최종 실행

| 검사 | 결과 |
|---|---|
| 독립 `npm run test:benches` | 발견 172 / 통과 **169** / 실패 **0** / 명시 제외 3 / 미실행 대기 0 |
| 성공 결과행 | **2095** — `ok N` / `ok - N` 그룹 수, 개별 assert 수 아님 |
| 별도 checkout `characterAssetsWrite --allow-source-mutation` | 13개 그룹 통과, 실제 mutation 실행, 대상 소스의 전후 SHA 동일 |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `git diff --check` | exit 0 |
| 원본 settingsRegression | 6개 그룹 통과, fence 바이트 동일 |

따라서 **172개 중 170개 파일을 실행하여 통과**했다. `settingsViewport`의 전용 브라우저 검사와 `partyTurnLiveRo`의 특정 개인 DB fixture 검사는 수행하지 않았다. `fixMobileClip`·`shortcutHub`의 선택적 브라우저 geometry 부분도 미실행이다. UI callback/SSR 검사를 실제 Galaxy 기기·키보드·PWA 검증으로 간주하지 않는다.

실행기는 별도 임시 harness에서 정상·실패·timeout·중단·손자 프로세스 종료·명시 제외 대상 거절·mutation 원복/미원복을 검증했다. runtime 환경은 임시 DB와 비활성 loopback 모델을 사용한다. 라이브 데이터·실모델 생성은 사용하지 않았다.

전체 파일 목록과 상태는 [검증 JSON](BENCH-HEALTH-VALIDATION.json), 재현 명령과 제외 정책은 [TESTING.md](TESTING.md)에 있다. 배포·병합은 이 벤치 수정의 검증 범위가 아니다.
