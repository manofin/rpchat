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
import type { GenParams } from '../apps/server/src/model/adapter.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-virtual-provenance-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
const calls: GenParams[] = [];
const result = (text: string) => ({ text, usage: null, finishReason: 'stop', ttftMs: 1, totalMs: 1 });
const model = { complete: async (p: GenParams) => { calls.push(p); return result('null'); },
  stream: async (p: GenParams, cb: (s: string) => void) => { calls.push(p); const s = '서술\n나리 | 응답'; cb(s); return result(s); } };
const ctx = { db, model, queue: new GenerationQueue(1), resolvedModel: () => 'mock', effectiveDataDir: tmp } as unknown as Ctx;
const app = Fastify();
for (const route of [characterRoutes, storyRoutes, conversationRoutes, chatRoutes]) app.register(route(ctx));
let passed = 0;
async function api(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
  const r = await app.inject({ method, url, payload }); assert.ok(r.statusCode < 400, `${r.statusCode} ${r.body}`);
  if (String(r.headers['content-type']).includes('text/event-stream')) { assert.ok(r.body.includes('"type":"done"'), r.body); return null; }
  return r.json();
}
async function t(name: string, fn: () => Promise<void>) { await fn(); console.log(`ok ${++passed} ${name}`); }
async function main() {
  db.prepare(`INSERT INTO model_profiles (name, temperature, top_p, max_tokens, stop_json, system_mode) VALUES ('rp-balanced', .8, .95, 400, '[]', 'system')`).run();
  const a = await api('POST', '/api/characters', { name: '나리', first_message: '', tags: ['party:place=교실'] });
  const b = await api('POST', '/api/characters', { name: '세라', first_message: '', tags: ['party:place=교실'] });
  const story = await api('POST', '/api/stories', { name: 'fixture', setting: 'WORLD', scene_catalog: { places: [{ id: '교실' }] } });
  for (const [i, actor] of [a, b].entries()) await api('POST', `/api/stories/${story.id}/characters`, { characterId: actor.id, sortOrder: i });
  const c = await api('POST', '/api/conversations', { characterId: a.id, storyId: story.id, mode: 'story', scene: { format: 'dialog' } });
  const root = insertMessage(db, c.id, null, 'user', 'PROVENANCE_ROOT', 'complete');
  db.prepare("UPDATE messages SET id = 'draft' WHERE id = ?").run(root.id);
  const rows = ['draft']; let parent = 'draft';
  for (let i = 1; i < 40; i++) { parent = insertMessage(db, c.id, parent, i % 2 ? 'assistant' : 'user', `PROVENANCE_KEEP_${i}`, 'complete').id; rows.push(parent); }
  const baseHead = parent; setHead(db, c.id, baseHead);
  db.prepare(`INSERT INTO lorebooks (id, story_id, name, created_at) VALUES ('virtual-book', ?, 'fixture', '2026')`).run(story.id);
  db.prepare(`INSERT INTO lore_entries (id, lorebook_id, title, keywords_json, content) VALUES ('virtual-lore', 'virtual-book', 'fixture', '["CURRENT_KEYWORD"]', 'DRAFT_KEYWORD_LORE')`).run();
  const addSummary = (tier: string, id: string, content: string, until: string, conversationId = c.id) => db.prepare(`INSERT INTO summaries (id, conversation_id, content, status, tier, covers_until_message_id, created_at)
    VALUES (?, ?, ?, 'approved', ?, ?, ?)`).run(id, conversationId, content, tier, until, id);
  const compare = async (conversationId = c.id, maxTokens = 900, expectLore = true) => {
    const p = await api('GET', `/api/conversations/${conversationId}/prompt-preview?draft=${encodeURIComponent('나리, CURRENT_KEYWORD')}`);
    calls.length = 0; await api('POST', `/api/conversations/${conversationId}/messages`, { content: '나리, CURRENT_KEYWORD' });
    const actual = calls.find(v => v.max_tokens === maxTokens)!;
    assert.deepEqual(actual.messages, p.messages, 'virtual draft must not change summary selection or compaction');
    const log = JSON.parse((db.prepare('SELECT budget_json FROM generation_log WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1').get(conversationId) as any).budget_json);
    assert.equal(log.est_total, p.budget.est_total);
    assert.deepEqual(log.sections, p.budget.sections);
    if (maxTokens === 900) assert.deepEqual(log.diagnostics.summaries, p.budget.diagnostics.summaries);
    if (expectLore) assert.ok(actual.messages.some(m => m.content.includes('DRAFT_KEYWORD_LORE')), 'current draft still participates in lore matching');
    return { p, text: actual.messages.map(m => m.content).join('\n') };
  };
  const tiers = ['episode', 'scene'];
  for (const tier of tiers) await t(`${tier} summary on a stored old draft ancestor matches preview/send`, async () => {
    db.prepare('DELETE FROM summaries WHERE conversation_id = ?').run(c.id); setHead(db, c.id, baseHead);
    const marker = `PROVENANCE_${tier.toUpperCase()}`;
    addSummary(tier, marker, marker + (tier === 'episode' ? ' 지난 승인 사건을 온전히 기록했다. '.repeat(8) : ''), 'draft');
    const result = await compare();
    assert.ok(result.text.includes(marker)); assert.ok(!result.text.includes('PROVENANCE_ROOT'));
    assert.ok(result.text.includes('PROVENANCE_KEEP_1'));
    assert.equal(result.p.budget.diagnostics.summaries.find((s: any) => s.tier === tier).used, true);
  });
  for (const tier of tiers) for (const index of [16, 17]) await t(`${tier} recent-24 boundary at index ${index} matches preview/send`, async () => {
    db.prepare('DELETE FROM summaries WHERE conversation_id = ?').run(c.id); setHead(db, c.id, baseHead);
    const marker = `BOUNDARY_${tier.toUpperCase()}_${index}`;
    addSummary(tier, marker, marker + (tier === 'episode' ? ' 지난 승인 사건을 온전히 기록했다. '.repeat(8) : ''), rows[index]);
    const result = await compare();
    assert.equal(result.p.budget.diagnostics.summaries.find((s: any) => s.tier === tier).used, index === 16);
    assert.equal(result.text.includes(marker), index === 16);
    assert.equal(result.text.includes('PROVENANCE_ROOT'), index === 17);
    assert.ok(result.text.includes('PROVENANCE_KEEP_17'), 'protected raw history remains');
  });

  let siblingHead = insertMessage(db, c.id, null, 'user', 'DIALOG_OTHER_ROOT', 'complete').id;
  for (let i = 1; i < 40; i++) siblingHead = insertMessage(db, c.id, siblingHead, i % 2 ? 'assistant' : 'user', `DIALOG_OTHER_${i}`, 'complete').id;
  for (const tier of ['whole', 'state', 'episode', 'scene']) await t(`dialog ${tier} virtual draft cannot admit an off-path summary`, async () => {
    db.prepare('DELETE FROM summaries WHERE conversation_id = ?').run(c.id); setHead(db, c.id, siblingHead);
    const marker = `OFFPATH_DIALOG_${tier.toUpperCase()}`;
    addSummary(tier, marker, marker + ' 지난 승인 사건을 온전히 기록했다. '.repeat(8), 'draft');
    const result = await compare();
    assert.ok(!result.text.includes(marker)); assert.ok(result.text.includes('DIALOG_OTHER_ROOT'));
    assert.equal(result.p.budget.diagnostics.summaries.find((s: any) => s.tier === tier).used, false);
  });

  // The same virtual identity contract applies to the existing 1:1 preview/builder.
  await api('DELETE', `/api/conversations/${c.id}`);
  const soloActor = await api('POST', '/api/characters', { name: '혼자', first_message: '' });
  const solo = await api('POST', '/api/conversations', { characterId: soloActor.id, mode: 'chat' });
  const soloRoot = insertMessage(db, solo.id, null, 'user', 'SOLO_ROOT', 'complete');
  db.prepare("UPDATE messages SET id = 'draft' WHERE id = ?").run(soloRoot.id);
  let soloHead = 'draft';
  for (let i = 1; i < 40; i++) soloHead = insertMessage(db, solo.id, soloHead, i % 2 ? 'assistant' : 'user', `SOLO_KEEP_${i}`, 'complete').id;
  for (const tier of ['whole', 'state', 'episode', 'scene']) await t(`1:1 ${tier} stored draft ancestor does not collide with virtual input`, async () => {
    db.prepare('DELETE FROM summaries WHERE conversation_id = ?').run(solo.id); setHead(db, solo.id, soloHead);
    const marker = `SOLO_${tier.toUpperCase()}`;
    addSummary(tier, marker, marker + (tier === 'episode' ? ' 지난 승인 사건을 온전히 기록했다. '.repeat(8) : ''), 'draft', solo.id);
    const result = await compare(solo.id, 400, false);
    assert.ok(result.text.includes(marker)); assert.ok(!result.text.includes('SOLO_ROOT'));
    assert.ok(result.text.includes('SOLO_KEEP_1'), 'watermark still denotes the stored root index');
    assert.equal(result.p.budget.diagnostics.summaries.find((s: any) => s.tier === tier).used, true);
  });
  let soloSibling = insertMessage(db, solo.id, null, 'user', 'SOLO_OTHER_ROOT', 'complete').id;
  for (let i = 1; i < 40; i++) soloSibling = insertMessage(db, solo.id, soloSibling, i % 2 ? 'assistant' : 'user', `SOLO_OTHER_${i}`, 'complete').id;
  for (const tier of ['whole', 'state', 'episode', 'scene']) await t(`1:1 ${tier} virtual draft cannot admit an off-path summary`, async () => {
    db.prepare('DELETE FROM summaries WHERE conversation_id = ?').run(solo.id); setHead(db, solo.id, soloSibling);
    const marker = `OFFPATH_SOLO_${tier.toUpperCase()}`;
    addSummary(tier, marker, marker + ' 지난 승인 사건을 온전히 기록했다. '.repeat(8), 'draft', solo.id);
    const result = await compare(solo.id, 400, false);
    assert.ok(!result.text.includes(marker)); assert.ok(result.text.includes('SOLO_OTHER_ROOT'));
    assert.equal(result.p.budget.diagnostics.summaries.find((s: any) => s.tier === tier).used, false);
  });
}
main().then(() => console.log(`PASS=${passed}`)).catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await app.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
