# 배포 준비 수정·검증 기록 — 2026-09-21

## 판정

기준 `f3881351126f5e81205e4af67d039c787f72e343`에 작업 트리 수정을 적용했고, 보고된 세 항목의 회귀 검사와 격리 빌드 기동 검증을 통과했다.
수정된 작업 트리는 배포 후보로 검토할 수 있다. **기존 master 커밋 자체를 수정 완료·배포 승인 상태로 판정하지 않는다.**
커밋·PR·merge·push·실제 배포·라이브 재시작·라이브 DB 접근은 수행하지 않았다.
Chloe 독립 검증과 Easton 실제 UI QA는 수행하지 않았다. 이 문서는 구현자의 검증 기록이다.
라이브 환경·데이터 상태는 이번 검증 범위 밖이며, 실제 배포는 별도 사람 게이트를 거친다.

## 작업 경계

- BASE: `f3881351126f5e81205e4af67d039c787f72e343`.
- 사용자 지시: “배포 가능하도록 정리, 수정해주십시오.”에 따른 소스 수정·검증.
- 관심사: `GenerationFailureCleanup`, `SQLiteNoMutationInspection`, `TailscaleTokenRegression`.
- LIVE_NO_TOUCH: 테스트 DB·포트·모델·빌드는 격리 fixture만 사용.
- 비범위: 배포, 인프라·인증 정책 변경, 실데이터 복구/migration, 전역 스킬 설치, OPS 승인 규칙 개편.
- 기준 구분: `2eded3415ef94d0bcd7eff11e817edfee32f2eff` 단독 브랜치 결과는 현재 통합 코드의 미구현 증거로 사용하지 않는다.

## 수정과 실패 전후 증거

### 1. 생성 실패 정리

대상: `apps/server/src/routes/chat.ts`, beat/dialog 생성 함수의 SSE 시작 전 바깥쪽 catch.

통합 BASE는 이미 finally에서 활성 생성을 해제했다. 따라서 구버전의 “active=1 잔류”를 이번 BASE의 결함으로 기록하지 않는다.
이번 BASE에서 재현한 결함은 scene-delta 이후 계획 조립 예외가 HTTP 500을 반환하면서 새 user 메시지를 남기는 것이었다.

- 수정 전: `partyGenerationLifecycle`의 추가 단언이 실패. 실패 전 user 0개, 실패 후 1개.
- 수정: 두 catch가 기존 `retractUnconfirmedSend(userMessage, conv.head_message_id)`를 호출한다. 활성 생성 해제는 기존 finally 책임을 유지한다.
- 수정 후: beat/dialog 모두 active=0, queued=0, user 수·활성 메시지 경로·head·scene이 요청 전과 일치. 재전송 200, 성공 user 증가량 정확히 1.
- 과거 user를 편집한 branch에서도 동일 예외를 주입해 기존 최신 head와 메시지 경로가 복원됨을 확인했다.
- abort의 user 유지, 동시에 두 번째 전송 409, 생성 중 삭제 거절은 기존 동작을 유지하며 회귀 검사 통과.

증거: `bench/partyGenerationLifecycle.test.ts`의 `planAssemblyBoom` 및 branch setup failure 검사,
`bench/branchFailureHeadRestore.test.ts`, `bench/activeGenerationDeleteGuard.test.ts`, `bench/failSendUserPersist.test.ts`.
정리 함수 호출 수를 고정한 두 소스 문자열 단언은 제거했다. 실제 실패·복원 검사는 유지·확장했다.

### 2. SQLite 검사 무변경

대상: `apps/server/src/db/index.ts`의 `openReadonlyDb`, `inspectSchema` 및 `apps/server/src/db/cli.ts`의 `migrate`.

- 수정 전: 구형 스키마 fixture 검사 후 주 DB hash는 같지만 `rpchat.db-shm`(32768 bytes), `rpchat.db-wal`(0 bytes)이 생겨 디렉터리 스냅샷 단언 실패.
- 수정: 원본 파일을 SQLite로 열지 않고 읽은 메모리 이미지로 검사한다. deserialize용 journal-mode 바이트 변경은 메모리 복사본에만 적용한다.
- 읽기 전후 main/WAL/SHM/journal의 inode·크기·mtime·ctime을 비교한다. 비어 있지 않은 WAL/복구 저널은 검사 거절한다.
- 읽기·쿼리 오류는 `readError`로 보고하며 migration CLI는 writable open과 백업 전에 종료한다. CLI도 migration manifest 일치를 검사한다.
- 수정 후: 구형 DB의 CLI 검사와 실제 서버 기동 실패 전후 파일 목록·크기·mtime·SHA-256 동일. 정상 settled DB 검사도 sidecar 없이 통과.
- non-empty WAL, 손상 DB, 복구 저널 fixture는 check/migrate 모두 exit 1이며 기존 파일 상태 유지.
- migration 성공·중복 실행·백업·SQL 실패 동작은 임시 DB에서만 검증했다.

증거: `bench/explicitMigrationLifecycle.test.ts`의 `diskState`, old DB, settled WAL, uncheckpointed WAL, corrupt DB/recovery journal 검사.

운영 제약: 검사는 **서비스가 정지한 안정된 DB**가 대상이다. DB 크기에 비례하는 메모리가 필요하다.
파일 읽기 자체에 따른 atime 변경은 무변경 비교에서 제외한다.
비정상 종료 후 WAL이 남으면 자동으로 무시·삭제·checkpoint하지 않고 기동을 거절한다. 승인된 복구 후 재검사가 필요하다.
임의 시점의 실행 중 DB를 검사하는 기능은 제공하지 않는다. 파일 상태 비교가 동시 writer에 대한 잠금을 대신하지 않는다.
상세 운영 안내는 `docs/OPERATIONS.md`의 스키마 적용 절에 반영했다.
구현 근거: [SQLite deserialize의 WAL 이미지 제한](https://sqlite.org/c3ref/deserialize.html).

### 3. Tailscale token 회귀 진단

대상: `bench/tailscaleIngress.test.ts`의 임시 DB 초기화.

- BASE 실패: peer 관련 21개 검사 이후 token login에서 기대 200, 실제 500.
- 원인: 명시적 migration 도입 이후 `openDb`가 스키마를 만들지 않는데 fixture는 이전 호출을 유지했다. 세션 테이블이 없었다.
- 수정: fixture 초기화를 `openMigratedDb`로 변경. 프로덕션 인증 로직·권한 정책은 변경하지 않았다.
- 수정 후: 22개 전체 통과. 비신뢰 peer와 위조 forwarded header 거절, 실제 IPv4/IPv6 loopback 요청, non-loopback inject peer의 token 쿠키 인증 포함.

## 검증 결과

모든 아래 결과는 위 BASE + 이번 작업 트리 변경 기준이다. 구버전 브랜치 결과와 합산하지 않았다.

| 검사 파일 (`bench/`) | 통과 |
|---|---:|
| partyGenerationLifecycle.test.ts | 12 |
| activeGenerationDeleteGuard.test.ts | 12 |
| branchFailureHeadRestore.test.ts | 6 |
| failSendUserPersist.test.ts | 6 |
| leakChoicesDisplay.test.ts | 17 |
| readablePreview.test.ts | 11 |
| schemaCompatManifest.test.ts | 10 |
| explicitMigrationLifecycle.test.ts | 16 |
| tailscaleIngress.test.ts | 22 |
| 합계 | **112** |

각 벤치 실행 명령(레포 루트):

```bash
RPCHAT_PROMPT_DUMP=0 RPCHAT_REQUEST_DUMP=0 node --import tsx bench/<검사파일>
```

실제 socket 테스트 및 CLI의 tsx 자식 프로세스는 sandbox 밖 실행 승인을 받아 실행했다.
`npm run typecheck`: 서버·웹 모두 exit 0.
`git diff --check`: exit 0.

프로덕션 빌드는 소스·content·deploy·package 파일을 `/tmp/rpchat-build-narbuwmr`로 복사하고 기존 node_modules를 연결한 뒤 `npm run build`로 실행했다. exit 0.
라이브 체크아웃의 dist는 빌드하지 않았다. 웹 109 modules, PWA precache 11 entries, 서버 TypeScript 빌드 성공.

해당 임시 빌드의 컴파일된 CLI로 `/tmp/rpchat-boot-wnn0shcu`만 초기화하고, 가짜 모델 HTTP 서버와 loopback 임의 포트에서 컴파일된 서버를 실행했다.

| 빌드 기동 스모크 | 첫 기동 | 정상 종료 후 재기동 |
|---|---:|---:|
| 웹 `/` | 200 | 200 |
| `/api/health` | 200 | 200 |
| SIGTERM 종료 코드 | 0 | 0 |
| 종료 후 컴파일된 CLI schema check | 0 | 0 |

이 스모크는 실제 모델 품질·브라우저 조작·라이브 Tailscale 설정 검증을 대신하지 않는다.

## 배포 인계

1. 위 변경을 관심사별로 검토하고 확정된 커밋 SHA에 연결한다. 현재 HEAD만 배포하면 이번 수정은 포함되지 않는다.
2. Chloe 독립 검증과 필요한 Easton UI QA 결과를 해당 SHA에 첨부한다.
3. 실제 배포 단계에서 승인된 서비스 중지·백업·스키마 검사 절차를 따른다. 잔여 WAL 발견 시 별도 복구 판단으로 멈춘다.
4. migration 필요 여부와 라이브 경로를 확인한 뒤 해당 사람 게이트를 별도로 거친다. 이번 작업은 새로운 migration SQL을 추가하지 않았다.
5. 승인된 배포 후 실제 SHA·dist·PID 및 인증/생성/중단 흐름을 확인한다.

이번 결과로 알려진 세 항목의 코드·테스트 수정은 완료했다. 실제 배포 승인과 라이브 적합성 판정은 아직 수행하지 않았다.
