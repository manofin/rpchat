# 설치 가이드 (SETUP)

RP Chat 은 Mac Studio(모델) → Ubuntu(앱) → Galaxy(PWA) 3계층으로 동작한다. 네트워크(사설망) 구성은 [NETWORKING.md](./NETWORKING.md) 를 먼저 읽는다. 이 문서는 앱 자체의 설치를 다룬다.

## 0. 사전 준비
- **Mac Studio**: OpenAI 호환 API 를 제공하는 로컬 모델 서버가 `127.0.0.1:8080` 에서 동작. `/v1/chat/completions`(스트리밍) 와 `/v1/models` 를 지원해야 한다. RP 용으로는 지시-튜닝된 한국어 능력이 있는 모델을 권장한다.
- **Ubuntu 미니PC**: Docker(권장) 또는 Node 22+. 상시 켜둔다.
- 세 기기가 같은 tailnet 에 연결되어 있고, 모델 서버가 Tailscale Serve 로 게시되어 있을 것.

## 1. 소스 배치
```bash
sudo mkdir -p /opt/rpchat && sudo chown "$USER" /opt/rpchat
# 이 저장소 내용을 /opt/rpchat 로 복사 (git clone 또는 파일 업로드)
cd /opt/rpchat
```

## 2A. Docker 로 실행 (권장)
```bash
cd /opt/rpchat/deploy
cp rpchat.env.example .env
nano .env      # MODEL_BASE_URL, AUTH_MODE, ALLOWED_LOGIN 을 본인 값으로

docker compose up -d --build
docker compose logs -f rpchat   # "기동 설정" 로그와 model.ok 확인
```
컨테이너는 `127.0.0.1:8787` 에만 노출된다. 이어서 Ubuntu 에서 `tailscale serve --bg https / http://127.0.0.1:8787` 로 게시한다(§NETWORKING).

부팅 자동 기동은 systemd 로:
```bash
sudo cp deploy/rpchat.service /etc/systemd/system/
sudo sed -i 's#/opt/rpchat/deploy#'$(pwd)'#' /etc/systemd/system/rpchat.service
sudo systemctl daemon-reload && sudo systemctl enable --now rpchat
```

## 2B. Node 로 직접 실행 (Docker 미사용)
better-sqlite3 네이티브 빌드 도구가 필요하다.
```bash
sudo apt-get install -y python3 make g++
cd /opt/rpchat
npm install
npm run build           # web(vite) + server(tsc) 빌드

sudo useradd -r -s /usr/sbin/nologin rpchat || true
sudo mkdir -p /var/lib/rpchat && sudo chown rpchat:rpchat /var/lib/rpchat
cp deploy/rpchat.env.example .env
nano .env               # DATA_DIR=/var/lib/rpchat, HOST=127.0.0.1, MODEL_BASE_URL ...

sudo cp deploy/rpchat-node.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now rpchat-node
journalctl -u rpchat-node -f
```

## 3. 첫 기동 시 동작
- SQLite 스키마가 자동 마이그레이션된다(`apps/server/migrations`).
- 기본 모델 프로필 4종(`rp-balanced`, `rp-creative`, `summary`, `memory-extract`)이 시드된다.
- DB 가 비어 있으면 `content/characters/*.json`, `content/personas/*.json` 의 샘플이 적재된다(서리·카이·여행자). 원치 않으면 해당 파일을 지우고 기동한다.

## 4. 동작 확인
tailnet 안에서:
```bash
curl -s https://ubuntu.<tailnet>.ts.net/api/health | jq
```
`db: "ok"`, `model.ok: true`, `model.resolvedModel` 이 채워지면 정상. 모델이 오프라인이면 앱은 뜨지만 전송이 비활성화된다(설정 화면에 경고 표시).

## 5. 개발 모드 (로컬 PC)
```bash
npm install
# 터미널 1 — 서버 (모델 서버 주소를 환경변수로)
MODEL_BASE_URL=http://127.0.0.1:8080/v1 AUTH_MODE=none npm run dev --workspace @rpchat/server
# 터미널 2 — 웹(Vite, /api 는 8787 로 프록시)
npm run dev --workspace @rpchat/web
# http://127.0.0.1:5173
```
`AUTH_MODE=none` 은 `HOST=127.0.0.1` 에서만 허용되는 개발 전용 모드다.

## 환경변수 요약
`.env.example`(루트) 및 `deploy/rpchat.env.example` 참고. 핵심:
| 변수 | 의미 |
|---|---|
| `MODEL_BASE_URL` | 모델 서버 `/v1` 주소 |
| `MODEL_NAME` | 비우면 `/v1/models` 첫 항목 자동 사용 |
| `CONTEXT_TOKENS` | 프롬프트 예산 산정 기준 컨텍스트 크기 |
| `AUTH_MODE` | `tailscale` / `token` / `none` |
| `ALLOWED_LOGIN` | tailscale 모드에서 허용할 본인 로그인 |
| `DATA_DIR` | SQLite/미디어 저장 경로 |
