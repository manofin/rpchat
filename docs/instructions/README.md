# 모델 프로필 서술 지침 파일

모델 프로필(`model_profiles`)에 붙는 **서술 지침**을 로컬 파일에서 DB로 적재하는 형식이다.
실제 지침 원문은 비공개 런타임 데이터라 이 저장소에 두지 않는다. 이 폴더에는 형식을 보여 주는 빈 예제(`rp-example.md`)만 있다.

## 파일 규칙

- 경로: `INSTRUCTIONS_DIR`(절대경로). 비우면 `<DATA_DIR>/instructions`. CLI의 `--dir`이 둘 다보다 우선한다.
- 파일명 = 프로필 이름 + `.md`. 이름은 `^[a-z0-9-]{2,40}$`이고, 채팅 화면의 프로필 목록에 보이려면 `rp-`로 시작해야 한다.
- 본문 = `instruction_text`. 앞뒤 공백까지 그대로 저장하며 sha256도 저장값 기준으로 계산한다. `{{user}}`/`{{char}}`는 생성할 때 치환된다.
- 건너뛰는 파일: 빈 파일(공백만 있는 파일 포함), 이름 규칙 위반, 20000자 초과.

## 적재

```bash
# 먼저 dry-run: DB를 읽기 전용으로만 열고 파일별 action/chars/est_tokens/sha256을 출력한다
npm run db:import-instructions --workspace @rpchat/server -- --data-dir /abs/data --dry-run
# 실제 적재: 먼저 DB를 백업하고 integrity 확인을 거친 뒤 create/update만 한 트랜잭션으로 쓴다
npm run db:import-instructions --workspace @rpchat/server -- --data-dir /abs/data
```

- create: 샘플링 값은 `rp-balanced`에서 복제한다. notes는 첫 줄 제목이며 `instruction_enabled=1`이다.
- update: 원문과 `instruction_enabled=1`만 바꾼다. 샘플링 값과 notes는 그대로 둔다.

### 실행 조건

- `--data-dir`는 절대경로이고 DB 파일이 이미 있어야 한다. migration이 최신이어야 한다(missing·extra 0, 즉 0023 적용). 그렇지 않으면 적재를 시작하지 않고 exit 1로 끝난다.
- **서비스가 실행 중이어도 된다(WAL 허용).** 검사는 일반 SQLite 연결로 `schema_migrations`를 읽는다. `db:check`의 무변경 파일 검사는 WAL이 남아 있으면 거부하므로 이 검사에는 쓰지 않는다.
- `--dry-run`은 읽기 전용 연결을 쓰며 DB 내용을 쓰지 않는다.
- 실제 적재는 다음 순서다: 일반 연결(busy_timeout 5000) → 온라인 백업(`rpchat-pre-import-instructions-<시각>.db`)과 integrity 확인 → create/update를 한 트랜잭션으로 쓰기.
- 재시작은 필요 없다. 생성 경로가 턴마다 프로필을 한 번씩 읽으므로, 한 턴 안에서 지침이 바뀌어 섞이지 않는다.
- 적재만으로는 기존 방에 적용되지 않는다. 방의 프로필(`conversations.profile_name`)을 그 프로필로 바꿔야 적용된다.

## 적용 범위

- 1:1: `### 서술 지침` 블록이 규칙 바로 뒤에 들어간다. 이때 HARD_RULES 4번의 산문 순서 문장과 응답 길이 힌트는 빠진다(`PromptPolicy`). OOC 턴에는 넣지 않는다.
- 파티: 서술을 생성하는 호출(beat N·F·E, 대본 S)마다 그 호출의 `## 규칙` 바로 앞에 한 번씩 들어간다. 장면 판정과 선택지(Pass C)에는 넣지 않는다. 호출별 문장 수·대사 줄 수 제한과 샘플링 값은 그대로 유지된다.
- 프로필은 방에 저장된 `conversations.profile_name`으로 정해진다. 새 방의 프로필은 명시값 > 스토리 기본 > 캐릭터 기본 > `rp-balanced` 순서로 정한다.

## 컨텍스트 초과

지침은 잘라 넣지 않는다. 들어가지 않으면 **생성 전에 422로 거부**한다. 모델 호출, 메시지 생성, 로그 기록 모두 일어나지 않고, 보낸 입력도 되돌린다.

- 1:1: 지침을 넣고 나면 현재 턴조차 가용 예산(`context − max_tokens − 64`)에 들어가지 않을 때 거부한다.
- 파티: 지침 블록 하나만으로도 그 형식의 가장 작은 IC 호출 예산을 넘을 때, 장면 판정보다 먼저 거부한다. 지침 블록만으로는 들어가지만 호출 본문과 합쳐서 넘는 경우에는 오래된 서술부터 줄인다. 그래도 넘으면 그 호출만 실패한다(지침과 inject는 자르지 않음).
- 판정은 그 턴의 토큰 보정계수(`token_calibration`) 기준이라, 경계 근처에서는 보정계수가 움직이면 결과가 달라질 수 있다. 프롬프트 미리보기와 인스펙터는 거부하지 않고 `서술 지침` 섹션 note에 "컨텍스트 초과 — 생성 거부"로 보여 준다.

## 규칙과 지침이 부딪힐 때

지침 뒤에는 앱 공통 문구가 붙어 "이 요청의 규칙이 정한 출력 형식·길이·화자 제한이 지침보다 우선"임을 명시한다. rpchat은 1:1 고정 규칙과 파티의 모든 호출 규칙에서 {{user}} 대필을 금지한다. 따라서 **유저 대필(사칭)을 허용하는 지침을 넣어도 rpchat은 유저의 대사·행동을 대신 쓰지 않는다.** 그런 지침은 대필을 허용하지 않는 판과 사실상 같게 동작한다.
