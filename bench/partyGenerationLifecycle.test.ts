/**
 * npx tsx bench/partyGenerationLifecycle.test.ts
 * LOCK PartyGenerationLifecycle — scene-delta wait is on activeList with an
 * AbortSignal. Isolated: no systemd, no live DB, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import { chatRoutes } from '../apps/server/src/routes/chat.ts';
import { THOUGHT_MARKER } from '../apps/server/src/prompt/passes.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import type { Scene } from '../apps/server/src/types.ts';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.ts';
import { ApiError, sendOkForComposer } from '../apps/web/src/lib/api.ts';

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

function abortErr(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

const DIALOG_SCRIPT = '나리 | "대사입니다."\n<choices>["가","나","다"]</choices>';

async function waitUntil(pred: () => boolean, label: string) {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < 4000) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.ok(pred(), label);
}

async function main() {
  await t('register-before-await invariant holds for beat and dialog', () => {
    const s = code('apps/server/src/routes/chat.ts');
    const beat = s.slice(s.indexOf('async function generateBeat'), s.indexOf('async function generateDialog'));
    const dialog = s.slice(s.indexOf('async function generateDialog'));
    for (const [name, fn] of [['beat', beat], ['dialog', dialog]] as const) {
      const reg = fn.indexOf('ctx.queue.register');
      const firstAwait = fn.search(/await ctx\.queue\.run/);
      assert.ok(reg >= 0, `${name} registers`);
      assert.ok(firstAwait >= 0, `${name} awaits queue.run`);
      assert.ok(reg < firstAwait, `${name} register at ${reg} before first await at ${firstAwait}`);
      const firstComplete = fn.slice(firstAwait, firstAwait + 700);
      assert.ok(firstComplete.includes('signal: controller.signal'), `${name} first complete is abortable`);
    }
  });

  await t('stop looks up activeGeneration when SSE has not started', () => {
    const web = code('apps/web/src/pages/useChat.ts');
    const stop = web.slice(web.indexOf('const stop = useCallback'), web.indexOf('const selectSibling'));
    assert.ok(stop.includes('activeGeneration'));
    assert.ok(stop.includes('abortGeneration(gid)'));
    assert.ok(web.includes('sendOkForComposer'));
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-party-gen-life-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  const errors: unknown[][] = [];
  let origin = '';
  let holdDelta = false;
  let deltaHeld = false;
  let deltaRelease: (() => void) | undefined;
  const completePrompts: string[] = [];

  const model = {
    complete: async (p: GenParams): Promise<GenResult> => {
      const prompt = String(p.messages?.[0]?.content ?? '');
      completePrompts.push(prompt.slice(0, 80));
      if (prompt.includes('장면 진행 판정기')) {
        if (holdDelta) {
          await new Promise<void>((resolve, reject) => {
            const fail = () => reject(abortErr());
            if (p.signal?.aborted) return fail();
            deltaRelease = resolve;
            p.signal?.addEventListener('abort', fail, { once: true });
            deltaHeld = true;
          });
        }
        return ok(JSON.stringify({ base_version: versionOf(prompt), advance_minutes: 10, weather: '맑음' }));
      }
      if (prompt.includes('입력 초안만 쓴다')) return ok('<choices>["가","나","다"]</choices>');
      if (prompt.includes('너는 장면 서술자다') || prompt.includes('군중') || prompt.startsWith('당신은 카메라')) {
        return ok('서술이 이어진다.');
      }
      return ok('"교칙이야."');
    },
    stream: async (p: GenParams, onToken: (d: string) => void): Promise<GenResult> => {
      const prompt = String(p.messages?.[0]?.content ?? '');
      const text = prompt.includes('대본으로 쓴다')
        ? DIALOG_SCRIPT
        : `"……짝꿍?"\n${THOUGHT_MARKER} 왜 안 피하지.`;
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

    const newConv = async (format?: 'dialog') => {
      const convRes = await api('POST', '/api/conversations', { characterId: hayeon.id, storyId: story, mode: 'story' });
      const id = (convRes.json as { id: string }).id;
      if (format === 'dialog') {
        const patch = await api('PATCH', `/api/conversations/${id}`, {
          scene: { format: 'dialog', location: '교실', present_ids: [hayeon.id, nari.id, sera.id] },
        });
        assert.equal(patch.status, 200, patch.text);
      }
      return id;
    };

    const sceneOf = (id: string) =>
      (db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(id) as { scene_json: string }).scene_json;

    const userCount = (id: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user'`).get(id) as { n: number }).n;

    const assistantCount = (id: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'assistant'`).get(id) as { n: number }).n;

    async function secondSendRejected(conv: string, label: string) {
      holdDelta = true;
      deltaHeld = false;
      const first = fetch(`${origin}/api/conversations/${conv}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `${label} hold` }),
      });
      await waitUntil(() => deltaHeld, `${label} delta is held; prompts=${JSON.stringify(completePrompts)}`);
      const active = await api('GET', '/api/generations/active');
      assert.equal((active.json as { active: unknown[] }).active.length, 1, `${label} registered during delta`);
      const second = await api('POST', `/api/conversations/${conv}/messages`, { content: `${label} nope` });
      assert.equal(second.status, 409, second.text);
      holdDelta = false;
      deltaRelease?.();
      assert.equal((await first).status, 200);
      assert.equal(userCount(conv), 1, `${label} 2nd send retracted`);
    }

    async function abortDuringDelta(conv: string, label: string) {
      const before = sceneOf(conv);
      holdDelta = true;
      deltaHeld = false;
      errors.length = 0;
      const first = fetch(`${origin}/api/conversations/${conv}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `${label} abort` }),
      });
      await waitUntil(() => deltaHeld, `${label} delta is held for abort`);
      const active = await api('GET', '/api/generations/active');
      const gid = (active.json as { active: Array<{ id: string }> }).active[0]?.id;
      assert.ok(gid, `${label} generation id during delta`);
      const abortRes = await api('POST', `/api/generations/${gid}/abort`);
      assert.equal(abortRes.status, 200, abortRes.text);
      const res = await first;
      assert.equal(res.status, 499, await res.text());
      holdDelta = false;
      const afterActive = await api('GET', '/api/generations/active');
      assert.equal((afterActive.json as { active: unknown[]; queued: number }).active.length, 0);
      assert.equal((afterActive.json as { queued: number }).queued, 0);
      assert.equal(errors.length, 0, `${label} abort must not log.error`);
      assert.equal(userCount(conv), 1, `${label} user row kept`);
      assert.equal(assistantCount(conv), 0, `${label} no assistant rows`);
      assert.equal(sceneOf(conv), before, `${label} scene unchanged`);
      const errMsgs = db.prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND status = 'error'`,
      ).get(conv) as { n: number };
      assert.equal(errMsgs.n, 0);
    }

    const beat409 = await newConv();
    await t('beat delayed scene-delta 2nd send is 409', () => secondSendRejected(beat409, 'beat'));

    const beatAbort = await newConv();
    await t('beat abort during scene-delta stops and unregisters', () => abortDuringDelta(beatAbort, 'beat'));

    const dialog409 = await newConv('dialog');
    await t('dialog delayed scene-delta 2nd send is 409', () => secondSendRejected(dialog409, 'dialog'));

    const dialogAbort = await newConv('dialog');
    await t('dialog abort during scene-delta stops and unregisters', () => abortDuringDelta(dialogAbort, 'dialog'));

    async function planAssemblyBoom(conv: string, label: string) {
      const orig = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM characters WHERE id IN')) {
          throw new Error(`${label} plan assembly boom`);
        }
        return orig(sql);
      }) as typeof db.prepare;
      let res: { status: number; text: string };
      try {
        res = await api('POST', `/api/conversations/${conv}/messages`, { content: `${label} plan boom` });
      } finally {
        db.prepare = orig as typeof db.prepare;
      }
      assert.equal(res.status, 500, `${label} plan boom status ${res.status} ${res.text}`);
      const afterActive = await api('GET', '/api/generations/active');
      assert.equal((afterActive.json as { active: unknown[]; queued: number }).active.length, 0, `${label} active after plan boom`);
      assert.equal((afterActive.json as { queued: number }).queued, 0, `${label} queued after plan boom`);
      const retry = await api('POST', `/api/conversations/${conv}/messages`, { content: `${label} retry` });
      assert.equal(retry.status, 200, `${label} retry after plan boom: ${retry.text}`);
    }

    const beatPlan = await newConv();
    await t('beat plan-assembly exception unregisters and next send works', () => planAssemblyBoom(beatPlan, 'beat'));

    const dialogPlan = await newConv('dialog');
    await t('dialog plan-assembly exception unregisters and next send works', () => planAssemblyBoom(dialogPlan, 'dialog'));

    await t('explicit abort 499 does not restore composer; HTTP fail does', () => {
      assert.equal(sendOkForComposer(new ApiError(499, '생성이 중단되었습니다'), false), true);
      assert.equal(sendOkForComposer(new ApiError(503, '모델 없음'), false), false);
      assert.equal(sendOkForComposer(new Error('network drop'), false), true);
      assert.equal(sendOkForComposer(new ApiError(500, 'x'), true), true);
    });

    await t('1:1 path still completes', async () => {
      const convRes = await api('POST', '/api/conversations', { characterId: hayeon.id, mode: 'chat' });
      assert.equal(convRes.status, 201, convRes.text);
      const id = (convRes.json as { id: string }).id;
      const res = await fetch(`${origin}/api/conversations/${id}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '안녕' }),
      });
      const body = await res.text();
      assert.equal(res.status, 200, body);
      assert.ok(assistantCount(id) >= 1, '1:1 assistant persisted');
      const scene = JSON.parse(sceneOf(id) || '{}') as Scene;
      assert.notEqual(scene.format, 'beat');
    });
  } finally {
    await app.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
