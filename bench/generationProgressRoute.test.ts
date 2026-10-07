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
import { streamPost } from '../apps/web/src/lib/api.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-dialog-secret-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
const SECRET = 'NARI_ONLY_CODE_7391';
let output = '';
let failureMode = '';
const polledPhases: string[] = [];
// 현재 대화 경로는 공개 대본 1회 + 인물별·서술자 비공개 보충 요청을 따로 보낸다.
let actorOutput: Record<string, string> = {};
let narratorOutput = 'NO_NARRATION';
const audiences: string[] = [];
const result = (text: string) => ({ text, usage: null, finishReason: 'stop', ttftMs: 1, totalMs: 1 });
const model = {
  complete: async () => result('null'),
  stream: async (params: any, emit: (s: string) => void) => {
    const active = ctx.queue.activeList.find(g=>g.kind !== 'ending-judge')!;
    const polled = (await api('GET', `/api/conversations/${active.conversationId}`)).json();
    polledPhases.push(polled.activeGeneration.phase);
    if (failureMode === 'timeout') throw Object.assign(new Error('unsafe private data'), { name: 'TimeoutError' });
    if (failureMode === 'connection') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const audience = params.audience ?? { kind: 'public' };
    audiences.push(audience.kind === 'actor' ? `actor:${audience.actor_name}` : audience.kind);
    if (audience.kind === 'actor') return result(actorOutput[audience.actor_name] ?? 'NO_LINE');
    if (audience.kind === 'narrator') return result(narratorOutput);
    emit(output);
    return result(output);
  },
};
function reset() { output = ''; actorOutput = {}; narratorOutput = 'NO_NARRATION'; audiences.length = 0; }
const app = Fastify();
const ctx = { db, model, queue: new GenerationQueue(1), resolvedModel: () => 'mock', effectiveDataDir: tmp,
  log: { error() {}, warn() {}, info() {} } } as unknown as Ctx;
for (const route of [characterRoutes, storyRoutes, conversationRoutes, chatRoutes]) app.register(route(ctx));
async function api(method: any, url: string, payload?: unknown, headers?: Record<string, string>) {
  const r = await app.inject({ method, url, payload, headers });
  assert.ok(r.statusCode < 400, `${r.statusCode} ${r.body}`);
  return r;
}
let passed = 0;
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

const sseEvents = (body: string) => body.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
async function generate(id: string, progress = '1') { audiences.length = 0; return api('POST', `/api/conversations/${id}/messages`, { content: '나리, 다음 장면을 진행하자.' }, progress ? { 'x-rpchat-generation-progress': progress } : {}); }
async function main() {
  db.prepare(`INSERT INTO model_profiles(name,temperature,top_p,max_tokens,stop_json,system_mode) VALUES('rp-balanced',.8,.95,400,'[]','system')`).run();
  for (const name of ['나리','세라']) cast.push((await api('POST','/api/characters',{name,first_message:'',tags:['party:place=교실']})).json());
  let failures=0;
  for (const mode of ['success','validation','timeout','connection']) {
    reset(); polledPhases.length=0; failureMode=mode;
    const id=await room([cast[0].id]);
    output=mode==='validation' ? `세라 | ${SECRET}` : '나리 | 조용히 기다리자.';
    const r=await generate(id); const events=sseEvents(r.body);
    try {
      const phases=events.filter(e=>e.type==='progress');
      assert.ok(phases.some(e=>e.phase==='queued'));
      assert.ok(phases.some(e=>e.phase==='writing'));
      assert.ok(phases.every(e=>Number.isFinite(Date.parse(e.startedAt))));
      assert.ok(polledPhases.length && polledPhases.every(p=>p==='writing'));
      if(mode==='success') {
        assert.ok(phases.some(e=>e.phase==='validating'));
        assert.ok(events.some(e=>e.type==='done'));
        assert.ok(events.findIndex(e=>e.type==='progress'&&e.phase==='validating')<events.findIndex(e=>e.type==='token'));
      } else {
        const error=events.find(e=>e.type==='error');assert.equal(error?.code,mode==='timeout'?'model_timeout':mode);
        assert.ok(!error.message.includes(SECRET) && !error.message.includes('unsafe private data'));
        assert.ok(!events.some(e=>e.type==='token'));
      }
      assert.equal((await api('GET',`/api/conversations/${id}`)).json().activeGeneration,null);
      console.log(`ok ${++passed} - real route phase/polling/error ${mode}`);
    } catch(e) {failures++;console.error(mode,String(e));}
  }
  for (const capability of ['', '0', '1']) {
    reset(); failureMode = 'success'; output = '나리 | 조용히 기다리자.';
    const dialogId = await room([cast[0].id]);
    const dialogEvents = sseEvents((await generate(dialogId, capability)).body);
    assert.equal(dialogEvents.some(e => e.type === 'progress'), capability === '1');
    assert.ok(dialogEvents.some(e => e.type === 'done'));
    const soloId = (await api('POST', '/api/conversations', { characterId: cast[0].id })).json().id;
    const soloEvents = sseEvents((await generate(soloId, capability)).body);
    assert.equal(soloEvents.some(e => e.type === 'progress'), capability === '1');
    const done = soloEvents.find(e => e.type === 'done'); assert.ok(done);
    const continued = sseEvents((await api('POST', `/api/conversations/${soloId}/continue`, { messageId: done.message.id }, capability ? { 'x-rpchat-generation-progress': capability } : {})).body);
    assert.equal(continued.some(e => e.type === 'progress'), capability === '1');
    assert.ok(continued.some(e => e.type === 'done'));
    console.log(`ok ${++passed} - dialog/solo/continuation progress capability ${capability || 'legacy absent'}`);
  }
  const originalFetch = globalThis.fetch;
  try {
    let capability: string | null = null;
    globalThis.fetch = async (_url, init) => {
      capability = new Headers(init?.headers).get('x-rpchat-generation-progress');
      return new Response('data: {"type":"done"}\n\n', { status: 200 });
    };
    await streamPost('/local-test', {}, () => {});
    assert.equal(capability, '1');
    console.log(`ok ${++passed} - actual web stream requests opt into progress`);
  } finally { globalThis.fetch = originalFetch; }
  await app.close();db.close();console.log(JSON.stringify({passed,failures}));if(failures)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
