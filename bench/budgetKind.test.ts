/** npx tsx bench/budgetKind.test.ts
 * P5-R1 — budget sections carry a source kind so the inspector can label them per source.
 * Temp in-memory DB only. Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 * Does not start systemd or touch the live DB. No UI. Additive metadata only — message bytes unchanged.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DB } from '../apps/server/src/db/index.js';
import { buildPrompt } from '../apps/server/src/prompt/builder.js';
import { PROMPT_VERSION } from '../apps/server/src/config.ts';
import type { ConversationRow, MessageRow } from '../apps/server/src/types.js';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const SETTING = '눈 덮인 왕국. {{char}}는 북쪽 관문을 지킨다.';
const CAST = [
  { name: '행상인', note: '정보를 판다' },
  { name: '경비', note: '문을 지킨다' },
];

function seed(): DB {
  const db = new Database(':memory:') as unknown as DB;
  db.exec(`
    CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT, tagline TEXT, description TEXT, personality TEXT, speech_style TEXT, scenario TEXT, taboos TEXT, example_dialogue TEXT);
    CREATE TABLE personas (id TEXT PRIMARY KEY, name TEXT, address_as TEXT, appearance TEXT, personality TEXT, relationship TEXT, is_default INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE model_profiles (name TEXT PRIMARY KEY, model TEXT, temperature REAL, top_p REAL, max_tokens INTEGER, stop_json TEXT, system_mode TEXT, notes TEXT);
    INSERT INTO characters VALUES ('c1','테스트캐','짧은소개','설명','성격','말투','시나리오','금기','예시');
    INSERT INTO model_profiles VALUES ('rp-balanced',NULL,0.8,0.95,400,'[]','system',NULL);
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, character_id TEXT, persona_id TEXT, mode TEXT, profile_name TEXT, scene_json TEXT, user_note TEXT,
      story_id TEXT, story_applied_at TEXT, story_name_snapshot TEXT, story_setting_snapshot TEXT, story_minor_cast_snapshot TEXT
    );
    CREATE TABLE stories (id TEXT PRIMARY KEY, name TEXT, setting TEXT, archived INTEGER);
    INSERT INTO stories VALUES ('s1','라이브이름','라이브설정',0);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, status TEXT, created_at TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY, conversation_id TEXT, character_id TEXT, content TEXT, source TEXT, status TEXT, importance INTEGER, scope TEXT, evidence_message_ids_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE summaries (id TEXT PRIMARY KEY, conversation_id TEXT, content TEXT, covers_until_message_id TEXT, covers_from_message_id TEXT, status TEXT, created_at TEXT, tier TEXT, rolled_up_into TEXT);
    CREATE TABLE lorebooks (id TEXT PRIMARY KEY, character_id TEXT);
    CREATE TABLE lore_entries (id TEXT PRIMARY KEY, lorebook_id TEXT, title TEXT, content TEXT, keywords_json TEXT, secondary_keys_json TEXT, selective INTEGER, always_on INTEGER, priority INTEGER, token_cap INTEGER, enabled INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('token_calibration','1.0');
  `);
  db.prepare(`INSERT INTO personas VALUES (?,?,?,?,?,?,?,?,?)`).run('p1', '유저', '호칭1', '외형1', '페르소나성격', '관계1', 1, '0001', '0001');
  db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?)`).run('m01', 'conv1', 'user', '시작입니다.', 'done', '0001');
  db.prepare(`INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    'mem1', 'conv1', 'c1', '핀 기억 한 줄', 'manual', 'pinned', 5, 'conversation', '[]', '0001', '0001',
  );
  return db;
}

function conv(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: 'conv1',
    character_id: 'c1',
    persona_id: 'p1',
    title: '',
    mode: 'story',
    profile_name: 'rp-balanced',
    scene_json: '{"place":"광장"}',
    head_message_id: null,
    prompt_version: PROMPT_VERSION,
    favorite: 0,
    archived: 0,
    created_at: 't',
    updated_at: 't',
    last_message_at: 't',
    user_note: null,
    persona_name_snapshot: null,
    persona_address_snapshot: null,
    persona_appearance_snapshot: null,
    persona_personality_snapshot: null,
    persona_relationship_snapshot: null,
    persona_applied_at: null,
    story_id: 's1',
    story_applied_at: 't0',
    story_name_snapshot: '설원왕국',
    story_setting_snapshot: SETTING,
    story_minor_cast_snapshot: JSON.stringify(CAST),
    ...over,
  } as ConversationRow;
}

const db = seed();
const history = db.prepare(`SELECT * FROM messages WHERE conversation_id='conv1' ORDER BY created_at`).all() as MessageRow[];
const built = buildPrompt(db, conv(), history, 8192, 'test-model');
const sections = built.budget.sections;

const typesSrc = fs.readFileSync(path.resolve('apps/server/src/types.ts'), 'utf8');
const webTypesSrc = fs.readFileSync(path.resolve('apps/web/src/types.ts'), 'utf8');
const drawerSrc = fs.readFileSync(path.resolve('apps/web/src/pages/ChatDrawer.tsx'), 'utf8');

t('KIND-01 every emitted section carries a kind', () => {
  const missing = sections.filter((s) => !s.kind).map((s) => s.name);
  assert.deepEqual(missing, [], `sections without kind: ${missing.join(' / ')}`);
});

t('KIND-02 kinds map to the real assembly order, one per source block', () => {
  assert.deepEqual(
    sections.map((s) => s.kind),
    ['system', 'story', 'lore', 'memory', 'recent'],
    `actual: ${JSON.stringify(sections.map((s) => [s.name, s.kind]))}`,
  );
});

t('KIND-03 additive only — names, tokens and notes are untouched', () => {
  assert.deepEqual(sections.map((s) => s.name), [
    '시스템 규칙+카드+페르소나+장면',
    '스토리 설정',
    '활성 로어',
    '고정 기억+요약',
    '최근 대화',
  ]);
  for (const s of sections) {
    assert.equal(typeof s.est_tokens, 'number');
    assert.equal(typeof s.budget, 'number');
  }
  assert.equal(built.messages.some((m) => JSON.stringify(m).includes('"kind"')), false, 'kind must never reach the model');
});

t('KIND-04 story-less conversation still labels every remaining section', () => {
  const b2 = buildPrompt(db, conv({ story_id: null, story_setting_snapshot: null, story_minor_cast_snapshot: null }), history, 8192, 'test-model');
  assert.deepEqual(b2.budget.sections.map((s) => s.kind), ['system', 'lore', 'memory', 'recent']);
});

t('KIND-05 kind is optional in both type mirrors — old payloads stay valid', () => {
  const union = /kind\?: 'system' \| 'story' \| 'lore' \| 'memory' \| 'summary' \| 'recent'/;
  assert.match(typesSrc, union, 'server BudgetReport.sections');
  assert.match(webTypesSrc, union, 'web BudgetReport.sections mirror must match server');
});

t("KIND-06 'summary' is declared but unemitted — 기억+요약 is one section today", () => {
  assert.equal(sections.some((s) => s.kind === 'summary'), false);
  assert.ok(drawerSrc.includes("summary: '요약'"), 'label exists for the day that section splits');
});

t('KIND-07 inspector renders the kind as a per-row source tag, existing markup kept', () => {
  assert.ok(drawerSrc.includes('KIND_LABEL'), 'label map missing');
  assert.ok(drawerSrc.includes('s.kind'), 'BudgetBars must read kind');
  assert.ok(drawerSrc.includes('{s.est_tokens}/{s.budget}t'), 'existing token readout kept');
  assert.ok(drawerSrc.includes("s.est_tokens > s.budget ? 'var(--danger)' : 'var(--accent)'"), 'existing accent/danger rule kept — no new palette');
  assert.equal(drawerSrc.includes('app.css'), false, 'no new CSS file');
});

console.log(`passed ${passed}`);
