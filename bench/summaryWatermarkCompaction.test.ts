/** npx tsx bench/summaryWatermarkCompaction.test.ts
 * summary-watermark-compaction — approved covers_until removes covered turns
 * from the recent window. Isolated memory DB. No live DB, no generate, no UI.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { DB } from '../apps/server/src/db/index.js';
import { getPath } from '../apps/server/src/db/tree.ts';
import { buildPrompt } from '../apps/server/src/prompt/builder.ts';
import {
  effectiveCompactionEndIndex,
  resolveWatermarkIndex,
  type CompactionPathMessage,
  type CompactionSummaryInput,
} from '../apps/server/src/prompt/compaction.ts';
import { SCENE_RECENT_GUARD } from '../apps/server/src/prompt/summaryBudget.ts';
import { PROMPT_VERSION } from '../apps/server/src/config.ts';
import type { ConversationRow, MessageRow } from '../apps/server/src/types.js';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const CONV = 'conv1';
const OTHER = 'conv2';
const SUMMARY_BODY = 'SUMMARY_BODY_UNIQUE 승인된 요약 본문';

function pad(i: number): string {
  return String(i).padStart(2, '0');
}
function mid(i: number, prefix = 'm'): string {
  return `${prefix}${pad(i)}`;
}
function marker(id: string): string {
  return `MARKER_${id}`;
}

function pathOf(n: number, conv = CONV, prefix = 'm'): CompactionPathMessage[] {
  return Array.from({ length: n }, (_, i) => ({ id: mid(i + 1, prefix), conversation_id: conv }));
}

function sum(partial: Partial<CompactionSummaryInput> & Pick<CompactionSummaryInput, 'covers_until_message_id'>): CompactionSummaryInput {
  return {
    status: 'approved',
    conversation_id: CONV,
    covers_from_message_id: null,
    ...partial,
  };
}

t('1 helper: no approved summary → null watermark, no compaction', () => {
  const path = pathOf(40);
  assert.equal(resolveWatermarkIndex(path, [], CONV), null);
  assert.equal(effectiveCompactionEndIndex(null, path.length), null);
  assert.equal(resolveWatermarkIndex(path, [sum({ status: 'draft', covers_until_message_id: 'm10' })], CONV), null);
});

t('2 helper: valid watermark index is covers_until on path', () => {
  const path = pathOf(40);
  assert.equal(resolveWatermarkIndex(path, [sum({ covers_until_message_id: 'm10' })], CONV), 9);
});

t('3 helper: off-path / other-branch watermark ignored', () => {
  const path = pathOf(40);
  assert.equal(resolveWatermarkIndex(path, [sum({ covers_until_message_id: 'branch-leaf' })], CONV), null);
});

t('4 helper: missing covers_until or missing target → fallback', () => {
  const path = pathOf(40);
  assert.equal(resolveWatermarkIndex(path, [sum({ covers_until_message_id: null })], CONV), null);
  assert.equal(resolveWatermarkIndex(path, [sum({ covers_until_message_id: 'no-such' })], CONV), null);
});

t('5 helper: reversed or off-path covers_from is invalid', () => {
  const path = pathOf(40);
  assert.equal(resolveWatermarkIndex(path, [sum({ covers_from_message_id: 'm20', covers_until_message_id: 'm10' })], CONV), null);
  assert.equal(resolveWatermarkIndex(path, [sum({ covers_from_message_id: 'ghost', covers_until_message_id: 'm10' })], CONV), null);
  assert.equal(resolveWatermarkIndex(path, [sum({ covers_from_message_id: 'm05', covers_until_message_id: 'm10' })], CONV), 9);
});

t('6 helper: several approved summaries pick farthest on-path until', () => {
  const path = pathOf(40);
  assert.equal(resolveWatermarkIndex(path, [
    sum({ covers_until_message_id: 'm08', covers_from_message_id: 'm01' }),
    sum({ covers_until_message_id: 'm15', covers_from_message_id: 'm09' }),
    sum({ covers_until_message_id: 'm12' }),
  ], CONV), 14);
});

t('7 helper: draft/rejected/deleted never become watermarks', () => {
  const path = pathOf(40);
  assert.equal(resolveWatermarkIndex(path, [
    sum({ status: 'draft', covers_until_message_id: 'm30' }),
    sum({ status: 'rejected', covers_until_message_id: 'm30' }),
    sum({ status: 'deleted', covers_until_message_id: 'm30' }),
    sum({ status: 'approved', conversation_id: OTHER, covers_until_message_id: 'm30' }),
  ], CONV), null);
});

t('8 helper: recent guard clips watermark that reaches the head', () => {
  const n = 40;
  const wm = resolveWatermarkIndex(pathOf(n), [sum({ covers_until_message_id: mid(n) })], CONV);
  assert.equal(wm, n - 1);
  const end = effectiveCompactionEndIndex(wm, n);
  assert.equal(end, n - SCENE_RECENT_GUARD - 1);
  assert.equal(end, 15);
});

t('9 helper: whole path inside guard → no compaction, no negative index', () => {
  assert.equal(effectiveCompactionEndIndex(10, 10), null);
  assert.equal(effectiveCompactionEndIndex(23, SCENE_RECENT_GUARD), null);
  assert.equal(effectiveCompactionEndIndex(-1, 40), null);
  assert.equal(effectiveCompactionEndIndex(0, 0), null);
  assert.equal(effectiveCompactionEndIndex(5, 40), 5);
});

t('wrong-conversation path message is not a watermark target', () => {
  const path = pathOf(20).map((m, i) => i === 9 ? { ...m, conversation_id: OTHER } : m);
  assert.equal(resolveWatermarkIndex(path, [sum({ covers_until_message_id: 'm10' })], CONV), null);
});

function seed(n: number, opts?: { long?: boolean }): DB {
  const db = new Database(':memory:') as unknown as DB;
  db.exec(`
    CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT, tagline TEXT, description TEXT, personality TEXT, speech_style TEXT, scenario TEXT, taboos TEXT, example_dialogue TEXT);
    CREATE TABLE personas (id TEXT PRIMARY KEY, name TEXT, address_as TEXT, appearance TEXT, personality TEXT, relationship TEXT, is_default INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE model_profiles (name TEXT PRIMARY KEY, model TEXT, temperature REAL, top_p REAL, max_tokens INTEGER, stop_json TEXT, system_mode TEXT, notes TEXT);
    INSERT INTO characters VALUES ('c1','테스트캐','짧은소개','설명','성격','말투','시나리오','금기','예시');
    INSERT INTO model_profiles VALUES ('rp-balanced',NULL,0.8,0.95,400,'[]','system',NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, character_id TEXT, persona_id TEXT, mode TEXT, profile_name TEXT, scene_json TEXT, user_note TEXT, head_message_id TEXT);
    INSERT INTO conversations VALUES ('${CONV}','c1','p1','chat',NULL,'{}',NULL,NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, parent_id TEXT, role TEXT, content TEXT, status TEXT, meta_json TEXT, bookmarked INTEGER, created_at TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY, conversation_id TEXT, character_id TEXT, content TEXT, source TEXT, status TEXT, importance INTEGER, scope TEXT, evidence_message_ids_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE summaries (id TEXT PRIMARY KEY, conversation_id TEXT, content TEXT, covers_until_message_id TEXT, covers_from_message_id TEXT, status TEXT, created_at TEXT, tier TEXT, rolled_up_into TEXT);
    CREATE TABLE lorebooks (id TEXT PRIMARY KEY, character_id TEXT);
    CREATE TABLE lore_entries (id TEXT PRIMARY KEY, lorebook_id TEXT, title TEXT, content TEXT, keywords_json TEXT, secondary_keys_json TEXT, selective INTEGER, always_on INTEGER, priority INTEGER, token_cap INTEGER, enabled INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('token_calibration','1.0');
  `);
  db.prepare(`INSERT INTO personas VALUES (?,?,?,?,?,?,?,?,?)`).run('p1', '유저', '호칭1', '외형1', '페르소나성격', '관계1', 1, '0001', '0001');
  const ins = db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)`);
  const body = opts?.long ? '가나다라마바사아자차카타파하'.repeat(30) : '짧은대사';
  let parent: string | null = null;
  for (let i = 1; i <= n; i++) {
    const id = mid(i);
    const role = i % 2 ? 'user' : 'assistant';
    ins.run(id, CONV, parent, role, `${marker(id)} ${body}`, 'complete', '{}', 0, pad(i));
    parent = id;
  }
  db.prepare(`UPDATE conversations SET head_message_id = ? WHERE id = ?`).run(mid(n), CONV);
  return db;
}

function insertSummary(db: DB, row: {
  id?: string;
  status?: string;
  tier?: string;
  until: string | null;
  from?: string | null;
  content?: string;
  conversation_id?: string;
}): void {
  db.prepare(`INSERT INTO summaries VALUES (?,?,?,?,?,?,?,?,?)`).run(
    row.id ?? `s-${row.until ?? 'none'}`,
    row.conversation_id ?? CONV,
    row.content ?? SUMMARY_BODY,
    row.until,
    row.from ?? null,
    row.status ?? 'approved',
    '0001',
    row.tier ?? 'whole',
    null,
  );
}

function convOf(db: DB): ConversationRow {
  return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(CONV) as ConversationRow;
}

function build(db: DB, history?: MessageRow[]) {
  const conv = convOf(db);
  const path = history ?? getPath(db, conv);
  return { built: buildPrompt(db, conv, path, 8192, 'test-model'), path };
}

function turnText(built: ReturnType<typeof buildPrompt>): string {
  return built.messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n');
}

function sysText(built: ReturnType<typeof buildPrompt>): string {
  return built.messages.find((m) => m.role === 'system')?.content ?? '';
}

function assemblyHash(built: ReturnType<typeof buildPrompt>): string {
  const payload = JSON.stringify(
    built.messages.map((m) => ({ role: m.role, content: m.content })),
  );
  return crypto.createHash('sha256').update(payload).digest('hex');
}

t('1 build: no summary keeps the same recent window as a draft watermark', () => {
  const db = seed(40);
  const a = build(db).built;
  insertSummary(db, { id: 'draft1', status: 'draft', until: 'm20' });
  const b = build(db).built;
  assert.equal(a.budget.dropped_messages, b.budget.dropped_messages);
  assert.equal(a.budget.included_messages, b.budget.included_messages);
  assert.equal(a.budget.recent_from_id, b.budget.recent_from_id);
  assert.equal(turnText(a), turnText(b));
});

t('2 build: valid watermark drops covered markers and keeps summary text', () => {
  const db = seed(40);
  insertSummary(db, { until: 'm12', from: 'm01', tier: 'whole' });
  const { built, path } = build(db);
  const turns = turnText(built);
  const compactEnd = effectiveCompactionEndIndex(resolveWatermarkIndex(path, [
    sum({ covers_until_message_id: 'm12', covers_from_message_id: 'm01' }),
  ], CONV), path.length);
  assert.ok(compactEnd != null && compactEnd >= 0);
  for (let i = 1; i <= compactEnd + 1; i++) {
    assert.equal(turns.includes(marker(mid(i))), false, `covered ${mid(i)} must leave recent window`);
  }
  assert.ok(sysText(built).includes('### 이전 대화 요약'));
  assert.ok(sysText(built).includes(SUMMARY_BODY));
  assert.ok(turns.includes(marker(mid(path.length))));
});

t('3 build: other-branch watermark is ignored', () => {
  const db = seed(40);
  const ins = db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run('branch-leaf', CONV, 'm10', 'assistant', `${marker('branch-leaf')} 가지`, 'complete', '{}', 0, '99');
  insertSummary(db, { until: 'branch-leaf', from: 'm01' });
  const { built, path } = build(db);
  assert.equal(path.some((m) => m.id === 'branch-leaf'), false);
  const turns = turnText(built);
  assert.ok(turns.includes(marker('m01')) || built.budget.dropped_messages > 0);
  // m01 may still drop on tokens; the point is compaction did not force-exclude it via watermark.
  const without = seed(40);
  const baseline = build(without).built;
  assert.equal(built.budget.recent_from_id, baseline.budget.recent_from_id);
  assert.equal(built.budget.included_messages, baseline.budget.included_messages);
});

t('4 build: watermark target gone → existing assembly', () => {
  const db = seed(40);
  insertSummary(db, { until: 'ghost-id' });
  const withGhost = build(db).built;
  const clean = build(seed(40)).built;
  assert.equal(withGhost.budget.recent_from_id, clean.budget.recent_from_id);
  assert.equal(turnText(withGhost), turnText(clean));
});

t('5 build: reversed coverage does not compact', () => {
  const db = seed(40);
  insertSummary(db, { from: 'm20', until: 'm08' });
  const reversed = build(db).built;
  const clean = build(seed(40)).built;
  assert.equal(turnText(reversed), turnText(clean));
});

t('6 build: farthest of several approved watermarks wins', () => {
  const db = seed(40);
  insertSummary(db, { id: 's-early', until: 'm08', from: 'm01', tier: 'scene' });
  insertSummary(db, { id: 's-late', until: 'm16', from: 'm09', tier: 'episode' });
  const { built, path } = build(db);
  const turns = turnText(built);
  const end = effectiveCompactionEndIndex(15, path.length)!;
  for (let i = 1; i <= end + 1; i++) {
    assert.equal(turns.includes(marker(mid(i))), false, `far watermark must exclude ${mid(i)}`);
  }
});

t('7 build: non-approved rows do not compact', () => {
  const db = seed(40);
  insertSummary(db, { id: 'd', status: 'draft', until: 'm16' });
  insertSummary(db, { id: 'r', status: 'rejected', until: 'm16' });
  insertSummary(db, { id: 'x', status: 'deleted', until: 'm16' });
  const dirty = build(db).built;
  const clean = build(seed(40)).built;
  assert.equal(turnText(dirty), turnText(clean));
});

t('8 build: recent guard keeps original messages even if summary covers head', () => {
  const n = 40;
  const db = seed(n);
  insertSummary(db, { until: mid(n), from: 'm01' });
  const { built } = build(db);
  const turns = turnText(built);
  const guardFrom = n - SCENE_RECENT_GUARD + 1;
  for (let i = guardFrom; i <= n; i++) {
    assert.ok(turns.includes(marker(mid(i))), `guard ${mid(i)} stays as original`);
  }
  for (let i = 1; i <= n - SCENE_RECENT_GUARD; i++) {
    assert.equal(turns.includes(marker(mid(i))), false, `pre-guard ${mid(i)} compacted`);
  }
});

t('9 build: path shorter than guard never compacts', () => {
  const db = seed(SCENE_RECENT_GUARD);
  insertSummary(db, { until: mid(SCENE_RECENT_GUARD), from: 'm01' });
  const covered = build(db).built;
  const clean = build(seed(SCENE_RECENT_GUARD)).built;
  assert.equal(turnText(covered), turnText(clean));
  assert.equal(covered.budget.included_messages, clean.budget.included_messages);
});

t('10 build: dropped_messages ignores compacted turns and counts budget misses only', () => {
  const n = 50;
  const dbLong = seed(n, { long: true });
  const before = build(dbLong).built;
  insertSummary(dbLong, { until: 'm20', from: 'm01' });
  const after = build(dbLong).built;
  const turns = turnText(after);
  for (let i = 1; i <= 20; i++) {
    assert.equal(turns.includes(marker(mid(i))), false);
  }
  assert.ok(after.budget.dropped_messages < before.budget.dropped_messages, `dropped ${after.budget.dropped_messages} < ${before.budget.dropped_messages}`);
  assert.equal(turns.includes(marker('m01')), false);
  // compacted count must not sneak into dropped: remaining candidates = n - 20, dropped <= that
  assert.ok(after.budget.dropped_messages + after.budget.included_messages <= n - 20);
  assert.equal(after.budget.dropped_messages + after.budget.included_messages, n - 20);
});

t('11 build: switching head to the other branch ignores the previous path watermark', () => {
  const n = 40;
  const db = seed(n);
  const ins = db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)`);
  let parent = 'm10';
  const branchIds: string[] = [];
  for (let i = 11; i <= n; i++) {
    const id = mid(i, 'b');
    branchIds.push(id);
    ins.run(id, CONV, parent, i % 2 ? 'user' : 'assistant', `${marker(id)} 가지`, 'complete', '{}', 0, `b${pad(i)}`);
    parent = id;
  }
  insertSummary(db, { until: 'm20', from: 'm01' });
  const onA = build(db, getPath(db, { ...convOf(db), head_message_id: mid(n) } as ConversationRow));
  db.prepare(`UPDATE conversations SET head_message_id = ? WHERE id = ?`).run(mid(n, 'b'), CONV);
  const onB = build(db);
  assert.ok(!turnText(onA.built).includes(marker('m01')));
  assert.ok(turnText(onB.built).includes(marker('m01')) || onB.built.budget.dropped_messages > 0);
  const cleanB = seed(n);
  let p = 'm10';
  const ins2 = cleanB.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)`);
  for (let i = 11; i <= n; i++) {
    const id = mid(i, 'b');
    ins2.run(id, CONV, p, i % 2 ? 'user' : 'assistant', `${marker(id)} 가지`, 'complete', '{}', 0, `b${pad(i)}`);
    p = id;
  }
  cleanB.prepare(`UPDATE conversations SET head_message_id = ? WHERE id = ?`).run(mid(n, 'b'), CONV);
  const baselineB = build(cleanB).built;
  assert.equal(onB.built.budget.recent_from_id, baselineB.budget.recent_from_id);
  assert.equal(turnText(onB.built), turnText(baselineB));
});

t('12 build: same DB + same head is deterministic', () => {
  const db = seed(40);
  insertSummary(db, { until: 'm12', from: 'm01' });
  const a = build(db).built;
  const b = build(db).built;
  assert.equal(assemblyHash(a), assemblyHash(b));
  assert.equal(a.budget.dropped_messages, b.budget.dropped_messages);
  assert.equal(a.budget.included_messages, b.budget.included_messages);
});

t('tier name does not admit or reject a watermark by itself', () => {
  for (const tier of ['scene', 'episode', 'whole', 'state']) {
    const db = seed(40);
    insertSummary(db, { id: `t-${tier}`, until: 'm12', from: 'm01', tier });
    const turns = turnText(build(db).built);
    assert.equal(turns.includes(marker('m01')), false, `${tier} with valid coverage still compacts`);
  }
});

t('PROMPT_VERSION records compact without a new API field', () => {
  assert.equal(PROMPT_VERSION, '2026.08.22-r1+story+compact');
});

console.log(`passed ${passed}`);
