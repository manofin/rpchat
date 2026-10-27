import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { openMigratedDb, openDb, one, run } from '../apps/server/src/db/index.js';
import { getPath, insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { memoryRoutes } from '../apps/server/src/routes/memory.js';
import { ModelClient } from '../apps/server/src/model/adapter.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { provenanceReader } from '../apps/server/src/memory/provenance.js';
import { buildDialogPrompt } from '../apps/server/src/prompt/dialogPrompt.js';
import { buildSideModePrompt } from '../apps/server/src/prompt/sideModePrompt.js';
import { buildPrompt } from '../apps/server/src/prompt/builder.js';
import { selectContext } from '../apps/server/src/prompt/contextSelection.js';
import type { ConversationRow, MemoryRow, SummaryRow } from '../apps/server/src/types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'derived-provenance-'));
let db = openMigratedDb(dir, path.resolve('apps/server/migrations'));
let app = Fastify();
const wire: any[] = [];
let output: any = {};
let duringModel: (() => Promise<void> | void) | undefined;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  wire.push(JSON.parse(raw));
  const hook = duringModel; duringModel = undefined; await hook?.();
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
const PUBLIC = { visibility: 'public' as const };
const shared = { visibility: 'private' as const, recipient_ids: ['user', 'a'], observer_ids: [] };
let checks = 0;
async function check(label: string, fn: () => unknown) { await fn(); console.log(`ok ${++checks} ${label}`); }
const conv = (id: string) => one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id=?', id)!;
const memory = (id: string) => one<MemoryRow>(db, 'SELECT * FROM memories WHERE id=?', id)!;
const summary = (id: string) => one<SummaryRow>(db, 'SELECT * FROM summaries WHERE id=?', id)!;
const request = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => app.inject({ method, url, payload });
function room(id: string, format = 'dialog') {
  run(db, 'INSERT INTO conversations(id,character_id,profile_name,prompt_version,title,scene_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    id, 'a', 'default', 'test', id, JSON.stringify({ format }), '2026', '2026');
}
function add(id: string, text: string, audience: any = PUBLIC) {
  return insertMessage(db, id, conv(id).head_message_id, 'user', text, 'complete', { observation: audience });
}
function append(id: string, text: string, audience: any = PUBLIC) {
  const m = add(id, text, audience); setHead(db, id, m.id); return m;
}
function result(text: string, scene = text) { output = { summary: text, state: { 보류: text }, scene, memories: [{ content: text, importance: 3 }] }; }
async function summarize(id: string) {
  const r = await request('POST', `/api/conversations/${id}/summarize`, {}); assert.equal(r.statusCode, 200, r.body); return r.json();
}
const body = (messages: unknown) => JSON.stringify(messages);
async function main() {
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const model = new ModelClient(`http://127.0.0.1:${address.port}/v1`, '', 5000, dir);
    const configure = () => app.register(memoryRoutes({ db, model, queue: new GenerationQueue(1), log: app.log, resolvedModel: () => 'loopback-only' } as any));
    await configure();
    for (const id of ['a', 'b']) run(db, 'INSERT INTO characters(id,name,created_at,updated_at) VALUES(?,?,?,?)', id, '같은 이름', '2026', '2026');
    room('mixed');
    run(db, 'UPDATE conversations SET story_participant_ids_snapshot=? WHERE id=?', JSON.stringify(['a', 'b']), 'mixed');
    const first = append('mixed', 'PUBLIC_SOURCE');
    const secret = append('mixed', 'PRIVATE_MIDDLE_SOURCE', shared);
    const last = append('mixed', 'PUBLIC_LAST_SOURCE');
    result('PRIVATE_DERIVED_CANARY');
    const oneResult = await summarize('mixed');
    const mid = oneResult.candidates[0].id;
    await check('actual selected middle input and audience survive every generated artifact', () => {
      assert.ok(body(wire.at(-1).messages).includes('PRIVATE_MIDDLE_SOURCE'));
      for (const artifact of [oneResult.summary, oneResult.state, oneResult.scene, oneResult.candidates[0]]) {
        const p = JSON.parse(artifact.input_provenance_json);
        assert.deepEqual(p.inputs.map((s: any) => s.id), [first.id, secret.id, last.id]);
        assert.deepEqual(p.ceiling, { visibility: 'private', recipient_ids: ['a', 'user'], observer_ids: [] });
      }
    });
    await request('PATCH', `/api/memories/${mid}?confirm=1`, { status: 'pinned' });
    await request('PATCH', `/api/summaries/${oneResult.summary.id}`, { status: 'approved' });
    await check('pin and public/narrator/actor assignment cannot expand source rights', async () => {
      for (const known_by of ['public', [], ['b'], ['a']] as any[]) {
        const scene = { format: 'dialog', dialog_context: { version: 1, entries: [{ memory_id: mid, anchor_message_id: last.id, kind: 'fact', known_by, status: 'active' }] } };
        const c = { ...conv('mixed'), scene_json: JSON.stringify(scene) };
        const built = buildDialogPrompt(db, c, getPath(db, c), '공개', '계속', 8192, 'loopback-only', undefined, scene as any);
        assert.ok(!body(built.messages).includes('PRIVATE_DERIVED_CANARY'));
        assert.ok(!body(built.narrator_request).includes('PRIVATE_DERIVED_CANARY'));
        assert.equal(body(built.actor_requests).includes('PRIVATE_DERIVED_CANARY'), Array.isArray(known_by) && known_by[0] === 'a');
        if (built.actor_requests.length) {
          await model.complete({ model: 'loopback-only', messages: built.actor_requests[0].messages, max_tokens: 64 });
          assert.ok(body(wire.at(-1).messages).includes('PRIVATE_DERIVED_CANARY'));
        }
      }
    });
    const newPublic = append('mixed', 'NEW_PUBLIC_SOURCE');
    result('SECOND_PRIVATE_CANARY');
    const twoResult = await summarize('mixed');
    await check('previous summary dependency is captured even with only new public messages', () => {
      const p = JSON.parse(twoResult.candidates[0].input_provenance_json);
      assert.deepEqual(p.inputs.map((s: any) => [s.kind, s.id]), [['summary', oneResult.summary.id], ['message', newPublic.id]]);
      assert.equal(provenanceReader(db).canUse(memory(twoResult.candidates[0].id), 'memory'), false);
      assert.equal(provenanceReader(db).canUse(memory(twoResult.candidates[0].id), 'memory', shared), true);
    });
    await check('editing, character scope and restore preserve private restrictions', async () => {
      const changed = await request('PATCH', `/api/memories/${mid}`, { content: 'EDITED_PRIVATE_CANARY', scope: 'character' });
      assert.equal(changed.statusCode, 200);
      assert.equal(provenanceReader(db).canUse(memory(mid), 'memory'), false);
      assert.equal(provenanceReader(db).canUse(memory(mid), 'memory', shared), true);
      const restored = await request('POST', `/api/summaries/${oneResult.summary.id}/restore`, {});
      assert.equal(restored.statusCode, 200);
      assert.equal(restored.json().input_provenance_json, summary(oneResult.summary.id).input_provenance_json);
      assert.equal(provenanceReader(db).canUse(restored.json(), 'summary'), false);
      for (const mode of ['summary', 'community'] as const) assert.ok(!body(buildSideModePrompt(db, conv('mixed'), mode, '', 8192).messages).includes('EDITED_PRIVATE_CANARY'));
    });
    room('legacy');
    const legacyFirst = append('legacy', 'LEGACY_ORIGINAL_READABLE');
    for (let i = 0; i < 24; i++) append('legacy', `PUBLIC_TURN_${i}`);
    run(db, `INSERT INTO summaries(id,conversation_id,content,covers_until_message_id,status,tier,created_at) VALUES('old','legacy','LEGACY_SUMMARY_CANARY',?,'approved','whole','9999')`, conv('legacy').head_message_id);
    run(db, `INSERT INTO memories(id,conversation_id,character_id,content,source,status,importance,scope,evidence_message_ids_json,created_at,updated_at) VALUES('old-memory','legacy','a','LEGACY_MEMORY_CANARY','model','pinned',3,'conversation','[]','2026','2026')`);
    await check('legacy generated records remain readable with withholding reason, including restore', async () => {
      const sums = (await request('GET', '/api/conversations/legacy/summaries')).json();
      const mems = (await request('GET', '/api/conversations/legacy/memories')).json();
      assert.equal(sums[0].content, 'LEGACY_SUMMARY_CANARY'); assert.equal(sums[0].generation_access.status, 'withheld');
      assert.equal(mems.pinned[0].content, 'LEGACY_MEMORY_CANARY'); assert.equal(mems.pinned[0].generation_access.status, 'withheld');
      const restored = (await request('POST', '/api/summaries/old/restore', {})).json();
      assert.equal(restored.content, 'LEGACY_SUMMARY_CANARY'); assert.equal(restored.input_provenance_json, null);
      assert.equal(provenanceReader(db).canUse(restored, 'summary'), false);
    });
    await check('withheld legacy summaries cannot compact original history in solo or dialog', () => {
      const c = conv('legacy'), history = getPath(db, c);
      for (const built of [buildPrompt(db, c, history, 8192, 'loopback-only'), buildDialogPrompt(db, c, history, '공개', '계속', 8192, 'loopback-only')]) {
        assert.ok(body(built.messages).includes('LEGACY_ORIGINAL_READABLE'));
        assert.ok(!body(built.messages).includes('LEGACY_SUMMARY_CANARY')); assert.ok(!body(built.messages).includes('LEGACY_MEMORY_CANARY'));
      }
    });
    await check('legacy manual public memory remains usable without invented provenance', async () => {
      const r = await request('POST', '/api/memories', { conversationId: 'legacy', content: 'MANUAL_PUBLIC_CANARY' }); assert.equal(r.statusCode, 201);
      const p = r.json(); assert.equal(provenanceReader(db).canUse(memory(p.id), 'memory'), true);
      run(db, 'UPDATE memories SET input_provenance_json=NULL WHERE id=?', p.id);
      assert.equal(provenanceReader(db).canUse(memory(p.id), 'memory'), true);
    });
    result('VERIFIED_PUBLIC_SUMMARY');
    const validPublic = await summarize('legacy');
    await request('PATCH', `/api/summaries/${validPublic.summary.id}`, { status: 'approved' });
    for (let i = 0; i < 6; i++) run(db, `INSERT INTO summaries(id,conversation_id,content,covers_until_message_id,status,tier,created_at) VALUES(?, 'legacy','UNKNOWN_NEWER',?,'approved','whole',?)`, `newer-${i}`, legacyFirst.id, `9999-${i}`);
    await check('newer unverified records do not starve an older eligible summary', () => {
      assert.equal(selectContext(db, conv('legacy'), getPath(db, conv('legacy')), { memory: 4000, lore: 500 }, 1).summaryText, 'VERIFIED_PUBLIC_SUMMARY');
      assert.ok(!body(wire.find(r => body(r.messages).includes('LEGACY_ORIGINAL_READABLE'))?.messages).includes('LEGACY_SUMMARY_CANARY'));
    });
    await check('malformed, unknown version, missing source and hash mismatch fail closed', () => {
      const original = memory(mid).input_provenance_json!;
      const parsed = JSON.parse(original);
      const variants = [{}, { ...parsed, version: 99 }, { ...parsed, basis: 'generated', inputs: [] }, { ...parsed, inputs: [{ ...parsed.inputs[0], id: 'missing' }] }, { ...parsed, content_sha256: '0'.repeat(64) }];
      for (const bad of variants) {
        run(db, 'UPDATE memories SET input_provenance_json=? WHERE id=?', JSON.stringify(bad), mid);
        assert.equal(provenanceReader(db).canUse(memory(mid), 'memory', shared), false);
      }
      run(db, 'UPDATE memories SET input_provenance_json=? WHERE id=?', original, mid);
      assert.equal(provenanceReader(db).canUse(memory(mid), 'memory', shared), true);
    });
    await check('moving to a sibling branch withholds derived data and switching back restores eligibility', () => {
      const head = conv('mixed').head_message_id;
      const sibling = insertMessage(db, 'mixed', first.id, 'user', 'OTHER_BRANCH', 'complete'); setHead(db, 'mixed', sibling.id);
      assert.equal(provenanceReader(db).canUse(memory(mid), 'memory', shared), false);
      setHead(db, 'mixed', head); assert.equal(provenanceReader(db).canUse(memory(mid), 'memory', shared), true);
    });
    await check('selected branch preview uses its own provenance path without changing the active head', () => {
      const head = conv('mixed').head_message_id;
      const scene = { format: 'dialog', dialog_context: { version: 1, entries: [{ memory_id: mid, anchor_message_id: last.id, kind: 'fact', known_by: ['a'], status: 'active' }] } };
      const build = (c: ConversationRow) => buildDialogPrompt(db, c, getPath(db, c), '공개', '계속', 8192, 'loopback-only', undefined, scene as any);
      const expected = build(conv('mixed'));
      const sibling = insertMessage(db, 'mixed', first.id, 'user', 'PREVIEW_OTHER_BRANCH', 'complete'); setHead(db, 'mixed', sibling.id);
      assert.ok(!body(build(conv('mixed')).actor_requests).includes('EDITED_PRIVATE_CANARY'));
      const selected = build({ ...conv('mixed'), head_message_id: head });
      assert.ok(body(selected.actor_requests).includes('EDITED_PRIVATE_CANARY'));
      assert.deepEqual(selected.actor_requests, expected.actor_requests);
      assert.equal(conv('mixed').head_message_id, sibling.id); setHead(db, 'mixed', head);
    });
    await check('manual evidence from another branch stays readable but withheld until that branch is selected', async () => {
      const head = conv('mixed').head_message_id;
      const sibling = insertMessage(db, 'mixed', first.id, 'user', 'MANUAL_OTHER_BRANCH', 'complete', { observation: shared });
      const r = await request('POST', '/api/memories?confirm=1', { conversationId: 'mixed', content: 'MANUAL_SIBLING_FACT', evidenceMessageIds: [sibling.id] });
      assert.equal(r.statusCode, 201, r.body); assert.equal(r.json().generation_access.status, 'withheld');
      setHead(db, 'mixed', sibling.id);
      assert.equal(provenanceReader(db).canUse(memory(r.json().id), 'memory', shared), true);
      assert.equal(provenanceReader(db).canUse(memory(r.json().id), 'memory'), false);
      setHead(db, 'mixed', head);
    });
    await check('source changes while a model is running prevent all derived writes', async () => {
      for (const mutation of ['content', 'audience', 'previous-summary', 'approval-withdrawal', 'source-deletion']) {
        const id = `race-${mutation}`; room(id); const source = append(id, 'RACE_SOURCE', shared);
        let previous: any;
        if (mutation === 'previous-summary' || mutation === 'approval-withdrawal') {
          result('RACE_PREVIOUS'); previous = await summarize(id);
          await request('PATCH', `/api/summaries/${previous.summary.id}`, { status: 'approved' }); append(id, 'RACE_NEXT');
        }
        const before = db.prepare('SELECT COUNT(*) n FROM summaries WHERE conversation_id=?').get(id);
        duringModel = async () => {
          if (mutation === 'content') run(db, 'UPDATE messages SET content=? WHERE id=?', 'CHANGED_SOURCE', source.id);
          else if (mutation === 'audience') run(db, 'UPDATE messages SET meta_json=? WHERE id=?', JSON.stringify({ observation: PUBLIC }), source.id);
          else if (mutation === 'source-deletion') run(db, 'DELETE FROM messages WHERE id=?', source.id);
          else { const r = await request('PATCH', `/api/summaries/${previous.summary.id}`, mutation === 'approval-withdrawal' ? { status: 'draft' } : { content: 'CHANGED_PREVIOUS' }); assert.equal(r.statusCode, 200); }
        };
        result('MUST_NOT_COMMIT');
        const r = await request('POST', `/api/conversations/${id}/summarize`, {});
        assert.equal(r.statusCode, 409, r.body);
        assert.deepEqual(db.prepare('SELECT COUNT(*) n FROM summaries WHERE conversation_id=?').get(id), before);
        assert.equal(db.prepare("SELECT COUNT(*) n FROM memories WHERE conversation_id=? AND content='MUST_NOT_COMMIT'").get(id)?.n, 0);
      }
    });
    await check('a restricted rollup retains every scene dependency without hiding public scenes', async () => {
      room('roll'); append('roll', 'ROLL_PUBLIC_SOURCE'); result('ROLL_PUBLIC_WHOLE', 'ROLL_PUBLIC_SCENE'); const pub = await summarize('roll');
      await request('PATCH', `/api/summaries/${pub.summary.id}`, { status: 'approved' });
      append('roll', 'ROLL_PRIVATE_SOURCE', shared); result('ROLL_PRIVATE_WHOLE', 'ROLL_PRIVATE_SCENE'); const priv = await summarize('roll');
      await request('PATCH', `/api/summaries/${priv.summary.id}`, { status: 'approved' });
      output = { episode: 'ROLL_PRIVATE_EPISODE' };
      const rolled = await request('POST', '/api/conversations/roll/rollup-episode?force=1', {}); assert.equal(rolled.statusCode, 200, rolled.body);
      const episode = rolled.json().episode; const p = JSON.parse(episode.input_provenance_json);
      assert.deepEqual(new Set(p.inputs.map((s: any) => s.id)), new Set([pub.scene.id, priv.scene.id]));
      assert.equal(provenanceReader(db).canUse(episode, 'summary'), false); assert.equal(provenanceReader(db).canUse(episode, 'summary', shared), true);
      await request('PATCH', `/api/summaries/${episode.id}`, { status: 'approved' });
      for (let i = 0; i < 30; i++) append('roll', `LATER_TURN_${i}`);
      const selected = selectContext(db, conv('roll'), getPath(db, conv('roll')), { memory: 4000, lore: 500 }, 1);
      assert.ok(body(selected.memoryParts).includes('ROLL_PUBLIC_SCENE')); assert.ok(!body(selected.memoryParts).includes('ROLL_PRIVATE_EPISODE'));
    });
    await check('rollup of only unverified legacy scenes refuses before any model call', async () => {
      room('old-roll'); const source = append('old-roll', 'OLD_ROLL_SOURCE');
      run(db, `INSERT INTO summaries(id,conversation_id,content,covers_until_message_id,status,tier,created_at) VALUES('old-scene','old-roll','OLD_SCENE',?,'approved','scene','2026')`, source.id);
      const before = wire.length;
      assert.equal((await request('POST', '/api/conversations/old-roll/rollup-episode?force=1', {})).statusCode, 400); assert.equal(wire.length, before);
    });
    await check('reopening SQLite and routes preserves private positive and public negative', async () => {
      await app.close(); db.close(); db = openDb(dir); app = Fastify(); await configure();
      assert.equal(provenanceReader(db).canUse(memory(mid), 'memory'), false);
      assert.equal(provenanceReader(db).canUse(memory(mid), 'memory', shared), true);
      const records = (await request('GET', '/api/conversations/mixed/memories')).json();
      assert.ok(records.pinned.some((m: any) => m.id === mid && m.content === 'EDITED_PRIVATE_CANARY'));
      assert.equal((await request('GET', '/api/conversations/legacy/summaries')).json().find((s: any) => s.id === 'old').generation_access.status, 'withheld');
    });
    console.log(`PASSED ${checks} checks`);
  } finally {
    const artifact = process.env.RPCHAT_BENCH_ARTIFACT_DIR;
    if (artifact) fs.writeFileSync(path.join(artifact, 'wire.json'), JSON.stringify({ externalModelCalls: 0, wire }, null, 2));
    await app.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
