// Actual HTTP routes + temporary synthetic DB. All model completions are local stubs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb, many, one, run } from '../apps/server/src/db/index.js';
import { setHead } from '../apps/server/src/db/tree.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { memoryRoutes } from '../apps/server/src/routes/memory.js';
import { currentApprovedState } from '../apps/web/src/lib/summaryDiff.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { Summary } from '../apps/web/src/types.js';

type ScopedSummary = Summary & { branch_scope: 'current' | 'other' | 'unlinked'; branch_head_id: string | null };
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);
const timestamp = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-summary-branch-'));
  const db = openMigratedDb(dir, path.resolve('apps/server/migrations'));
  const app = Fastify();
  const prompts: string[] = [];
  const ctx = {
    db, queue: new GenerationQueue(1), resolvedModel: () => 'local-stub', log: app.log,
    model: {
      async complete(request: { messages: Array<{ content: string }> }) {
        prompts.push(request.messages.map(m => m.content).join('\n'));
        return { text: JSON.stringify({ summary: '합성 요약', state: { 장소: '합성 장소' }, scene: '합성 장면', memories: [], episode: '합성 에피소드' }) };
      },
      generate() { throw new Error('External generation is forbidden in summaryBranchScope'); },
    },
  } as unknown as Ctx;
  run(db, 'INSERT INTO characters (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', 'char', '합성 안내자', timestamp(0), timestamp(0));
  for (const id of ['conv', 'foreign']) {
    run(db, 'INSERT INTO conversations (id, character_id, profile_name, prompt_version, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, 'char', 'summary', 'test', '합성 분기', timestamp(0), timestamp(0));
  }
  for (const [id, parent, conv] of [
    ['root', null, 'conv'], ['shared', 'root', 'conv'],
    ['a1', 'shared', 'conv'], ['a2', 'a1', 'conv'],
    ['b1', 'shared', 'conv'], ['b2', 'b1', 'conv'], ['foreign-head', null, 'foreign'],
  ]) {
    run(db, 'INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, conv, parent, id === 'root' ? 'user' : 'assistant', `TRANSCRIPT_${id}`, 'complete', '{}', timestamp(0));
  }
  setHead(db, 'conv', 'a2');
  setHead(db, 'foreign', 'foreign-head');
  function summary(id: string, tier: string, until: string | null, minute: number, from: string | null = null, status = 'approved') {
    run(db, 'INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, 'conv', `MARKER_${id}`, until, from, status, timestamp(minute), tier);
  }
  const snapshot = () => JSON.stringify(['summaries', 'memories', 'messages', 'conversations'].map(table => many(db, `SELECT * FROM ${table} ORDER BY id`)));
  async function api(method: 'GET' | 'POST', suffix: string) {
    const response = await app.inject({ method, url: `/api/conversations/conv/${suffix}`, ...(method === 'POST' ? { payload: {} } : {}) });
    return { status: response.statusCode, body: response.json() };
  }
  await app.register(memoryRoutes(ctx));
  await app.ready();
  return { db, prompts, summary, snapshot, api, close: async () => { await app.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function using(fn: (f: Fixture) => Promise<void>) {
  const f = await fixture();
  try { await fn(f); } finally { await f.close(); }
}

test('GET A/B/A preserves all rows, performs no writes/completions and updates current state', () => using(async f => {
  f.summary('state-a', 'state', 'a1', 2);
  f.summary('state-b', 'state', 'b1', 3);
  f.summary('shared', 'whole', 'shared', 1);
  f.summary('draft-b', 'state', 'b2', 4, null, 'draft');
  const observations = [];
  for (const [head, expected] of [['a2', 'state-a'], ['b2', 'state-b'], ['a2', 'state-a']]) {
    setHead(f.db, 'conv', head);
    const before = f.snapshot();
    const response = await f.api('GET', 'summaries');
    assert.equal(response.status, 200);
    assert.equal(f.snapshot(), before, 'GET changed persisted rows including head/scene');
    assert.equal(f.prompts.length, 0, 'GET requested a completion');
    const rows = response.body as ScopedSummary[];
    assert.ok(Array.isArray(rows), 'Existing array response contract must remain');
    assert.deepEqual(rows.map(s => s.id).sort(), ['draft-b', 'shared', 'state-a', 'state-b']);
    observations.push({ head, expected, actual: currentApprovedState(rows)?.id, scopes: rows.map(s => [s.id, s.branch_scope]) });
  }
  console.log('A_B_A_OBSERVATIONS', JSON.stringify(observations));
  assert.deepEqual(observations.map(o => o.actual), ['state-a', 'state-b', 'state-a']);
  const rows = (await f.api('GET', 'summaries')).body as ScopedSummary[];
  assert.ok(rows.every(s => s.branch_head_id === 'a2'));
  assert.equal(rows.find(s => s.id === 'shared')?.branch_scope, 'current');
  assert.equal(rows.find(s => s.id === 'state-b')?.branch_scope, 'other');
}));

test('GET distinguishes shared/other ancestry from missing, foreign and contradictory evidence', () => using(async f => {
  f.summary('shared', 'whole', 'shared', 1);
  f.summary('current-range', 'scene', 'a2', 2, 'shared');
  f.summary('other-range', 'scene', 'b2', 3, 'b1');
  f.summary('no-until', 'state', null, 4);
  f.summary('deleted-until', 'state', 'deleted', 5);
  f.summary('deleted-from', 'scene', 'a2', 6, 'deleted');
  f.summary('foreign-until', 'whole', 'foreign-head', 7);
  f.summary('foreign-from', 'scene', 'a2', 8, 'foreign-head');
  f.summary('cross-branch', 'scene', 'a2', 9, 'b1');
  f.summary('reversed', 'scene', 'a1', 10, 'a2');
  const before = f.snapshot();
  const response = await f.api('GET', 'summaries');
  assert.equal(response.status, 200);
  assert.equal(f.snapshot(), before);
  const rows = response.body as ScopedSummary[];
  const actual = Object.fromEntries(rows.map(s => [s.id, s.branch_scope]));
  console.log('EVIDENCE_SCOPES', JSON.stringify(actual));
  assert.deepEqual(actual, {
    reversed: 'unlinked', 'cross-branch': 'unlinked', 'foreign-from': 'unlinked',
    'foreign-until': 'unlinked', 'deleted-from': 'unlinked', 'deleted-until': 'unlinked',
    'no-until': 'unlinked', 'other-range': 'other', 'current-range': 'current', shared: 'current',
  });
}));

test('an empty head has no current approved state', () => using(async f => {
  f.summary('state-b', 'state', 'b1', 1);
  run(f.db, 'UPDATE conversations SET head_message_id = NULL WHERE id = ?', 'conv');
  const response = await f.api('GET', 'summaries');
  assert.equal(response.status, 200);
  const rows = response.body as ScopedSummary[];
  assert.equal(rows[0].branch_head_id, null);
  assert.notEqual(rows[0].branch_scope, 'current');
  assert.equal(currentApprovedState(rows), null);
}));

test('summarize uses the current approved whole even when other-branch and invalid rows are newer', () => using(async f => {
  f.summary('shared-prev', 'whole', 'shared', 1);
  f.summary('a-prev', 'whole', 'a1', 2);
  f.summary('b-prev', 'whole', 'b1', 3);
  f.summary('unlinked-prev', 'whole', null, 4);
  f.summary('draft-a', 'whole', 'a2', 5, null, 'draft');
  const response = await f.api('POST', 'summarize');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(f.prompts.length, 1);
  const prompt = f.prompts[0];
  console.log('SUMMARIZE_CURRENT_PREV', JSON.stringify(prompt));
  assert.ok(prompt.includes('MARKER_a-prev'));
  for (const excluded of ['MARKER_b-prev', 'MARKER_unlinked-prev', 'MARKER_draft-a', 'MARKER_shared-prev', 'TRANSCRIPT_b1', 'TRANSCRIPT_a1']) {
    assert.ok(!prompt.includes(excluded), `Unexpected input ${excluded}`);
  }
  assert.ok(prompt.includes('TRANSCRIPT_a2'));
  assert.equal(response.body.summary.status, 'draft');
  assert.equal(response.body.summary.covers_until_message_id, 'a2');
  assert.equal(response.body.state.status, 'draft');
}));

test('summarize falls back to a shared ancestor, not another branch', () => using(async f => {
  f.summary('shared-prev', 'whole', 'shared', 1);
  f.summary('b-prev', 'whole', 'b1', 2);
  const response = await f.api('POST', 'summarize');
  assert.equal(response.status, 200);
  console.log('SUMMARIZE_SHARED_PREV', JSON.stringify(f.prompts[0]));
  assert.ok(f.prompts[0].includes('MARKER_shared-prev'));
  assert.ok(!f.prompts[0].includes('MARKER_b-prev'));
  assert.ok(f.prompts[0].includes('TRANSCRIPT_a1'));
  assert.ok(!f.prompts[0].includes('TRANSCRIPT_shared'));
}));

test('summarize without a linked current predecessor passes no previous summary', () => using(async f => {
  f.summary('b-prev', 'whole', 'b1', 1);
  f.summary('unlinked-prev', 'whole', 'missing', 2);
  const response = await f.api('POST', 'summarize');
  assert.equal(response.status, 200);
  assert.ok(!f.prompts[0].includes('[기존 요약]'));
  assert.ok(!f.prompts[0].includes('MARKER_'));
  assert.ok(f.prompts[0].includes('TRANSCRIPT_root'));
}));

test('rollup filters before the five-scene limit and leaves other branches untouched', () => using(async f => {
  for (let i = 0; i < 5; i++) {
    f.summary(`b-scene-${i}`, 'scene', 'b1', i + 1, 'shared');
    f.summary(`a-scene-${i}`, 'scene', 'a1', i + 10, 'shared');
  }
  f.summary('invalid-scene', 'scene', 'a1', 0, 'b1');
  const otherBefore = many(f.db, "SELECT * FROM summaries WHERE id LIKE 'b-scene-%' ORDER BY id");
  const response = await f.api('POST', 'rollup-episode');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  console.log('ROLLUP_TARGETS', JSON.stringify(response.body.rolledScenes));
  assert.deepEqual(response.body.rolledScenes, Array.from({ length: 5 }, (_, i) => `a-scene-${i}`));
  for (let i = 0; i < 5; i++) assert.ok(f.prompts[0].includes(`MARKER_a-scene-${i}`));
  assert.ok(!f.prompts[0].includes('MARKER_b-scene'));
  assert.ok(!f.prompts[0].includes('MARKER_invalid-scene'));
  assert.deepEqual(many(f.db, "SELECT * FROM summaries WHERE id LIKE 'b-scene-%' ORDER BY id"), otherBefore);
  assert.equal(one<{ rolled_up_into: string | null }>(f.db, 'SELECT rolled_up_into FROM summaries WHERE id = ?', 'invalid-scene')?.rolled_up_into, null);
  assert.equal(response.body.episode.status, 'draft');
}));

test('other-branch scenes do not satisfy rollup threshold; forced rollup uses only eligible scenes', () => using(async f => {
  f.summary('a-scene', 'scene', 'a1', 10, 'shared');
  for (let i = 0; i < 4; i++) f.summary(`b-scene-${i}`, 'scene', 'b1', i + 1, 'shared');
  const before = f.snapshot();
  const refused = await f.api('POST', 'rollup-episode');
  assert.equal(refused.status, 400);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.snapshot(), before);
  const forced = await f.api('POST', 'rollup-episode?force=1');
  assert.equal(forced.status, 200);
  assert.deepEqual(forced.body.rolledScenes, ['a-scene']);
  assert.equal(f.prompts.length, 1);
}));

test('forced rollup with no current scenes does not call the model or mutate rows', () => using(async f => {
  f.summary('b-scene', 'scene', 'b1', 1);
  f.summary('unlinked-scene', 'scene', null, 2);
  const before = f.snapshot();
  const response = await f.api('POST', 'rollup-episode?force=1');
  assert.equal(response.status, 400);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.snapshot(), before);
}));

test('side-mode and internal anchor rows cannot serve as summary evidence, while visible ancestors remain current', () => using(async f => {
  for (const [id, role, meta] of [
    ['anchor', 'memory-anchor', { memory_anchor: { kind: 'approved' } }],
    ['side', 'assistant', { side_mode: { mode: 'summary', prompt: '합성', anchor_message_id: 'a1' } }],
  ] as const) {
    run(f.db, 'INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, 'conv', 'a1', role, '합성 내부 행', 'complete', JSON.stringify(meta), timestamp(0));
  }
  run(f.db, 'UPDATE messages SET parent_id = ? WHERE id = ?', 'anchor', 'a2');
  f.summary('visible-state', 'state', 'a1', 1);
  f.summary('anchor-state', 'state', 'anchor', 2);
  f.summary('side-state', 'state', 'side', 3);
  f.summary('anchor-start', 'scene', 'a2', 4, 'anchor');
  for (const head of ['a2', 'anchor']) {
    setHead(f.db, 'conv', head);
    const before = f.snapshot();
    const response = await f.api('GET', 'summaries');
    assert.equal(response.status, 200);
    assert.equal(f.snapshot(), before);
    const scopes = Object.fromEntries((response.body as ScopedSummary[]).map(s => [s.id, s.branch_scope]));
    assert.deepEqual(scopes, { 'anchor-start': 'unlinked', 'side-state': 'unlinked', 'anchor-state': 'unlinked', 'visible-state': 'current' });
  }
  assert.equal(f.prompts.length, 0);
}));

test('cyclic or cross-conversation ancestry is unlinked and GET remains read-only', () => using(async f => {
  f.summary('a-state', 'state', 'a1', 1);
  f.summary('b-state', 'state', 'b1', 2);
  for (const brokenParent of ['a1', 'foreign-head']) {
    run(f.db, 'UPDATE messages SET parent_id = ? WHERE id = ?', brokenParent, 'shared');
    const before = f.snapshot();
    const response = await f.api('GET', 'summaries');
    assert.equal(response.status, 200);
    assert.equal(f.snapshot(), before);
    const rows = response.body as ScopedSummary[];
    assert.ok(rows.every(s => s.branch_scope === 'unlinked'));
  }
  assert.equal(f.prompts.length, 0);
}));

test('rollup coverage follows message ancestry when scene creation order is reversed', () => using(async f => {
  f.summary('earlier-range', 'scene', 'a1', 20, 'shared');
  f.summary('later-range', 'scene', 'a2', 10, 'a1');
  const response = await f.api('POST', 'rollup-episode?force=1');
  assert.equal(response.status, 200);
  assert.deepEqual(new Set(response.body.rolledScenes), new Set(['earlier-range', 'later-range']));
  const earlierAt = f.prompts[0].indexOf('MARKER_earlier-range');
  const laterAt = f.prompts[0].indexOf('MARKER_later-range');
  assert.ok(earlierAt >= 0 && laterAt > earlierAt, 'Episode input must describe the earlier message range before the later range');
  assert.equal(response.body.episode.covers_from_message_id, 'shared');
  assert.equal(response.body.episode.covers_until_message_id, 'a2');
  const rows = (await f.api('GET', 'summaries')).body as ScopedSummary[];
  assert.equal(rows.find(s => s.id === response.body.episode.id)?.branch_scope, 'current');
}));

async function main() {
  let passed = 0;
  const failed: string[] = [];
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok ${++passed} ${name}`); }
    catch (error) { failed.push(name); console.error(`FAIL ${name}`, error); }
  }
  console.log(JSON.stringify({ passed, failed: failed.length, modelMode: 'local stubs only', failedCases: failed }));
  assert.equal(failed.length, 0, `${failed.length} summary branch contract(s) failed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
