import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { insertMessage, getPath, setHead } from '../apps/server/src/db/tree.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import { buildPrompt } from '../apps/server/src/prompt/builder.js';
import { config } from '../apps/server/src/config.js';
import { estimateMessageTokens } from '../apps/server/src/prompt/tokens.js';
import type { ConversationRow } from '../apps/server/src/types.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';
import type { Ctx } from '../apps/server/src/ctx.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-dialog-context-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
const calls: GenParams[] = [];
let patch = 'null';
let output = 'RECENT_MODEL_OUTPUT\n나리 | ACTIVE_RESPONSE';
const result = (text: string): GenResult => ({ text, usage: null, finishReason: 'stop', ttftMs: 1, totalMs: 1 });
const model = {
  complete: async (p: GenParams) => { calls.push(p); return result(patch); },
  stream: async (p: GenParams, token: (s: string) => void) => { calls.push(p); token(output); return result(output); },
};
const ctx = { db, model, queue: new GenerationQueue(1), resolvedModel: () => 'mock-model', effectiveDataDir: tmp } as unknown as Ctx;
const app = Fastify();
app.register(characterRoutes(ctx)); app.register(conversationRoutes(ctx)); app.register(storyRoutes(ctx)); app.register(chatRoutes(ctx));
let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) { await fn(); console.log(`ok ${++passed} ${name}`); }
async function api(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
  const res = await app.inject({ method, url, payload });
  assert.ok(res.statusCode < 400, `${method} ${url}: ${res.statusCode} ${res.body}`);
  return res;
}
function conv(id: string) { return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow; }
function text(p: { messages: { content: string }[] }) { return p.messages.map((m) => m.content).join('\n'); }
function request() { return calls.find((p) => p.max_tokens === 900)!; }
function comparable(messages: any[]) { return messages.map(({ role, content }) => ({ role, content })); }
function checkedBudget(preview: any) {
  const actual = preview.messages.reduce((sum: number, m: any) => sum + estimateMessageTokens(m.content, preview.budget.calibration), 0);
  assert.equal(preview.budget.est_total, actual);
  assert.ok(actual <= preview.budget.available);
  assert.equal(preview.budget.reply_reserve, 964);
  for (const s of preview.budget.sections) assert.ok(s.est_tokens <= s.budget, JSON.stringify(s));
}
async function preview(id: string, query: Record<string, string> = {}) {
  const res = await api('GET', `/api/conversations/${id}/prompt-preview?${new URLSearchParams(query)}`);
  return res.json();
}
async function send(id: string, content: string, inject?: string) {
  calls.length = 0;
  const res = await api('POST', `/api/conversations/${id}/messages`, { content, inject_instruction: inject });
  assert.ok(res.body.includes('"type":"done"'), res.body);
}
function memory(id: string, room: string, char: string, content: string, status: string, evidence: string[] = []) {
  db.prepare(`INSERT INTO memories (id, conversation_id, character_id, content, source, status, importance, scope, evidence_message_ids_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'model', ?, 3, 'conversation', ?, '2026-01-01', '2026-01-01')`).run(id, room, char, content, status, JSON.stringify(evidence));
}
function summary(id: string, room: string, content: string, status: string, until: string) {
  db.prepare(`INSERT INTO summaries (id, conversation_id, content, status, tier, covers_until_message_id, created_at)
    VALUES (?, ?, ?, ?, 'whole', ?, ?)`).run(id, room, content, status, until, id);
}

async function main() {
  db.prepare(`INSERT INTO model_profiles (name, temperature, top_p, max_tokens, stop_json, system_mode, instruction_enabled, instruction_text)
    VALUES ('rp-balanced', 0.8, 0.95, 400, '[]', 'system', 1, 'PROFILE_CONTEXT {{user}} {{char}}')`).run();
  const nari = (await api('POST', '/api/characters', { name: '나리', personality: 'CARD_CONTEXT', tags: ['party:place=교실'], first_message: '' })).json();
  const sera = (await api('POST', '/api/characters', { name: '세라', personality: 'SECOND_CARD', tags: ['party:place=교실'], first_message: '' })).json();
  const persona = (await api('POST', '/api/personas', { name: '방문자', appearance: 'FROZEN_PERSONA', relationship: 'PERSONA_RELATION' })).json();
  const story = (await api('POST', '/api/stories', { name: '테스트', setting: 'FROZEN_WORLD', minor_cast: [{ name: '조연', note: 'FROZEN_CAST' }],
    scene_catalog: { places: [{ id: '교실' }], weathers: ['맑음', '흐림'] } })).json();
  for (const [sortOrder, c] of [nari, sera].entries()) await api('POST', `/api/stories/${story.id}/characters`, { characterId: c.id, sortOrder });
  const room = (await api('POST', '/api/conversations', { characterId: nari.id, storyId: story.id, personaId: persona.id, mode: 'story', scene: { format: 'dialog' } })).json();
  const roomId = room.id;
  let head: string | null = null;
  const root = insertMessage(db, roomId, head, 'user', 'COMMON_HISTORY', 'complete'); head = root.id;
  for (let i = 0; i < 18; i++) {
    head = insertMessage(db, roomId, head, 'assistant', `ACTIVE_HISTORY_${i}`, 'complete', { block_kind: 'line', speaker_character_id: nari.id, speaker_name: '나리' }).id;
    head = insertMessage(db, roomId, head, 'user', `USER_HISTORY_${i}`, 'complete').id;
  }
  head = insertMessage(db, roomId, head, 'assistant', 'UI_POISON', 'complete', { block_kind: 'ui' }).id;
  head = insertMessage(db, roomId, head, 'assistant', 'INFO_POISON', 'complete', { block_kind: 'info' }).id;
  head = insertMessage(db, roomId, head, 'assistant', 'THOUGHT_POISON', 'complete', { block_kind: 'thought' }).id;
  head = insertMessage(db, roomId, head, 'assistant', 'VISIBLE_HISTORY<choices>["CHOICE_POISON"]</choices><think>PRIVATE_POISON</think>', 'complete', { block_kind: 'narration' }).id;
  setHead(db, roomId, head);
  const sibling = insertMessage(db, roomId, root.id, 'assistant', 'SIBLING_HISTORY', 'complete');
  memory('mem-ok', roomId, nari.id, 'APPROVED_MEMORY', 'pinned', [root.id]);
  memory('mem-draft', roomId, nari.id, 'CANDIDATE_MEMORY', 'candidate');
  memory('mem-reject', roomId, nari.id, 'REJECTED_MEMORY', 'rejected');
  memory('mem-sibling', roomId, nari.id, 'SIBLING_MEMORY', 'pinned', [sibling.id]);
  memory('char-sibling', roomId, nari.id, 'CHAR_SIBLING_MEMORY', 'pinned', [sibling.id]);
  db.prepare("UPDATE memories SET scope = 'character', conversation_id = NULL WHERE id = 'char-sibling'").run();
  summary('a-summary', roomId, 'APPROVED_SUMMARY', 'approved', root.id);
  summary('b-sibling', roomId, 'SIBLING_SUMMARY', 'approved', sibling.id);
  summary('c-draft', roomId, 'DRAFT_SUMMARY', 'draft', root.id);
  db.prepare(`INSERT INTO lorebooks (id, story_id, name, created_at) VALUES ('book', ?, 'book', '2026')`).run(story.id);
  db.prepare(`INSERT INTO lore_entries (id, lorebook_id, title, keywords_json, content, always_on) VALUES ('lore', 'book', '세계관', '["열쇠"]', 'RELEVANT_LORE', 0)`).run();
  db.prepare(`INSERT INTO lore_entries (id, lorebook_id, title, keywords_json, content, always_on) VALUES ('sibling-lore', 'book', '다른 분기', '["SIBLING_HISTORY"]', 'SIBLING_LORE', 0)`).run();
  db.prepare("UPDATE stories SET setting = 'LIVE_WORLD', minor_cast = '[{\"name\":\"변경\",\"note\":\"LIVE_CAST\"}]' WHERE id = ?").run(story.id);
  db.prepare("UPDATE personas SET appearance = 'LIVE_PERSONA' WHERE id = ?").run(persona.id);

  await t('1:1 prompt matches the pinned BASE messages (profile, persona, choices, recent)', async () => {
    const solo = (await api('POST', '/api/characters', { name: '솔로', first_message: '' })).json();
    const c = (await api('POST', '/api/conversations', { characterId: solo.id, personaId: persona.id })).json();
    const u = insertMessage(db, c.id, null, 'user', 'SOLO_INPUT', 'complete');
    setHead(db, c.id, u.id);
    const built = buildPrompt(db, conv(c.id), getPath(db, conv(c.id)), 8192, 'mock-model');
    const sha = createHash('sha256').update(JSON.stringify(built.messages)).digest('hex');
    console.log(`1TO1_BASE_SHA=${sha}`);
    assert.equal(sha, '02ab78f2f41edc0e443adaef8898ba54dd12ff022cf97811e3da2e8fb6dd3509');
  });

  await t('reproduction: actual dialog adapter receives approved context and frozen world', async () => {
    const before = await preview(roomId, { draft: '나리, 열쇠 CURRENT_USER', inject_instruction: 'INJECT_CONTEXT' });
    await send(roomId, '나리, 열쇠 CURRENT_USER', 'INJECT_CONTEXT');
    const actual = request();
    assert.ok(actual, 'Pass S ran');
    const prompt = text(actual);
    for (const marker of ['FROZEN_WORLD', 'FROZEN_CAST', 'FROZEN_PERSONA', 'PERSONA_RELATION', 'APPROVED_MEMORY', 'APPROVED_SUMMARY', 'RELEVANT_LORE', 'ACTIVE_HISTORY_17', 'VISIBLE_HISTORY', 'CARD_CONTEXT', 'PROFILE_CONTEXT', 'INJECT_CONTEXT']) assert.ok(prompt.includes(marker), marker);
    for (const marker of ['SIBLING_HISTORY', 'SIBLING_MEMORY', 'CHAR_SIBLING_MEMORY', 'SIBLING_SUMMARY', 'CANDIDATE_MEMORY', 'REJECTED_MEMORY', 'DRAFT_SUMMARY', 'UI_POISON', 'INFO_POISON', 'THOUGHT_POISON', 'PRIVATE_POISON', 'CHOICE_POISON', 'SIBLING_LORE', 'LIVE_WORLD', 'LIVE_CAST', 'LIVE_PERSONA']) assert.ok(!prompt.includes(marker), marker);
    assert.deepEqual(comparable(actual.messages), comparable(before.messages));
    checkedBudget(before);
    assert.deepEqual(comparable(calls[0].messages), comparable(before.scene_delta.messages));
    assert.equal(actual.messages[0].role, 'system');
    assert.equal(actual.messages.at(-1)?.role, 'user');
    assert.equal(actual.messages.at(-1)?.content, '나리, 열쇠 CURRENT_USER');
    assert.ok(!actual.messages[0].content.includes('CURRENT_USER'));
    assert.ok(actual.messages.some((m) => m.role === 'assistant' && m.content.includes('나리 | ACTIVE_HISTORY_17')));
    assert.equal(prompt.split('INJECT_CONTEXT').length - 1, 1);
    assert.equal(prompt.split('[정보]:').length - 1, 1);
    assert.equal(before.scene_delta.pending, true);
    const log = JSON.parse((db.prepare('SELECT budget_json FROM generation_log WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1').get(roomId) as any).budget_json);
    assert.equal(log.est_total, before.budget.est_total);
    assert.ok(log.dialog_log && log.profile_instruction);
  });

  await t('regenerate uses the target turn parent and shares preview input exactly', async () => {
    const originalHead = conv(roomId).head_message_id!;
    const before = await preview(roomId, { regenerate: originalHead });
    calls.length = 0;
    output = 'REGENERATED_NARRATION\n나리 | REGENERATED_RESPONSE';
    await api('POST', `/api/conversations/${roomId}/regenerate`, { messageId: originalHead });
    assert.deepEqual(comparable(request().messages), comparable(before.messages));
    assert.ok(!text(request()).includes('ACTIVE_RESPONSE'));
    assert.ok(text(request()).includes('ACTIVE_HISTORY_17'));
    assert.equal(request().messages.at(-1)?.content, '나리, 열쇠 CURRENT_USER');
  });

  await t('edited user branch excludes the discarded turn and its later input', async () => {
    const target = getPath(db, conv(roomId)).find((m) => m.content === '나리, 열쇠 CURRENT_USER')!;
    const before = await preview(roomId, { branch: target.id, draft: '나리, BRANCH_USER', inject_instruction: 'BRANCH_INJECT' });
    calls.length = 0;
    await api('POST', `/api/conversations/${roomId}/branch`, { messageId: target.id, content: '나리, BRANCH_USER', inject_instruction: 'BRANCH_INJECT' });
    assert.deepEqual(comparable(request().messages), comparable(before.messages));
    assert.ok(!text(request()).includes('CURRENT_USER'));
    assert.ok(!text(request()).includes('REGENERATED_RESPONSE'));
    assert.equal(request().messages.at(-1)?.content, '나리, BRANCH_USER');
  });

  await t('long context trims deterministically and counts actual roles and wrappers', async () => {
    const { buildDialogPrompt } = await import('../apps/server/src/prompt/dialogPrompt.js');
    const { dialogPlanInput } = await import('../apps/server/src/prompt/dialogContext.js');
    const { planDialogBeat } = await import('../apps/server/src/prompt/composeDialog.js');
    const c = conv(roomId);
    const history = getPath(db, c);
    history.push({ ...history.at(-1)!, id: 'budget-input', parent_id: c.head_message_id, role: 'user', content: '나리, BUDGET_USER', meta_json: '{}' });
    for (const m of history.slice(0, -1)) if (m.role === 'user' || JSON.parse(m.meta_json).block_kind === 'line') m.content += '긴 이전 대화. '.repeat(300);
    const plan = planDialogBeat(dialogPlanInput(db, c, JSON.parse(c.scene_json), '나리, BUDGET_USER', null)!);
    const a = buildDialogPrompt(db, c, history, plan.pass_s, '나리, BUDGET_USER', 4096, 'mock-model', { instruction: 'BUDGET_INJECT' });
    const b = buildDialogPrompt(db, c, history, plan.pass_s, '나리, BUDGET_USER', 4096, 'mock-model', { instruction: 'BUDGET_INJECT' });
    assert.deepEqual(a, b);
    checkedBudget(a);
    assert.ok(a.budget.dropped_messages > 0);
    assert.ok(text(a).includes('BUDGET_INJECT'));
    assert.equal(a.messages.at(-1)?.content, '나리, BUDGET_USER');
  });

  await t('inject-only and OOC keep party instruction policy without duplicate user/model text', async () => {
    const p = await preview(roomId, { draft: '', inject_instruction: 'INJECT_ONLY_MARK' });
    await send(roomId, '', 'INJECT_ONLY_MARK');
    assert.deepEqual(comparable(request().messages), comparable(p.messages));
    assert.equal(text(request()).split('INJECT_ONLY_MARK').length - 1, 1);
    assert.ok(!request().messages.some((m) => m.role === 'user' && !m.content.trim()));
    const ooc = await preview(roomId, { draft: '(OOC) 다음 장면을 이야기하자', inject_instruction: 'OOC_INJECT' });
    await send(roomId, '(OOC) 다음 장면을 이야기하자', 'OOC_INJECT');
    assert.deepEqual(comparable(request().messages), comparable(ooc.messages));
    assert.ok(text(request()).includes('OOC_INJECT') && text(request()).includes('PROFILE_CONTEXT'));
    const after = await preview(roomId, { draft: '나리, IC_RETURN' });
    assert.ok(!text(after).includes('(OOC) 다음 장면을 이야기하자'));
    await send(roomId, '나리, IC_RETURN');
  });

  await t('approved state/episode/scene tiers share the budget; draft and sibling evidence stay out', async () => {
    for (const [id, tier, body, status, until, from] of [
      ['state-ok', 'state', 'APPROVED_STATE', 'approved', root.id, root.id],
      ['episode-ok', 'episode', 'APPROVED_EPISODE ' + '먼 지난 장면의 승인된 사건. '.repeat(8), 'approved', root.id, root.id],
      ['scene-ok', 'scene', 'APPROVED_SCENE', 'approved', root.id, root.id],
      ['state-bad', 'state', 'SIBLING_STATE', 'approved', root.id, sibling.id],
      ['episode-bad', 'episode', 'SIBLING_EPISODE', 'approved', sibling.id, root.id],
      ['scene-draft', 'scene', 'DRAFT_SCENE', 'draft', root.id, root.id],
    ]) db.prepare(`INSERT INTO summaries (id, conversation_id, tier, content, status, covers_until_message_id, covers_from_message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, roomId, tier, body, status, until, from, id);
    const p = await preview(roomId, { draft: '나리, 열쇠 TIER_USER' });
    for (const m of ['APPROVED_STATE', 'APPROVED_EPISODE', 'APPROVED_SCENE', 'APPROVED_SUMMARY']) assert.ok(text(p).includes(m), m);
    for (const m of ['SIBLING_STATE', 'SIBLING_EPISODE', 'DRAFT_SCENE']) assert.ok(!text(p).includes(m), m);
    checkedBudget(p);
    for (const tier of ['state', 'whole', 'episode', 'scene']) assert.equal(p.budget.diagnostics.summaries.find((s: any) => s.tier === tier).used, true, tier);
  });

  await t('related approved episodes respect their source room active branch', async () => {
    const source = (await api('POST', '/api/conversations', { characterId: nari.id, personaId: persona.id })).json();
    const active = insertMessage(db, source.id, null, 'user', 'RELATED_ACTIVE', 'complete');
    const abandoned = insertMessage(db, source.id, null, 'user', 'RELATED_ABANDONED', 'complete');
    setHead(db, source.id, active.id);
    for (const [id, body, until] of [['related-ok', 'RELATED_APPROVED ' + '연결된 승인 사건. '.repeat(8), active.id], ['related-zbad', 'RELATED_SIBLING', abandoned.id]]) {
      db.prepare(`INSERT INTO summaries (id, conversation_id, tier, content, status, covers_until_message_id, rel_character_id, rel_persona_id, created_at)
        VALUES (?, ?, 'episode', ?, 'approved', ?, ?, ?, ?)`).run(id, source.id, body, until, nari.id, persona.id, 'z' + id);
    }
    const p = await preview(roomId, { draft: '나리, 열쇠 RELATED_USER' });
    assert.ok(text(p).includes('RELATED_APPROVED'));
    assert.ok(!text(p).includes('RELATED_SIBLING'));
    checkedBudget(p);
  });

  await t('applied delta uses the same Pass S assembly and preview marks its pending boundary', async () => {
    const { dialogPlanInput } = await import('../apps/server/src/prompt/dialogContext.js');
    const { planDialogBeat } = await import('../apps/server/src/prompt/composeDialog.js');
    const { buildDialogPrompt } = await import('../apps/server/src/prompt/dialogPrompt.js');
    const { resolveSceneBase } = await import('../apps/server/src/db/sceneBase.js');
    const beforeConv = conv(roomId);
    const scene = resolveSceneBase(db, { conversationScene: JSON.parse(beforeConv.scene_json), parentId: beforeConv.head_message_id }).scene;
    const proposal = { base_version: scene.scene_version ?? 0, weather: '흐림' };
    const p = await preview(roomId, { draft: '나리, DELTA_USER' });
    assert.equal(p.scene_delta.pending, true);
    patch = JSON.stringify(proposal);
    try {
      await send(roomId, '나리, DELTA_USER');
      const history = getPath(db, conv(roomId));
      const input = history.find((m) => m.content === '나리, DELTA_USER')!;
      const prior = history.slice(0, history.indexOf(input) + 1);
      const plan = planDialogBeat(dialogPlanInput(db, beforeConv, scene, input.content, input.parent_id, proposal)!);
      const expected = buildDialogPrompt(db, beforeConv, prior, plan.pass_s, input.content, config.model.contextTokens, 'mock-model');
      assert.deepEqual(comparable(request().messages), comparable(expected.messages));
      assert.equal(plan.applied.state.weather, '흐림');
      assert.ok(request().messages[0].content.includes('[흐림]'));
      checkedBudget(expected);
    } finally { patch = 'null'; }
  });

  await t('mandatory overflow refuses before any model call, preview reports it', async () => {
    const old = config.model.contextTokens;
    try {
      config.model.contextTokens = 1024;
      const before = await preview(roomId, { draft: '나리, ' + '긴 입력 '.repeat(1000) });
      assert.ok(before.budget.instruction_overflow);
      calls.length = 0;
      const headBefore = conv(roomId).head_message_id;
      const res = await app.inject({ method: 'POST', url: `/api/conversations/${roomId}/messages`, payload: { content: '나리, ' + '긴 입력 '.repeat(1000) } });
      assert.equal(res.statusCode, 422, res.body);
      assert.equal(calls.length, 0);
      assert.equal(conv(roomId).head_message_id, headBefore);
    } finally { config.model.contextTokens = old; }
  });

  await t('oversized profile and inject are preserved in preview and refused before model calls', async () => {
    const old = config.model.contextTokens;
    const profileText = (db.prepare("SELECT instruction_text FROM model_profiles WHERE name = 'rp-balanced'").get() as any).instruction_text;
    try {
      config.model.contextTokens = 4096;
      const huge = 'PROFILE_START ' + '대필하지 않는 긴 서술 지침. '.repeat(500) + ' PROFILE_END';
      db.prepare("UPDATE model_profiles SET instruction_text = ? WHERE name = 'rp-balanced'").run(huge);
      const p = await preview(roomId, { draft: '나리, PROFILE_USER', inject_instruction: 'PROTECTED_INJECT' });
      assert.ok(p.budget.instruction_overflow);
      assert.ok(text(p).includes('PROFILE_START') && text(p).includes('PROFILE_END') && text(p).includes('PROTECTED_INJECT'));
      calls.length = 0;
      const res = await app.inject({ method: 'POST', url: `/api/conversations/${roomId}/messages`, payload: { content: '나리, PROFILE_USER', inject_instruction: 'PROTECTED_INJECT' } });
      assert.equal(res.statusCode, 422, res.body);
      assert.equal(calls.length, 0);
    } finally {
      config.model.contextTokens = old;
      db.prepare("UPDATE model_profiles SET instruction_text = ? WHERE name = 'rp-balanced'").run(profileText);
    }
  });

  await t('ambient seed and speaker cap are deterministic between preview and send', async () => {
    for (const name of ['세 번째', '네 번째', '다섯 번째']) {
      const c = (await api('POST', '/api/characters', { name, personality: '추가 인물', tags: ['party:place=교실'], first_message: '' })).json();
      await api('POST', `/api/stories/${story.id}/characters`, { characterId: c.id, sortOrder: 2 });
    }
    const c = (await api('POST', '/api/conversations', { characterId: nari.id, storyId: story.id, mode: 'story', scene: { format: 'dialog' } })).json();
    for (const content of ['나리, 첫 장면', '나리, 이어진 장면']) {
      const p = await preview(c.id, { draft: content });
      await send(c.id, content);
      assert.deepEqual(comparable(request().messages), comparable(p.messages));
      checkedBudget(p);
      const log = JSON.parse((db.prepare('SELECT budget_json FROM generation_log WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1').get(c.id) as any).budget_json);
      assert.ok(log.dialog_log.allowed_ids.length <= 3);
      assert.ok(log.dialog_log.ambient_ids.length > 0);
    }
  });

  await t('preview is read-only, validates branch scope, and uses real pending-delta assembly', async () => {
    const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const before = changes();
    const beforeCalls = calls.length;
    const p = await preview(roomId, { draft: '나리, 다음 장면' });
    assert.equal(changes(), before);
    assert.equal(calls.length, beforeCalls);
    assert.equal(p.path, 'dialog');
    const other = (await api('POST', '/api/conversations', { characterId: sera.id })).json();
    const foreign = insertMessage(db, other.id, null, 'user', 'FOREIGN_USER', 'complete');
    const res = await app.inject({ method: 'GET', url: `/api/conversations/${roomId}/prompt-preview?regenerate=${foreign.id}` });
    assert.equal(res.statusCode, 400);
  });


}
main().then(() => console.log(`PASS=${passed}`)).catch((err) => { console.error(err); process.exitCode = 1; }).finally(async () => { await app.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
