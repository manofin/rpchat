/**
 * npx tsx bench/characterPlayGuide.test.ts
 * C3 characters.play_guide — user-only field, never injected into prompts.
 * Isolated: temp DB + real routes. No live DB, no systemd, no generate.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { openDb, one, run, uid, nowIso, setSetting } from '../apps/server/src/db/index.ts';
import { buildPrompt } from '../apps/server/src/prompt/builder.ts';
import { PROMPT_VERSION } from '../apps/server/src/config.ts';
import type { ConversationRow, MessageRow } from '../apps/server/src/types.ts';
import {
  characterDraftStorageKey,
  isCharacterDraft,
  readCharacterDraft,
  type Kv,
} from '../apps/web/src/lib/characterDraftStore.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIG_DIR = path.join(ROOT, 'apps/server/migrations');
const MARK = 'PLAY-GUIDE-C3-LEAK-7f3a9c2e';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', cwd: ROOT }).toString();
}

function t(name: string, fn: () => void | Promise<void>) {
  return { name, fn };
}

const editor = fs.readFileSync(path.join(ROOT, 'apps/web/src/components/CharacterEditor.tsx'), 'utf8');
const charRoutes = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/characters.ts'), 'utf8');
const templates = fs.readFileSync(path.join(ROOT, 'apps/server/src/prompt/templates.ts'), 'utf8');
const migPath = path.join(MIG_DIR, '0021_character_play_guide.sql');
const migSql = fs.readFileSync(migPath, 'utf8');

function tabSection(src: string, from: string, to?: string): string {
  const a = src.indexOf(`{tab === '${from}' && (`);
  assert.ok(a >= 0, `tab ${from} missing`);
  const b = to ? src.indexOf(`{tab === '${to}' && (`, a + 1) : src.length;
  assert.ok(b > a, `tab ${to ?? 'end'} missing after ${from}`);
  return src.slice(a, b);
}

const tests = [
  t('1 migration file is 0021_character_play_guide.sql with a single ALTER', () => {
    assert.ok(fs.existsSync(migPath));
    const names = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
    assert.equal(names.at(-1), '0021_character_play_guide.sql');
    const body = migSql
      .split('\n')
      .filter((l) => l.trim() && !l.trimStart().startsWith('--'))
      .join('\n')
      .replace(/;\s*$/, '')
      .trim();
    assert.equal(body, "ALTER TABLE characters ADD COLUMN play_guide TEXT NOT NULL DEFAULT ''");
    assert.equal((migSql.match(/\bALTER\b/gi) ?? []).length, 1);
  }),

  t('2 column constraint is TEXT NOT NULL DEFAULT empty string', () => {
    assert.match(migSql, /play_guide TEXT NOT NULL DEFAULT ''/);
  }),

  t('3 existing migration files are unmodified', () => {
    assert.equal(git(['diff', 'HEAD', '--', 'apps/server/migrations']).trim(), '');
    const names = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const f of names) {
      if (f === '0021_character_play_guide.sql') continue;
      assert.equal(git(['diff', 'HEAD', '--', `apps/server/migrations/${f}`]).trim(), '');
    }
  }),

  t('11 renderCharacter source does not mention play_guide', () => {
    const start = templates.indexOf('export function renderCharacter');
    const end = templates.indexOf('export function renderPersona');
    assert.ok(start >= 0 && end > start);
    assert.equal(templates.slice(start, end).includes('play_guide'), false);
  }),

  t('12 templates.ts / builder.ts / PROMPT_VERSION bytes unchanged vs HEAD', () => {
    assert.equal(git(['diff', 'HEAD', '--', 'apps/server/src/prompt/templates.ts']).trim(), '');
    assert.equal(git(['diff', 'HEAD', '--', 'apps/server/src/prompt/builder.ts']).trim(), '');
    assert.equal(git(['diff', 'HEAD', '--', 'apps/server/src/config.ts']).trim(), '');
    assert.match(
      fs.readFileSync(path.join(ROOT, 'apps/server/src/config.ts'), 'utf8'),
      /export const PROMPT_VERSION = /,
    );
  }),

  t('14 CharacterEditor intro tab has play_guide field', () => {
    const intro = tabSection(editor, 'intro', 'prompt');
    assert.match(intro, /플레이 가이드/);
    assert.match(intro, /AI 에 전달되지 않음/);
    assert.match(intro, /set\('play_guide'/);
    assert.equal(tabSection(editor, 'prompt', 'detail').includes("set('play_guide'"), false);
  }),

  t('15 TokenChips field= count stays 8', () => {
    assert.equal((editor.match(/<TokenChips field="/g) ?? []).length, 8);
    const intro = tabSection(editor, 'intro', 'prompt');
    assert.equal(intro.includes('<TokenChips field="play_guide"'), false);
  }),

  t('16 save payload remains d', () => {
    assert.match(editor, /await post<Character>\('\/api\/characters', d\)/);
    assert.match(editor, /await put<Character>\(`\/api\/characters\/\$\{character\.id\}`, d\)/);
  }),

  t('19 Draft Omit list unchanged', () => {
    assert.match(
      editor,
      /type Draft = Omit<Character, 'id' \| 'created_at' \| 'updated_at' \| 'archived' \| 'conversation_count' \| 'last_chat_at'>/,
    );
  }),

  t('20 ConversationGuidePage.tsx unchanged', () => {
    assert.equal(git(['diff', 'HEAD', '--', 'apps/web/src/pages/ConversationGuidePage.tsx']).trim(), '');
    const guide = fs.readFileSync(path.join(ROOT, 'apps/web/src/pages/ConversationGuidePage.tsx'), 'utf8');
    assert.equal(guide.includes('play_guide'), false);
  }),

  t('21 no new endpoints', () => {
    const head = git(['show', 'HEAD:apps/server/src/routes/characters.ts']);
    const re = /app\.(get|post|put|delete|patch)\('([^']+)'/g;
    const paths = (src: string) => [...src.matchAll(re)].map((m) => `${m[1]} ${m[2]}`).sort();
    assert.deepEqual(paths(charRoutes), paths(head));
    assert.equal(charRoutes.includes('/api/play_guide'), false);
    assert.equal(charRoutes.includes('/play_guide'), false);
  }),

  t('22 CharacterEditor.tsx as unknown is 0', () => {
    assert.equal((editor.match(/as unknown/g) ?? []).length, 0);
  }),
];

async function runHttpAndPrompt(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-c3-pg-'));
  const db = openDb(tmp, MIG_DIR);
  const log = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
  const app = Fastify({ logger: false });
  await app.register(characterRoutes({ db, dataDir: tmp, log }));
  await app.ready();

  try {
    const tooLong = await app.inject({
      method: 'POST',
      url: '/api/characters',
      payload: { name: '한도초과', play_guide: 'x'.repeat(501) },
    });
    assert.equal(tooLong.statusCode, 400, '4 zod rejects 501 chars');

    const okLen = await app.inject({
      method: 'POST',
      url: '/api/characters',
      payload: { name: '한도허용', play_guide: 'y'.repeat(500) },
    });
    assert.equal(okLen.statusCode, 201, '4 zod allows 500 chars');
    assert.equal(JSON.parse(okLen.body).play_guide.length, 500);

    const omitted = await app.inject({
      method: 'POST',
      url: '/api/characters',
      payload: { name: '생략기본' },
    });
    assert.equal(omitted.statusCode, 201, '5 omitted play_guide stores empty');
    const omittedBody = JSON.parse(omitted.body);
    assert.equal(omittedBody.play_guide, '');
    const omittedGet = await app.inject({ method: 'GET', url: `/api/characters/${omittedBody.id}` });
    assert.equal(omittedGet.statusCode, 200);
    assert.equal(JSON.parse(omittedGet.body).play_guide, '');

    const created = await app.inject({
      method: 'POST',
      url: '/api/characters',
      payload: { name: '라운드트립', play_guide: '보관값-α' },
    });
    assert.equal(created.statusCode, 201, '6 POST->GET roundtrip');
    const createdBody = JSON.parse(created.body);
    assert.equal(createdBody.play_guide, '보관값-α');
    assert.ok('play_guide' in createdBody, '9 characterOut includes play_guide');
    const got = await app.inject({ method: 'GET', url: `/api/characters/${createdBody.id}` });
    assert.equal(got.statusCode, 200);
    assert.equal(JSON.parse(got.body).play_guide, '보관값-α');

    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/characters/${createdBody.id}`,
      payload: {
        name: '라운드트립',
        tagline: '',
        description: '',
        personality: '',
        speech_style: '',
        scenario: '',
        first_message: '',
        example_dialogue: '',
        taboos: '',
        play_guide: '수정값-β',
        tags: [],
      },
    });
    assert.equal(putRes.statusCode, 200, '7 PUT roundtrip');
    assert.equal(JSON.parse(putRes.body).play_guide, '수정값-β');
    const gotPut = await app.inject({ method: 'GET', url: `/api/characters/${createdBody.id}` });
    assert.equal(JSON.parse(gotPut.body).play_guide, '수정값-β');

    const imported = await app.inject({
      method: 'POST',
      url: '/api/characters/import',
      payload: { json: { name: '임포트캐', description: '카드설명' } },
    });
    assert.equal(imported.statusCode, 201, `8 import play_guide is empty: ${imported.body}`);
    const importedBody = JSON.parse(imported.body);
    assert.equal(importedBody.character.play_guide, '');
    const importedGet = await app.inject({
      method: 'GET',
      url: `/api/characters/${importedBody.character.id}`,
    });
    assert.equal(JSON.parse(importedGet.body).play_guide, '');

    const leakChar = await app.inject({
      method: 'POST',
      url: '/api/characters',
      payload: {
        name: '누출검사용',
        description: '카드설명-본문',
        personality: '성격본문',
        speech_style: '말투본문',
        scenario: '시나리오본문',
        first_message: '첫메시지',
        example_dialogue: '예시대화',
        taboos: '금기본문',
        play_guide: MARK,
        tags: ['여성'],
      },
    });
    assert.equal(leakChar.statusCode, 201);
    const leakId = JSON.parse(leakChar.body).id as string;
    const tnow = nowIso();
    const personaId = uid();
    const convId = uid();
    const msgId = uid();
    const lorebook = one<{ id: string }>(db, 'SELECT id FROM lorebooks WHERE character_id = ?', leakId);
    assert.ok(lorebook);
    run(
      db,
      `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
      'rp-balanced', 0.8, 0.95, 400, '[]', 'system', 'c3',
    );
    setSetting(db, 'token_calibration', '1.0');
    setSetting(db, 'content_policy', 'RULE-PATH-C3-OK 성인 이용자 대상.');
    run(
      db,
      `INSERT INTO personas (id, name, is_default, appearance, personality, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
      personaId, '테스터', '외형본문', '페르소나성격', tnow, tnow,
    );
    run(
      db,
      `INSERT INTO conversations (
         id, character_id, persona_id, title, mode, profile_name, scene_json, prompt_version,
         created_at, updated_at, user_note, story_applied_at, story_name_snapshot, story_setting_snapshot
       ) VALUES (?, ?, ?, ?, 'chat', 'rp-balanced', ?, ?, ?, ?, ?, ?, ?, ?)`,
      convId,
      leakId,
      personaId,
      '누출방',
      JSON.stringify({ place: 'SCENE-PATH-C3-OK', time: '밤', mood: '차분' }),
      PROMPT_VERSION,
      tnow,
      tnow,
      'NOTE-PATH-C3-OK',
      tnow,
      '스토리이름',
      'STORY-PATH-C3-OK',
    );
    run(
      db,
      `INSERT INTO messages (id, conversation_id, role, content, status, created_at)
       VALUES (?, ?, 'user', ?, 'complete', ?)`,
      msgId, convId, '안녕', tnow,
    );
    run(
      db,
      `INSERT INTO memories (id, conversation_id, character_id, content, source, status, importance, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', 'pinned', 5, 'conversation', ?, ?)`,
      uid(), convId, leakId, 'MEM-PATH-C3-OK', tnow, tnow,
    );
    run(
      db,
      `INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, status, created_at, tier)
       VALUES (?, ?, ?, ?, 'approved', ?, 'whole')`,
      uid(), convId, 'SUM-PATH-C3-OK', msgId, tnow,
    );
    run(
      db,
      `INSERT INTO lore_entries (id, lorebook_id, title, content, always_on, enabled, priority)
       VALUES (?, ?, ?, ?, 1, 1, 10)`,
      uid(), lorebook.id, '로어', 'LORE-PATH-C3-OK',
    );

    const conv = one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', convId)!;
    const history = [
      one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', msgId)!,
    ];
    const built = buildPrompt(db, conv, history, 128000, 'dummy-model', 'rp-balanced', { diagnostics: true });
    const assembled = built.messages.map((m) => m.content).join('\n');
    const whole = `${assembled}\n${JSON.stringify(built)}`;

    assert.equal(whole.includes(MARK), false, '10+13 play_guide marker absent from full buildPrompt output');
    assert.equal((whole.match(new RegExp(MARK, 'g')) ?? []).length, 0);
    assert.ok(whole.includes('SCENE-PATH-C3-OK'), '13 scene path ran');
    assert.ok(whole.includes('MEM-PATH-C3-OK'), '13 memory path ran');
    assert.ok(whole.includes('SUM-PATH-C3-OK'), '13 summary path ran');
    assert.ok(whole.includes('LORE-PATH-C3-OK'), '13 lore path ran');
    assert.ok(whole.includes('NOTE-PATH-C3-OK'), '13 user_note path ran');
    assert.ok(whole.includes('STORY-PATH-C3-OK'), '13 story path ran');
    assert.ok(whole.includes('RULE-PATH-C3-OK'), '13 rules path ran');
    assert.equal(assembled.includes(MARK), false);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runDraftCompat(): void {
  const store: Record<string, string> = {};
  const kv: Kv = {
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };
  const old = {
    name: '구형드래프트',
    tagline: '',
    avatar: null,
    description: '',
    personality: '',
    speech_style: '',
    scenario: '',
    first_message: '',
    example_dialogue: '',
    taboos: '',
    tags: ['여성'],
  };
  assert.equal(isCharacterDraft(old), true, '17 legacy draft without play_guide is still valid');
  assert.equal('play_guide' in old, false);
  kv.setItem(characterDraftStorageKey(null), JSON.stringify(old));
  const read = readCharacterDraft(null, kv);
  assert.ok(read, '18 store read does not discard legacy draft');
  assert.equal(read!.name, '구형드래프트');
  assert.equal('play_guide' in (read as object), false);
  assert.equal(isCharacterDraft(read), true);
}

async function main() {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (e) {
      failed++;
      console.error(`not ok - ${name}`);
      console.error(e);
    }
  }
  try {
    await runHttpAndPrompt();
    console.log('ok - 4-9 route+db play_guide behaviour');
    console.log('ok - 10+13 buildPrompt isolation (marker 0 in full output)');
  } catch (e) {
    failed++;
    console.error('not ok - 4-9 / 10+13 http+prompt');
    console.error(e);
  }
  try {
    runDraftCompat();
    console.log('ok - 17-18 legacy draft store read');
  } catch (e) {
    failed++;
    console.error('not ok - 17-18 legacy draft');
    console.error(e);
  }
  if (failed) {
    console.error(`FAIL ${failed}`);
    process.exit(1);
  }
  console.log('PASS characterPlayGuide');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
