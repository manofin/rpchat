import { fixtureProvenance } from './helpers/derivedProvenanceFixture.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { openDb, openMigratedDb, one, run } from '../apps/server/src/db/index.js';
import { insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { appendRoleEvent } from '../apps/server/src/db/roleFacts.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { ModelClient } from '../apps/server/src/model/adapter.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { sideModeRoutes } from '../apps/server/src/routes/sideModes.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { MessageRow } from '../apps/server/src/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'side-recipient-boundary-'));
let db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
let app = Fastify();
const wire: any[] = [];
const intermediate: Array<{ content: string; meta_json: string }> = [];
const receipts: any[] = [];
let releaseProvider: (() => void) | undefined;
let firstStored: (() => void) | undefined;
const publicCanaries = ['CANARY_PUBLIC_BODY', 'CANARY_PUBLIC_MEMORY', 'CANARY_PUBLIC_SUMMARY', 'CANARY_PUBLIC_ROLE'];
const sharedCanaries = ['CANARY_SHARED_BODY', 'CANARY_SHARED_MEMORY', 'CANARY_SHARED_SUMMARY', 'CANARY_SHARED_ROLE'];
const forbiddenCanaries = ['CANARY_GM_BODY', 'CANARY_USER_BODY', 'CANARY_OBSERVER_BODY', 'CANARY_MALFORMED_BODY',
  'CANARY_SENTINEL_BODY', 'CANARY_GM_MEMORY', 'CANARY_OBSERVER_MEMORY', 'CANARY_GM_SUMMARY',
  'CANARY_OBSERVER_SUMMARY', 'CANARY_GM_ROLE', 'CANARY_OBSERVER_ROLE'];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  wire.push(body);
  // Echo only synthetic canaries actually received over HTTP. A leaking input
  // consequently appears in SSE, intermediate storage and subsequent GETs.
  const canaries = [...new Set<string>(JSON.stringify(body.messages).match(/CANARY_[A-Z_]+/g) ?? [])];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [index, canary] of canaries.entries()) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${canary}\n` }, finish_reason: null }] })}\n\n`);
    if (index === 0) await new Promise<void>(resolve => { releaseProvider = resolve; });
  }
  res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
const privateTo = (...recipient_ids: string[]) => ({ visibility: 'private' as const, recipient_ids, observer_ids: [] });
const outputAudience = (mode: string) => mode === 'summary' ? privateTo('user', 'gm') : { visibility: 'public' };
let checks = 0;
function check(name: string, fn: () => void) { fn(); console.log(`ok ${++checks} ${name}`); }
function streamEvents(raw: string): any[] {
  return raw.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}
async function main() {
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const model = new ModelClient(`http://127.0.0.1:${address.port}/v1`, '', 5000, tmp);
    const stream = model.stream.bind(model);
    model.stream = (params, callback) => stream(params, token => {
      callback(token);
      const row = one<MessageRow>(db, "SELECT * FROM messages WHERE status = 'streaming' LIMIT 1");
      assert.ok(row);
      intermediate.push({ content: row.content, meta_json: row.meta_json });
      firstStored?.(); firstStored = undefined;
    });
    const configure = () => {
      const ctx = { db, model, queue: new GenerationQueue(1), log: app.log, resolvedModel: () => 'loopback-only' } as Ctx;
      app.register(conversationRoutes(ctx));
      app.register(sideModeRoutes(ctx));
    };
    configure();
    run(db, 'INSERT INTO characters(id,name,created_at,updated_at) VALUES(?,?,?,?)', 'a', '나리', '2026', '2026');
    for (const format of ['dialog', 'beat']) for (const enabled of [false, true]) {
      const room = `${format}-${enabled}`;
      run(db, 'INSERT INTO conversations(id,character_id,profile_name,prompt_version,title,scene_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        room, 'a', 'default', 'test', '합성 수신자 경계', JSON.stringify({ format, observation_filter: enabled }), '2026', '2026');
      let parent: string | null = null;
      function add(content: string, observation: unknown) {
        const row = insertMessage(db, room, parent, 'assistant', content, 'complete', { block_kind: 'narration' });
        run(db, 'UPDATE messages SET meta_json=? WHERE id=?', JSON.stringify({ block_kind: 'narration', observation }), row.id);
        parent = row.id; setHead(db, room, parent); return row.id;
      }
      const pub = add('CANARY_PUBLIC_BODY', { visibility: 'public' });
      const shared = add('CANARY_SHARED_BODY', privateTo('user', 'gm'));
      const gm = add('CANARY_GM_BODY', privateTo('gm'));
      add('CANARY_USER_BODY', privateTo('user'));
      const observer = add('CANARY_OBSERVER_BODY', { ...privateTo('a'), observer_ids: ['user', 'gm'] });
      add('CANARY_MALFORMED_BODY', { visibility: 'private', recipient_ids: 'gm' });
      add('CANARY_SENTINEL_BODY', privateTo('public-community'));
      for (const [kind, source] of [['PUBLIC', pub], ['SHARED', shared], ['GM', gm], ['OBSERVER', observer]]) {
        run(db, `INSERT INTO memories(id,conversation_id,character_id,content,source,status,importance,scope,evidence_message_ids_json,created_at,updated_at)
          VALUES(?,?,?,?, 'user','pinned',3,'conversation',?,'2026','2026')`, `${room}-${kind}-memory`, room, 'a', `CANARY_${kind}_MEMORY`, JSON.stringify([source]));
        run(db, `INSERT INTO summaries(id,conversation_id,content,covers_from_message_id,covers_until_message_id,status,tier,created_at)
          VALUES(?,?,?,?,?,'approved','scene','2026')`, `${room}-${kind}-summary`, room, `CANARY_${kind}_SUMMARY`, source, source);
        fixtureProvenance(db, 'summary', `${room}-${kind}-summary`, [source]);
        appendRoleEvent(db, {
          action: 'register', proposal_id: `${room}-${kind}-role`, conversation_id: room, anchor_message_id: pub, expected_version: 0,
          proposal: { kind: 'role', subject_id: 'user', proposed_by: 'a', description: `CANARY_${kind}_ROLE`, source_message_ids: [kind === 'OBSERVER' ? observer : pub],
            audience: kind === 'SHARED' ? privateTo('user', 'gm') : kind === 'GM' ? privateTo('gm') : { visibility: 'public' } },
        }, 'synthetic-fixture');
      }
      const original = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id').all(room);
      const originalConv = db.prepare('SELECT * FROM conversations WHERE id=?').get(room);
      for (const mode of ['summary', 'community'] as const) {
        const offset = intermediate.length;
        const started = new Promise<void>(resolve => { firstStored = resolve; });
        const pending = Promise.resolve(app.inject({ method: 'POST', url: `/api/conversations/${room}/side-mode`, payload: { mode } }));
        await Promise.race([started, pending.then(response => { throw new Error(`generation ended before streaming checkpoint: ${response.statusCode}`); })]);
        const active = one<MessageRow>(db, "SELECT * FROM messages WHERE status = 'streaming'")!;
        const duringGet = await app.inject({ method: 'GET', url: `/api/messages/${active.id}` });
        const duringList = await app.inject({ method: 'GET', url: `/api/conversations/${room}/side-mode` });
        assert.equal(duringGet.statusCode, 200); assert.equal(duringList.statusCode, 200);
        const streamingGet = duringGet.json();
        const streamingList = duringList.json().find((row: any) => row.id === active.id);
        assert.equal(streamingGet.status, 'streaming'); assert.equal(streamingList.status, 'streaming');
        releaseProvider?.(); releaseProvider = undefined;
        const response = await pending;
        assert.equal(response.statusCode, 200, response.body);
        const events = streamEvents(response.body);
        const done = events.at(-1); assert.equal(done.type, 'done');
        const id = done.message.id;
        const saved = one<MessageRow>(db, 'SELECT * FROM messages WHERE id=?', id)!;
        const get = await app.inject({ method: 'GET', url: `/api/messages/${id}` }); assert.equal(get.statusCode, 200);
        const list = await app.inject({ method: 'GET', url: `/api/conversations/${room}/side-mode` }); assert.equal(list.statusCode, 200);
        const record = {
          format, enabled, mode, room, id, wire: wire.at(-1),
          sseText: events.filter(e => e.type === 'token').map(e => e.text).join(''),
          sseEvents: events.filter(e => e.type === 'token').flatMap(e => e.events),
          intermediate: intermediate.slice(offset), streamingGet, streamingList, saved, get: get.json(),
          list: list.json().find((row: any) => row.id === id), done: done.message,
        };
        receipts.push(record);
      }
      assert.deepEqual(db.prepare('SELECT * FROM conversations WHERE id=?').get(room), originalConv);
      assert.deepEqual(db.prepare('SELECT * FROM messages WHERE conversation_id=? AND id IN (SELECT id FROM messages WHERE meta_json NOT LIKE ?) ORDER BY id').all(room, '%side_mode%'), original);
    }
    // Reopen both SQLite and routes: reconnect results must come from persistence,
    // not an in-memory projection or the original generation response.
    await app.close(); db.close(); db = openDb(tmp); app = Fastify(); configure();
    for (const receipt of receipts) {
      const reconnected = await app.inject({ method: 'GET', url: `/api/conversations/${receipt.room}/side-mode` });
      assert.equal(reconnected.statusCode, 200);
      receipt.reconnect = reconnected.json().find((row: any) => row.id === receipt.id);
    }
    const artifact = process.env.RPCHAT_BENCH_ARTIFACT_DIR;
    if (artifact) fs.writeFileSync(path.join(artifact, 'recipient-wire.json'), JSON.stringify({ externalModelCalls: 0, liveDbAccess: false, receipts }, null, 2));
    for (const receipt of receipts) {
      const label = `${receipt.format}, filter ${receipt.enabled}, ${receipt.mode}`;
      const expected = [...publicCanaries, ...(receipt.mode === 'summary' ? sharedCanaries : [])];
      const denied = [...forbiddenCanaries, ...(receipt.mode === 'community' ? sharedCanaries : [])];
      check(`${label}: actual HTTP checks every output recipient before sending`, () => {
        const body = JSON.stringify(receipt.wire.messages);
        for (const canary of expected) assert.ok(body.includes(canary), `missing positive ${canary}`);
        for (const canary of denied) assert.ok(!body.includes(canary), `unauthorized HTTP input ${canary}`);
      });
      check(`${label}: allowed content survives SSE, events, intermediate save, GET and reopen`, () => {
        for (const surface of ['sseText', 'sseEvents', 'saved', 'get', 'list', 'done', 'reconnect']) {
          const body = JSON.stringify(receipt[surface]);
          for (const canary of expected) assert.ok(body.includes(canary), `${surface} missing ${canary}`);
          for (const canary of denied) assert.ok(!body.includes(canary), `${surface} exposed ${canary}`);
        }
        assert.ok(receipt.intermediate.length > 0);
        for (const canary of expected) assert.ok(receipt.intermediate.some((snapshot: any) => snapshot.content.includes(canary)), `intermediate missing ${canary}`);
        for (const snapshot of receipt.intermediate) {
          for (const canary of denied) assert.ok(!JSON.stringify(snapshot).includes(canary), `intermediate exposed ${canary}`);
          assert.deepEqual(JSON.parse(snapshot.meta_json).observation, outputAudience(receipt.mode));
        }
        for (const surface of ['get', 'list', 'done', 'reconnect']) assert.deepEqual(receipt[surface].meta.observation, outputAudience(receipt.mode));
        for (const surface of ['streamingGet', 'streamingList']) {
          const firstCanary = JSON.stringify(receipt.wire.messages).match(/CANARY_[A-Z_]+/)?.[0];
          assert.ok(firstCanary && expected.includes(firstCanary));
          assert.ok(receipt[surface].content.includes(firstCanary));
          for (const canary of denied) assert.ok(!JSON.stringify(receipt[surface]).includes(canary), `${surface} exposed ${canary}`);
          assert.deepEqual(receipt[surface].meta.observation, outputAudience(receipt.mode));
        }
      });
    }
    check('all eight requests reached only the loopback provider', () => assert.equal(wire.length, 8));
    console.log(`PASSED ${checks} checks`);
  } finally {
    releaseProvider?.();
    await app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    db.close(); fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
