# Tailscale 사설망 구성 가이드

이 앱은 **공개 인터넷에 노출하지 않는다.** 브라우저(Galaxy)는 Ubuntu 백엔드에만 접속하고, 백엔드만 Mac Studio 모델 서버를 호출한다. 세 노드를 하나의 tailnet 에 넣고, `tailscale serve`(사설망 내부 HTTPS)만 사용한다. `funnel`(공개 노출)과 포트포워딩은 쓰지 않는다.

```
┌────────────┐  내부 HTTPS(Serve)  ┌─────────────┐   OpenAI 호환   ┌──────────────┐
│  Galaxy    │ ──────────────────▶ │  Ubuntu     │ ──────────────▶ │  Mac Studio  │
│  (PWA)     │   https://ubuntu…   │  백엔드:8787 │  :8080/v1       │  모델 서버    │
└────────────┘                     └─────────────┘                 └──────────────┘
        모두 같은 tailnet (WireGuard). 공개 포트 없음.
```

## 1. 세 기기를 tailnet 에 연결
각 기기에 Tailscale 설치 후 로그인. `tailscale status` 로 세 노드가 보이면 된다. MagicDNS 를 켜면 `ubuntu`, `mac-studio` 같은 이름으로 접근할 수 있다(권장).

## 2. Mac Studio 모델 서버: 루프백 바인딩 + Serve
모델 서버(mlx-openai-server 등)는 **`127.0.0.1:8080` 에만** 바인딩한다. 그런 다음 Tailscale Serve 로 tailnet 내부에서만 접근 가능하게 프록시한다.

```bash
# Mac Studio 에서 (모델 서버가 127.0.0.1:8080 에 떠 있는 상태)
tailscale serve --bg --https=8443 http://127.0.0.1:8080
tailscale serve status     # https://mac-studio.<tailnet>.ts.net:8443 확인
```

Ubuntu 백엔드의 `MODEL_BASE_URL` 을 여기에 맞춘다:
```
MODEL_BASE_URL=https://mac-studio.<tailnet>.ts.net:8443/v1
```
> 모델 서버에 자체 인증이 없다면, tailnet 내부라도 이 경로가 유일한 통로가 되도록 방화벽에서 8080 의 외부 유입을 차단한다.

## 3. Ubuntu 백엔드: 앱을 Serve 로 게시
앱을 `127.0.0.1:8787` 로 띄운 뒤(§Docker/Node 각 방식은 SETUP.md 참고), Serve 로 tailnet 에 HTTPS 게시한다.

```bash
# 기본 443 으로 게시 (경로 라우팅 필요 없으면 가장 단순)
tailscale serve --bg https / http://127.0.0.1:8787
tailscale serve status
# → https://ubuntu.<tailnet>.ts.net 로 Galaxy 에서 접속
```

### 신원 헤더 인증 (AUTH_MODE=tailscale)
Serve 는 요청에 접속자의 tailnet 신원을 헤더로 붙여준다. 앱은 `Tailscale-User-Login` 을 읽어 `ALLOWED_LOGIN` 과 대조한다.

```
AUTH_MODE=tailscale
ALLOWED_LOGIN=you@example.com   # tailscale status 의 본인 로그인과 일치
```

- tailnet 은 단독 사용자이므로 사실상 본인만 접근 가능하지만, 이 대조로 한 번 더 못을 박는다.
- 헤더는 Serve 가 신뢰 경계에서 주입하므로 위조가 어렵다. **앱은 `trustProxy=false`** 로, 클라이언트가 보낸 `X-Forwarded-*` 는 신뢰하지 않는다.

> 토큰 모드(`AUTH_MODE=token`)를 쓰려면 Serve(HTTPS) 뒤에서만 사용한다. 쿠키가 `Secure` 라서 평문 HTTP 에서는 로그인 세션이 유지되지 않는다.

## 4. PWA 설치 (Galaxy)
Chrome 으로 `https://ubuntu.<tailnet>.ts.net` 접속 → 메뉴 → **홈 화면에 추가**. Serve 인증서는 tailnet 도메인에 대해 정식 발급되므로 브라우저 경고 없이 서비스워커/PWA 설치가 동작한다.

## 확인 체크리스트
- [ ] `tailscale status` 에 세 노드 모두 온라인
- [ ] Mac: `tailscale serve status` 에 8443→8080 노출, 8080 은 외부 차단
- [ ] Ubuntu 앱 헬스: tailnet 안에서 `curl https://ubuntu.<tailnet>.ts.net/api/health` → `model.ok=true`
- [ ] Galaxy 에서 PWA 설치 및 대화 스트리밍 정상
- [ ] `funnel` 미사용(`tailscale funnel status` 비어 있음), 공유기 포트포워딩 없음
