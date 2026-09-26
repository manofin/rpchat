<!-- .github/PULL_REQUEST_TEMPLATE.md — rpchat
     OPS.md + AGENTS.md 검증 루프를 폼으로. 에이전트가 채우고, 사람은 diff가 아니라 체크박스를 본다.
     /verify를 구현된 자동화로 쓰지 말 것. 실행한 명령·결과·UI를 아래에 붙인다. -->

## 무엇이 바뀌나

한 문단. 유저가 이제 할 수 있게 된 것, 또는 멈춘 것.

## 먼저 재현했다

- [ ] 바꾸기 전에 앱을 돌려 버그 / 현재 동작을 봤다
- 사용한 절차: <!-- 정확한 절차 또는 CLI 명령 -->

## 증거

- [ ] UI: 스크린샷 / 녹화 첨부, 같은 절차가 통과함을 보임
- [ ] 백엔드 · perf: 수치 첨부 (지연 · 건수 · 크기, before → after)
- [ ] 버그 수정: 위 재현 → 같은 절차 통과
- [ ] 스위트 영수증: `test:benches` results.json 경로 · pass/fail/excluded 수 · typecheck EXIT (제외 ≠ 통과, 재실행 횟수 포함)

<!-- 여기 붙이기 -->

## 범위 · LOCK

- named lock: <!-- 이름. 이 레포 계약은 OPS.md §6 (named lock · BASE · LIVE_NO_TOUCH · 비범위) -->
- BASE: <!-- 작업 기준 커밋 -->
- [ ] 바뀐 모든 라인이 제목의 그 한 가지에 복무
- [ ] 유저 노출 문자열에 코드네임 · TODO · 내 추론 없음
- [ ] 원인 대신 workaround를 설명하는 주석 없음
- [ ] LIVE_NO_TOUCH 준수(라이브 자산 비변경) · 비범위 명시

## 사람 게이트 (해당하면 사람 대기)

- [ ] **migrate** — DB 마이그레이션 / 파괴적 명령
- [ ] **Hermes 배포** — 배포 · 인프라 변경
- [ ] **돈/권한** — 결제 · 자격 · 크레덴셜
- [ ] **LIVE DB 쓰기** — 라이브 데이터 기록
- [ ] 해당 없음 (문서·web-only 등). green·Easton PASS는 머지 증거이지 실행·머지 승인이 아님
- [ ] 서버·인증·migration 변경 — standing / auto-merge 대상 아님

## 검증 역할

- [ ] Hermes: 재현 명령·결과 첨부 (요약만으로 대체 금지)
- [ ] Chloe: 독립 검증 (구현 코딩 아님)
- [ ] Easton: 실제 UI PASS/FAIL 기록 (해당하면)
