/** npx tsx bench/personaResolve.test.ts
 * Slice C characterization: persona pick needs no builder change.
 * A. persona_id set → resolvePersona returns that row
 * B. persona_id null → is_default=1
 * C. persona_id dangling id → fallback default
 * D. persona edit → next buildPrompt contains new appearance (live reference)
 * E. diagnostics: 4 summary tiers present, no fifth user-note layer
 * F. persona swap leaves non-persona sections unchanged
 *
 * NOT a live-wiring proof. Live apply of personas is already in builder.ts.
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { DB } from '../apps/server/src/db/index.js';
import { buildPrompt, resolvePersona } from '../apps/server/src/prompt/builder.js';

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
    INSERT INTO characters VALUES ('c1','테스트캐',NULL,'설명','성격','말투',NULL,NULL,NULL);
    INSERT INTO model_profiles VALUES ('rp-balanced',NULL,0.8,0.95,400,'[]','system',NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, character_id TEXT, persona_id TEXT, mode TEXT, profile_name TEXT, scene_json TEXT, user_note TEXT,
      persona_name_snapshot TEXT, persona_address_snapshot TEXT, persona_appearance_snapshot TEXT, persona_personality_snapshot TEXT, persona_relationship_snapshot TEXT, persona_applied_at TEXT);
    INSERT INTO conversations VALUES ('conv1','c1','p1','story',NULL,'{}',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, status TEXT, created_at TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY, conversation_id TEXT, character_id TEXT, content TEXT, source TEXT, status TEXT, importance INTEGER, scope TEXT, evidence_message_ids_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE summaries (id TEXT PRIMARY KEY, conversation_id TEXT, content TEXT, covers_until_message_id TEXT, covers_from_message_id TEXT, status TEXT, created_at TEXT, tier TEXT, rolled_up_into TEXT);
    CREATE TABLE lorebooks (id TEXT PRIMARY KEY, character_id TEXT);
    CREATE TABLE lore_entries (id TEXT PRIMARY KEY, lorebook_id TEXT, title TEXT, content TEXT, keywords_json TEXT, secondary_keys_json TEXT, selective INTEGER, always_on INTEGER, priority INTEGER, token_cap INTEGER, enabled INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('token_calibration','1.0');
  `);
  const insP = db.prepare(`INSERT INTO personas VALUES (?,?,?,?,?,?,?,?,?)`);
  insP.run('p1', '유저', '호칭1', '외형1', '페르소나성격', '관계1', 0, '0001', '0001');
  insP.run('p2', '기본', null, null, null, null, 1, '0002', '0002');
  const ins = db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?)`);
  for (let i = 1; i <= 60; i++) ins.run(`m${String(i).padStart(2, '0')}`, 'conv1', i % 2 ? 'user' : 'assistant', `대화 ${i}입니다.`, 'done', String(i).padStart(4, '0'));
  return db;
}

function convRow(db: DB): any {
  return db.prepare(`SELECT * FROM conversations WHERE id = 'conv1'`).get();
}

function history(db: DB): any[] {
  return db.prepare(`SELECT * FROM messages WHERE conversation_id='conv1' ORDER BY created_at`).all();
}

const db = seed();

t('A. persona_id set → that row', () => {
  const p = resolvePersona(db, convRow(db));
  assert.equal(p!.id, 'p1');
});

t('B. persona_id null → is_default=1', () => {
  db.prepare(`UPDATE conversations SET persona_id = NULL WHERE id='conv1'`).run();
  const p = resolvePersona(db, convRow(db));
  assert.equal(p!.id, 'p2');
});

t('C. dangling persona_id → fallback default', () => {
  db.prepare(`UPDATE conversations SET persona_id = 'ghost' WHERE id='conv1'`).run();
  const p = resolvePersona(db, convRow(db));
  assert.equal(p!.id, 'p2');
  db.prepare(`UPDATE conversations SET persona_id = 'p1' WHERE id='conv1'`).run();
});

t('D. persona edit → next buildPrompt contains new appearance (live reference)', () => {
  const before = buildPrompt(db, convRow(db), history(db), 16384, 'm', 'rp-balanced').messages.map((m: any) => m.content).join('\n');
  assert.ok(before.includes('외형1'));
  db.prepare(`UPDATE personas SET appearance='외형-수정됨' WHERE id='p1'`).run();
  const after = buildPrompt(db, convRow(db), history(db), 16384, 'm', 'rp-balanced').messages.map((m: any) => m.content).join('\n');
  assert.ok(after.includes('외형-수정됨'));
  assert.ok(!before.includes('외형-수정됨'));
});

t('E. diagnostics: 4 summary tiers present, no fifth user-note layer', () => {
  const b = buildPrompt(db, convRow(db), history(db), 16384, 'm', 'rp-balanced', { diagnostics: true });
  const diag = b.budget.diagnostics!.summaries!;
  for (const tier of ['state', 'whole', 'scene', 'episode']) {
    assert.ok(diag.some((d: any) => d.tier === tier), `tier ${tier} present in diagnostics`);
  }
  const text = JSON.stringify(b);
  assert.ok(!text.includes('user_note'), 'no fifth user-note layer');
  assert.ok(!text.includes('allocateUserContextBudget'), 'no user-context budget helper');
});

t('F. persona swap leaves non-persona sections unchanged', () => {
  const withP1 = buildPrompt(db, convRow(db), history(db), 16384, 'm', 'rp-balanced').messages.map((m: any) => m.content).join('\n---\n');
  db.prepare(`UPDATE conversations SET persona_id = NULL WHERE id='conv1'`).run();
  const withDefault = buildPrompt(db, convRow(db), history(db), 16384, 'm', 'rp-balanced').messages.map((m: any) => m.content).join('\n---\n');
  db.prepare(`UPDATE conversations SET persona_id = 'p1' WHERE id='conv1'`).run();
  // userName legitimately appears in system rules + persona block.
  // Characterize: the recent-message window is byte-identical regardless of persona,
  // and only the system message (which carries the persona block) differs.
  const sysA = withP1.split('\n---\n')[0];
  const sysB = withDefault.split('\n---\n')[0];
  assert.notEqual(sysA, sysB, 'system message differs with persona');
  const restA = withP1.slice(withP1.indexOf('\n---\n') + 5);
  const restB = withDefault.slice(withDefault.indexOf('\n---\n') + 5);
  assert.equal(restA, restB, 'non-persona sections (history + tail) unchanged');
  assert.ok(sysA.includes('외형-수정됨'));
});

console.log(`passed ${passed}`);
