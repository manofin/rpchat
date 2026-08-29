/** npx tsx bench/storyInjectBuild.test.ts
 * F8b story-inject-build — renderStory + buildPrompt inject + budget sub-split + PROMPT_VERSION.
 * Temp DB only. Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 * Does not start systemd or touch the live DB. No UI.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import type { DB } from '../apps/server/src/db/index.js';
import { buildPrompt } from '../apps/server/src/prompt/builder.js';
import { PROMPT_VERSION } from '../apps/server/src/config.ts';
import type { ConversationRow, MessageRow } from '../apps/server/src/types.js';

const require2 = createRequire(import.meta.url);
let renderStory: typeof import('../apps/server/src/prompt/templates.js')['renderStory'];
try {
  renderStory = require2('../apps/server/src/prompt/templates.ts').renderStory;
  if (typeof renderStory !== 'function') throw new Error('renderStory is not a function');
} catch (e) {
  console.error('RED: renderStory missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const NAME_MARKER = 'UNIQUE_STORY_NAME_설원왕국';
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
  db.prepare(
    `INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('mem1', 'conv1', 'c1', '핀 기억 한 줄', 'manual', 'pinned', 5, 'conversation', '[]', '0001', '0001');
  return db;
}

function convBase(over: Partial<ConversationRow> = {}): ConversationRow {
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
    story_name_snapshot: NAME_MARKER,
    story_setting_snapshot: SETTING,
    story_minor_cast_snapshot: JSON.stringify(CAST),
    ...over,
  } as ConversationRow;
}

function sys(db: DB, conv: ConversationRow, history?: MessageRow[]) {
  const hist =
    history ??
    (db.prepare(`SELECT * FROM messages WHERE conversation_id='conv1' ORDER BY created_at`).all() as MessageRow[]);
  const b = buildPrompt(db, conv, hist, 8192, 'test-model');
  const text = String(b.messages.find((m) => m.role === 'system')?.content ?? '');
  return { b, text };
}

const db = seed();
const builderSrc = fs.readFileSync('apps/server/src/prompt/builder.ts', 'utf8');
const templatesSrc = fs.readFileSync('apps/server/src/prompt/templates.ts', 'utf8');
const configSrc = fs.readFileSync('apps/server/src/config.ts', 'utf8');

t('PROMPT_VERSION ends with +story', () => {
  assert.equal(PROMPT_VERSION.endsWith('+story'), true);
  assert.match(configSrc, /PROMPT_VERSION = '2026\.08\.22-r1\+story'/);
});

t('sub-budget constants: setting 0.7 then cast 0.3 of story room', () => {
  assert.match(builderSrc, /STORY_SETTING_SHARE\s*=\s*0\.7/);
  assert.match(builderSrc, /STORY_CAST_SHARE\s*=\s*0\.3/);
});

t('builder does not query live stories table', () => {
  assert.equal(/\bFROM\s+stories\b/i.test(builderSrc), false);
  assert.equal(builderSrc.includes('story_characters'), false);
  assert.ok(builderSrc.includes('resolveStory'));
  assert.ok(builderSrc.includes('renderStory'));
});

t('renderStory: setting + cast headers; name omitted', () => {
  const out = renderStory({ setting: SETTING, minorCast: CAST }, '테스트캐', '유저');
  assert.ok(out);
  assert.ok(out!.includes('### 스토리 설정'));
  assert.ok(out!.includes('눈 덮인 왕국'));
  assert.ok(out!.includes('테스트캐는 북쪽 관문을 지킨다'));
  assert.ok(out!.includes('### 조연'));
  assert.ok(out!.includes('- 행상인: 정보를 판다'));
  assert.ok(out!.includes('- 경비: 문을 지킨다'));
  assert.equal(out!.includes(NAME_MARKER), false);
  assert.equal(out!.includes('설원왕국'), false);
});

t('renderStory: empty setting omits setting header; empty cast omits 조연; both empty → null', () => {
  const onlyCast = renderStory({ setting: '  ', minorCast: CAST }, '캐', '유저');
  assert.ok(onlyCast);
  assert.equal(onlyCast!.includes('### 스토리 설정'), false);
  assert.ok(onlyCast!.includes('### 조연'));
  const onlySet = renderStory({ setting: '배경', minorCast: [] }, '캐', '유저');
  assert.ok(onlySet);
  assert.ok(onlySet!.includes('### 스토리 설정'));
  assert.equal(onlySet!.includes('### 조연'), false);
  assert.equal(renderStory({ setting: '', minorCast: [] }, '캐', '유저'), null);
  assert.equal(renderStory(null, '캐', '유저'), null);
});

t('applied_at + setting → ### 스토리 설정 after scene, before memories; name absent', () => {
  const { text, b } = sys(db, convBase());
  assert.ok(text.includes('### 스토리 설정'));
  assert.ok(text.includes('눈 덮인 왕국'));
  assert.ok(text.includes('### 조연'));
  const sceneIdx = text.indexOf('### 현재 장면');
  const storyIdx = text.indexOf('### 스토리 설정');
  const memIdx = text.indexOf('### 고정 기억');
  assert.ok(sceneIdx >= 0 && storyIdx > sceneIdx, `story after scene (${sceneIdx},${storyIdx})`);
  assert.ok(memIdx > storyIdx, `memories after story (${storyIdx},${memIdx})`);
  assert.equal(text.includes(NAME_MARKER), false);
  const row = b.budget.sections.find((s) => s.name === '스토리 설정');
  assert.ok(row, 'budget section 스토리 설정');
  assert.ok((row!.est_tokens as number) > 0);
});

t('story_applied_at null (story_id set) → no story block', () => {
  const { text, b } = sys(db, convBase({ story_applied_at: null, story_id: 's1' }));
  assert.equal(text.includes('### 스토리 설정'), false);
  assert.equal(text.includes('### 조연'), false);
  assert.equal(b.budget.sections.some((s) => s.name === '스토리 설정'), false);
});

t('OOC → no story inject', () => {
  const hist: MessageRow[] = [
    {
      id: 'm01',
      conversation_id: 'conv1',
      parent_id: null,
      role: 'user',
      content: '(OOC) 설정 확인',
      status: 'complete',
      created_at: '0001',
      metadata_json: null,
    } as MessageRow,
  ];
  const { text, b } = sys(db, convBase(), hist);
  assert.equal(b.isOoc, true);
  assert.equal(text.includes('### 스토리 설정'), false);
  assert.equal(text.includes('### 조연'), false);
});

t('huge setting is truncated (not summarized); head kept, tail dropped', () => {
  const head = '[[STORY_HEAD]]';
  const tail = '[[STORY_TAIL]]';
  const huge = `${head}${'가'.repeat(8000)}${tail}`;
  const { text, b } = sys(db, convBase({ story_setting_snapshot: huge, story_minor_cast_snapshot: '[]' }));
  assert.ok(text.includes('### 스토리 설정'));
  assert.ok(text.includes(head));
  assert.equal(text.includes(tail), false);
  assert.ok(text.includes('…'));
  const row = b.budget.sections.find((s) => s.name === '스토리 설정');
  assert.ok(row?.note && row.note.includes('절단'));
});

t('minor_cast prefix whole-or-drop; later items dropped as a suffix', () => {
  const hugeNote = '나'.repeat(8000);
  const cast = [
    { name: '행상인', note: '정보를 판다' },
    { name: '드롭1', note: hugeNote },
    { name: '드롭2', note: hugeNote },
  ];
  const { text, b } = sys(
    db,
    convBase({ story_setting_snapshot: SETTING, story_minor_cast_snapshot: JSON.stringify(cast) }),
  );
  assert.ok(text.includes('- 행상인: 정보를 판다'));
  assert.equal(text.includes('드롭1'), false);
  assert.equal(text.includes('드롭2'), false);
  const row = b.budget.sections.find((s) => s.name === '스토리 설정');
  assert.ok(row?.note && /조연 2건 제외/.test(row.note));
});

t('damaged JSON → empty cast, setting still injects', () => {
  const { text } = sys(db, convBase({ story_minor_cast_snapshot: '{not-json' }));
  assert.ok(text.includes('### 스토리 설정'));
  assert.equal(text.includes('### 조연'), false);
});

t('empty setting and empty cast snapshot → no block', () => {
  const { text, b } = sys(
    db,
    convBase({ story_setting_snapshot: '', story_minor_cast_snapshot: '[]' }),
  );
  assert.equal(text.includes('### 스토리 설정'), false);
  assert.equal(text.includes('### 조연'), false);
  assert.equal(b.budget.sections.some((s) => s.name === '스토리 설정'), false);
});

t('live stories.setting change does not change build (no live fallback)', () => {
  const a = sys(db, convBase()).text;
  db.prepare(`UPDATE stories SET setting = '바뀐라이브' WHERE id = 's1'`).run();
  const c = sys(db, convBase()).text;
  assert.equal(c, a);
  assert.equal(c.includes('바뀐라이브'), false);
  assert.ok(c.includes('눈 덮인 왕국'));
});

t('archived=1 on live story does not change build', () => {
  db.prepare(`UPDATE stories SET archived = 1 WHERE id = 's1'`).run();
  const { text } = sys(db, convBase());
  assert.ok(text.includes('### 스토리 설정'));
  assert.ok(text.includes('눈 덮인 왕국'));
});

console.log(`passed ${passed}`);
