/** npm run test:benches -- auxiliaryTimeout
 * Real chat routes + isolated migrated DB; the model and clock are controlled.
 * No socket, real model, or live data. Optional E deadlines follow MODEL_TIMEOUT_MS.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import Fastify from 'fastify';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';

async function main() {
// Config reads environment at module load; keep this before all product imports.
process.env.MODEL_TIMEOUT_MS = '45000';
const { config } = await import('../apps/server/src/config.js');
const { openMigratedDb } = await import('../apps/server/src/db/index.js');
const { GenerationQueue } = await import('../apps/server/src/model/queue.js');
const { characterRoutes } = await import('../apps/server/src/routes/characters.js');
const { conversationRoutes } = await import('../apps/server/src/routes/conversations.js');
const { storyRoutes } = await import('../apps/server/src/routes/stories.js');
const { chatRoutes } = await import('../apps/server/src/routes/chat.js');

type Mode = 'warmup' | 'slow-extras' | 'timeout' | 'abort' | 'n-timeout' | 'c-timeout';
type Pass = 'delta' | 'n' | 'f' | 'e' | 'c';
type Call = { pass: Pass; signal?: AbortSignal; beforeDeadline?: boolean; atDeadline?: boolean; reason?: unknown };
type Row = { role: string; status: string; content: string; meta_json: string };
const ok = (text: string): GenResult => ({ text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-aux-timeout-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
db.prepare(`INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`)
  .run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);
const queue = new GenerationQueue(1);
let mode: Mode = 'warmup';
const calls: Call[] = [];
const errors: unknown[][] = [];
const app = Fastify({ logger: false });
const classify = (p: GenParams): Pass => {
  const text = p.messages.map(m => m.content).join('\n');
  if (text.includes('장면 진행 판정기')) return 'delta';
  if (text.includes('입력 초안만 쓴다')) return 'c';
  if (text.startsWith('너는 장면 서술자다')) return 'n';
  return 'e';
};
let parentAbortStatus: number | null = null;
let concurrent = 0;
let peakConcurrent = 0;
const model = {
  complete: async (p: GenParams): Promise<GenResult> => {
    const pass = classify(p);
    const call: Call = { pass, signal: p.signal };
    calls.push(call);
    concurrent++;
    peakConcurrent = Math.max(peakConcurrent, concurrent);
    try {
      if (pass === 'delta') return ok('null');
      if (pass === 'e' && mode === 'slow-extras') {
        mock.timers.tick(config.model.timeoutMs - 1);
        call.beforeDeadline = Boolean(p.signal?.aborted);
      }
      if ((pass === 'e' && mode === 'timeout') || (pass === 'n' && mode === 'n-timeout') || (pass === 'c' && mode === 'c-timeout')) {
        const limit = pass === 'e' ? config.model.timeoutMs : 20_000;
        mock.timers.tick(limit - 1);
        call.beforeDeadline = Boolean(p.signal?.aborted);
        mock.timers.tick(1);
        call.atDeadline = Boolean(p.signal?.aborted);
        call.reason = p.signal?.reason;
      }
      if (pass === 'e' && mode === 'abort') {
        mock.timers.tick(1000);
        const active = queue.activeList.find(g => g.kind !== 'ending-judge');
        parentAbortStatus = active
          ? (await app.inject({ method: 'POST', url: `/api/generations/${active.id}/abort` })).statusCode
          : 0;
        call.atDeadline = Boolean(p.signal?.aborted);
      }
      if (p.signal?.aborted) throw p.signal.reason;
      if (pass === 'n') return ok('나리가 교실 문을 열고 세라와 하연을 돌아본다.');
      if (pass === 'c') return ok('<choices>["인사한다","기다린다","질문한다"]</choices>');
      return ok('"기다렸어. 이제 이야기하자."');
    } finally {
      concurrent--;
    }
  },
  stream: async (p: GenParams, token: (text: string) => void): Promise<GenResult> => {
    calls.push({ pass: 'f', signal: p.signal });
    const text = '"응, 무슨 이야기야?"';
    token(text);
    return ok(text);
  },
  listModels: async () => ['mock-model'],
};
const ctx: Ctx = {
  db, queue, model: model as unknown as Ctx['model'],
  log: { error(...args: unknown[]) { errors.push(args); }, info() {}, warn() {}, debug() {} } as unknown as Ctx['log'],
  resolvedModel: () => 'mock-model', setResolvedModel() {},
  health: async () => ({ ok: true, checkedAt: '', latencyMs: 0, models: ['mock-model'] }),
};
await app.register(characterRoutes(ctx));
await app.register(storyRoutes(ctx));
await app.register(conversationRoutes(ctx));
await app.register(chatRoutes(ctx));

let passed = 0;
async function t(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`ok ${++passed} ${name}`);
}
const post = async (url: string, payload: unknown, expected = 201) => {
  const res = await app.inject({ method: 'POST', url, payload });
  assert.equal(res.statusCode, expected, res.body);
  return res;
};
let storyId: string;
let nariId: string;
let hayeonId: string;
const makeRoom = async () => {
  mode = 'warmup';
  const room = (await post('/api/conversations', { characterId: hayeonId, storyId, mode: 'story' })).json().id as string;
  await post(`/api/conversations/${room}/messages`, { content: '첫 인사를 나눈다.' }, 200);
  calls.length = 0;
  return room;
};
const sceneOf = (room: string) => (db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(room) as { scene_json: string }).scene_json;
const send = async (room: string, nextMode: Mode) => {
  mode = nextMode;
  errors.length = 0;
  parentAbortStatus = null;
  peakConcurrent = 0;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const beforeCount = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(room) as { n: number }).n;
    const res = await post(`/api/conversations/${room}/messages`, { content: '나리, 네 이야기 말인데.' }, 200);
    const rows = (db.prepare('SELECT role, status, content, meta_json FROM messages WHERE conversation_id = ? ORDER BY rowid').all(room) as Row[]).slice(beforeCount);
    assert.match(res.body, /"type":"done"/);
    assert.doesNotMatch(res.body, /"type":"error"/);
    assert.deepEqual(queue.activeList, []);
    assert.equal(queue.queued, 0);
    assert.equal(peakConcurrent, 1, 'model calls remain serial');
    assert.deepEqual(errors, []);
    mock.timers.tick(config.model.timeoutMs + 20_001);
    return rows;
  } finally {
    mock.timers.reset();
  }
};
const lines = (rows: Row[]) => rows.filter(row => JSON.parse(row.meta_json).block_kind === 'line');
const extras = () => calls.filter(call => call.pass === 'e');
const checkOptionalCompletion = (rows: Row[], room: string) => {
  assert.equal(rows.some(row => row.status === 'error' || row.status === 'interrupted'), false);
  const scene = JSON.parse(sceneOf(room));
  assert.equal(scene.last_beat.focus_id, nariId);
  const start = rows.find(row => JSON.parse(row.meta_json).scene_state);
  assert.ok(start, 'completed beat has a branch snapshot');
  assert.deepEqual(JSON.parse(start.meta_json).scene_state.after_delta, scene);
  assert.equal(calls.at(-1)?.pass, 'c');
};

try {
  assert.equal(config.model.timeoutMs, 45_000, 'MODEL_TIMEOUT_MS is actually loaded');
  const ids: string[] = [];
  for (const [name, duty] of [['나리', '이야기'], ['세라', '교칙'], ['하연', '수업']]) {
    ids.push((await post('/api/characters', { name, personality: `${name} 성격`, first_message: '', tags: [`party:duty=${duty}`, 'party:place=교실'] })).json().id);
  }
  [nariId, , hayeonId] = ids;
  storyId = (await post('/api/stories', {
    name: '합성 시간 제한', setting: '교실', minor_cast: [],
    scene_catalog: { places: [{ id: '교실' }], weathers: ['맑음'], arcs: ['entry'], duties: { 교칙: { slot: '질서' } } },
  })).json().id;
  for (const [index, id] of [hayeonId, nariId, ids[1]].entries()) {
    await post(`/api/stories/${storyId}/characters`, { characterId: id, sortOrder: index });
  }

  await t('each extra may finish after 15s and before the configured 45s; completed deadlines are cleared', async () => {
    const room = await makeRoom();
    const rows = await send(room, 'slow-extras');
    assert.equal(extras().length, 2);
    assert.deepEqual(extras().map(call => call.beforeDeadline), [false, false]);
    assert.equal(lines(rows).length, 3, 'both slow extras are persisted beside the focus');
    assert.deepEqual(calls.filter(call => ['n', 'e', 'c'].includes(call.pass)).map(call => call.signal?.aborted), [false, false, false, false], 'timers cannot abort completed calls');
    checkOptionalCompletion(rows, room);
  });

  await t('configured E deadline aborts the model, omits only extras and leaves choices + scene complete', async () => {
    const room = await makeRoom();
    const rows = await send(room, 'timeout');
    assert.equal(extras().length, 2);
    for (const call of extras()) {
      assert.equal(call.beforeDeadline, false);
      assert.equal(call.atDeadline, true);
      assert.match(String(call.reason), /pass timeout/);
    }
    assert.equal(lines(rows).length, 1);
    assert.equal(JSON.parse(lines(rows)[0].meta_json).speaker_character_id, nariId);
    assert.ok(rows.some(row => JSON.parse(row.meta_json).choices?.length === 3));
    checkOptionalCompletion(rows, room);
  });

  await t('E also respects a configured limit shorter than the old fixed timeout', async () => {
    const room = await makeRoom();
    const previous = config.model.timeoutMs;
    config.model.timeoutMs = 1000;
    try {
      const rows = await send(room, 'timeout');
      assert.equal(extras().length, 2);
      assert.deepEqual(extras().map(call => [call.beforeDeadline, call.atDeadline]), [[false, true], [false, true]]);
      assert.equal(lines(rows).length, 1);
      checkOptionalCompletion(rows, room);
    } finally { config.model.timeoutMs = previous; }
  });

  await t('parent abort during E stops later passes, preserves scene and interrupts the focus', async () => {
    const room = await makeRoom();
    const before = sceneOf(room);
    const rows = await send(room, 'abort');
    assert.equal(parentAbortStatus, 200);
    assert.equal(extras().length, 1);
    assert.equal(extras()[0].atDeadline, true);
    assert.equal(calls.some(call => call.pass === 'c'), false);
    assert.equal(sceneOf(room), before);
    assert.equal(lines(rows).length, 1);
    assert.equal(lines(rows)[0].status, 'interrupted');
    assert.equal(JSON.parse(lines(rows)[0].meta_json).finish_reason, 'aborted');
  });

  await t('Pass N retains its 20s deadline and optional narration failure', async () => {
    const room = await makeRoom();
    const rows = await send(room, 'n-timeout');
    const call = calls.find(call => call.pass === 'n')!;
    assert.equal(call.beforeDeadline, false);
    assert.equal(call.atDeadline, true);
    assert.equal(rows.some(row => JSON.parse(row.meta_json).block_kind === 'narration'), false);
    assert.equal(lines(rows).length, 3);
    checkOptionalCompletion(rows, room);
  });

  await t('Pass C retains its 20s deadline and optional choices failure', async () => {
    const room = await makeRoom();
    const rows = await send(room, 'c-timeout');
    const call = calls.find(call => call.pass === 'c')!;
    assert.equal(call.beforeDeadline, false);
    assert.equal(call.atDeadline, true);
    assert.equal(rows.some(row => JSON.parse(row.meta_json).choices?.length), false);
    assert.equal(lines(rows).length, 3);
    checkOptionalCompletion(rows, room);
  });
  console.log(`\n${passed} passed`);
} finally {
  mock.timers.reset();
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

}
main().catch(error => { console.error(error); process.exit(1); });
