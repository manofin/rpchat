/**
 * Loopback-only A1111-shaped stub for pre-Task1 smoke.
 * Not a measurement. Does not load a model. Does not bind beyond 127.0.0.1.
 *
 * GET  /healthz              → 200 {ok:true}
 * POST /sdapi/v1/txt2img     → delay STUB_DELAY_MS then 200 {images:["<placeholder>"]}
 *                              or every Nth POST (STUB_FAIL_EVERY_N) → 500 {error:"stub induced failure"}
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const BIND_HOST = '127.0.0.1';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
  return n;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createStubServer(opts?: {
  delayMs?: number;
  failEveryN?: number;
}): http.Server {
  const delayMs = opts?.delayMs ?? envInt('STUB_DELAY_MS', 3000);
  const failEveryN = opts?.failEveryN ?? envInt('STUB_FAIL_EVERY_N', 0);
  let postCount = 0;

  return http.createServer((req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0];
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && path === '/sdapi/v1/txt2img') {
      void (async () => {
        const raw = await readBody(req).catch((e) => {
          console.error(`stub txt2img body-read error: ${e instanceof Error ? e.message : String(e)}`);
          return '';
        });
        postCount += 1;
        const induceFail = failEveryN > 0 && postCount % failEveryN === 0;
        console.error(
          `stub txt2img #${postCount} delay_ms=${delayMs} fail=${induceFail} body_bytes=${Buffer.byteLength(raw)}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
        if (induceFail) {
          sendJson(res, 500, { error: 'stub induced failure' });
          return;
        }
        sendJson(res, 200, { images: ['<placeholder>'] });
      })().catch((e) => {
        console.error(`stub txt2img handler error: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'stub handler error' });
      });
      return;
    }

    sendJson(res, 404, { error: `stub no route ${method} ${path}` });
  });
}

function isMain(): boolean {
  const self = fileURLToPath(import.meta.url);
  const argv1 = process.argv[1];
  return Boolean(argv1) && (argv1 === self || argv1.endsWith('stubDrawThingsServer.ts'));
}

if (isMain()) {
  const port = envInt('STUB_PORT', 9999);
  const server = createStubServer();
  server.listen(port, BIND_HOST, () => {
    console.error(`stubDrawThings listening http://${BIND_HOST}:${port} delay_ms=${process.env.STUB_DELAY_MS ?? 3000} fail_every_n=${process.env.STUB_FAIL_EVERY_N ?? 0}`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
