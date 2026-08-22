# syntax=docker/dockerfile:1

# ---- 1) 의존성 + 빌드 ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 네이티브 빌드에 필요한 도구
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 워크스페이스 매니페스트 먼저 복사 (레이어 캐시)
COPY package.json package-lock.json* ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm install

# 소스 복사 후 빌드
COPY . .
RUN npm run build --workspace @rpchat/web \
  && npm run build --workspace @rpchat/server

# 프로덕션 의존성만 다시 설치 (서버만 런타임에 필요)
RUN npm prune --omit=dev

# ---- 2) 런타임 ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 런타임 산출물만 복사
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/migrations ./apps/server/migrations
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/content ./content

# 데이터 볼륨 (SQLite + 미디어)
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node

ENV PORT=8787 HOST=0.0.0.0 DATA_DIR=/data WEB_DIST=../web/dist
EXPOSE 8787

# 헬스체크 (모델 오프라인이어도 앱 자체는 200 을 반환하도록 db 상태만 확인)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||8787) +'/api/health').then(r=>r.json()).then(j=>process.exit(j.db==='ok'?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
