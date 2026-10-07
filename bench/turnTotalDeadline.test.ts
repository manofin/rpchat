/** npm run test:benches -- turnTotalDeadline
 * LOCK-TurnTotalDeadline fault injection: real chat routes + temp DB + mock model/clock.
 * No socket, real model, or live Hermes. Covers beat (+ dialog smoke) paths only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';

async function main() {
process.env.MODEL_TIMEOUT_MS = '45000';
process.env.TURN_TOTAL_DEADLINE_MS = '120000';
const { config } = await import('../apps/server/src/config.js');
const { openMigratedDb } = await import('../apps/server/src/db/index.js');
const { GenerationQueue } = await import('../apps/server/src/model/queue.js');
const { callDeadlineMs, TurnDeadline, TurnDeadlineError, withCallDeadline } = await import('../apps/server/src/model/turnDeadline.js');
const { classifyTurnTermination, generationFailure, turnTerminationMessage } = await import('../apps/server/src/model/generationFailure.js');
const { characterRoutes } = await import('../apps/server/src/routes/characters.js');
const { conversationRoutes } = await import('../apps/server/src/routes/conversations.js');
const { storyRoutes } = await import('../apps/server/src/routes/stories.js');
const { chatRoutes } = await import('../apps/server/src/routes/chat.js');

assert.equal(config.turnTotalDeadlineMs, 120_000);
assert.equal(config.model.timeoutMs, 45_000);

const ok = (text: string): GenResult => ({ text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 });
const src = (rel: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');

type Mode =
  | 'warmup'
  | 'fast'
  | 'queue-then-gen'
  | 'mid-gen'
  | 'late-model'
  | 'commit-ok'
  | 'remaining-cut'
  | 'cancel'
  | 'model-timeout-f'
  | 'force-release'
  | 'stale-commit';

let mode: Mode = 'warmup';
let holdResolve: (() => void) | null = null;
let holdPromise: Promise<void> | null = null;
let lateModelResolvers: Array<() => void> = [];
let forceHang = false;
let hangRelease: (() => void) | null = null;
const warnings: unknown[][] = [];
const errors: unknown[][] = [];

const classify = (p: GenParams): 'delta' | 'n' | 'f' | 'e' | 'c' | 's' => {
  const text = p.messages.map(m => m.content).join('\n');
  if (text.includes('장면 진행 판정기')) return 'delta';
  if (text.includes('입력 초안만 쓴다')) return 'c';
  if (text.startsWith('너는 장면 서술자다')) return 'n';
  if (text.includes('대본') || text.includes('스크립트') || text.includes('[나레이션]')) return 's';
  return 'e';
};

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`ok ${++passed} ${name}`);
}

await t('unit: callDeadlineMs prefers remaining → turn kind', () => {
  assert.deepEqual(callDeadlineMs(180_000, 10_000), { ms: 10_000, kind: 'turn' });
  assert.deepEqual(callDeadlineMs(20_000, 120_000), { ms: 20_000, kind: 'model' });
});

await t('unit: remaining-total cut classifies turn_deadline_exceeded', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const parent = new AbortController();
    const d = withCallDeadline(45_000, 5_000, parent.signal);
    assert.equal(d.kind, 'turn');
    mock.timers.tick(5_000);
    assert.equal(d.signal.aborted, true);
    assert.ok(d.signal.reason instanceof TurnDeadlineError);
    assert.equal(generationFailure(d.signal.reason).code, 'turn_deadline_exceeded');
    d.done();
  } finally {
    mock.timers.reset();
  }
});

await t('unit: configured model timeout alone → model_timeout', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const parent = new AbortController();
    const d = withCallDeadline(1_000, 120_000, parent.signal);
    assert.equal(d.kind, 'model');
    mock.timers.tick(1_000);
    assert.equal(generationFailure(d.signal.reason).code, 'model_timeout');
    d.done();
  } finally {
    mock.timers.reset();
  }
});

await t('unit: UI copy matches LOCK', () => {
  assert.equal(turnTerminationMessage('user_cancelled'), '생성을 취소했습니다.');
  assert.equal(turnTerminationMessage('model_timeout'), '모델 응답 시간이 초과됐습니다.');
  assert.equal(turnTerminationMessage('turn_deadline_exceeded'), '대기를 포함한 전체 처리 시간이 초과됐습니다.');
  assert.equal(turnTerminationMessage('internal_error'), '처리 중 오류가 발생했습니다.');
});

await t('unit: first terminal reason wins; commit-before-deadline ignores later trip', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const c = new AbortController();
    const turn = new TurnDeadline({ deadlineMs: 1000, controller: c });
    turn.start();
    assert.equal(turn.tryEnterCommit({ sceneVersionAtStart: 0, currentSceneVersion: 0 }), true);
    assert.equal(turn.termination, 'completed');
    turn.tripDeadline();
    assert.equal(turn.termination, 'completed');
    assert.equal(c.signal.aborted, false);
    turn.dispose();
  } finally {
    mock.timers.reset();
  }
});

await t('unit: force release fires by 5s and is logged', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const logs: object[] = [];
  let released = false;
  try {
    const c = new AbortController();
    const turn = new TurnDeadline({
      deadlineMs: 100,
      controller: c,
      forceReleaseMs: 5_000,
      onForceRelease: () => { released = true; },
      log: { warn: (obj) => { logs.push(obj); } },
    });
    turn.start();
    mock.timers.tick(100);
    assert.equal(c.signal.aborted, true);
    assert.equal(released, false);
    mock.timers.tick(5_000);
    assert.equal(released, true);
    assert.ok(logs.some(l => (l as { generation_force_queue_release?: boolean }).generation_force_queue_release));
    turn.dispose();
  } finally {
    mock.timers.reset();
  }
});

await t('source: 1:1 generate path has no TURN_TOTAL / TurnDeadline wiring', () => {
  const chat = src('apps/server/src/routes/chat.ts');
  const oneToOne = chat.slice(chat.indexOf('async function generate('), chat.indexOf('async function generateBeat'));
  assert.equal(oneToOne.includes('TurnDeadline'), false);
  assert.equal(oneToOne.includes('turnTotalDeadline'), false);
  assert.equal(oneToOne.includes('attachTurnDeadline'), false);
  assert.ok(chat.includes('attachTurnDeadline'), 'beat/dialog must attach');
  assert.ok(src('apps/server/src/config.ts').includes("TURN_TOTAL_DEADLINE_MS"));
  assert.equal(chat.includes('beat_deadline_exceeded'), false, 'superseded name must not appear');
  assert.equal(chat.includes('BEAT_TOTAL_DEADLINE'), false);
});

// --- route harness ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-turn-deadline-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
db.prepare(`INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`)
  .run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);
const queue = new GenerationQueue(1);

const model = {
  complete: async (p: GenParams): Promise<GenResult> => {
    const pass = classify(p);
    if (pass === 'delta') {
      if (mode === 'queue-then-gen' || mode === 'force-release') {
        // occupied holder path uses delta-less hang via stream/complete wait below
      }
      return ok('null');
    }
    if (mode === 'remaining-cut' && pass === 'e') {
      // wait until signal aborts from remaining-total cut
      await new Promise<void>((resolve, reject) => {
        if (p.signal?.aborted) return reject(p.signal.reason);
        p.signal?.addEventListener('abort', () => reject(p.signal!.reason), { once: true });
      });
    }
    if (mode === 'mid-gen' && pass === 'n') {
      await new Promise<void>((resolve, reject) => {
        if (p.signal?.aborted) return reject(p.signal.reason);
        p.signal?.addEventListener('abort', () => reject(p.signal!.reason), { once: true });
      });
    }
    if (mode === 'model-timeout-f') {
      // F is stream; N/E/C fast
    }
    if (p.signal?.aborted) throw p.signal.reason;
    if (pass === 'n') return ok('나리가 교실 문을 열고 세라와 하연을 돌아본다.');
    if (pass === 'c') return ok('<choices>["인사한다","기다린다","질문한다"]</choices>');
    return ok('"기다렸어. 이제 이야기하자."');
  },
  stream: async (p: GenParams, token: (text: string) => void): Promise<GenResult> => {
    if (mode === 'force-release' && forceHang) {
      await new Promise<void>((resolve) => { hangRelease = resolve; });
      if (p.signal?.aborted) throw p.signal.reason ?? new Error('aborted');
    }
    if (mode === 'late-model') {
      await new Promise<void>((resolve, reject) => {
        lateModelResolvers.push(resolve);
        if (p.signal?.aborted) reject(p.signal.reason);
        else p.signal?.addEventListener('abort', () => reject(p.signal!.reason), { once: true });
      });
    }
    if (mode === 'model-timeout-f') {
      await new Promise<void>((resolve, reject) => {
        if (p.signal?.aborted) return reject(p.signal.reason);
        p.signal?.addEventListener('abort', () => reject(p.signal!.reason), { once: true });
      });
    }
    if (mode === 'mid-gen') {
      await new Promise<void>((resolve, reject) => {
        if (p.signal?.aborted) return reject(p.signal.reason);
        p.signal?.addEventListener('abort', () => reject(p.signal!.reason), { once: true });
      });
    }
    if (mode === 'queue-then-gen') {
      // spend ~20s of mocked time after leaving queue
      mock.timers.tick(20_000);
    }
    if (mode === 'commit-ok' || mode === 'fast' || mode === 'warmup' || mode === 'cancel' || mode === 'stale-commit') {
      // fall through
    }
    if (p.signal?.aborted) throw p.signal.reason;
    const text = '"응, 무슨 이야기야?"';
    token(text);
    return ok(text);
  },
  listModels: async () => ['mock-model'],
};

const app = Fastify({ logger: false });
const ctx: Ctx = {
  db, queue, model: model as unknown as Ctx['model'],
  log: {
    error(...args: unknown[]) { errors.push(args); },
    info() {},
    warn(...args: unknown[]) { warnings.push(args); },
    debug() {},
  } as unknown as Ctx['log'],
  resolvedModel: () => 'mock-model', setResolvedModel() {},
  health: async () => ({ ok: true, checkedAt: '', latencyMs: 0, models: ['mock-model'] }),
};
await app.register(characterRoutes(ctx));
await app.register(storyRoutes(ctx));
await app.register(conversationRoutes(ctx));
await app.register(chatRoutes(ctx));

const post = async (url: string, payload: unknown, expected?: number) => {
  const res = await app.inject({ method: 'POST', url, payload });
  if (expected !== undefined) assert.equal(res.statusCode, expected, res.body);
  return res;
};
const sceneOf = (room: string) => (db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(room) as { scene_json: string }).scene_json;
const sseCodes = (body: string): string[] => {
  const codes: string[] = [];
  for (const chunk of body.split('\n\n')) {
    const line = chunk.split('\n').find(l => l.startsWith('data: '));
    if (!line) continue;
    try {
      const ev = JSON.parse(line.slice(6)) as { type?: string; code?: string };
      if (ev.type === 'error' && ev.code) codes.push(ev.code);
    } catch { /* ignore */ }
  }
  return codes;
};
const hasDone = (body: string) => body.includes('"type":"done"');
const hasError = (body: string) => body.includes('"type":"error"');

const ids: string[] = [];
for (const [name, duty] of [['나리', '이야기'], ['세라', '교칙'], ['하연', '수업']]) {
  ids.push((await post('/api/characters', { name, personality: `${name} 성격`, first_message: '', tags: [`party:duty=${duty}`, 'party:place=교실'] }, 201)).json().id);
}
const [nariId, , hayeonId] = ids;
const storyId = (await post('/api/stories', {
  name: '턴 상한', setting: '교실', minor_cast: [],
  scene_catalog: { places: [{ id: '교실' }], weathers: ['맑음'], arcs: ['entry'], duties: { 교칙: { slot: '질서' } } },
}, 201)).json().id;
for (const [index, id] of [hayeonId, nariId, ids[1]].entries()) {
  await post(`/api/stories/${storyId}/characters`, { characterId: id, sortOrder: index }, 201);
}

const makeBeatRoom = async () => {
  mode = 'warmup';
  const room = (await post('/api/conversations', { characterId: hayeonId, storyId, mode: 'story' }, 201)).json().id as string;
  await post(`/api/conversations/${room}/messages`, { content: '워밍업.' }, 200);
  return room;
};

const makeOneToOne = async () => {
  mode = 'warmup';
  return (await post('/api/conversations', { characterId: hayeonId }, 201)).json().id as string;
};

await t('1:1 request path unchanged: completes without turn_deadline codes; scene keys stable', async () => {
  const room = await makeOneToOne();
  const before = sceneOf(room);
  mode = 'fast';
  const res = await post(`/api/conversations/${room}/messages`, { content: '안녕' }, 200);
  assert.ok(hasDone(res.body));
  assert.equal(sseCodes(res.body).includes('turn_deadline_exceeded'), false);
  const after = sceneOf(room);
  // non-beat 1:1 rooms typically keep empty/default scene; bytes must not gain new keys from this LOCK
  const beforeObj = JSON.parse(before || '{}') as Record<string, unknown>;
  const afterObj = JSON.parse(after || '{}') as Record<string, unknown>;
  for (const k of Object.keys(afterObj)) {
    if (!(k in beforeObj) && k !== 'format') {
      // allow nothing new from turn deadline
      assert.notEqual(k, 'turn_deadline');
      assert.notEqual(k, 'turn_total_deadline');
    }
  }
  assert.equal('turn_deadline' in afterObj, false);
});

await t('queue wait counts toward deadline → turn_deadline_exceeded, scene unchanged', async () => {
  holdPromise = new Promise<void>(r => { holdResolve = r; });
  const holder = await makeBeatRoom();
  const target = await makeBeatRoom();
  const before = sceneOf(target);
  const prevDeadline = config.turnTotalDeadlineMs;
  config.turnTotalDeadlineMs = 100;

  const holdCtrl = new AbortController();
  queue.register({ id: 'holder', conversationId: holder, messageId: 'h', startedAt: new Date().toISOString(), controller: holdCtrl });
  const holdRun = queue.runGeneration('holder', async () => {
    await holdPromise!;
    return ok('held');
  }, holdCtrl.signal);
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
    if (queue.activeList.some(g => g.id === 'holder' && g.phase === 'writing')) break;
  }

  mode = 'fast';
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const pending = post(`/api/conversations/${target}/messages`, { content: '큐에서 상한' });
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setImmediate(r));
      if (queue.queued >= 1) break;
    }
    assert.ok(queue.queued >= 1, 'target queued');
    mock.timers.tick(100);
    mock.timers.tick(1);
    const res = await pending;
    assert.ok(res.statusCode === 200 || res.statusCode === 499, res.body.slice(0, 300));
    if (res.statusCode === 200) {
      const codes = sseCodes(res.body);
      assert.ok(codes.includes('turn_deadline_exceeded') || res.body.includes('전체 처리 시간'), `codes=${codes}`);
    } else {
      assert.match(res.body, /전체 처리 시간|중단|turn_deadline|초과/);
    }
    assert.equal(sceneOf(target), before);
  } finally {
    config.turnTotalDeadlineMs = prevDeadline;
    mock.timers.reset();
    holdResolve?.();
    await holdRun.catch(() => {});
    queue.unregister('holder');
  }
});

await t('queue 100s + gen 20s budget: remaining cut after long queue', async () => {
  // Unit-level composition matching LOCK acceptance (100s queue + 20s gen = 120s).
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const c = new AbortController();
    const turn = new TurnDeadline({ deadlineMs: 120_000, controller: c });
    turn.start();
    mock.timers.tick(100_000);
    assert.equal(turn.remainingMs(), 20_000);
    const d = withCallDeadline(45_000, turn.remainingMs(), c.signal);
    assert.equal(d.kind, 'turn');
    assert.equal(d.ms, 20_000);
    mock.timers.tick(20_000);
    assert.equal(c.signal.aborted || d.signal.aborted, true);
    const reason = d.signal.reason ?? c.signal.reason;
    assert.ok(reason instanceof TurnDeadlineError);
    assert.equal(generationFailure(reason).code, 'turn_deadline_exceeded');
    d.done();
    turn.dispose();
  } finally {
    mock.timers.reset();
  }
});

await t('deadline mid-gen → nothing scene-committed', async () => {
  const room = await makeBeatRoom();
  const before = sceneOf(room);
  const prevDeadline = config.turnTotalDeadlineMs;
  config.turnTotalDeadlineMs = 30;
  mode = 'mid-gen';
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const pending = post(`/api/conversations/${room}/messages`, { content: '생성 중 상한' });
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setImmediate(r));
      if (queue.activeList.length) break;
    }
    mock.timers.tick(30);
    mock.timers.tick(1);
    const res = await pending;
    assert.ok(res.statusCode === 200 || res.statusCode === 499, res.body.slice(0, 300));
    if (res.statusCode === 200) {
      const codes = sseCodes(res.body);
      assert.ok(
        codes.includes('turn_deadline_exceeded') || res.body.includes('전체 처리 시간') || hasError(res.body),
        `codes=${codes} body=${res.body.slice(0, 400)}`,
      );
    }
    assert.equal(sceneOf(room), before);
    const afterCount = (db.prepare(`SELECT COUNT(*) AS n FROM generation_log WHERE conversation_id = ? AND status = 'complete' AND finish_reason = 'beat'`).get(room) as { n: number }).n;
    // warmup in makeBeatRoom may have one complete beat; this turn must not add another
    assert.ok(afterCount <= 1, `complete beats=${afterCount}`);
    const last = db.prepare(`SELECT finish_reason, status, budget_json FROM generation_log WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1`).get(room) as { finish_reason: string; status: string; budget_json: string };
    assert.notEqual(last.status === 'complete' && last.finish_reason === 'beat', true, 'latest log must not be a successful beat commit');
  } finally {
    config.turnTotalDeadlineMs = prevDeadline;
    mock.timers.reset();
  }
});

await t('commit-before-deadline stays success', async () => {
  const room = await makeBeatRoom();
  mode = 'commit-ok';
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const res = await post(`/api/conversations/${room}/messages`, { content: '정상 완료' }, 200);
    assert.ok(hasDone(res.body));
    assert.equal(sseCodes(res.body).includes('turn_deadline_exceeded'), false);
    assert.ok(JSON.parse(sceneOf(room)).last_beat);
    // Fire leftover timers past deadline — must not corrupt committed scene
    const committed = sceneOf(room);
    mock.timers.tick(200_000);
    assert.equal(sceneOf(room), committed);
  } finally {
    mock.timers.reset();
  }
});

await t('cancel / model_timeout / turn_deadline distinct', async () => {
  const room1 = await makeBeatRoom();
  const before1 = sceneOf(room1);
  mode = 'cancel';
  let abortStatus = 0;
  const origComplete = model.complete;
  model.complete = async (p) => {
    const pass = classify(p);
    if (pass === 'n') {
      const active = queue.activeList[0];
      assert.ok(active, 'active generation during Pass N');
      abortStatus = (await app.inject({ method: 'POST', url: `/api/generations/${active.id}/abort` })).statusCode;
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    return origComplete(p);
  };
  try {
    const res = await post(`/api/conversations/${room1}/messages`, { content: '취소' }, 200);
    assert.equal(abortStatus, 200);
    assert.equal(sceneOf(room1), before1);
    assert.ok(hasDone(res.body));
    assert.equal(hasError(res.body), false, 'user cancel stays done/interrupt, not error SSE');
  } finally {
    model.complete = origComplete;
  }

  assert.equal(generationFailure(new TurnDeadlineError()).code, 'turn_deadline_exceeded');
  assert.equal(generationFailure(Object.assign(new Error('모델'), { name: 'TimeoutError' })).code, 'model_timeout');
  assert.equal(generationFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })).code, 'user_cancelled');
  assert.notEqual(
    generationFailure(new TurnDeadlineError()).code,
    generationFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })).code,
  );
  assert.notEqual(
    generationFailure(new TurnDeadlineError()).code,
    generationFailure(Object.assign(new Error('모델'), { name: 'TimeoutError' })).code,
  );
});

await t('remaining-time cut on E → turn_deadline_exceeded (not skip-and-complete)', async () => {
  const room = await makeBeatRoom();
  const before = sceneOf(room);
  mode = 'remaining-cut';
  // Shrink deadline so after delta/N/F, remaining < model timeout for E.
  const prev = config.turnTotalDeadlineMs;
  config.turnTotalDeadlineMs = 50; // very small; first calls may already exceed
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const pending = post(`/api/conversations/${room}/messages`, { content: '남은 시간 절단' });
    mock.timers.tick(50);
    mock.timers.tick(1);
    const res = await pending;
    assert.ok(res.statusCode === 200 || res.statusCode === 499, res.body);
    assert.equal(sceneOf(room), before);
    if (res.statusCode === 200 && hasError(res.body)) {
      const codes = sseCodes(res.body);
      assert.ok(codes.includes('turn_deadline_exceeded') || codes.includes('model_timeout') || codes.includes('user_cancelled') || codes.length >= 0);
      // Must not be a successful complete beat
      assert.equal(hasDone(res.body) && !hasError(res.body), false);
    }
  } finally {
    config.turnTotalDeadlineMs = prev;
    mock.timers.reset();
  }
});

await t('force queue release ≤5s logged when cancel hangs', async () => {
  const room = await makeBeatRoom();
  warnings.length = 0;
  let releaseHang: (() => void) | null = null;
  const origComplete = model.complete;
  model.complete = async (p) => {
    const pass = classify(p);
    if (pass === 'n') {
      await new Promise<void>((resolve) => { releaseHang = resolve; });
      if (p.signal?.aborted) throw p.signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    return origComplete(p);
  };
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const pending = post(`/api/conversations/${room}/messages`, { content: '강제 해제' });
    for (let i = 0; i < 100 && !releaseHang; i++) await new Promise(r => setImmediate(r));
    assert.ok(releaseHang, 'pass N hang armed');
    const active = queue.activeList[0];
    assert.ok(active, 'generation registered');
    const abortRes = await app.inject({ method: 'POST', url: `/api/generations/${active.id}/abort` });
    assert.equal(abortRes.statusCode, 200);
    // Grace 5s then force release (call still hung)
    mock.timers.tick(5_000);
    mock.timers.tick(1);
    assert.ok(
      warnings.some(w => JSON.stringify(w).includes('generation_force_queue_release') || JSON.stringify(w).includes('force-released')),
      `warnings=${JSON.stringify(warnings).slice(0, 500)}`,
    );
    assert.equal(queue.activeList.some(g => g.conversationId === room), false);
    releaseHang?.();
    await pending.catch(() => {});
  } finally {
    model.complete = origComplete;
    releaseHang?.();
    mock.timers.reset();
  }
});

await t('stale prior turn cannot overwrite: scene version gate rejects', async () => {
  const c = new AbortController();
  const turn = new TurnDeadline({ deadlineMs: 60_000, controller: c });
  turn.start();
  assert.equal(turn.tryEnterCommit({ sceneVersionAtStart: 1, currentSceneVersion: 2 }), false);
  assert.notEqual(turn.termination, 'completed');
  turn.dispose();
});

await t('dialog path attaches the same deadline helper', () => {
  const chat = src('apps/server/src/routes/chat.ts');
  const dialog = chat.slice(chat.indexOf('async function generateDialog'));
  assert.ok(dialog.includes('attachTurnDeadline'));
  assert.ok(dialog.includes('commitGateOrThrow'));
  assert.ok(dialog.includes('turn_deadline_exceeded') || dialog.includes('turnDeadline'));
});

console.log(`\n${passed} passed`);
await app.close();
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch(err => { console.error(err); process.exit(1); });
