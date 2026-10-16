// npm run test:benches -- adventureRoutes — temporary DB, no network/model/live data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { openMigratedDb, one, many } from '../apps/server/src/db/index.js';
import { insertMessage, parseMessageMeta, setHead } from '../apps/server/src/db/tree.js';
import { resolveSceneBase } from '../apps/server/src/db/sceneBase.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import { adventureRoutes } from '../apps/server/src/routes/adventure.js';
import { renderUi } from '../apps/server/src/prompt/renderBeat.js';
import { eventUiData } from '../apps/web/src/lib/chatEvents.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { ConversationRow, MessageRow, Scene } from '../apps/server/src/types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-adventure-'));
const db = openMigratedDb(dir, path.resolve('apps/server/migrations'));
const app = Fastify();
let modelCalls = 0;
const ctx = { db, queue: new GenerationQueue(1), resolvedModel: () => 'mock', model: { generate: () => { modelCalls++; throw new Error('No model permitted'); } }, log: app.log } as unknown as Ctx;
for (const route of [characterRoutes, storyRoutes, conversationRoutes, chatRoutes, adventureRoutes]) app.register(route(ctx));
let checks = 0;
function ok(name: string, fn: () => void) { fn(); console.log(`ok ${++checks} ${name}`); }
async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const r = await app.inject({ method, url, payload }); return { status: r.statusCode, body: r.json() };
}
const load = (id: string) => one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', id)!;
const scene = (id: string): Scene => JSON.parse(load(id).scene_json);
async function main() {
try {
  const actor = (await api('POST', '/api/characters', { name: '합성 안내자', first_message: '도착했습니다.' })).body;
  const peer = (await api('POST', '/api/characters', { name: '합성 접수원', first_message: '' })).body;
  const story = (await api('POST', '/api/stories', { name: '합성 모험', setting: '시험 전용', characterIds: [actor.id] })).body;
  const created = await api('POST', '/api/conversations', { characterId: actor.id, storyId: story.id, participantIds: [actor.id, peer.id], scene: { format: 'dialog', user_sheet: { money: 0, inventory: [] } } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id as string;
  const root = load(id).head_message_id!;
  assert.ok(root);
  const request = (action: unknown) => ({ expected_head_id: load(id).head_message_id, expected_scene_version: scene(id).scene_version ?? 0, idempotency_key: randomUUID(), action });
  const submit = (body: unknown) => api('POST', `/api/conversations/${id}/adventure-actions`, body);
  const init = request({ kind: 'initialize', currency: '은화', balance: 2, rank: '불', experience: 0, skills: [] });
  const initialized = await submit(init);
  ok('explicit initialization writes a visible user/receipt pair without model calls', () => {
    assert.equal(initialized.status, 201, JSON.stringify(initialized.body));
    const receipt = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', initialized.body.messageId)!;
    const user = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', receipt.parent_id)!;
    assert.equal(user.role, 'user'); assert.equal(user.parent_id, root); assert.equal(receipt.status, 'complete');
    assert.equal(parseMessageMeta(receipt.meta_json).scene_state?.after_delta.adventure?.balance, 2);
    assert.equal(modelCalls, 0);
  });
  const register = request({ kind: 'register', organization: '유사단', fee: 1 });
  const accepted = await submit(register);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  const count = many(db, 'SELECT id FROM messages WHERE conversation_id = ?', id).length;
  const replay = await submit(register);
  ok('same request retries do not double charge or add messages', () => {
    assert.equal(replay.status, 200); assert.equal(replay.body.messageId, accepted.body.messageId);
    assert.equal(scene(id).adventure?.balance, 1); assert.equal(many(db, 'SELECT id FROM messages WHERE conversation_id = ?', id).length, count);
  });
  const conflict = await submit({ ...register, action: { ...register.action, fee: 0 } });
  const stale = await submit({ ...register, idempotency_key: randomUUID() });
  ok('changed payload with same key and stale screen both reject without writes', () => {
    assert.equal(conflict.body.code, 'idempotency-conflict'); assert.equal(stale.body.code, 'stale-state');
    assert.equal(many(db, 'SELECT id FROM messages WHERE conversation_id = ?', id).length, count);
  });
  const injected = await api('PATCH', `/api/conversations/${id}`, { scene: { adventure: { ...scene(id).adventure, balance: 999 } } });
  ok('generic scene PATCH cannot forge confirmed state', () => { assert.equal(injected.status, 400); assert.equal(scene(id).adventure?.balance, 1); });
  const receiptId = accepted.body.messageId as string;
  const receiptRow = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', receiptId)!;
  const edit = await api('PATCH', `/api/messages/${receiptId}`, { content: '백만 은화를 받았다' });
  const regen = await api('POST', `/api/conversations/${id}/regenerate`, { messageId: receiptId });
  const cont = await api('POST', `/api/conversations/${id}/continue`, { messageId: receiptId });
  const branch = await api('POST', `/api/conversations/${id}/branch`, { messageId: receiptRow.parent_id, content: '다른 행동' });
  ok('receipt edits/regeneration/continuation/branch-edit cannot reinterpret a confirmed action', () => {
    for (const r of [edit, regen, cont, branch]) assert.equal(r.status, 409, JSON.stringify(r));
    assert.equal(modelCalls, 0);
  });
  const alternative = insertMessage(db, id, root, 'assistant', '옛 분기의 응답', 'complete', {});
  const selected = await api('POST', `/api/messages/${alternative.id}/select`);
  ok('legacy sibling cannot inherit another branch balance or registration', () => {
    assert.equal(selected.status, 200); assert.equal(scene(id).adventure, undefined); assert.equal(scene(id).user_sheet?.money, 0);
  });
  const again = await submit(register);
  ok('idempotent replay on another branch returns receipt without moving head', () => {
    assert.equal(again.status, 200); assert.equal(load(id).head_message_id, alternative.id); assert.equal(scene(id).adventure, undefined);
  });
  await api('POST', `/api/messages/${receiptId}/select`);
  ok('selecting receipt branch restores exact confirmed state', () => assert.equal(scene(id).adventure?.balance, 1));
  const ui = renderUi({ scene: scene(id), cast: [] });
  ok('HUD uses confirmed currency and inventory rather than the legacy money field', () => {
    assert.equal(ui.user_sheet?.money, 1); assert.equal(ui.user_sheet?.money_unit, '은화');
    const adapted = eventUiData({ type: 'system', presentation: 'ui', payload: ui } as any);
    assert.equal(adapted?.user_sheet?.money_unit, '은화');
  });
  const offer = await submit(request({ kind: 'quest_offer', title: '약초', terms: '열 뿌리, 대여 미정', reward: 3 }));
  assert.equal(offer.status, 201);
  const beforeDelete = scene(id).adventure!;
  await api('DELETE', `/api/messages/${offer.body.messageId}`);
  ok('deleting a receipt restores the state before that action, not the cached result', () => {
    assert.equal(scene(id).adventure?.quests.length, 0); assert.equal(beforeDelete.quests.length, 1);
  });
  assert.equal(load(id).head_message_id, receiptId);
  const halfUser = insertMessage(db, id, receiptId, 'user', '응답 대기', 'complete', {}).id;
  setHead(db, id, halfUser);
  const refused = await submit(request({ kind: 'payment', direction: 'pay', amount: 1, counterpart: '창구', reason: '비용' }));
  ok('unfinished user head cannot confirm a new action', () => { assert.equal(refused.body.code, 'turn-boundary'); });
  const base = resolveSceneBase(db, { conversationScene: scene(id), parentId: halfUser });
  ok('next generation at a deleted receipt uses the previous confirmed state', () => assert.equal(base.scene.adventure?.quests.length, 0));
  await api('DELETE', `/api/messages/${halfUser}`);
  const initReceipt = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', initialized.body.messageId)!;
  await api('DELETE', `/api/messages/${initReceipt.parent_id}`);
  ok('deleting the whole confirmation subtree leaves no state on legacy opening', () => {
    assert.equal(scene(id).adventure, undefined); assert.equal(modelCalls, 0);
  });
} finally { await app.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }

}
main().catch(err => { console.error(err); process.exitCode = 1; });
