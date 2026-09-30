/** npm run test:benches -- endingJudgeVisibility
 * Temp DB and fake model only. Judge visibility, route gates, cancellation,
 * slot-relative timeout, and cleanup are exercised without live generation.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { insertMessage, setHead } from '../apps/server/src/db/tree.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { fireEndingEvalJob } from '../apps/server/src/endingJudge.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { chatRoutes } from '../apps/server/src/routes/chat.ts';
import { memoryRoutes } from '../apps/server/src/routes/memory.ts';
import { healthRoutes } from '../apps/server/src/routes/health.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.ts';

let checks = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(predicate: () => boolean, label: string) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await sleep(5);
  }
}
async function t(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`ok ${++checks} ${name}`);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
const result = (text = JSON.stringify({ evals: [{ ending_id: 'h1', eligible: true, confidence: 1, reason: 'met' }] })): GenResult =>
  ({ text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 });

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-judge-visibility-'));
  const db = openMigratedDb(dir, path.resolve('apps/server/migrations'));
  const queue = new GenerationQueue(1);
  const logs: Array<Record<string, unknown>> = [];
  let calls = 0;
  let complete: (p: GenParams) => Promise<GenResult> = async () => result();
  const ctx = {
    db, queue,
    model: { complete: (p: GenParams) => { calls++; return complete(p); } },
    log: { error() {}, warn() {}, debug() {}, info: (obj: Record<string, unknown>) => logs.push(obj) },
    resolvedModel: () => 'fixture-model', setResolvedModel() {},
    health: async () => ({ ok: true, checkedAt: 'fixture', latencyMs: 0, models: ['fixture-model'] }),
  } as unknown as Ctx;
  const app = Fastify({ logger: false });
  await app.register(characterRoutes(ctx));
  await app.register(storyRoutes(ctx));
  await app.register(conversationRoutes(ctx));
  await app.register(chatRoutes(ctx));
  await app.register(memoryRoutes(ctx));
  await app.register(healthRoutes(ctx));
  const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  try {
    const ch = (await api('POST', '/api/characters', { name: '검증 인물', first_message: '인사' })).json();
    const story = (await api('POST', '/api/stories', { name: '검증 이야기', setting: '장면' })).json();
    const updated = await api('PUT', `/api/stories/${story.id}`, {
      name: '검증 이야기', setting: '장면', tagline: '', minor_cast: [],
      endings: [{ id: 'h1', title: '재회', conditions: { min_turns: 1, narrative_hint: '재회했다' } }],
    });
    assert.equal(updated.statusCode, 200, updated.body);
    const conv = (await api('POST', '/api/conversations', { characterId: ch.id, storyId: story.id })).json();
    const user = insertMessage(db, conv.id, conv.head_message_id, 'user', '재회', 'complete', {});
    const answer = insertMessage(db, conv.id, user.id, 'assistant', '다시 만났다', 'complete', {});
    setHead(db, conv.id, answer.id);
    const count = () => (db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_id = ?').get(conv.id) as { n: number }).n;
    const idle = () => until(() => queue.activeList.length === 0, 'judge registry cleanup');

    await t('queued judge is visible before its model call and cleans up after success', async () => {
      const hold = deferred();
      const occupied = queue.run(() => hold.promise);
      const before = calls;
      const logStart = logs.length;
      fireEndingEvalJob(ctx, conv.id);
      try {
        assert.equal(queue.activeList.length, 1);
        assert.equal(queue.activeList[0].kind, 'ending-judge');
        assert.equal(queue.activeList[0].conversationId, conv.id);
        assert.equal(queue.queued, 1);
        assert.equal(calls, before);
      } finally { hold.resolve(); await occupied; }
      await idle();
      assert.equal(calls, before + 1);
      assert.equal(logs.length, logStart + 1);
      assert.equal(logs.at(-1)?.llm_called, 1);
      assert.equal(logs.at(-1)?.eligible, true);
    });

    await t('judge fired inside occupied chat callback finishes without a nested-queue deadlock', async () => {
      const before = calls;
      await queue.run(async () => { fireEndingEvalJob(ctx, conv.id); });
      await idle();
      assert.equal(calls, before + 1);
      assert.equal(queue.queued, 0);
    });

    await t('running judge blocks same-room writes without rows and is visible in health/active', async () => {
      const hold = deferred();
      complete = async () => { await hold.promise; return result(); };
      const n = count();
      fireEndingEvalJob(ctx, conv.id);
      try {
        const active = (await api('GET', '/api/generations/active')).json().active;
        assert.equal(active.length, 1);
        assert.equal(active[0].kind, 'ending-judge');
        const health = (await api('GET', '/api/health')).json();
        assert.equal(health.generation.active[0].id, active[0].id);
        assert.equal(health.generation.active[0].kind, 'ending-judge');
        const detail = (await api('GET', `/api/conversations/${conv.id}`)).json();
        assert.equal(detail.activeGeneration, null, 'judge must not look like a recoverable streaming response');
        for (const [method, url, body] of [
          ['POST', `/api/conversations/${conv.id}/messages`, { content: '중복 전송' }],
          ['POST', `/api/conversations/${conv.id}/summarize`, {}],
          ['POST', `/api/messages/${answer.id}/select`, {}],
          ['DELETE', `/api/conversations/${conv.id}`, undefined],
          ['DELETE', `/api/messages/${answer.id}`, undefined],
        ] as const) {
          const response = await api(method, url, body);
          assert.equal(response.statusCode, 409, `${method} ${url}: ${response.body}`);
          assert.equal(count(), n);
          assert.equal((db.prepare('SELECT head_message_id AS h FROM conversations WHERE id=?').get(conv.id) as { h: string }).h, answer.id);
        }
      } finally { hold.resolve(); }
      await idle();
      complete = async () => result();
    });

    await t('cancel while queued removes judge without invoking model and records failure', async () => {
      const hold = deferred();
      const occupied = queue.run(() => hold.promise);
      const before = calls;
      const logStart = logs.length;
      fireEndingEvalJob(ctx, conv.id);
      try {
        const job = queue.activeList[0];
        const response = await api('POST', `/api/generations/${job.id}/abort`, {});
        assert.equal(response.statusCode, 200);
        await idle();
        assert.equal(queue.queued, 0);
        assert.equal(calls, before);
        assert.equal(logs.length, logStart + 1);
        assert.equal(logs.at(-1)?.llm_called, 0);
      } finally { hold.resolve(); await occupied; }
    });

    await t('shutdown active-controller abort reaches running judge and releases slot', async () => {
      let seenSignal: AbortSignal | undefined;
      complete = (p) => new Promise((_resolve, reject) => {
        seenSignal = p.signal;
        p.signal!.addEventListener('abort', () => reject(p.signal!.reason), { once: true });
      });
      fireEndingEvalJob(ctx, conv.id);
      await until(() => !!seenSignal, 'model received signal');
      for (const job of queue.activeList) job.controller.abort();
      await idle();
      assert.equal(seenSignal?.aborted, true);
      assert.equal(await queue.run(async () => 'released'), 'released');
      complete = async () => result();
    });

    await t('timeout starts after slot acquisition and logs timeout once', async () => {
      const original = AbortSignal.timeout;
      let timeoutCalls = 0;
      AbortSignal.timeout = (_ms) => { timeoutCalls++; return original(40); };
      const hold = deferred();
      const occupied = queue.run(() => hold.promise);
      const before = calls;
      const logStart = logs.length;
      complete = (p) => new Promise((_resolve, reject) => {
        assert.equal(p.signal!.aborted, false);
        p.signal!.addEventListener('abort', () => reject(p.signal!.reason), { once: true });
      });
      try {
        fireEndingEvalJob(ctx, conv.id);
        await sleep(80);
        assert.equal(timeoutCalls, 0, 'waiting must not consume timeout');
        assert.equal(calls, before);
        hold.resolve(); await occupied;
        await idle();
        assert.equal(timeoutCalls, 1);
        assert.equal(calls, before + 1);
        assert.equal(logs.length, logStart + 1);
        assert.equal(logs.at(-1)?.llm_called, 0);
      } finally {
        hold.resolve(); await occupied;
        AbortSignal.timeout = original;
        complete = async () => result();
      }
    });

    await t('model and parse failure both clean up registry and leave a verdict log', async () => {
      for (const stub of [async () => { throw new Error('fixture failure'); }, async () => result('bad json')]) {
        complete = stub;
        const start = logs.length;
        fireEndingEvalJob(ctx, conv.id);
        await idle();
        assert.equal(logs.length, start + 1);
        assert.equal(logs.at(-1)?.eligible, false);
      }
      complete = async () => result();
    });

    await t('non-story room never registers a judge or calls the model', async () => {
      const room = (await api('POST', '/api/conversations', { characterId: ch.id })).json();
      const before = calls;
      fireEndingEvalJob(ctx, room.id);
      await idle();
      assert.equal(calls, before);
    });
  } finally {
    for (const job of queue.activeList) job.controller.abort();
    await app.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`passed ${checks}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
