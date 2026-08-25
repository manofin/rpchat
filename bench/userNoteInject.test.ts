/** npx tsx bench/userNoteInject.test.ts
 * user_note live-wiring characterization (builder.ts, 2026-08-25).
 * A. user_note set → '### 유저노트' appears in system text, after persona block
 * B. user_note null/empty → no '유저노트' section, system text identical to pre-lock shape
 * C. oversized note → note dropped entirely (whole-or-nothing), fixed block reports '유저노트 제외'
 * D. PATCH-visible: conv row with note vs without → only system message differs
 *
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { DB } from '../apps/server/src/db/index.js';
import { buildPrompt } from '../apps/server/src/prompt/builder.js';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function seed(): DB {
  const db = new Database(':memory:') as unknown as DB;
  db.exec(`
    CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT, tagline TEXT, description TEXT, personality TEXT, speech_style TEXT, scenario TEXT, taboos TEXT, example_dialogue TEXT);
    CREATE TABLE personas (id TEXT PRIMARY KEY, name TEXT, address_as TEXT, appearance TEXT, personality TEXT, relationship TEXT, is_default INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE model_profiles (name TEXT PRIMARY KEY, model TEXT, temperature REAL, top_p REAL, max_tokens INTEGER, stop_json TEXT, system_mode TEXT, notes TEXT);
    INSERT INTO characters VALUES ('c1','테스트캐','짧은소개','설명','성격','말투','시나리오','금기','예시');
    INSERT INTO model_profiles VALUES ('rp-balanced',NULL,0.8,0.95,400,'[]','system',NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, character_id TEXT, persona_id TEXT, mode TEXT, profile_name TEXT, scene_json TEXT, user_note TEXT);
    INSERT INTO conversations VALUES ('conv1','c1','p1','story',NULL,'{}',NULL);
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
  return db;
}

const NOTE = '테스트 유저노트: {{char}}는 지금 비어 있는 창고에 있다.';

function systemOf(db: DB, note: string | null): { text: string; report: unknown } {
  db.prepare('UPDATE conversations SET user_note = ? WHERE id = ?').run(note, 'conv1');
  const conv: any = db.prepare(`SELECT * FROM conversations WHERE id = 'conv1'`).get();
  const history: any[] = db.prepare(`SELECT * FROM messages WHERE conversation_id='conv1' ORDER BY created_at`).all();
  const b = buildPrompt(db, conv, history, 8192, 'test-model', undefined, { diagnostics: true });
  const sys = b.messages.find((m: any) => m.role === 'system');
  return { text: sys ? String(sys.content) : '', report: b.budget };
}

const db = seed();

t('A. note set → 유저노트 section after persona block', () => {
  const { text } = systemOf(db, NOTE);
  assert.ok(text.includes('### 유저노트'), 'note section present');
  const personaIdx = text.indexOf('### 사용자 페르소나');
  const noteIdx = text.indexOf('### 유저노트');
  assert.ok(personaIdx >= 0 && noteIdx > personaIdx, `note after persona (persona@${personaIdx}, note@${noteIdx})`);
  assert.ok(text.includes(NOTE), 'note body verbatim');
});

t('B. note null → section absent', () => {
  const { text } = systemOf(db, null);
  assert.ok(!text.includes('### 유저노트'), 'no note section');
  assert.ok(!text.includes('유저노트 제외'), 'no drop note');
});

t('C. oversized note → dropped whole, fixed section reports drop', () => {
  const big = '장'.repeat(4000);
  const { text, report } = systemOf(db, big);
  assert.ok(!text.includes('### 유저노트'), 'note not injected');
  const rep = report as any;
  const fixed = rep.sections.find((s: any) => s.name.startsWith('시스템 규칙'));
  assert.ok(fixed, 'fixed section exists');
  assert.ok(fixed.est_tokens <= fixed.budget, `fixed within budget (${fixed.est_tokens} <= ${fixed.budget})`);
  assert.equal(fixed.note, '유저노트 제외');
});

t('D. note on/off → recent window identical, only system differs', () => {
  const on = systemOf(db, NOTE);
  const off = systemOf(db, null);
  // rebuild messages arrays via a direct build to compare turns
  const conv: any = db.prepare(`SELECT * FROM conversations WHERE id = 'conv1'`).get();
  const history: any[] = db.prepare(`SELECT * FROM messages WHERE conversation_id='conv1' ORDER BY created_at`).all();
  const b1 = buildPrompt(db, { ...conv, user_note: NOTE }, history, 8192, 'test-model');
  const b2 = buildPrompt(db, { ...conv, user_note: null }, history, 8192, 'test-model');
  assert.deepEqual(b1.messages.slice(1), b2.messages.slice(1), 'non-system messages identical');
  const s1 = b1.messages[0].content as string;
  const s2 = b2.messages[0].content as string;
  assert.ok(s1.includes(NOTE) && !s2.includes(NOTE));
  void on; void off;
});

console.log(`passed ${passed}`);
