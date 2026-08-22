import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // apps/server/src 또는 apps/server/dist

function env(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function num(name: string, def: number): number {
  const n = Number(env(name, String(def)));
  if (!Number.isFinite(n)) throw new Error(`환경변수 ${name} 가 숫자가 아님: ${process.env[name]}`);
  return n;
}

export type AuthMode = 'tailscale' | 'token' | 'none';

export const PROMPT_VERSION = '2026.08.22-r1';

export const config = {
  port: num('PORT', 8787),
  host: env('HOST', '127.0.0.1'),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  logLevel: env('LOG_LEVEL', 'info'),
  model: {
    baseUrl: env('MODEL_BASE_URL', 'http://127.0.0.1:8080/v1').replace(/\/+$/, ''),
    apiKey: env('MODEL_API_KEY', ''),
    name: env('MODEL_NAME', ''),
    contextTokens: num('CONTEXT_TOKENS', 32768),
    timeoutMs: num('MODEL_TIMEOUT_MS', 180_000),
  },
  auth: {
    mode: env('AUTH_MODE', 'tailscale') as AuthMode,
    allowedLogin: env('ALLOWED_LOGIN', ''),
    appToken: env('APP_TOKEN', ''),
    sessionSecret: env('SESSION_SECRET', ''),
    sessionTtlHours: num('SESSION_TTL_HOURS', 12),
  },
  // apps/server 기준 상대 경로 → 절대 경로
  webDist: path.resolve(here, '..', env('WEB_DIST', '../web/dist')),
  migrationsDir: path.resolve(here, '..', 'migrations'),
  contentDir: path.resolve(here, '..', '..', '..', 'content'),
};

export function validateConfig(): string[] {
  const problems: string[] = [];
  const a = config.auth;
  if (!['tailscale', 'token', 'none'].includes(a.mode)) problems.push(`AUTH_MODE 값이 잘못됨: ${a.mode}`);
  if (a.mode === 'tailscale' && !a.allowedLogin) problems.push('AUTH_MODE=tailscale 에는 ALLOWED_LOGIN 이 필요');
  if (a.mode === 'token') {
    if (a.appToken.length < 16) problems.push('AUTH_MODE=token 에는 16자 이상 APP_TOKEN 이 필요');
    if (a.sessionSecret.length < 32) problems.push('AUTH_MODE=token 에는 32자 이상 SESSION_SECRET 이 필요');
  }
  if (a.mode === 'none' && config.host !== '127.0.0.1' && config.host !== 'localhost')
    problems.push('AUTH_MODE=none 은 HOST=127.0.0.1 에서만 허용');
  if (!/^https?:\/\//.test(config.model.baseUrl)) problems.push('MODEL_BASE_URL 은 http(s):// 로 시작해야 함');
  if (config.model.contextTokens < 2048) problems.push('CONTEXT_TOKENS 가 너무 작음 (<2048)');
  return problems;
}
