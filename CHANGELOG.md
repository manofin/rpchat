# Changelog

제품 버전 SoT 는 `/home/hermes/rpchat/app` 에서 `git describe --tags` 다.
`package.json` 의 `0.1.0` 은 쓰지 않는다. 스키마 버전은 `PRAGMA user_version` 이 아니라
`schema_migrations.name` 집합이다. 이 트리가 요구하는 집합은 `deploy/schema-compat.json`.

형식은 [Keep a Changelog](https://keepachangelog.com/). 태그 제목을 기준으로 했다.

## [Unreleased]

### Added
- 백업 매니페스트: `backup-host.py` 가 `.db.gz` 옆에 `rpchat-<stamp>.manifest.json` 을 남긴다
  (`app_version` = `git describe`, `schema_migrations`, `required_migrations`).
- `restore.sh --check <gz>`: 무결성 + 스키마 바인딩만 출력. 라이브 중지/덮어쓰기 없음.
- 스키마 불일치 시 `BIND_WARN`(missing/extra). 롤백을 막지 않는다.
- P0-6 최소: 고아 `streaming` 을 boot/GET/generate 에서 `interrupted` 로 접음.
  PWA 는 `activeGeneration` 이 있으면 700ms GET 폴링 + abort id 복원. 신규 테이블/idempotency key 없음.

### Fixed
- `restore.sh` / `OPERATIONS.md` 를 docker 전제에서 host/systemd 토폴로지로 재작성 (`13e694f`).

### Changed
- P4 sketchBench 하니스 감사 수정 (측정 무결성, Mac PATH/DELETE, stub smoke). 제품 경로 아님.

## [0.0.19] - 2026-08-23

### Added
- state 체크포인트 이력 + 복원 (PRD order-6). 묶음(분기+기억+장면) 복원은 아님.

## [0.0.18] - 2026-08-23

### Fixed
- 자동 추출 기억 evidence 를 요약 구간 끝이 아니라 시작 메시지에 붙임.

## [0.0.17] - 2026-08-23

### Fixed
- 프롬프트 분기 범위 가드.
- episode 예산 고갈 시 쓰레기 주입 가드.

## [0.0.16] - 2026-08-23

### Fixed
- 최신 assistant 가 아닌 턴에서 스토리 선택지 숨김.

## [0.0.15] - 2026-08-23

### Added
- 요약 진단에 episode 표시 (P1-6 후속).

## [0.0.14] - 2026-08-23

### Added
- episode rollup + 주입 (P1-3c).

## [0.0.13] - 2026-08-23

### Added
- 조립 진단: lore match/no-match + summary tiers (preview only).

## [0.0.12] - 2026-08-23

### Added
- scene tier 생성 + 주입 (P1-3b).

## [0.0.11] - 2026-08-23

### Added
- state tracker tier (P1-3a). 마이그레이션 `0005_summary_tiers.sql`.

## [0.0.10] - 2026-08-23

### Added
- 요약 `covers_until` 메시지 점프 (태그 제목은 P1-3a 였으나 실체는 점프 버튼).

## [0.0.9] - 2026-08-23

### Added
- 프롬프트 조립 디버그 목록 (P1-6).

## [0.0.8] - 2026-08-23

### Added
- 기억 evidence 원본 점프 (P1-5).

## [0.0.7] - 2026-08-23

### Added
- 중복 기억 병합 UX (P1-2c, dup-only).

## [0.0.6] - 2026-08-23

### Changed
- 규칙 기반 conflict 를 억제하고 `new` + `conflict-suppressed` 로 접음. 임베딩으로 이월 후 비채택.

## [0.0.5] - 2026-08-23

### Added
- 규칙 기반 충돌 감지 (dup/conflict/new, CAL_CUT=0.35).

## [0.0.4] - 2026-08-22

### Added
- memory `superseded` 상태. 조회/프롬프트에서 제외.

## [0.0.3] - 2026-08-22

### Added
- `0004_memory_scope.sql`: scope/validity/replaces/`world_id` 컬럼. `world_id` 는 이후 미사용.

## [0.0.2] - 2026-08-22

### Added
- FTS5 `/search` 라우트.

## [0.0.1] - 2026-08-22

### Added
- 앱 런타임 트리 베이스라인.
