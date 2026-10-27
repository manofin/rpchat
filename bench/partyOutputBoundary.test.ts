import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import { memoryRoutes } from '../apps/server/src/routes/memory.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';
import { reduceChatEvent, initialChatState } from '../apps/web/src/lib/chatStreamState.js';

import { userVisibleRequests } from '../apps/server/src/prompt/partyOutput.js';
process.env.RPCHAT_PARTY_OUTPUT = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'party-output-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
db.prepare(`INSERT INTO model_profiles(name,temperature,top_p,max_tokens,stop_json,system_mode) VALUES ('rp-balanced',0.8,0.95,400,'[]','system')`).run();
const BAD = 'FORBIDDEN_CANARY', GOOD = 'VERIFIED_CANARY', TAIL = 'INCOMPLETE_CANARY';
let current = ''; let calls: string[] = []; let prompts: string[] = [];
let behavior: (pass: string, p: GenParams, emit: (s: string) => void) => Promise<GenResult>;
const result = (text: string, finishReason = 'stop'): GenResult => ({ text, finishReason, usage: { prompt_tokens: 10, completion_tokens: 10 }, ttftMs: 1, totalMs: 2 });
const kind = (p: GenParams) => p.max_tokens === 300 ? 'N' : p.max_tokens === 500 ? 'F' : p.max_tokens === 220 ? 'E' : p.max_tokens === 900 ? 'S' : 'supplement';
let completeFailure = false; let deltaFailure = false;
const model = {
  complete: async (p: GenParams) => {
    if (p.max_tokens === 200) { calls.push('delta'); if (deltaFailure) throw new Error(BAD); return result('{"base_version":0}'); }
    calls.push('C'); if (completeFailure) throw new Error('choices failure'); return result('<choices>["가","나","다"]</choices>');
  },
  stream: async (p: GenParams, emit: (s: string) => void) => { const pass = kind(p); calls.push(pass); prompts.push(p.messages.map(m => m.content).join('\n')); return behavior(pass, p, emit); },
  listModels: async () => ['synthetic-only'],
};
const ctx = { db, model, queue: new GenerationQueue(1), log: { info() { }, warn() { }, error() { }, debug() { } }, resolvedModel: () => 'synthetic-only' } as unknown as Ctx;
const app = Fastify({ logger: false });
let a: string, b: string, story: string;
let count = 0;
const rows = () => db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid').all(current) as any[];
const saved = () => JSON.stringify(rows());
async function api(method: any, url: string, payload?: any) { const r = await app.inject({ method, url, payload }); return { status: r.statusCode, body: r.body, json: () => r.json() }; }
async function room(format = 'dialog', filter = false) { const r = await api('POST', '/api/conversations', { characterId: a, storyId: story, mode: 'story' }); assert.equal(r.status, 201, r.body); current = r.json().id; const p = await api('PATCH', `/api/conversations/${current}`, { scene: { format, location: '합성실', present_ids: [a, b], observation_filter: filter } }); assert.equal(p.status, 200, p.body); calls = []; prompts = []; completeFailure = false; deltaFailure = false; return current; }
const send = (extra = {}) => api('POST', `/api/conversations/${current}/messages`, { content: '하린, 대답해 주세요.', ...extra });
const basic = async (pass: string, p: GenParams, emit: (s: string) => void) => { const text = pass === 'N' ? '고요한 방.\n' : pass === 'S' ? `하린 | ${GOOD}\n` : `${GOOD}\n`; emit(text); return result(text); };
async function test(name: string, fn: () => Promise<void> | void) { await fn(); console.log(`ok ${++count} ${name}`); }
async function main() {
  for (const r of [characterRoutes, storyRoutes, conversationRoutes, chatRoutes, memoryRoutes]) await app.register(r(ctx));
  const char = async (name: string) => { const r = await api('POST', '/api/characters', { name, first_message: '', tags: ['party:place=합성실'] }); assert.equal(r.status, 201, r.body); return r.json().id; };
  a = await char('하린'); b = await char('나린'); const sr = await api('POST', '/api/stories', { name: '출력 경계', setting: '합성실', minor_cast: [], scene_catalog: { places: [{ id: '합성실', name: '합성실' }], weathers: ['실내'] } }); story = sr.json().id;
  for (const [sortOrder, characterId] of [a, b].entries()) assert.equal((await api('POST', `/api/stories/${story}/characters`, { characterId, sortOrder })).status, 201);
  for (const firstBad of [false, true]) await test(`dialog nine boundaries ${firstBad ? 'forbidden-first' : 'mixed'}`, async () => {
    await room(); behavior = async (pass, p, emit) => {
      assert.equal(pass, 'S'); const first = firstBad ? '' : `하린 | ${GOOD}\n`;
      emit(first + `금지인물 | ${BAD}\n하린 | ${TAIL}`);
      assert.ok(!saved().includes(BAD)); assert.ok(!saved().includes(TAIL));
      const get = await api('GET', `/api/conversations/${current}`); assert.ok(!get.body.includes(BAD)); assert.ok(!get.body.includes(TAIL));
      const streaming = rows().find(r => r.status === 'streaming'); assert.ok(streaming);
      const single = await api('GET', `/api/messages/${streaming.id}`); assert.ok(!single.body.includes(BAD)); assert.ok(!single.body.includes(TAIL));
      emit(` 완료\n하린 | ${GOOD}\n`); return result(first + `금지인물 | ${BAD}\n하린 | ${TAIL} 완료\n하린 | ${GOOD}\n`);
    };
    const r = await send(); assert.equal(r.status, 200); assert.ok(!r.body.includes(BAD)); assert.ok(saved().includes(GOOD)); assert.ok(!saved().includes(BAD));
    assert.ok(!(await api('GET', `/api/conversations/${current}`)).body.includes(BAD));
  });
  for (const format of ['beat', 'dialog']) await test(`${format} required delta failure never starts narrative output`, async () => {
    await room(format); deltaFailure = true; behavior = basic; const r = await send(); assert.equal(r.status, 500); assert.deepEqual(calls, ['delta']); assert.equal(rows().length, 0); assert.ok(!r.body.includes(BAD));
  });
  await test('required dialog failure retracts published prefix and scene', async () => {
    await room(); const before = db.prepare('SELECT scene_json FROM conversations WHERE id=?').get(current);
    behavior = async (pass, p, emit) => { emit(`하린 | ${GOOD}\n`); assert.ok(saved().includes(GOOD)); throw new Error(BAD); };
    const r = await send(); assert.ok(r.body.includes('retract')); assert.ok(!r.body.includes(BAD)); assert.equal(rows().length, 0); assert.deepEqual(db.prepare('SELECT scene_json FROM conversations WHERE id=?').get(current), before);
  });
  await test('speaker violation only and header only cannot commit', async () => {
    await room(); behavior = async (pass, p, emit) => { emit(`금지인물 | ${BAD}\n`); return result(`금지인물 | ${BAD}\n`); };
    assert.ok((await send()).body.includes('retract')); assert.equal(rows().length, 0);
  });
  await test('public stop retains verified prefix but not incomplete tail or scene delta', async () => {
    await room(); const before = db.prepare('SELECT scene_json FROM conversations WHERE id=?').get(current);
    behavior = async (pass, p, emit) => { emit(`하린 | ${GOOD}\n하린 | ${TAIL}`); ctx.queue.abort(ctx.queue.activeList[0].id); p.signal!.throwIfAborted(); return result(''); };
    const r = await send(); assert.ok(!r.body.includes(TAIL)); assert.ok(saved().includes(GOOD)); assert.ok(!saved().includes(TAIL)); assert.ok(rows().filter(r => r.role === 'assistant').every(r => r.status === 'interrupted')); assert.deepEqual(db.prepare('SELECT scene_json FROM conversations WHERE id=?').get(current), before);
  });
  await test('N partial failure disappears from storage and later prompts while F succeeds', async () => {
    await room('beat'); behavior = async (pass, p, emit) => { if (pass === 'N') { emit(BAD + '\n'); throw new Error('N failed'); } assert.ok(!p.messages.some(m => m.content.includes(BAD))); return basic(pass, p, emit); };
    const r = await send(); assert.ok(calls.includes('N') && calls.includes('F')); assert.ok(!r.body.includes(BAD)); assert.ok(!saved().includes(BAD)); assert.ok(saved().includes(GOOD)); assert.ok(!r.body.includes('retract'));
  });
  await test('N validation failure is optional but empty remaining body fails', async () => {
    await room('beat'); behavior = async (pass, p, emit) => { const text = pass === 'N' ? `하린 | ${BAD}\n` : 'NO_LINE\n'; emit(text); return result(text); };
    const r = await send(); assert.ok(r.body.includes('retract')); assert.equal(rows().length, 0);
  });
  await test('beat F and E reject named outsiders without losing permitted plain speech', async () => {
    await room('beat'); behavior = async (pass, p, emit) => { if (pass === 'N') return basic(pass, p, emit); const text = `${GOOD}\n금지인물 | ${BAD}\n${TAIL}\n`; emit(text); return result(text); };
    const r = await send(); assert.ok(!r.body.includes(BAD)); assert.ok(!r.body.includes(TAIL)); assert.ok(saved().includes(GOOD));
  });
  await test('required F failure retracts successful N as well', async () => {
    await room('beat'); behavior = async (pass, p, emit) => { if (pass === 'F') { emit(GOOD + '\n'); throw new Error(BAD); } return basic(pass, p, emit); };
    const r = await send(); assert.ok(calls.includes('N') && calls.includes('F')); assert.ok(r.body.includes('retract')); assert.equal(rows().length, 0); assert.ok(!calls.includes('C'));
  });
  await test('choices failure preserves successful turn', async () => {
    await room('beat'); behavior = basic; completeFailure = true; const r = await send(); assert.ok(calls.includes('C')); assert.ok(!r.body.includes('retract')); assert.ok(rows().filter(r => r.role === 'assistant').every(r => r.status === 'complete'));
  });
  await test('private beat content absent during generation and present only on success', async () => {
    await room('beat', true); behavior = async (pass, p, emit) => { if (pass === 'F') { emit(GOOD + '\n'); assert.ok(!saved().includes(GOOD)); assert.ok(!(await api('GET', `/api/conversations/${current}`)).body.includes(GOOD)); return result(GOOD + '\n'); } return basic(pass, p, emit); };
    const r = await send({ observation: { visibility: 'private', recipient_ids: [a], observer_ids: [] } }); assert.ok(!r.body.includes('retract')); assert.ok(saved().includes(GOOD)); const privateRows = rows().filter(r => r.content.includes(GOOD)); assert.ok(privateRows.some(r => JSON.parse(r.meta_json).observation.visibility === 'private'));
  });
  await test('private beat stop discards withheld prefix', async () => {
    await room('beat', true); behavior = async (pass, p, emit) => { if (pass === 'F') { emit(BAD + '\n'); ctx.queue.abort(ctx.queue.activeList[0].id); p.signal!.throwIfAborted(); } return basic(pass, p, emit); };
    const r = await send({ observation: { visibility: 'private', recipient_ids: [a], observer_ids: [] } }); assert.ok(!saved().includes(BAD)); assert.ok(!r.body.includes(BAD));
  });
  await test('permission mutation bypass is caught before next public save', async () => {
    await room(); behavior = async (pass, p, emit) => { emit(`하린 | ${GOOD}\n`); db.prepare("UPDATE conversations SET scene_json=json_set(scene_json,'$.observation_filter',1) WHERE id=?").run(current); emit(`하린 | ${BAD}\n`); return result(''); };
    const r = await send(); assert.ok(r.body.includes('retract')); assert.ok(!r.body.includes(BAD)); assert.equal(rows().length, 0);
  });
  await test('memory writes and ancestor edits refused during pending output', async () => {
    await room(); behavior = async (pass, p, emit) => {
      const m = await api('POST', '/api/memories', { conversationId: current, content: 'test', status: 'pinned', scope: 'conversation', importance: 3, evidenceMessageIds: [] }); assert.equal(m.status, 409, m.body);
      const user = rows().find(r => r.role === 'user'); assert.equal((await api('PATCH', `/api/messages/${user.id}`, { content: BAD })).status, 409);
      return basic(pass, p, emit);
    }; assert.ok(!(await send()).body.includes('retract'));
  });
  for (const format of ['dialog', 'beat']) await test(`${format} continuation failure retracts only new output`, async () => {
    await room(format); behavior = basic; await send(); const before = rows(); const head = (db.prepare('SELECT head_message_id FROM conversations WHERE id=?').get(current) as any).head_message_id;
    behavior = async (pass, p, emit) => { emit(pass === 'S' ? `하린 | ${GOOD}\n` : `${GOOD}\n`); throw new Error(BAD); };
    const r = await api('POST', `/api/conversations/${current}/continue`, { messageId: head }); assert.equal(r.status, 200, r.body); assert.ok(r.body.includes('retract')); assert.deepEqual(rows(), before); assert.equal((db.prepare('SELECT head_message_id FROM conversations WHERE id=?').get(current) as any).head_message_id, head);
  });
  for (const format of ['dialog', 'beat']) await test(`${format} continuation success preserves previous rows`, async () => {
    await room(format); behavior = basic; await send(); const before = rows(); const head = (db.prepare('SELECT head_message_id FROM conversations WHERE id=?').get(current) as any).head_message_id;
    const r = await api('POST', `/api/conversations/${current}/continue`, { messageId: head }); assert.equal(r.status, 200, r.body); assert.ok(!r.body.includes('retract')); assert.deepEqual(rows().slice(0, before.length), before); assert.ok(rows().length > before.length);
  });
  await test('private permission change rejects held content before final commit', async () => {
    await room('beat', true); behavior = async (pass, p, emit) => { if (pass === 'F') { emit(BAD + '\n'); db.prepare("UPDATE conversations SET scene_json=json_set(scene_json,'$.location','changed') WHERE id=?").run(current); return result(BAD + '\n'); } return basic(pass, p, emit); };
    const r = await send({ observation: { visibility: 'private', recipient_ids: [a], observer_ids: [] } }); assert.ok(r.body.includes('retract')); assert.ok(!r.body.includes(BAD)); assert.ok(!saved().includes(BAD));
  });
  await test('optional N does not swallow a user cancellation', async () => {
    await room('beat'); behavior = async (pass, p, emit) => { assert.equal(pass, 'N'); emit(BAD + '\n'); ctx.queue.abort(ctx.queue.activeList[0].id); p.signal!.throwIfAborted(); return result(''); };
    const r = await send(); assert.ok(!calls.includes('F')); assert.ok(!r.body.includes(BAD)); assert.equal(rows().length, 0);
  });
  await test('log failure rolls scene and output back together', async () => {
    await room(); const before = db.prepare('SELECT scene_json FROM conversations WHERE id=?').get(current); behavior = basic;
    db.exec("CREATE TRIGGER reject_complete BEFORE INSERT ON generation_log WHEN NEW.status='complete' BEGIN SELECT RAISE(ABORT,'synthetic log failure'); END");
    try { const r = await send(); assert.ok(r.body.includes('retract')); assert.equal(rows().length, 0); assert.deepEqual(db.prepare('SELECT scene_json FROM conversations WHERE id=?').get(current), before); } finally { db.exec('DROP TRIGGER reject_complete'); }
  });
  await test('model actor and narrator roles never imply player output permission', () => {
    assert.deepEqual(userVisibleRequests([{ audience: { kind: 'actor', actor_id: a, actor_name: '하린' } }, { audience: { kind: 'narrator' } }]), []);
    const visible = userVisibleRequests([{ audience: { kind: 'actor' as const, actor_id: a, actor_name: '하린' }, outputAudience: { visibility: 'private' as const, recipient_ids: ['user', a], observer_ids: [] } }]);
    assert.equal(visible.length, 1); assert.deepEqual(visible[0].outputAudience, { visibility: 'private', recipient_ids: ['user', a], observer_ids: [] });
  });
  await test('retract reducer removes only identified rows and clears active stream', () => {
    const state = { ...initialChatState, messages: [{ id: 'old' }, { id: 'new' }] as any, generating: true, streamingId: 'new' };
    const after = reduceChatEvent(state, { type: 'retract', generationId: 'g', messageIds: ['new'] }, 'c'); assert.deepEqual(after.messages.map(m => m.id), ['old']); assert.equal(after.generating, false); assert.equal(after.streamingId, null);
  });
}
main().finally(async () => { await app.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }).catch(e => { console.error(e); process.exitCode = 1; });
