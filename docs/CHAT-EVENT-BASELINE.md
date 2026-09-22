# ChatEvent 도입 전 S0 기준선

측정 시각: 2026-09-22 04:04:15 UTC / 13:04:15 KST.

이 문서는 이번 계약 변경 전 실제 실행 프로세스, 제공 번들 및 DB 메시지 형태를 읽기 전용으로 확인한 기록이다. 개인 대화 본문, 캐릭터 이름, 사용자 식별자, 인증 정보는 수집 결과에 포함하지 않았다. 신규 계약 구현의 검증 결과와는 구분한다.

## 실행 코드와 제공 번들

| 항목 | 측정값 |
| --- | --- |
| 배포 SHA | `2bfc555968dc270549041e8ff9c97f92a5fd2bd4` |
| 실제 `/proc/<pid>/cwd` | `/home/hermes/rpchat/releases/2bfc555-20260922` |
| PID / 측정 후 PID | `522106` / `522106` |
| 프로세스 시작 | 2026-09-22 02:48:59 UTC |
| NRestarts | `0` |
| localhost health | `ok=true`, DB `ok`, model `ok=true`, active `0`, queued `0` |
| Tailscale 경유 health | `ok=true`, DB `ok`, model `ok=true`, active `0`, queued `0` |
| 실제 제공 JS | `/assets/index-D67qZKXs.js` |
| 제공 JS SHA-256 | `562bc505092429c502ec1c0cef0a6c83ee9e368d0ec8335c65aff182fa3a44f2` |
| 제공 HTML SHA-256 | `e609feb50028e7b90b1fd6ed146a5f87f4172147f4515758b793998b72275532` |
| 제공 HTML·JS와 release 파일 비교 | 모두 byte 동일 |
| 서버·웹 dist와 배포 manifest 비교 | 78개 파일 전체 동일 |

기존 `/home/hermes/rpchat/app`은 SHA `f3881351126f5e81205e4af67d039c787f72e343`와 미커밋 diff SHA-256 `4e64d4376b88ab9268c9e8655c88d08ca2f14413f687c49d83e9dfb15063ca6b`를 유지했다. 이 경로는 측정 당시 서비스 실행 경로가 아니었다.

## DB 사본 검사 방법

라이브 DB에 SQLite 연결을 열지 않았다. 라이브 DB와 WAL을 원격 임시 디렉터리(권한 `0700`)로 파일 복사하고, 복사 전후 각 원본의 inode·크기·mtime·ctime이 같은지 확인했다. rollback journal이 있으면 중단하도록 했다. SQLite 연결과 integrity/schema/통계 조회는 임시 사본에만 수행했다. 검사를 끝낸 뒤 사본을 삭제했다.

- 사본 `PRAGMA integrity_check`: `ok`.
- 적용 migration: 22개, 해당 release의 `deploy/schema-compat.json`과 정확히 일치.
- 전체 검사 후에도 라이브 원본 DB/WAL stat 동일.
- 서비스 재시작, 배포, migration, 라이브 메시지 생성·수정 없음.

| 테이블 | 행 수 |
| --- | ---: |
| messages | 1130 |
| conversations | 36 |
| characters | 17 |
| stories | 3 |

messages 열은 `id`, `conversation_id`, `parent_id`, `role`, `content`, `status`, `meta_json`, `bookmarked`, `created_at`이었다. `bookmarked`는 INTEGER, 나머지는 TEXT다. 기존 저장 형태는 content와 meta_json이며, 이 측정 시점에는 새 ChatEvent 저장 필드가 없었다.

| `meta_json.block_kind` | 행 수 |
| --- | ---: |
| 없음 | 422 |
| header | 135 |
| narration | 148 |
| ui | 139 |
| line | 152 |
| thought | 132 |
| info | 2 |

모든 1130행은 `status=complete`였다. role은 assistant 857행, user 273행이며 빈 content 5행, 비어 있지 않은 content 1125행이었다. JSON 파싱 실패 또는 object가 아닌 meta_json은 0행이었다. `block_kind`가 없는 행은 user와 기존 assistant를 포함하므로, 이 수치 자체를 1:1 assistant 수로 해석하지 않는다.

| 관측 meta 키와 타입 | 행 수 |
| --- | ---: |
| profile: string | 857 |
| prompt_version: string | 857 |
| generation_id: string | 846 |
| usage: object | 138 |
| finish_reason: string | 146 |
| choices: array | 212 |
| speaker_character_id: string | 295 |
| speaker_name: string | 295 |
| block_kind: string | 708 |
| beat_seq: number | 708 |
| scene_state: object | 108 |

이전 `thought` 132행은 실제 저장 데이터다. 신규 출력의 thought 비표시·미저장 정책은 과거 행을 자동 삭제하거나 다시 쓰는 허가를 뜻하지 않는다. 기존 행은 읽기 어댑터에서 숨기는 동작으로 검증해야 한다.

## 과거 변경과 비교할 때의 주의점

배포 이후 사용자 승인으로 assistant 메시지 한 건의 테스트 표식 접미사를 제거한 기록이 있다. 따라서 배포 당시 전체 DB 논리 해시와 현재 해시가 다를 수 있다. 이 S0 검사는 본문 해시 동일성을 주장하지 않으며, 원본 stat 불변·사본 무결성·schema·형태·행 수를 확인한다.

기존 B-2는 서버 내부 `PartyTurn` 매퍼와 웹 공통 렌더러를 도입했지만, 서버 매퍼를 wire/persist 계약으로 소비하지 않았다. 웹이 `block_kind + meta`로 공통 블록을 유도하는 경로가 남아 있었다. 이번 계약 도입은 이 경계의 변경으로 검증해야 한다. focused/ensemble 생성 정책, 기존 프롬프트 및 장면 처리 의미를 바꾸는 작업과 혼합하지 않는다.

## 증거와 한계

실행 스크립트와 본문 없는 원자료는 이 작업 환경의 `/private/tmp/rpchat-baseline-audit.py`, `/private/tmp/rpchat-baseline-audit.json`에 보존했다. 이 파일들은 저장소에 커밋하지 않는다. 이전 배포 원자료는 로컬 인계 자료 `rpchat-handover-20260922/deploy-2bfc555/`에도 있다.

이번 S0 조사는 라이브 메시지를 생성하지 않았으므로 신규 SSE 표본을 채취하지 않았다. 서버 이벤트부터 화면까지의 SSE/새로고침/재생성 검증은 별도 격리 fixture로 수행해야 한다. 실제 사용자 기기 화면, 실모델 응답 품질 및 크랙 서비스의 로그인 후 흐름은 확인하지 않았다. 이 문서는 이후 구현 diff의 독립 코드 검토 완료를 의미하지 않는다.
