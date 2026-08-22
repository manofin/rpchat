import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { PROMPT_VERSION, config, validateConfig } from './config.js';
import { openDb } from './db/index.js';
import { seed } from './db/seed.js';
import { ModelClient } from './model/adapter.js';
import { GenerationQueue } from './model/queue.js';
import { registerAuthHook } from './auth.js';
import type { Ctx, ModelHealth } from './ctx.js';
import { healthRoutes } from './routes/health.js';
import { characterRoutes } from './routes/characters.js';
import { conversationRoutes } from './routes/conversations.js';
import { chatRoutes } from './routes/chat.js';
import { memoryRoutes } from './routes/memory.js';
import { settingsRoutes } from './routes/settings.js';
import { searchRoutes } from './routes/search.js';

async function main() {
  const problems = validateConfig();
  if (problems.length) {
    for (const p of problems) console.error(`[config] ${p}`);
    process.exit(1);
  }

  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 1_000_000,
    trustProxy: false, // Tailscale Serve 는 localhost 에서 접속하지만, X-Forwarded-* 를 신뢰할 이유가 없음
  });

  const db = openDb(config.dataDir, config.migrationsDir);
  seed(db, config.contentDir, (m) => app.log.info(m));

  const model = new ModelClient(config.model.baseUrl, config.model.apiKey, config.model.timeoutMs);
  const queue = new GenerationQueue(1);

  // 모델 이름 해석 + 헬스 캐시(10초)
  let resolvedModel = config.model.name;
  let healthCache: ModelHealth | null = null;
  let healthAt = 0;
  const health = async (): Promise<ModelHealth> => {
    if (healthCache && Date.now() - healthAt < 10_000) return healthCache;
    const t0 = Date.now();
    try {
      const models = await model.listModels(3000);
      if (!resolvedModel && models.length) resolvedModel = models[0];
      healthCache = { ok: true, checkedAt: new Date().toISOString(), latencyMs: Date.now() - t0, models };
    } catch (err) {
      healthCache = { ok: false, checkedAt: new Date().toISOString(), latencyMs: null, models: [], error: (err as Error).message };
    }
    healthAt = Date.now();
    return healthCache;
  };

  const ctx: Ctx = {
    db,
    model,
    queue,
    log: app.log,
    resolvedModel: () => resolvedModel,
    setResolvedModel: (n) => {
      resolvedModel = n;
    },
    health,
  };

  await app.register(fastifyCookie, { secret: config.auth.sessionSecret || 'unused-in-this-auth-mode-'.padEnd(40, 'x') });
  registerAuthHook(app, db);

  await app.register(healthRoutes(ctx));
  await app.register(characterRoutes(ctx));
  await app.register(conversationRoutes(ctx));
  await app.register(chatRoutes(ctx));
  await app.register(memoryRoutes(ctx));
  await app.register(settingsRoutes(ctx));
  await app.register(searchRoutes(ctx));

  // 정적 SPA (빌드 결과가 있을 때만). /api 외 경로는 index.html 로 폴백.
  const hasWeb = fs.existsSync(config.webDist) && fs.existsSync(`${config.webDist}/index.html`);
  if (hasWeb) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', index: ['index.html'], wildcard: true, cacheControl: true, maxAge: '1h', immutable: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      reply.header('cache-control', 'no-cache');
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn(`웹 번들이 없음 (${config.webDist}) — API 전용으로 실행`);
  }

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'unhandled');
    if (reply.sent) return;
    reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: err instanceof Error ? err.message : String(err) });
  });

  const h = await health();
  app.log.info({ model: config.model.baseUrl, resolvedModel, modelOk: h.ok, promptVersion: PROMPT_VERSION, auth: config.auth.mode, dataDir: config.dataDir }, '기동 설정');
  if (!h.ok) app.log.warn(`모델 서버 연결 실패: ${h.error} — 앱은 뜨지만 전송은 비활성화됨`);
  if (!resolvedModel) app.log.warn('MODEL_NAME 미설정이고 /v1/models 도 응답하지 않아 모델 이름을 해석하지 못함');

  await app.listen({ port: config.port, host: config.host });

  const shutdown = async (sig: string) => {
    app.log.info({ sig }, '종료 중');
    for (const g of queue.activeList) g.controller.abort();
    await app.close().catch(() => {});
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
