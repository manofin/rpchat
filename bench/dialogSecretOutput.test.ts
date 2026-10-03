import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import type { Ctx } from '../apps/server/src/ctx.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-dialog-secret-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
const SECRET = 'NARI_ONLY_CODE_7391';
let output = '';
let inspectDuringStream = false;
let interrupt = false;
let observed = '';
const result = (text: string) => ({ text, usage: null, finishReason: 'stop', ttftMs: 1, totalMs: 1 });
const model = {
  complete: async () => result('null'),
  stream: async (_: unknown, emit: (s: string) => void) => {
    const split = output.indexOf('7391');
    const first = split >= 0 ? output.slice(0, split) : output;
    emit(first);
    if (inspectDuringStream) {
      await new Promise(resolve => setTimeout(resolve, 550));
      emit(output.slice(first.length));
      observed = JSON.stringify(db.prepare('SELECT content, meta_json FROM messages').all());
    } else emit(output.slice(first.length));
    if (interrupt) throw new Error('synthetic stream failure');
    return result(output);
  },
};
const app = Fastify();
const ctx = { db, model, queue: new GenerationQueue(1), resolvedModel: () => 'mock', effectiveDataDir: tmp,
  log: { error() {}, warn() {}, info() {} } } as unknown as Ctx;
for (const route of [characterRoutes, storyRoutes, conversationRoutes, chatRoutes]) app.register(route(ctx));
async function api(method: any, url: string, payload?: unknown) {
  const r = await app.inject({ method, url, payload });
  assert.ok(r.statusCode < 400, `${r.statusCode} ${r.body}`);
  return r;
}
let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); console.log(`ok ${++passed} ${name}`); }
let cast: any[] = [];
async function room(known_by: unknown, status = 'pinned') {
  const story = (await api('POST', '/api/stories', { name: '출력 경계 fixture', scene_catalog: { places: [{ id: '교실' }] } })).json();
  for (const [sortOrder, c] of cast.entries()) await api('POST', `/api/stories/${story.id}/characters`, { characterId: c.id, sortOrder });
  const c = (await api('POST', '/api/conversations', { characterId: cast[0].id, storyId: story.id, mode: 'story', scene: { format: 'dialog' } })).json();
  const anchor = insertMessage(db, c.id, null, 'user', '비공개 기록을 승인했다.', 'complete');
  setHead(db, c.id, anchor.id);
  db.prepare(`INSERT INTO memories(id,conversation_id,content,source,status,importance,scope,evidence_message_ids_json,created_at,updated_at)
    VALUES(?, ?, ?, 'manual', ?, 3, 'conversation', ?, '2026', '2026')`).run(c.id, c.id, SECRET, status, JSON.stringify([anchor.id]));
  await api('PATCH', `/api/conversations/${c.id}`, { scene: { dialog_context: { version: 1, entries: [{ memory_id: c.id, anchor_message_id: anchor.id, kind: 'fact', known_by, status: 'active' }] }, pending_edit: { head_message_id: anchor.id } } });
  return c.id;
}
async function generate(id: string) { return api('POST', `/api/conversations/${id}/messages`, { content: '나리, 다음 장면을 진행하자.' }); }
async function main() {
  db.prepare(`INSERT INTO model_profiles(name,temperature,top_p,max_tokens,stop_json,system_mode) VALUES('rp-balanced',.8,.95,400,'[]','system')`).run();
  for (const name of ['나리', '세라', '하연']) cast.push((await api('POST', '/api/characters', { name, first_message: '', tags: ['party:place=교실'] })).json());
  await check('nonrecipient leak fails without SSE, polling, stored body or scene commit', async () => {
    const id = await room([cast[0].id]);
    const before = (db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(id) as any).scene_json;
    output = `나리 | 기다리자.\n세라 | 암호는 ${SECRET}야.`; inspectDuringStream = true;
    const r = await generate(id); inspectDuringStream = false;
    assert.ok(r.body.includes('"type":"error"')); assert.ok(!r.body.includes('"type":"done"'));
    assert.ok(!r.body.includes(SECRET)); assert.ok(!observed.includes(SECRET));
    const rows = db.prepare("SELECT content,meta_json,status FROM messages WHERE conversation_id = ? AND role = 'assistant'").all(id);
    assert.ok(!JSON.stringify(rows).includes(SECRET));
    assert.equal((db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(id) as any).scene_json, before);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM generation_log WHERE conversation_id = ? AND status = 'complete'").get(id) as any).n, 0);
  });
  await check('authorized speaker may use the exact registered secret', async () => {
    const id = await room([cast[0].id]); output = `나리 | 암호는 ${SECRET}야.\n세라 | 기다리자.`;
    const r = await generate(id); assert.ok(r.body.includes('"type":"done"')); assert.ok(r.body.includes(SECRET));
  });
  await check('public fact is not blocked for another speaker', async () => {
    const id = await room('public'); output = `세라 | 암호는 ${SECRET}야.`;
    assert.ok((await generate(id)).body.includes('"type":"done"'));
  });
  await check('unapproved candidate is not treated as a registered secret', async () => {
    const id = await room([cast[0].id], 'candidate'); output = `세라 | ${SECRET}`;
    assert.ok((await generate(id)).body.includes('"type":"done"'));
  });
  await check('narrator-only fact is forbidden in every NPC line', async () => {
    const id = await room([]); output = `나리 | ${SECRET}`;
    assert.ok((await generate(id)).body.includes('"type":"error"'));
  });
  await check('a leaking line beyond the display cap still fails the whole turn', async () => {
    const id = await room([cast[0].id]);
    output = Array.from({ length: 30 }, () => '나리 | 기다리자.').join('\n') + `\n세라 | ${SECRET}`;
    const r = await generate(id); assert.ok(r.body.includes('"type":"error"')); assert.ok(!r.body.includes(SECRET));
  });
  await check('failed guarded stream does not retain an unvalidated secret body', async () => {
    const id = await room([cast[0].id]); output = `세라 | ${SECRET}`; interrupt = true;
    const r = await generate(id); interrupt = false;
    assert.ok(r.body.includes('"type":"error"')); assert.ok(!r.body.includes(SECRET));
    assert.ok(!JSON.stringify(db.prepare("SELECT content,meta_json FROM messages WHERE conversation_id = ? AND role = 'assistant'").all(id)).includes(SECRET));
  });
}
main().finally(async () => { await app.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }).catch(e => { console.error(e); process.exitCode = 1; });
