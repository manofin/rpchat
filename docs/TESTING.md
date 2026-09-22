# 격리 벤치 실행

Node 22 이상에서 저장소 루트의 의존성을 설치한 뒤 실행한다.

```sh
npm ci
npm run test:benches -- --list
npm run test:benches -- --output-dir /tmp/rpchat-bench-evidence
npm run typecheck
npm run build
```

`test:benches`는 루트 `bench/*.test.ts`만 이름순으로 발견하고 각 파일을 별도 프로세스로 순차 실행한다. 실모델 실험 스크립트가 있는 하위 디렉터리는 실행하지 않는다. 자식 프로세스에는 임시 DATA_DIR, loopback 포트, 비활성 모델 주소를 전달하고 `.env`나 모델 자격증명을 읽어들이지 않는다. DB migration 검사는 임시 fixture DB에서만 수행한다.

실행 결과는 `results.json`과 개별 로그에 기록된다. 실패·timeout이 있으면 실행기는 nonzero로 종료한다. `reportedChecks`는 벤치가 출력한 `ok N` 또는 `ok - N` 그룹 수이며 개별 assert 호출 수가 아니다. 제외된 파일은 성공에 합산하지 않는다. 출력 디렉터리는 checkout 밖에 두고 기존 결과를 덮어쓰지 않는다.

선택 재현도 가능하다.

```sh
npm run test:benches -- tailscaleIngress episodeRelationWrite --output-dir /tmp/rpchat-bench-focused
```

## 별도 실행이 필요한 검사

| 벤치 | 기본 실행에서의 처리 |
|---|---|
| `settingsViewport` | 전용 브라우저·viewport 증거가 필요한 검사로 명시 제외 |
| `partyTurnLiveRo` | 특정 개인 DB 복사본과 고정 대화 fixture가 필요한 검사로 명시 제외 |
| `characterAssetsWrite` | 소스 mutation을 수행하므로 명시 제외; 폐기 가능한 별도 checkout에서만 단독 실행 |
| `fixMobileClip`, `shortcutHub` | `--no-browser`로 계약 검사를 실행; 선택적 브라우저 geometry 부분은 미실행으로 기록 |

제외된 브라우저·개인 DB 검사는 기본 suite의 성공으로 대체하지 않는다. 소스 mutation 검사는 아래 명령을 **폐기 가능한 별도 checkout**에서 사용한다. 중단·timeout 뒤에는 임시 checkout의 소스가 변경된 채 남을 수 있으므로 실제 작업 checkout에서 실행하지 않는다.

```sh
npm run test:benches -- characterAssetsWrite --allow-source-mutation --output-dir /tmp/rpchat-assets-mutation
```

`episodeRelationBuild`의 관찰 보고서는 실행 결과의 artifact 디렉터리에 저장한다. 직접 실행할 때는 임시 디렉터리에 저장하며 `RPCHAT_BENCH_ARTIFACT_DIR`로 별도 출력 위치를 지정할 수 있다. 추적 중인 과거 관찰 보고서는 덮어쓰지 않는다.

## 계약과 fence

`settingsRegression` 등의 원본 `git diff HEAD -- apps/server` fence를 유지한다. 제품 소스를 바꾼 작업은 해당 변경을 커밋한 검증용 checkout에서 검사하고, 통과시키기 위해 fence를 편집하지 않는다. 임시 DB fixture는 실제 migration SQL을 사용하고, 승인된 기능 변경으로 오래된 해시·소스 패턴 검사를 교체할 때는 보호할 동작과 실패해야 할 반례를 함께 검증한다.

호스트에만 설치된 `ast-grep`/`tgrep` 없이 저장소 의존성인 TypeScript AST를 사용한다. 도구 실행 실패를 “매칭 0개”로 취급하지 않는다. UI callback·SSR fixture 검사는 실제 기기의 키보드·safe-area·서비스워커 검증을 대신하지 않는다.
