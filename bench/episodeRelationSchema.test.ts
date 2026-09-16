/** npx tsx bench/episodeRelationSchema.test.ts
 * episode-relation-schema — summaries.rel_character_id + rel_persona_id (0022).
 * Schema + index + EXPLAIN only. Temp DB; real migrations. No live DB.
 * Does not touch rollup INSERT or builder.ts (that is episode-relation-build).
 *
 * ADR §5 inject shape under test (OR-by-union — preferred over a single OR):
 *   SELECT * FROM summaries
 *    WHERE conversation_id = ? AND tier = 'episode' AND status = 'approved'
 *   UNION ALL
 *   SELECT * FROM summaries
 *    WHERE tier = 'episode' AND status = 'approved'
 *      AND rel_character_id = ? AND rel_persona_id = ?
 *   ORDER BY created_at DESC
 * Conversation branch leads with conversation_id so idx_summaries_conv_tier_status wins;
 * relation branch leads with tier+status+pair so idx_summaries_relation wins.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../apps/server/src/db/index.ts';

const MIG = '0022_summaries_relation_scope.sql';

const BASE_SUMMARY_COLS = [
  'id',
  'conversation_id',
  'content',
  'covers_until_message_id',
  'status',
  'created_at',
  'tier',
  'covers_from_message_id',
  'rolled_up_into',
] as const;

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function tableInfo(db: ReturnType<typeof openDb>, table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
    type: string;
  }>;
}

function indexList(db: ReturnType<typeof openDb>, table: string) {
  return db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>;
}

function indexInfo(db: ReturnType<typeof openDb>, name: string) {
  return db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string; seqno: number }>;
}

function explain(db: ReturnType<typeof openDb>, sql: string, ...binds: unknown[]) {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>;
  return rows.map((r) => r.detail);
}

function assertNoFullScan(details: string[], label: string) {
  const joined = details.join('\n');
  console.log(`--- EXPLAIN ${label} ---\n${joined}\n---`);
  for (const d of details) {
    const line = d.trim();
    if (/^SCAN summaries$/i.test(line) || /^SCAN TABLE summaries$/i.test(line)) {
      assert.fail(`${label}: full table SCAN summaries (no index):\n${joined}`);
    }
    if (/SCAN summaries(?!\s+USING)/i.test(d) && !/USING (?:INDEX|COVERING INDEX)/i.test(d)) {
      assert.fail(`${label}: SCAN summaries without USING INDEX:\n${joined}`);
    }
  }
}

function main() {
  const migPath = path.resolve('apps/server/migrations', MIG);
  assert.ok(fs.existsSync(migPath), `missing ${MIG}`);
  const migSql = fs.readFileSync(migPath, 'utf8');

  t('migration file is ADD COLUMN only (no new table, no backfill UPDATE)', () => {
    assert.match(migSql, /ALTER TABLE summaries ADD COLUMN rel_character_id TEXT REFERENCES characters\(id\);/);
    assert.match(migSql, /ALTER TABLE summaries ADD COLUMN rel_persona_id TEXT REFERENCES personas\(id\);/);
    assert.doesNotMatch(migSql, /CREATE TABLE/i);
    assert.doesNotMatch(migSql, /\bUPDATE\b/i);
    const sqlOnly = migSql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    assert.doesNotMatch(sqlOnly, /ON DELETE/i);
    assert.match(
      migSql,
      /CREATE INDEX IF NOT EXISTS idx_summaries_relation\s+ON summaries\(tier, status, rel_character_id, rel_persona_id, created_at\)/,
    );
    assert.match(
      migSql,
      /CREATE INDEX IF NOT EXISTS idx_summaries_conv_tier_status\s+ON summaries\(conversation_id, tier, status, created_at\)/,
    );
  });

  t('SummaryRow declares both rel_* columns as nullable strings', () => {
    const typesSrc = fs.readFileSync('apps/server/src/types.ts', 'utf8');
    assert.match(
      typesSrc,
      /export interface SummaryRow \{[\s\S]*rel_character_id: string \| null;[\s\S]*rel_persona_id: string \| null;/,
    );
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-episode-relation-schema-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));

  t(`${MIG} applied via schema_migrations`, () => {
    const names = (
      db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>
    ).map((r) => r.name);
    assert.ok(names.includes(MIG), `expected ${MIG} in ${names.join(',')}`);
  });

  const cols = tableInfo(db, 'summaries');
  const colNames = cols.map((c) => c.name);

  t('ADD COLUMN 2개: rel_character_id + rel_persona_id, nullable', () => {
    for (const name of ['rel_character_id', 'rel_persona_id'] as const) {
      const c = cols.find((x) => x.name === name);
      assert.ok(c, `${name} missing`);
      assert.equal(c!.notnull, 0, `${name} must be nullable (no backfill)`);
    }
  });

  t('기존 summaries 열 무변경 (베이스 컬럼 전부 유지)', () => {
    for (const name of BASE_SUMMARY_COLS) {
      assert.ok(colNames.includes(name), `lost column ${name}`);
    }
  });

  const t0 = new Date(0).toISOString();
  db.prepare(
    `INSERT INTO characters (id, name, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
     VALUES (?, 'Char', '', '', '', '', '', '', '', '[]', ?, ?)`,
  ).run('char-1', t0, t0);
  db.prepare(
    `INSERT INTO personas (id, name, created_at, updated_at) VALUES (?, 'Persona', ?, ?)`,
  ).run('persona-1', t0, t0);
  db.prepare(
    `INSERT INTO conversations (id, character_id, persona_id, title, mode, profile_name, scene_json, prompt_version, created_at, updated_at)
     VALUES (?, 'char-1', 'persona-1', '', 'chat', 'rp-balanced', '{}', 'pv', ?, ?)`,
  ).run('conv-1', t0, t0);
  db.prepare(
    `INSERT INTO summaries (id, conversation_id, content, status, created_at, tier)
     VALUES ('ep-old', 'conv-1', 'grandfathered episode', 'approved', ?, 'episode')`,
  ).run(t0);

  t('기존 episode 행의 rel_* 는 NULL (백필 없음)', () => {
    const row = db.prepare(
      'SELECT rel_character_id, rel_persona_id FROM summaries WHERE id = ?',
    ).get('ep-old') as { rel_character_id: string | null; rel_persona_id: string | null };
    assert.equal(row.rel_character_id, null);
    assert.equal(row.rel_persona_id, null);
  });

  t('idx_summaries_relation 존재 + 컬럼 순서', () => {
    const names = indexList(db, 'summaries').map((i) => i.name);
    assert.ok(names.includes('idx_summaries_relation'), names.join(','));
    const info = indexInfo(db, 'idx_summaries_relation').sort((a, b) => a.seqno - b.seqno);
    assert.deepEqual(
      info.map((i) => i.name),
      ['tier', 'status', 'rel_character_id', 'rel_persona_id', 'created_at'],
    );
  });

  t('대화 분기 인덱스: 기존 conv/tier + 0022 conv_tier_status', () => {
    const names = indexList(db, 'summaries').map((i) => i.name);
    assert.ok(names.includes('idx_summaries_conv'), names.join(','));
    assert.ok(names.includes('idx_summaries_tier'), names.join(','));
    assert.ok(names.includes('idx_summaries_conv_tier_status'), names.join(','));
    const info = indexInfo(db, 'idx_summaries_conv_tier_status').sort((a, b) => a.seqno - b.seqno);
    assert.deepEqual(
      info.map((i) => i.name),
      ['conversation_id', 'tier', 'status', 'created_at'],
    );
  });

  db.prepare(
    `INSERT INTO summaries (id, conversation_id, content, status, created_at, tier, rel_character_id, rel_persona_id)
     VALUES ('ep-rel', 'conv-1', 'relation episode', 'approved', ?, 'episode', 'char-1', 'persona-1')`,
  ).run(t0);

  const convSql =
    `SELECT * FROM summaries WHERE conversation_id = ? AND tier = 'episode' AND status = 'approved'`;
  const relSql =
    `SELECT * FROM summaries WHERE tier = 'episode' AND status = 'approved' AND rel_character_id = ? AND rel_persona_id = ?`;
  const unionSql = `${convSql} UNION ALL ${relSql}`;

  t('EXPLAIN 대화 분기: conversation_id 선두 인덱스 (풀스캔 아님)', () => {
    const details = explain(db, convSql, 'conv-1');
    assertNoFullScan(details, 'conversation-branch');
    const joined = details.join('\n');
    assert.match(joined, /idx_summaries_conv(?:_tier_status)?/i, joined);
  });

  t('EXPLAIN 관계 분기: idx_summaries_relation (풀스캔 아님)', () => {
    const details = explain(db, relSql, 'char-1', 'persona-1');
    assertNoFullScan(details, 'relation-branch');
    const joined = details.join('\n');
    assert.match(joined, /idx_summaries_relation/i, joined);
  });

  t('EXPLAIN ADR §5 OR-by-union: 양쪽 인덱스, SCAN summaries 없음', () => {
    const details = explain(db, unionSql, 'conv-1', 'char-1', 'persona-1');
    assertNoFullScan(details, 'or-by-union');
    const joined = details.join('\n');
    assert.match(joined, /idx_summaries_relation/i, joined);
    assert.match(joined, /idx_summaries_conv(?:_tier_status)?/i, joined);
  });

  const orSql =
    `SELECT * FROM summaries WHERE tier = 'episode' AND status = 'approved' AND (conversation_id = ? OR (rel_character_id = ? AND rel_persona_id = ?))`;
  const orDetails = explain(db, orSql, 'conv-1', 'char-1', 'persona-1');
  console.log(`--- EXPLAIN naive-OR (informational) ---\n${orDetails.join('\n')}\n---`);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

main();
