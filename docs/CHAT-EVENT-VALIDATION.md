# ChatEvent 계약 검증

BASE: `2bfc555968dc270549041e8ff9c97f92a5fd2bd4`. 작업 대상은 별도 로컬 checkout이다. 운영 서버 변경, live DB 쓰기, 스키마 migration은 하지 않았다.

## 재현과 수정

1. BASE를 별도 디렉터리에 빌드하고 임시 DB·캐릭터·모의 모델로 실행했다. 1:1 응답의 `<think>INTERNAL_FIXTURE</think>`가 생성 중 및 완료 후 실제 브라우저에 노출됐다. 변경 후에는 내부 표식이 표시되지 않고 대사·서술이 구분된다.
2. 브라우저에서 재생성하면 이전 응답과 새 응답이 함께 남는 문제를 확인했다. 새 start/aux의 parent를 기준으로 활성 경로를 선택하게 수정했다. 재생성 직후 이전 표시가 교체되며, 완료 후 응답은 1개이고 이전 응답은 sibling 선택으로 남는다.
3. 생성 중 페이지를 새로고침해도 생성이 서버에서 계속되고 최종 응답을 다시 읽는 것을 확인했다. 명시적 중단 시에는 `(중단됨)`과 재생성 버튼이 표시된다.
4. 모의 모델 실패 시 입력이 복원되고 미확정 user 행이 철회된다. 재조회가 오류 안내까지 지워 버리는 문제를 보완하고 실제 runStream 콜백 검사와 최종 빌드의 브라우저 화면에서 오류 안내가 유지되는 것을 확인했다.
5. 독립 검토로 느린 GET 응답보다 빠른 폴링이 모든 응답을 stale 처리하는 문제를 재현했다. 다음 polling 요청은 이전 요청 완료 후 예약한다.
6. 독립 검토로 dialog의 완성된 줄이 스트리밍 때와 최종 저장 후 다르게 분류되는 반례를 확인했다. 스트림과 완료 경로가 같은 script parser와 line 변환을 사용하게 했다.
7. `meta_json`이 JSON null/배열/숫자/문자열인 레거시 행의 조회 오류를 재현하고 object 정규화를 추가했다. 원래 행은 수정하지 않는다.
8. 중단된 dialog script 행의 block_kind가 아직 없을 때 1:1로 오인하는 재생성 경계를 보완했다. 이미 출력한 INFO를 남기지 않고 해당 다중 행 턴 전체를 교체한다.

## 실행 방법

Node 22 이상과 workspace 의존성이 필요하다. 이번 검증은 공식 Node 22.16.0으로 실행했다.

```sh
npm run test:chat-events
npm run typecheck
npm run build
TSX_TSCONFIG_PATH=apps/web/tsconfig.json RPCHAT_PROMPT_DUMP=0 RPCHAT_REQUEST_DUMP=0 node --import tsx bench/partyBeatPersist.test.ts
python3 bench/chatEventUiFixture.py "$PWD" /tmp/rpchat-event-ui
```

마지막 명령은 빌드된 앱·모의 모델을 loopback에서 기동하고 state.json에 URL을 기록한다. DB는 임시 디렉터리에 기록하며 종료 시 삭제한다. 지정한 출력 디렉터리의 state.json과 server.log는 검증 기록으로 남는다. fixture 시작/종료로 운영 서비스에는 영향을 주지 않는다.

## 실행 결과

2026-09-22, 34개 bench의 419개 항목, 타입 검사, 서버·웹 빌드, `git diff --check` 통과. 핵심 신규 검증은 39개다. 모든 DB·모델 호출은 임시 DB와 모의 모델을 사용했다.

| bench | 통과 항목 |
| --- | ---: |
| chatEventContract / chatEventStream / chatEventReconnect | 21 / 15 / 3 |
| dialogScript / dialogPersist / partyBeatPersist | 24 / 17 / 11 |
| partyGenerationLifecycle / branchFailureHeadRestore / failSendUserPersist | 10 / 6 / 6 |
| activeGenerationDeleteGuard / sceneBranchSnapshot / sceneCommitOnSuccess | 12 / 24 / 12 |
| regenerateTurnBoundary / dialogBeatContract / beatByteBaseline | 15 / 7 / 14 |
| readablePreview / sanitizeNarration / leakChoicesDisplay / leakChoicesUi | 11 / 12 / 17 / 13 |
| oocFuelStrip / injectMacro1to1 / injectMacroParty | 10 / 8 / 16 |
| injectMacroApi / injectMacroClient / emptyUserTurn / composerRecovery | 12 / 14 / 19 / 13 |
| settingsRegression / partyRender / partyTurnWeb / beatRenderWeb | 6 / 12 / 7 / 19 |
| rpReadabilityR1 / sceneStatusPanelCatalog / chatLayout / shortcutHub | 13 / 8 / 4 / 8 |

표의 각 bench는 `TSX_TSCONFIG_PATH=apps/web/tsconfig.json RPCHAT_PROMPT_DUMP=0 RPCHAT_REQUEST_DUMP=0 node --import tsx bench/<이름>.test.ts`로 실행했다. `shortcutHub`에는 `--no-browser`를 지정했다. 이 bench의 선택적 390px Chrome geometry 검사는 실행하지 않았으며 8개 core 검사만 합계에 포함했다. 과거 단축어 작업의 일회성 “서버 전체 무변경” 단언은 이번 서버 리팩터링의 동작 검사가 아니므로 제거했다.

## 검증 범위

핵심 계약 fixture는 대사만, 서술만, 혼합 출력, 다중 캐릭터, 알 수 없는 화자, 중복 표시 이름, 잘못된 모델 출력, 레거시 행, 스트림 중단, 세션 재개를 포함한다. 실제 Fastify 경로와 SQLite를 사용해 저장/SSE/GET/React 렌더를 비교한다. DB를 닫고 다시 열어 재접속을 검증하고, 메시지 편집·북마크·이름 변경·실패 철회·재생성도 검사한다.

기존 파티 생성, 장면 스냅샷, 재생성 경계, choices, 단축어, 실패 입력 복구, 레이아웃 관련 bench를 함께 실행했다. 과거 렌더 함수의 이름이나 전체 파일 무변경을 검사하던 단언은 새 이벤트 렌더의 실제 동작 검사로 교체했다. `sceneCommitOnSuccess`의 실패 경로 기대값은 BASE에서도 실패함을 별도 사본에서 확인한 후, 실패한 턴 철회 시 기존 활성 경로가 그대로 유지되는 계약으로 수정했다.

사용하지 않는 웹 파서 5개는 삭제 대신 `bench/legacy/`로 옮겨 과거 호환 비교에만 사용한다. production 웹 번들은 이 코드들을 import하지 않는다.

## 한계

실모델의 한국어 출력 품질, 사용자 Galaxy 기기의 화면, 크랙 로그인 후 내부 동작은 검증하지 않았다. 기존 생성 정책·프롬프트 템플릿을 유지하고 focused beat의 byte 기준선 14개를 통과했다. 새 content의 thought 정제로 이후 모델에 전달되는 대화 이력은 달라질 수 있다. 전체 HTTP 요청의 exactly-once 보장이나 전체 레거시 DB 변환을 구현했다고 주장하지 않는다. merge와 운영 배포는 별도 단계다.
