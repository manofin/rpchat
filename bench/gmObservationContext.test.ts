// npm run test:benches -- gmObservationContext
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { buildSceneSnapshot } from '../apps/server/src/db/sceneBase.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import { runEndingEvalJob } from '../apps/server/src/endingJudge.js';
import { estimateMessageTokens } from '../apps/server/src/prompt/tokens.js';
import { config } from '../apps/server/src/config.js';
import { observationText, GM } from '../apps/server/src/prompt/observation.js';
import { buildSideModePrompt } from '../apps/server/src/prompt/sideModePrompt.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams } from '../apps/server/src/model/adapter.js';
import type { ConversationRow, MessageRow, Scene } from '../apps/server/src/types.js';

const ACTION = 'PUBLIC_ACTION_BANDAGED_WRIST';
const SPEECH = 'PUBLIC_SPEECH_PROMISE';
const GM_PRIVATE = 'GM_AUTHORIZED_BODY';
const NPC_PRIVATE = 'NPC_ONLY_BODY';
const CONTROL = 'CONTROL_MUST_NOT_REACH_MODEL';
const calls: Array<{ pass: string; p: GenParams; text: string }> = [];
const textOf = (p: GenParams) => p.messages.map(m => m.content).join('\n');
const result = (text: string) => ({ text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-gm-observation-'));
const db = openMigratedDb(dir, path.resolve('apps/server/migrations'));
const app = Fastify();
const ctx = { db, queue: new GenerationQueue(1), resolvedModel: () => 'mock', log: app.log,
  model: {
    complete: async (p: GenParams) => {
      const text = textOf(p);
      const pass = text.includes('장면 진행 판정기') ? 'delta' : text.includes('입력 초안만 쓴다') ? 'c'
        : text.includes('너는 장면 서술자다') ? 'n' : 'e';
      calls.push({ pass, p, text });
      return result(pass === 'delta' ? 'null' : pass === 'c' ? '<choices>["SAFE_CHOICE"]</choices>'
        : pass === 'n' ? 'SAFE_NEW_NARRATION' : '"SAFE_EXTRA"');
    },
    stream: async (p: GenParams, cb: (chunk: string) => void) => {
      calls.push({ pass: 'stream', p, text: textOf(p) });
      cb('"SAFE_REPLY"'); return result('"SAFE_REPLY"');
    },
  },
} as unknown as Ctx;
for (const route of [characterRoutes, storyRoutes, conversationRoutes, chatRoutes]) app.register(route(ctx));
let passed = 0, failed = 0;
async function test(name: string, run: () => Promise<void>) {
  try { await run(); console.log(`ok ${++passed} ${name}`); }
  catch (err) { failed++; console.error(`FAIL ${name}`, err); }
}
async function create(url: string, payload: object) {
  const r = await app.inject({ method: 'POST', url, payload });
  assert(r.statusCode < 400, r.body); return r.json();
}
async function main() {
  db.prepare("INSERT INTO model_profiles(name,temperature,top_p,max_tokens,stop_json,system_mode) VALUES('rp-balanced',.8,.95,800,'[]','system')").run();
  const a = await create('/api/characters', { name: '나리', first_message: '', tags: ['party:place=교실'] });
  const b = await create('/api/characters', { name: '세라', first_message: '', tags: ['party:place=교실'] });
  const story = await create('/api/stories', { name: 'GM fixture', setting: '교실', scene_catalog: { places: [{ id: '교실' }] } });
  for (const [i, actor] of [a, b].entries()) await create(`/api/stories/${story.id}/characters`, { characterId: actor.id, sortOrder: i });
  async function fixture(narrationTarget = true) {
    const room = await create('/api/conversations', { characterId: a.id, storyId: story.id, mode: 'story', scene: { format: 'beat' } });
    const scene: Scene = { format: 'beat', location: '교실', present_ids: [a.id, b.id], turn_no: 1, scene_version: 1, observation_filter: true };
    db.prepare('UPDATE conversations SET scene_json=? WHERE id=?').run(JSON.stringify(scene), room.id);
    const generation = 'fixture-' + room.id;
    let leaf = insertMessage(db, room.id, null, 'user', 'PUBLIC_USER', 'complete', {});
    leaf = insertMessage(db, room.id, leaf.id, 'assistant', 'HEADER', 'complete', { generation_id: generation, beat_seq: 0,
      block_kind: 'header', scene_state: buildSceneSnapshot(scene, scene) });
    const raw = `${ACTION}\n"${SPEECH}"\n<think>${CONTROL}</think>\n<choices>["${CONTROL}"]</choices>\n속마음:${CONTROL}`;
    const historical = insertMessage(db, room.id, leaf.id, 'assistant', raw, 'complete', {
      generation_id: generation, beat_seq: 1, block_kind: 'line', speaker_character_id: a.id, speaker_name: a.name,
      observation_text: `"${SPEECH}"`, observation: { visibility: 'public' },
    });
    db.prepare('UPDATE messages SET content=? WHERE id=?').run(raw, historical.id);
    insertMessage(db, room.id, historical.parent_id, 'assistant', 'SIBLING_ACTION', 'complete', {
      generation_id: generation, block_kind: 'line', observation: { visibility: 'public' },
    });
    leaf = insertMessage(db, room.id, historical.id, 'assistant', NPC_PRIVATE, 'complete', { generation_id: generation,
      beat_seq: 2, block_kind: 'line', observation: { visibility: 'private', recipient_ids: ['user', a.id], observer_ids: [] } });
    leaf = insertMessage(db, room.id, leaf.id, 'assistant', GM_PRIVATE, 'complete', { generation_id: generation,
      beat_seq: 3, block_kind: 'line', observation: { visibility: 'private', recipient_ids: ['user', 'gm'], observer_ids: [] } });
    leaf = insertMessage(db, room.id, leaf.id, 'assistant', narrationTarget ? 'PUBLIC_LAST_NARRATION' : '"PUBLIC_LAST_SPEECH"', 'complete', {
      generation_id: generation, beat_seq: 4, block_kind: narrationTarget ? 'narration' : 'line',
      ...(narrationTarget ? {} : { speaker_character_id: b.id, speaker_name: b.name }), observation: { visibility: 'public' },
    });
    setHead(db, room.id, leaf.id);
    return { room, leaf, historical };
  }
  await test('GM ending request retains authorized actions; controls, NPC private and siblings stay absent', async () => {
    const f = await fixture();
    db.prepare('UPDATE conversations SET story_endings_snapshot=? WHERE id=?').run(JSON.stringify([
      { id: 'ending', title: 'fixture', conditions: { min_turns: 1, narrative_hint: 'CHECK_WRIST' } },
    ]), f.room.id);
    const before = db.serialize(); let actual = '';
    await runEndingEvalJob({ db, modelName: 'mock', complete: async p => { actual = textOf(p); return result('{}'); }, log() {} }, f.room.id);
    assert(actual.includes('CHECK_WRIST'), 'ending adapter was not called');
    assert(actual.includes(ACTION), 'GM action absent'); assert(actual.includes(SPEECH)); assert(actual.includes(GM_PRIVATE));
    for (const marker of [NPC_PRIVATE, CONTROL, 'SIBLING_ACTION']) assert(!actual.includes(marker), marker);
    assert(before.equals(db.serialize()), 'ending evaluation must not write data');
  });
  await test('actual beat N retains GM actions while F/E keep speech proof and recipient isolation', async () => {
    const f = await fixture(); calls.length = 0;
    const before = db.prepare('SELECT content,meta_json FROM messages WHERE id=?').get(f.historical.id);
    const r = await app.inject({ method: 'POST', url: `/api/conversations/${f.room.id}/messages`, payload: { content: '세라, 지금 답해.' } });
    assert.equal(r.statusCode, 200); assert(r.body.includes('"type":"done"'), r.body);
    const n = calls.find(c => c.pass === 'n')!; assert(n, 'Pass N missing');
    assert(n.text.includes(ACTION), 'N action absent'); assert(n.text.includes(SPEECH)); assert(n.text.includes(GM_PRIVATE));
    assert(!n.text.includes(NPC_PRIVATE));
    const fRequest = calls.find(c => c.pass === 'stream')!; assert(fRequest, 'Pass F missing');
    assert(fRequest.text.includes(SPEECH)); assert(!fRequest.text.includes(NPC_PRIVATE));
    const e = calls.find(c => c.pass === 'e')!; assert(e, 'Pass E missing'); assert(e.text.includes(SPEECH));
    assert(e.text.includes(NPC_PRIVATE), 'recipient loses own whisper');
    for (const c of calls) {
      assert(!c.text.includes(CONTROL)); assert(!c.text.includes('SIBLING_ACTION'));
      if (['stream', 'e'].includes(c.pass)) { assert(!c.text.includes(ACTION)); assert(!c.text.includes(GM_PRIVATE)); }
      assert(estimateMessageTokens(c.text) + c.p.max_tokens + 64 <= config.model.contextTokens);
    }
    assert.deepEqual(db.prepare('SELECT content,meta_json FROM messages WHERE id=?').get(f.historical.id), before);
  });
  await test('GM narration continuation includes actions; NPC continuation still only sees authorized speech', async () => {
    for (const gm of [true, false]) {
      const f = await fixture(gm); calls.length = 0;
      const before = db.prepare('SELECT content,meta_json FROM messages WHERE id=?').get(f.historical.id);
      const r = await app.inject({ method: 'POST', url: `/api/conversations/${f.room.id}/continue`, payload: { messageId: f.leaf.id } });
      assert.equal(r.statusCode, 200); assert(r.body.includes('"type":"done"'), r.body);
      assert.equal(calls.length, 1); const c = calls[0];
      assert.equal(c.text.includes(ACTION), gm, 'GM continuation action missing or leaked to NPC');
      assert.equal(c.text.includes(GM_PRIVATE), gm); assert(c.text.includes(SPEECH));
      for (const marker of [NPC_PRIVATE, CONTROL, 'SIBLING_ACTION']) assert(!c.text.includes(marker), marker);
      assert(estimateMessageTokens(c.text) + c.p.max_tokens + 64 <= config.model.contextTokens);
      assert.deepEqual(db.prepare('SELECT content,meta_json FROM messages WHERE id=?').get(f.historical.id), before);
    }
  });
  await test('OFF text remains byte-identical and NPC observation remains speech-only', async () => {
    const f = await fixture();
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(f.historical.id) as MessageRow;
    assert.equal(observationText(row, false, GM), observationText(row, false));
    assert.equal(observationText(row, true, b.id), `"${SPEECH}"`);
    assert.equal(observationText(row, true), `"${SPEECH}"`);
    assert.equal(observationText(row, true, GM), row.content);
  });
  await test('free model metadata cannot be promoted to GM action context', async () => {
    const f = await fixture();
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(f.historical.id) as MessageRow;
    for (const field of ['private', 'private_thought', 'visible_action']) {
      const contaminated = { ...row, content: `${ACTION}\n"${SPEECH}"\n${field}: FREE_CONTROL_BODY` };
      assert.equal(observationText(contaminated, true, GM), `"${SPEECH}"`);
      assert.equal(observationText(contaminated, false, GM), observationText(contaminated, false));
      db.prepare('UPDATE messages SET content=? WHERE id=?').run(contaminated.content, row.id);
      const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(f.room.id) as ConversationRow;
      const summary = buildSideModePrompt(db, conv, 'summary', '', 16384);
      const actual = JSON.stringify(summary.messages);
      assert(actual.includes(SPEECH)); assert(!actual.includes('FREE_CONTROL_BODY'));
    }
  });
  await test('long GM history is filtered before budgeting and final adapter requests fit context', async () => {
    const f = await fixture();
    const generation = 'fixture-' + f.room.id;
    let leaf = f.leaf;
    for (let i = 0; i < 45; i++) {
      leaf = insertMessage(db, f.room.id, leaf.id, 'assistant', `LONG_ACTION_${i} ` + '가나다라'.repeat(500) + `\n"LONG_SPEECH_${i}"`, 'complete', {
        generation_id: generation, beat_seq: i + 5, block_kind: 'line', speaker_character_id: a.id,
        observation: { visibility: 'public' }, observation_text: `"LONG_SPEECH_${i}"`,
      });
    }
    leaf = insertMessage(db, f.room.id, leaf.id, 'assistant', 'LARGE_NPC_PRIVATE ' + '비밀'.repeat(50000), 'complete', {
      generation_id: generation, beat_seq: 50, block_kind: 'line',
      observation: { visibility: 'private', recipient_ids: ['user', a.id], observer_ids: [] },
    });
    setHead(db, f.room.id, leaf.id); calls.length = 0;
    const r = await app.inject({ method: 'POST', url: `/api/conversations/${f.room.id}/messages`, payload: { content: '세라, 이어서 답해.' } });
    assert.equal(r.statusCode, 200); assert(r.body.includes('"type":"done"'), r.body);
    const n = calls.find(c => c.pass === 'n')!; assert(n);
    assert(n.text.includes('LONG_ACTION_44'), 'latest allowed action lost');
    assert(!n.text.includes('LONG_ACTION_0 '), 'fixture must force history truncation');
    assert(!n.text.includes('LARGE_NPC_PRIVATE'), 'unreadable input consumed GM budget');
    for (const c of calls) {
      assert(estimateMessageTokens(c.text) + c.p.max_tokens + 64 <= config.model.contextTokens);
      if (['stream', 'e'].includes(c.pass)) assert(!c.text.includes('LONG_ACTION_'));
    }
  });
  if (failed) throw new Error(`${failed} GM context regressions`);
}
main().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  await app.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
