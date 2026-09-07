/**
 * npx tsx bench/abortBeforeFocusLog.test.ts
 * abort-before-focus-log-classification — a user abort before Pass F has a row
 * is a normal stop, not a generation failure. The live canary logged
 * `level:50 AbortError` / "비트 생성 실패" because the catch's else branch did
 * not look at `aborted`. Partial header rows stay; scene is untouched (S2).
 *
 * Isolated: no systemd, no live DB, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { openDb, parseJson } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import { chatRoutes } from '../apps/server/src/routes/chat.ts';
import { THOUGHT_MARKER } from '../apps/server/src/prompt/passes.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import type { MessageMeta, Scene } from '../apps/server/src/types.ts';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function code(rel: string): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(dir, '..', rel), 'utf8');
}

function ok(text: string): GenResult {
  return { text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
}

function versionOf(prompt: string): number {
  const m = prompt.match(/\{"base_version": (\d+)\}/);
  return m ? Number(m[1]) : 0;
}

function sseTypes(body: string): string[] {
  const types: string[] = [];
  for (const chunk of body.split('\n\n')) {
    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try {
      const ev = JSON.parse(line.slice(6)) as { type?: string };
      if (ev.type) types.push(ev.type);
    } catch { /* ignore */ }
  }
  return types;
}

async function main() {
await t('chat.ts checks abort on both catch branches of all three multi-row paths', () => {
  const s = code('apps/server/src/routes/chat.ts');
  assert.equal((s.match(/wasAborted\(controller, err\)/g) ?? []).length, 3);
  assert.equal((s.match(/else if \(aborted\)/g) ?? []).length, 3);
  const beat = s.slice(s.indexOf('async function generateBeat'), s.indexOf('async function generateDialog'));
  assert.ok(beat.includes('else if (aborted)'));
  assert.ok(beat.includes("ctx.log.error({ err, generationId }, '비트 생성 실패')"));
  assert.ok(beat.includes('wasAborted(controller, err)'));
});

await t('abort during Pass N is not logged as a generation failure and does not send error', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-abort-focus-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  const errors: unknown[][] = [];
  let origin = '';
  const model = {
    complete: async (p: GenParams): Promise<GenResult> => {
      const prompt = String(p.messages?.[0]?.content ?? '');
      if (prompt.includes('장면 진행 판정기')) {
        return ok(JSON.stringify({ base_version: versionOf(prompt), advance_minutes: 10, weather: '맑음' }));
      }
      if (prompt.includes('너는 장면 서술자다') || prompt.includes('군중') || prompt.startsWith('당신은 카메라')) {
        const active = await fetch(`${origin}/api/generations/active`);
        const body = await active.json() as { active: Array<{ id: string }> };
        assert.ok(body.active[0]?.id, 'generation is registered before Pass N');
        const abortRes = await fetch(`${origin}/api/generations/${body.active[0]!.id}/abort`, { method: 'POST' });
        assert.equal(abortRes.status, 200, await abortRes.text());
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      if (prompt.includes('입력 초안만 쓴다')) return ok('<choices>["가","나","다"]</choices>');
      return ok('"교칙이야."');
    },
    stream: async (_p: GenParams, onToken: (d: string) => void): Promise<GenResult> => {
      const text = `"……짝꿍?"\n${THOUGHT_MARKER} 왜 안 피하지.`;
      onToken(text);
      return { text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 3 };
    },
    listModels: async () => ['test-model'],
  };

  const ctx = {
    db,
    model: model as unknown as Ctx['model'],
    queue: new GenerationQueue(1),
    log: {
      error(...args: unknown[]) { errors.push(args); },
      info() {}, warn() {}, debug() {},
    } as unknown as Ctx['log'],
    resolvedModel: () => 'test-model',
    setResolvedModel: () => {},
    health: async () => ({ ok: true, checkedAt: 't', latencyMs: 0, models: ['test-model'] }),
  } as Ctx;

  const app = Fastify({ logger: false });
  await app.register(characterRoutes(ctx));
  await app.register(storyRoutes(ctx));
  await app.register(conversationRoutes(ctx));
  await app.register(chatRoutes(ctx));
  await app.listen({ host: '127.0.0.1', port: 0 });
  origin = `http://127.0.0.1:${(app.addresses()[0] as { port: number }).port}`;

  const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${origin}${url}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, text };
  };

  try {
    const char = async (name: string, tags: string[]) => {
      const res = await api('POST', '/api/characters', { name, personality: `${name} 성격`, first_message: '', tags });
      return res.json as { id: string };
    };
    const nari = await char('나리', ['party:duty=이야기', 'party:place=교실']);
    const sera = await char('세라', ['party:duty=교칙', 'party:place=교실']);
    const hayeon = await char('하연', ['party:duty=수업', 'party:place=교실']);
    const storyRes = await api('POST', '/api/stories', {
      name: '히어로 아카데미', tagline: 'S반', setting: '교실', minor_cast: [],
      scene_catalog: { places: [{ id: '교실', default_focus: 'nari' }], weathers: ['맑음'], arcs: ['entry'] },
    });
    const story = (storyRes.json as { id: string }).id;
    for (const [id, order] of [[hayeon.id, 0], [nari.id, 1], [sera.id, 2]] as const) {
      await api('POST', `/api/stories/${story}/characters`, { characterId: id, sortOrder: order });
    }
    const convRes = await api('POST', '/api/conversations', { characterId: hayeon.id, storyId: story, mode: 'story' });
    const conv = (convRes.json as { id: string }).id;
    const before = db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(conv) as { scene_json: string };

    const res = await fetch(`${origin}/api/conversations/${conv}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '중단할 턴' }),
    });
    const body = await res.text();
    assert.equal(res.status, 200, body);
    const types = sseTypes(body);
    assert.equal(types.includes('error'), false, `sse types: ${types.join(',')}`);
    assert.ok(types.includes('done'), `sse types: ${types.join(',')}`);
    assert.equal(errors.length, 0, `log.error was called: ${JSON.stringify(errors)}`);

    const msgs = db.prepare(
      `SELECT role, status, meta_json FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`,
    ).all(conv) as Array<{ role: string; status: string; meta_json: string }>;
    assert.equal(msgs.some((m) => m.status === 'error'), false);
    const assistants = msgs.filter((m) => m.role === 'assistant');
    assert.ok(assistants.length >= 1, 'header (or earlier) row remains');
    assert.equal(assistants.some((m) => parseJson<MessageMeta>(m.meta_json, {}).block_kind === 'line'), false,
      'focus line was not created');
    assert.equal(assistants.some((m) => parseJson<MessageMeta>(m.meta_json, {}).scene_state != null), false,
      'no completed snapshot');

    const after = db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(conv) as { scene_json: string };
    assert.equal(after.scene_json, before.scene_json, 'S2: abort does not commit scene');
    const scene = JSON.parse(after.scene_json) as Scene;
    assert.equal(typeof scene.clock_minutes, 'number');

    const active = await api('GET', '/api/generations/active');
    assert.equal((active.json as { active: unknown[]; queued: number }).active.length, 0);
    assert.equal((active.json as { queued: number }).queued, 0);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
