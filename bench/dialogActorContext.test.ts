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
import { memoryRoutes } from '../apps/server/src/routes/memory.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams } from '../apps/server/src/model/adapter.js';
import { estimateMessageTokens } from '../apps/server/src/prompt/tokens.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-actor-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
const calls: GenParams[] = [];
const result = (text: string) => ({ text, usage: null, finishReason: 'stop', ttftMs: 1, totalMs: 1 });
const model = {
  complete: async (p: GenParams) => { calls.push(p); return result('null'); },
  stream: async (p: GenParams, cb: (text: string) => void) => {
    calls.push(p);
    const s = p.audience?.kind === 'actor' ? `${p.audience.actor_name} | PRIVATE_ACTOR_OUTPUT` : '서술\n나리 | 응답';
    cb(s);
    return result(s);
  },
};
const ctx = { db, model, queue: new GenerationQueue(1), resolvedModel: () => 'mock', effectiveDataDir: tmp } as unknown as Ctx;
const app = Fastify();
for (const route of [characterRoutes, storyRoutes, conversationRoutes, memoryRoutes, chatRoutes]) app.register(route(ctx));
let passed = 0;
async function t(name: string, fn: () => Promise<void>) { await fn(); console.log(`ok ${++passed} ${name}`); }
async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  const r = await app.inject({ method, url, payload });
  assert.ok(r.statusCode < 400, `${r.statusCode} ${r.body}`);
  if (String(r.headers['content-type']).includes('text/event-stream')) { assert.ok(r.body.includes('"type":"done"'), r.body); return null; }
  return r.json();
}
async function main() {
  db.prepare(`INSERT INTO model_profiles (name, temperature, top_p, max_tokens, stop_json, system_mode) VALUES ('rp-balanced', .8, .95, 400, '[]', 'system')`).run();
  const a = await api('POST', '/api/characters', { name: '나리', tags: ['party:place=교실'], first_message: '' });
  const b = await api('POST', '/api/characters', { name: '세라', tags: ['party:place=교실'], first_message: '' });
  const story = await api('POST', '/api/stories', { name: 'fixture', setting: 'WORLD', scene_catalog: { places: [{ id: '교실' }] } });
  for (const [i, c] of [a, b].entries()) await api('POST', `/api/stories/${story.id}/characters`, { characterId: c.id, sortOrder: i });
  const room = await api('POST', '/api/conversations', { characterId: a.id, storyId: story.id, mode: 'story', scene: { format: 'dialog' } });
  const root = insertMessage(db, room.id, null, 'user', 'OLD_INPUT', 'complete');
  setHead(db, room.id, root.id);
  const publicFact = await api('POST', '/api/memories', { conversationId: room.id, content: 'PUBLIC_FACT', evidenceMessageIds: [root.id] });
  const secret = await api('POST', '/api/memories', { conversationId: room.id, content: 'PRIVATE_FACT', evidenceMessageIds: [root.id] });
  const metadata = { version: 1, entries: [
    { memory_id: publicFact.id, anchor_message_id: root.id, kind: 'fact', known_by: 'public', status: 'active' },
    { memory_id: secret.id, anchor_message_id: root.id, kind: 'fact', known_by: [a.id], status: 'active' },
  ] };
  await api('PATCH', `/api/conversations/${room.id}`, { scene: { dialog_context: metadata } });
  const preview = () => api('GET', `/api/conversations/${room.id}/prompt-preview?draft=${encodeURIComponent('나리, CURRENT')}`);
  const send = async () => { calls.length = 0; const r = await app.inject({ method: 'POST', url: `/api/conversations/${room.id}/messages`, payload: { content: '나리, CURRENT' } }); assert.ok(r.body.includes('"type":"done"'), r.body); return calls.find(p => p.max_tokens === 900)!; };
  const wireText = () => calls.filter(p => p.audience).flatMap(p => p.messages).map(m => m.content).join('\n');
  const assertScopedWire = (p: any) => {
    const publicCall = calls.find(c => c.audience?.kind === 'public')!;
    assert.deepEqual(publicCall.messages, p.messages);
    for (const request of p.actor_requests) {
      const actual = calls.find(c => c.audience?.kind === 'actor' && c.audience.actor_id === request.audience.actor_id)!;
      assert.ok(actual, `missing actor request ${request.audience.actor_id}`);
      assert.deepEqual(actual.messages, request.messages);
    }
    if (p.narrator_request) {
      const actual = calls.find(c => c.audience?.kind === 'narrator')!;
      assert.ok(actual, 'missing narrator request');
      assert.deepEqual(actual.messages, p.narrator_request.messages);
    }
  };
  const actor = (p: any, id: string) => p.actor_context.actors.find((v: any) => v.id === id);
  const spec = async (entries: any[]) => api('PATCH', `/api/conversations/${room.id}`, { scene: { dialog_context: { version: 1, entries } } });
  const memory = (text: string, extra: object = {}) => api('POST', '/api/memories?confirm=1', { conversationId: room.id, content: text, evidenceMessageIds: [root.id], ...extra });
  const entry = (m: any, kind: string, known_by: string | string[], extra: object = {}) => ({ memory_id: m.id, anchor_message_id: root.id, kind, known_by, status: 'active', ...extra });
  const budget = (p: any) => {
    assert.equal(p.budget.est_total, p.messages.reduce((n: number, m: any) => n + estimateMessageTokens(m.content, p.budget.calibration), 0));
    assert.ok(p.budget.est_total <= p.budget.available);
    for (const s of p.budget.sections) assert.ok(s.est_tokens <= s.budget, JSON.stringify(s));
  };

  await t('explicit knowledge survives scene authoring and reaches separate actor packets', async () => {
    const p = await preview();
    assert.ok(p.actor_context, 'actor context missing');
    const actual = await send();
    assert.deepEqual(actual.messages, p.messages);
    assert.ok(p.actor_context.public_facts.some((f: any) => f.memory_id === publicFact.id));
    assert.ok(actor(p, a.id).facts.some((f: any) => f.memory_id === secret.id));
    assert.ok(!actor(p, b.id).facts.some((f: any) => f.memory_id === secret.id));
    assert.ok(!JSON.stringify(actor(p, b.id)).includes('PRIVATE_FACT'));
    assert.ok(actor(p, b.id).public_memory_ids.includes(publicFact.id));
    assertScopedWire(p);
    assert.ok(!actual.messages.some(m => m.content.includes('PRIVATE_FACT')), 'public script request excludes private fact');
    const privateCall = calls.find(c => c.audience?.kind === 'actor' && c.audience.actor_id === a.id)!;
    assert.equal(privateCall.messages.map(m => m.content).join('\n').split('PRIVATE_FACT').length - 1, 1, 'private fact appears once in holder request');
    assert.ok(!privateCall.messages.some(m => m.content.includes(b.name)), 'holder request does not carry another actor packet');
    const stored = await api('GET', `/api/conversations/${room.id}`);
    const privateOutput = stored.messages.find((m: any) => m.content === 'PRIVATE_ACTOR_OUTPUT');
    assert.deepEqual(privateOutput.meta.observation, { visibility: 'private', recipient_ids: [a.id, 'user'], observer_ids: [] });
    const next = await preview();
    assert.ok(!next.messages.some((m: any) => m.content.includes('PRIVATE_ACTOR_OUTPUT')), 'private output never re-enters the public script request');
    budget(p);
  });

  await t('12 HTTP turns retain directional relationships, injury, promise, goal and private actor scope', async () => {
    const relA = await memory('A_TO_B_RELATION'); const relB = await memory('B_TO_A_RELATION');
    const injury = await memory('ACTIVE_INJURY'); const promise = await memory('ACTIVE_PROMISE'); const goal = await memory('UNRESOLVED_GOAL');
    const entries = [...metadata.entries,
      entry(relA, 'relationship', [a.id], { subject_id: a.id, target_id: b.id }),
      entry(relB, 'relationship', [b.id], { subject_id: b.id, target_id: a.id }),
      entry(injury, 'injury', [a.id], { subject_id: a.id }),
      entry(promise, 'promise', [a.id], { subject_id: a.id, target_id: 'user' }),
      entry(goal, 'goal', 'public', { subject_id: b.id }),
    ];
    await spec(entries);
    const turnBefore = (await api('GET', `/api/conversations/${room.id}`)).conversation.scene.turn_no;
    for (let i = 0; i < 12; i++) {
      const p = await preview(); const request = await send(); assert.deepEqual(request.messages, p.messages); assertScopedWire(p);
      assert.deepEqual(actor(p, a.id).facts.find((f: any) => f.memory_id === relA.id), { memory_id: relA.id, kind: 'relationship', text: 'A_TO_B_RELATION', subject_id: a.id, target_id: b.id });
      assert.ok(actor(p, b.id).facts.some((f: any) => f.memory_id === relB.id && f.subject_id === b.id && f.target_id === a.id));
      for (const f of [relA, injury, promise]) assert.ok(!JSON.stringify(actor(p, b.id)).includes(f.content));
      for (const f of [injury, promise]) assert.ok(actor(p, a.id).facts.some((v: any) => v.memory_id === f.id));
      assert.ok(p.actor_context.public_facts.some((f: any) => f.memory_id === goal.id)); budget(p);
      assert.ok(actor(p, a.id).facts.some((f: any) => f.memory_id === secret.id));
      assert.ok(!JSON.stringify(actor(p, b.id)).includes(secret.content));
      const stored = await api('GET', `/api/conversations/${room.id}`);
      assert.equal(stored.conversation.scene.turn_no, turnBefore + i + 1, 'each iteration must advance a persisted turn');
    }
  });

  await t('legacy remains unspecified narrator reference; resolved, unapproved and foreign references fail closed', async () => {
    const legacy = await memory('LEGACY_UNSPECIFIED'); const resolved = await memory('RESOLVED_PROMISE');
    const candidate = await memory('UNAPPROVED_SECRET', { status: 'candidate' });
    const foreignActor = await api('POST', '/api/characters', { name: '외부', first_message: '' });
    const foreign = await memory('FOREIGN_SCOPE', { conversationId: null, characterId: foreignActor.id, scope: 'character', evidenceMessageIds: [] });
    const secondary = await memory('SECONDARY_KNOWLEDGE', { conversationId: null, characterId: b.id, scope: 'character' });
    const unknown = await memory('UNKNOWN_RECIPIENT'); const narrator = await memory('NARRATOR_ONLY');
    const entries = [...metadata.entries, entry(resolved, 'promise', [a.id], { subject_id: a.id, target_id: b.id, status: 'resolved' }),
      entry(candidate, 'fact', [a.id]), entry(foreign, 'fact', [a.id]), entry(secondary, 'fact', [b.id]), entry(unknown, 'fact', ['missing-actor']), entry(narrator, 'fact', [])];
    await spec(entries);
    const p = await preview(); const actual = await send(); assert.deepEqual(actual.messages, p.messages);
    const request = actual.messages.map(m => m.content).join('\n');
    for (const m of [resolved, candidate, foreign, unknown]) assert.ok(!request.includes(m.content), m.content);
    assert.ok(request.includes(legacy.content));
    assert.ok(!JSON.stringify(p.actor_context).includes(legacy.content));
    assert.equal(p.actor_context.legacy_policy, 'narrator_reference_unspecified');
    assert.ok(actor(p, b.id).facts.some((f: any) => f.memory_id === secondary.id));
    assert.ok(p.actor_context.narrator_facts.some((f: any) => f.memory_id === narrator.id));
    assert.ok(!JSON.stringify(p.actor_context.actors).includes(narrator.content));
    await api('PATCH', `/api/memories/${candidate.id}?confirm=1`, { status: 'pinned' });
    const approved = await preview(); assert.ok(actor(approved, a.id).facts.some((f: any) => f.memory_id === candidate.id));
    await api('PATCH', `/api/memories/${candidate.id}`, { status: 'rejected' });
    assert.ok(!JSON.stringify((await preview()).actor_context.actors).includes(candidate.content));
    budget(p);
  });

  await t('assignment anchor and memory evidence isolate abandoned branches; regeneration uses branch metadata', async () => {
    await spec(metadata.entries); await send();
    const head = (db.prepare('SELECT head_message_id FROM conversations WHERE id = ?').get(room.id) as any).head_message_id;
    const heard = insertMessage(db, room.id, head, 'user', 'HEARD_EVENT', 'complete'); setHead(db, room.id, heard.id);
    const heardFact = await memory('HEARD_SECRET', { evidenceMessageIds: [heard.id] });
    const sibling = insertMessage(db, room.id, head, 'user', 'SIBLING_EVENT', 'complete');
    const siblingFact = await memory('SIBLING_EVIDENCE', { evidenceMessageIds: [sibling.id] });
    await spec([...metadata.entries, entry(heardFact, 'fact', [b.id], { anchor_message_id: heard.id }), entry(siblingFact, 'fact', [a.id])]);
    const p = await preview(); assert.ok(actor(p, b.id).facts.some((f: any) => f.memory_id === heardFact.id));
    assert.ok(!JSON.stringify(p.actor_context).includes('SIBLING_EVIDENCE'));
    const actual = await send(); assert.deepEqual(actual.messages, p.messages);
    const currentHead = (db.prepare('SELECT head_message_id FROM conversations WHERE id = ?').get(room.id) as any).head_message_id;
    const regen = await api('GET', `/api/conversations/${room.id}/prompt-preview?regenerate=${currentHead}`);
    calls.length = 0; await api('POST', `/api/conversations/${room.id}/regenerate`, { messageId: currentHead });
    assert.deepEqual(calls.find(c => c.max_tokens === 900)!.messages, regen.messages);
    const branch = await api('GET', `/api/conversations/${room.id}/prompt-preview?branch=${heard.id}&draft=${encodeURIComponent('나리, BRANCH')}`);
    assert.ok(!JSON.stringify(branch.actor_context).includes('HEARD_SECRET'));
    calls.length = 0; await api('POST', `/api/conversations/${room.id}/branch`, { messageId: heard.id, content: '나리, BRANCH' });
    assert.deepEqual(calls.find(c => c.max_tokens === 900)!.messages, branch.messages);
    assert.ok(!calls.find(c => c.max_tokens === 900)!.messages.map(m => m.content).join('\n').includes('HEARD_SECRET'));
    const { buildActorContext } = await import('../apps/server/src/prompt/dialogActorContext.js');
    const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(room.id) as any;
    const assignment = buildActorContext(db, c, new Set([root.id]), { version: 1, entries: [entry(publicFact, 'fact', [b.id], { anchor_message_id: heard.id })] }, [a, b].map(({ id, name }) => ({ id, name })), 2000, 1);
    assert.equal(assignment.packet.actors.find(v => v.id === b.id)!.facts.length, 0);
    assert.ok(assignment.packet.excluded.some(e => e.reason === 'assignment-off-branch'));
  });

  await t('metadata validation rejects ambiguity and model proposals cannot alter knowledge or validity', async () => {
    for (const entries of [[metadata.entries[0], metadata.entries[0]], [{ ...metadata.entries[0], known_by: 'publc' }], [entry(secret, 'promise', [a.id], { subject_id: a.id })]]) {
      const r = await app.inject({ method: 'PATCH', url: `/api/conversations/${room.id}`, payload: { scene: { dialog_context: { version: 1, entries } } } }); assert.equal(r.statusCode, 400);
    }
    const { applySceneDelta } = await import('../apps/server/src/prompt/applySceneDelta.js');
    const state: any = { scene_version: 0, dialog_context: metadata };
    const result = applySceneDelta(state, { base_version: 0, dialog_context: { version: 1, entries: [] } }, {}, 0);
    assert.deepEqual(result.state.dialog_context, metadata);
    result.state.dialog_context!.entries[1].known_by = [b.id];
    assert.deepEqual(metadata.entries[1].known_by, [a.id], 'no nested alias into archive/input');
  });

  await t('scoped budget selection is deterministic, whole-or-drop and never falls back to unscoped memory', async () => {
    const { buildDialogPrompt } = await import('../apps/server/src/prompt/dialogPrompt.js');
    const { getPath } = await import('../apps/server/src/db/tree.js');
    const { loadConversation } = await import('../apps/server/src/routes/conversations.js');
    const c = loadConversation(ctx, room.id)!;
    const huge = await memory('BUDGET_SECRET_START ' + '긴 승인 기억 '.repeat(70) + ' BUDGET_SECRET_END');
    const scene: any = { dialog_context: { version: 1, entries: [...metadata.entries, entry(huge, 'fact', [a.id])] } };
    const history = getPath(db, c); history.push({ ...history.at(-1)!, id: 'draft', role: 'user', content: 'CURRENT', meta_json: '{}' });
    const build = () => buildDialogPrompt(db, c, history, '## 규칙\nrules', 'CURRENT', 4096, 'mock', { instruction: null }, scene);
    const p = build(); assert.deepEqual(p, build()); budget(p);
    const request = p.messages.map(m => m.content).join('\n');
    assert.ok(!request.includes('BUDGET_SECRET_START'));
    assert.ok(p.actor_context!.excluded.some(e => e.memory_id === huge.id && e.reason === 'budget'));
    assert.ok(!JSON.stringify(p.actor_context!.actors.find(v => v.id === b.id)).includes('PRIVATE_FACT'));
    const changes = (db.prepare('SELECT total_changes() AS n').get() as any).n; const count = calls.length;
    await preview(); assert.equal((db.prepare('SELECT total_changes() AS n').get() as any).n, changes); assert.equal(calls.length, count);
    const malformed = buildDialogPrompt(db, c, history, '## 규칙\nrules', 'CURRENT', 4096, 'mock', { instruction: null }, { dialog_context: { version: 2, entries: metadata.entries } } as any);
    assert.ok(!malformed.messages.map(m => m.content).join('\n').includes('PRIVATE_FACT'));
    assert.ok(malformed.actor_context!.excluded.some(e => e.reason === 'invalid-contract'));
  });

  await t('active-resolved transitions and memory deletion or approval removal take effect on each request', async () => {
    const promise = await memory('LIFECYCLE_PROMISE');
    const definition = entry(promise, 'promise', [a.id], { subject_id: a.id, target_id: 'user' });
    const check = async (included: boolean) => {
      const p = await preview(); const actual = await send(); assert.deepEqual(actual.messages, p.messages);
      assert.equal(actor(p, a.id).facts.some((f: any) => f.memory_id === promise.id), included);
      assert.equal(wireText().includes(promise.content), included);
      assert.equal(actual.messages.some(m => m.content.includes(promise.content)), false, 'private promise never enters public request');
      assertScopedWire(p);
      budget(p); return p;
    };
    await spec([...metadata.entries, definition]); await check(true);
    await spec([...metadata.entries, { ...definition, status: 'resolved' }]);
    const resolved = await check(false);
    assert.ok(resolved.actor_context.excluded.some((e: any) => e.memory_id === promise.id && e.reason === 'resolved'));
    assert.equal((db.prepare('SELECT status FROM memories WHERE id = ?').get(promise.id) as any).status, 'pinned', 'validity never mutates approval');
    await spec([...metadata.entries, definition]); await check(true);
    for (const status of ['candidate', 'rejected', 'superseded']) {
      await api('PATCH', `/api/memories/${promise.id}`, { status });
      const p = await check(false);
      assert.ok(p.actor_context.excluded.some((e: any) => e.memory_id === promise.id && e.reason === 'not-approved'));
      await api('PATCH', `/api/memories/${promise.id}?confirm=1`, { status: 'pinned' }); await check(true);
    }
    await api('DELETE', `/api/memories/${promise.id}`);
    const deleted = await check(false);
    assert.ok(deleted.actor_context.excluded.some((e: any) => e.memory_id === promise.id && e.reason === 'not-approved'));
  });

  await t('version, field, ID, recipient and entry limits reject invalid writes without changing the scene', async () => {
    const sceneJson = () => (db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(room.id) as any).scene_json;
    const before = sceneJson();
    const invalid = [
      { version: 2, entries: metadata.entries },
      { version: 1, entries: [{ ...metadata.entries[0], invented_field: true }] },
      { version: 1, entries: [{ ...metadata.entries[0], memory_id: 'x'.repeat(101) }] },
      { version: 1, entries: [{ ...metadata.entries[0], anchor_message_id: '' }] },
      { version: 1, entries: [{ ...metadata.entries[0], anchor_message_id: undefined }] },
      { version: 1, entries: [{ ...metadata.entries[0], known_by: Array.from({ length: 13 }, (_, i) => `id-${i}`) }] },
      { version: 1, entries: [{ ...metadata.entries[0], known_by: [a.id, a.id] }] },
      { version: 1, entries: Array.from({ length: 65 }, (_, i) => ({ ...metadata.entries[0], memory_id: `id-${i}` })) },
    ];
    for (const dialog_context of invalid) {
      const r = await app.inject({ method: 'PATCH', url: `/api/conversations/${room.id}`, payload: { scene: { dialog_context } } });
      assert.equal(r.statusCode, 400, r.body); assert.equal(sceneJson(), before);
    }
    await spec([...metadata.entries, { ...metadata.entries[0], memory_id: 'missing-memory' }]);
    const p = await preview(); const actual = await send(); assert.deepEqual(actual.messages, p.messages);
    assert.ok(p.actor_context.excluded.some((e: any) => e.memory_id === 'missing-memory' && e.reason === 'not-approved'));
    assert.ok(!JSON.stringify(p.actor_context.public_facts).includes('missing-memory'));
    assert.ok(!actual.messages.some(m => m.content.includes('missing-memory'))); budget(p);
  });

  await t('synthetic, foreign, deleted and sibling anchors are rejected at write and excluded from legacy assembly', async () => {
    const other = await api('POST', '/api/conversations', { characterId: a.id });
    const foreign = insertMessage(db, other.id, null, 'user', 'FOREIGN_ANCHOR', 'complete');
    const deleted = insertMessage(db, room.id, root.id, 'user', 'DELETED_ANCHOR', 'complete');
    db.prepare('DELETE FROM messages WHERE id = ?').run(deleted.id);
    const sibling = insertMessage(db, room.id, root.id, 'user', 'SIBLING_ANCHOR', 'complete');
    const reject = async (anchor: string) => {
      const before = (db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(room.id) as any).scene_json;
      const r = await app.inject({ method: 'PATCH', url: `/api/conversations/${room.id}`, payload: { scene: { dialog_context: { version: 1, entries: [metadata.entries[0], { ...metadata.entries[1], anchor_message_id: anchor }] } } } });
      assert.equal(r.statusCode, 400, anchor);
      assert.equal((db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(room.id) as any).scene_json, before);
    };
    const legacy = async (anchor: string, reason: string) => {
      // Rehearse old/bypassed stored JSON: assembly must remain safe even without the write guard.
      const c = db.prepare('SELECT scene_json, head_message_id FROM conversations WHERE id = ?').get(room.id) as any;
      const scene = JSON.parse(c.scene_json);
      scene.dialog_context = { version: 1, entries: [metadata.entries[0], { ...metadata.entries[1], anchor_message_id: anchor }] };
      scene.pending_edit = { head_message_id: c.head_message_id };
      db.prepare('UPDATE conversations SET scene_json = ? WHERE id = ?').run(JSON.stringify(scene), room.id);
      const p = await preview(); const actual = await send();
      assert.deepEqual(actual.messages, p.messages, 'draft anchor must not grant knowledge in preview only');
      assert.ok(p.actor_context.excluded.some((e: any) => e.memory_id === secret.id && e.reason === reason));
      assert.ok(!JSON.stringify(p.actor_context.actors).includes('PRIVATE_FACT'));
      assert.ok(!wireText().includes('PRIVATE_FACT')); budget(p);
    };
    for (const anchor of ['draft', foreign.id, deleted.id]) { await reject(anchor); await legacy(anchor, 'invalid-anchor'); }
    await reject(sibling.id); await legacy(sibling.id, 'assignment-off-branch');
    const collision = insertMessage(db, room.id, root.id, 'user', 'DRAFT_ID_COLLISION', 'complete');
    db.prepare("UPDATE messages SET id = 'draft' WHERE id = ?").run(collision.id);
    await reject('draft'); await legacy('draft', 'assignment-off-branch');
    const { buildActorContext } = await import('../apps/server/src/prompt/dialogActorContext.js');
    const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(room.id) as any;
    for (const anchor of [foreign.id, deleted.id]) {
      const built = buildActorContext(db, c, new Set([root.id, anchor]), { version: 1, entries: [{ ...metadata.entries[1], anchor_message_id: anchor }] }, [a, b].map(({ id, name }) => ({ id, name })), 2000, 1);
      assert.ok(built.packet.excluded.some(e => e.reason === 'invalid-anchor'), 'membership alone is insufficient');
    }
    await spec(metadata.entries);
    const p = await preview(); const actual = await send(); assert.deepEqual(actual.messages, p.messages);
    assert.ok(actor(p, a.id).facts.some((f: any) => f.memory_id === secret.id), 'stored ancestor stays eligible');
    const fresh = await app.inject({ method: 'POST', url: '/api/conversations', payload: { characterId: a.id, scene: { dialog_context: metadata } } });
    assert.equal(fresh.statusCode, 400, 'new room cannot anchor to another room before it has messages');
  });

  await t('a stored draft ID ancestor stays valid and virtual collision cannot extend summary coverage', async () => {
    const { buildDialogPrompt } = await import('../apps/server/src/prompt/dialogPrompt.js');
    const { getPath } = await import('../apps/server/src/db/tree.js');
    const c = await api('POST', '/api/conversations', { characterId: a.id, storyId: story.id, mode: 'story', scene: { format: 'dialog' } });
    // Remove the isolated sibling collision from the previous group, then create a real ancestor.
    db.prepare("DELETE FROM messages WHERE id = 'draft'").run();
    const start = insertMessage(db, c.id, null, 'user', 'COLLISION_OLD_ROOT', 'complete');
    db.prepare("UPDATE messages SET id = 'draft' WHERE id = ?").run(start.id);
    let parent = 'draft';
    for (let i = 1; i < 40; i++) parent = insertMessage(db, c.id, parent, i % 2 ? 'assistant' : 'user', `COLLISION_KEEP_${i}`, 'complete').id;
    setHead(db, c.id, parent);
    const remembered = await api('POST', '/api/memories?confirm=1', { conversationId: c.id, content: 'VALID_STORED_ANCHOR_FACT', evidenceMessageIds: ['draft'] });
    await api('PATCH', `/api/conversations/${c.id}`, { scene: { dialog_context: { version: 1, entries: [{ ...entry(remembered, 'fact', [a.id]), anchor_message_id: 'draft' }] } } });
    const p = await api('GET', `/api/conversations/${c.id}/prompt-preview?draft=${encodeURIComponent('나리, COLLISION_CURRENT')}`);
    assert.ok(actor(p, a.id).facts.some((f: any) => f.memory_id === remembered.id), 'stored ancestor is valid regardless of its ID spelling');
    calls.length = 0; await api('POST', `/api/conversations/${c.id}/messages`, { content: '나리, COLLISION_CURRENT' });
    assert.deepEqual(calls.find(v => v.max_tokens === 900)!.messages, p.messages);
    db.prepare(`INSERT INTO summaries (id, conversation_id, content, status, tier, covers_until_message_id, created_at)
      VALUES ('collision-summary', ?, 'COLLISION_SUMMARY', 'approved', 'whole', 'draft', '2026')`).run(c.id);
    const stored = db.prepare('SELECT * FROM conversations WHERE id = ?').get(c.id) as any;
    const history = getPath(db, stored);
    const virtual = { ...history[0], id: 'draft', role: 'user' as const, content: 'VIRTUAL_CURRENT', prompt_preview_draft: true };
    history.push(virtual);
    const built = buildDialogPrompt(db, stored, history, '## 규칙\nrules', 'VIRTUAL_CURRENT', 8192, 'mock');
    const request = built.messages.map(m => m.content).join('\n');
    assert.ok(request.includes('COLLISION_SUMMARY'));
    assert.ok(!request.includes('COLLISION_OLD_ROOT'));
    assert.ok(request.includes('COLLISION_KEEP_1'), 'virtual ID must not move the stored ancestor watermark forward'); budget(built);
  });
}
main().then(() => console.log(`PASS=${passed}`)).catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await app.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
