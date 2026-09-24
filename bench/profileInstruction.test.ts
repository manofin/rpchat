/** npx tsx bench/profileInstruction.test.ts
 * profile-instruction (0023) — 1:1 path + PromptPolicy + profile API.
 *
 *   schema      → 0023 columns; schema-compat lists every migration file
 *   policy      → resolvePromptPolicy matrix (user's PromptPolicy, row field names)
 *   G-A bytes   → instruction off ⇒ buildPrompt / renderRules sha256 == HEAD 7b189b3 pins
 *                 (① no columns ② enabled=0+text ③ enabled=1+blank text)
 *   G-B on      → `### 서술 지침` right after rules, before card; prose-order sentence and
 *                 LENGTH_HINT gone; anti-repeat, minors, content policy kept; {{user}} substituted
 *   G-C budget  → own section; fixed/lore/memory budgets unchanged; recent shrinks by est exactly
 *   G-D OOC     → engine-on profile still yields the HEAD OOC prompt
 *   G-O overflow→ instruction that leaves no room for the current turn is reported
 *                 (budget.instruction_overflow); off / fitting instruction → key absent.
 *                 Threshold is the hard limit context − max_tokens, not `available` (P0)
 *   G-L long    → 300-message histories × 40 seeds with a LITE-size synthetic instruction:
 *                 0 refusals, every prompt ≤ context − max_tokens; a huge one is still refused
 *   API         → PUT create/update; absent fields keep stored instruction; bounds
 *
 * Pins: sha256(JSON of [{role,content}] with no spaces) — the CLAUDE.md assembly recipe.
 * Isolated: in-memory / temp DB, no systemd, no live DB, no model call.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { migrateSummaryRelationFixture } from './helpers/summaryRelationFixture.ts';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { DEFAULT_CONTENT_POLICY } from '../apps/server/src/db/seed.ts';
import { PROFILE_INSTRUCTION_WARN_SHARE, buildPrompt } from '../apps/server/src/prompt/builder.ts';
import { DEFAULT_PROMPT_POLICY, profileInstructionText, resolvePromptPolicy } from '../apps/server/src/prompt/promptPolicy.ts';
import { PROFILE_INSTRUCTION_ADAPTER, renderPartyRules, renderRules } from '../apps/server/src/prompt/templates.ts';
import { estimateMessageTokens, estimateTokens } from '../apps/server/src/prompt/tokens.ts';
import { settingsRoutes } from '../apps/server/src/routes/settings.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const roleContent = (msgs: Array<{ role: string; content: string }>) => msgs.map((m) => ({ role: m.role, content: m.content }));

// HEAD 7b189b3 pins (planning_documents/profile-instruction/pi-baseline.ts, same fixture as seed() below).
const PIN = {
  'plain-system': '45cde4ce7a715d2d6e8afd1e732056bc139f5595f4a509fb0cba3a81ffedc46a',
  'plain-merge': '3bfd4213ced66a0a6804894e81cbe08f31e6480752bd908c83d85fec27a5793e',
  ooc: '646afb14a55c1c7759cb79a17fba456a549dc3a036003fe80bc6a91ca134ceaa',
  'greeting-empty': '18225a8252eeba98f1778d5141ad5c11942e31fc7780fc307d70657a39f0253b',
  'renderRules-default': '0b813ee61c7367c056b8ea612ed5491da1f598a6257c793141932e4e59e5e24e',
  'renderRules-empty': '0c91c98bf134c4dc9675cb3df5cda55db95187839e08cd71e496a79185edde3d',
  'renderPartyRules-default': '9240aa23f15faafb696f22b9368229bd6fd69547ee36eb390913a2258459bdc2',
} as const;

const PROSE_ORDER_SENTENCE = '긴 서술은 감각 단서 → 관찰 가능한 변화 → NPC 반응 순으로 쓴다.';
const LENGTH_HINT_TEXT = '응답 길이는 4~10문장';
const MINORS_RULE = '미성년자로 설정된 인물은 어떤 경우에도 연애·성적 맥락에 두지 않는다.';
const ANTI_REPEAT = '직전 응답의 문장·표현·전개를 반복하지 않는다.';

// Synthetic instruction — never the private engine text (that stays out of the repo).
const ENGINE = '# 합성 서술 엔진\n## CORE\n- {{user}} 대필 금지. 입력=시도.\n## LOG\n<details><summary>Log</summary>\n[Mode]\n</details>\n';

function seed(withColumns: boolean): any {
  const db: any = new Database(':memory:');
  db.exec(`
    CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT, tagline TEXT, description TEXT, personality TEXT, speech_style TEXT, scenario TEXT, taboos TEXT, example_dialogue TEXT);
    CREATE TABLE personas (id TEXT PRIMARY KEY, name TEXT, address_as TEXT, appearance TEXT, personality TEXT, relationship TEXT, is_default INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE model_profiles (name TEXT PRIMARY KEY, model TEXT, temperature REAL, top_p REAL, max_tokens INTEGER, stop_json TEXT, system_mode TEXT, notes TEXT);
    INSERT INTO characters VALUES ('c1','테스트캐','짧은소개','설명','성격','말투','시나리오','금기','예시');
    INSERT INTO model_profiles VALUES ('rp-balanced',NULL,0.8,0.95,800,'[]','system',NULL);
    INSERT INTO model_profiles VALUES ('rp-merge',NULL,0.8,0.95,800,'[]','merge',NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, character_id TEXT, persona_id TEXT, mode TEXT, profile_name TEXT, scene_json TEXT, user_note TEXT);
    INSERT INTO conversations VALUES ('conv1','c1','p1','chat','rp-balanced','{"place":"창고"}','노트: {{char}}는 창고에 있다.');
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, status TEXT, created_at TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY, conversation_id TEXT, character_id TEXT, content TEXT, source TEXT, status TEXT, importance INTEGER, scope TEXT, evidence_message_ids_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE summaries (id TEXT PRIMARY KEY, conversation_id TEXT, content TEXT, covers_until_message_id TEXT, covers_from_message_id TEXT, status TEXT, created_at TEXT, tier TEXT, rolled_up_into TEXT);
    CREATE TABLE lorebooks (id TEXT PRIMARY KEY, character_id TEXT, story_id TEXT);
    CREATE TABLE lore_entries (id TEXT PRIMARY KEY, lorebook_id TEXT, title TEXT, content TEXT, keywords_json TEXT, secondary_keys_json TEXT, selective INTEGER, always_on INTEGER, priority INTEGER, token_cap INTEGER, enabled INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('token_calibration','1.173');
    INSERT INTO settings VALUES ('content_policy','${DEFAULT_CONTENT_POLICY}');
  `);
  if (withColumns) {
    db.exec(`
      ALTER TABLE model_profiles ADD COLUMN instruction_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE model_profiles ADD COLUMN instruction_text TEXT;
    `);
  }
  migrateSummaryRelationFixture(db);
  db.prepare(`INSERT INTO personas VALUES (?,?,?,?,?,?,?,?,?)`).run('p1', '유저', '호칭1', '외형1', '페르소나성격', '관계1', 1, '0001', '0001');
  const ins = db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?)`);
  ins.run('m01', 'conv1', 'user', '*문을 연다* "안녕."', 'done', '0001');
  ins.run('m02', 'conv1', 'assistant', '창고 안쪽에서 먼지가 일었다. "누구야."', 'done', '0002');
  ins.run('m03', 'conv1', 'user', '"나야. 열쇠 가져왔어."', 'done', '0003');
  ins.run('m04', 'conv1', 'user', '(OOC) 지금 몇 시야?', 'done', '0004');
  return db;
}

function cases(db: any) {
  const conv = db.prepare(`SELECT * FROM conversations WHERE id='conv1'`).get();
  const all = db.prepare(`SELECT * FROM messages WHERE conversation_id='conv1' ORDER BY created_at`).all();
  return {
    'plain-system': buildPrompt(db, conv, all.slice(0, 3), 16384, 'm'),
    'plain-merge': buildPrompt(db, conv, all.slice(0, 3), 16384, 'm', 'rp-merge'),
    ooc: buildPrompt(db, conv, all, 16384, 'm'),
    'greeting-empty': buildPrompt(db, conv, [], 16384, 'm'),
  };
}

function assertPinned(db: any, label: string) {
  for (const [k, b] of Object.entries(cases(db))) {
    assert.equal(sha(roleContent(b.messages)), PIN[k as keyof typeof PIN], `${label}: ${k} moved`);
  }
}

function setInstruction(db: any, name: string, enabled: number, text: string | null) {
  db.prepare('UPDATE model_profiles SET instruction_enabled = ?, instruction_text = ? WHERE name = ?').run(enabled, text, name);
}

async function main() {
  await t('0023 adds instruction_enabled (NOT NULL DEFAULT 0), instruction_text, characters.default_profile_name', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-pi-schema-'));
    const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
    const mp = db.prepare('PRAGMA table_info(model_profiles)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    const en = mp.find((c) => c.name === 'instruction_enabled');
    assert.ok(en && en.notnull === 1 && en.dflt_value === '0');
    const tx = mp.find((c) => c.name === 'instruction_text');
    assert.ok(tx && tx.notnull === 0);
    const ch = (db.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string; notnull: number }>).find((c) => c.name === 'default_profile_name');
    assert.ok(ch && ch.notnull === 0);
    db.prepare("INSERT INTO model_profiles (name) VALUES ('rp-x')").run();
    const row = db.prepare("SELECT instruction_enabled, instruction_text FROM model_profiles WHERE name='rp-x'").get() as { instruction_enabled: number; instruction_text: string | null };
    assert.deepEqual(row, { instruction_enabled: 0, instruction_text: null });
    db.close();
  });

  await t('schema-compat required_migrations == migrations dir (0023 listed)', () => {
    const spec = JSON.parse(fs.readFileSync('deploy/schema-compat.json', 'utf8')) as { required_migrations: string[] };
    const files = fs.readdirSync('apps/server/migrations').filter((f) => f.endsWith('.sql')).sort();
    assert.deepEqual(spec.required_migrations, files);
    assert.ok(files.includes('0023_profile_instruction.sql'));
  });

  await t('resolvePromptPolicy: only enabled=1 with non-blank text turns the engine on', () => {
    const off = { enforceProseOrder: true, includeLengthHint: true, includeEngineInstruction: false };
    const on = { enforceProseOrder: false, includeLengthHint: false, includeEngineInstruction: true };
    assert.deepEqual({ ...DEFAULT_PROMPT_POLICY }, off);
    assert.deepEqual(resolvePromptPolicy({}), off);
    assert.deepEqual(resolvePromptPolicy({ instruction_enabled: 0, instruction_text: ENGINE }), off);
    assert.deepEqual(resolvePromptPolicy({ instruction_enabled: 1, instruction_text: null }), off);
    assert.deepEqual(resolvePromptPolicy({ instruction_enabled: 1, instruction_text: ' \n\t ' }), off);
    assert.deepEqual(resolvePromptPolicy({ instruction_enabled: 1, instruction_text: ENGINE }), on);
    assert.equal(profileInstructionText({ instruction_enabled: 1, instruction_text: ENGINE }), ENGINE);
    assert.equal(profileInstructionText({ instruction_enabled: 0, instruction_text: ENGINE }), null);
  });

  await t('G-A renderRules / renderPartyRules default output == HEAD pins', () => {
    assert.equal(sha(renderRules(DEFAULT_CONTENT_POLICY, '서리', '황지명')), PIN['renderRules-default']);
    assert.equal(sha(renderRules('', '{{char}}', '{{user}}')), PIN['renderRules-empty']);
    assert.equal(sha(renderRules(DEFAULT_CONTENT_POLICY, '서리', '황지명', 'scene_change', { enforceProseOrder: true, includeLengthHint: true })), PIN['renderRules-default']);
    assert.equal(sha(renderPartyRules(DEFAULT_CONTENT_POLICY, '서리', '황지명')), PIN['renderPartyRules-default']);
  });

  await t('G-A ① fixture without 0023 columns → buildPrompt == HEAD pins', () => {
    assertPinned(seed(false), 'no-columns');
  });

  await t('G-A ② columns present, enabled=0 with text → HEAD pins', () => {
    const db = seed(true);
    setInstruction(db, 'rp-balanced', 0, ENGINE);
    setInstruction(db, 'rp-merge', 0, ENGINE);
    assertPinned(db, 'enabled=0');
  });

  await t('G-A ③ enabled=1 with blank text → HEAD pins', () => {
    const db = seed(true);
    setInstruction(db, 'rp-balanced', 1, '  \n ');
    setInstruction(db, 'rp-merge', 1, '');
    assertPinned(db, 'blank');
  });

  await t('renderRules policy: rule 4 loses only the prose-order sentence; LENGTH_HINT dropped; numbering contiguous', () => {
    const def = renderRules(DEFAULT_CONTENT_POLICY, '서리', '황지명');
    const eng = renderRules(DEFAULT_CONTENT_POLICY, '서리', '황지명', 'scene_change', { enforceProseOrder: false, includeLengthHint: false });
    const line4 = (s: string) => s.split('\n').find((l) => l.startsWith('4. '))!;
    assert.equal(line4(def), `${line4(eng)} ${PROSE_ORDER_SENTENCE}`);
    assert.ok(def.includes(LENGTH_HINT_TEXT) && !eng.includes(LENGTH_HINT_TEXT));
    assert.ok(!eng.includes(PROSE_ORDER_SENTENCE));
    assert.ok(eng.includes(ANTI_REPEAT) && eng.includes(MINORS_RULE) && eng.includes(DEFAULT_CONTENT_POLICY));
    const nums = eng.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => Number(l.split('.')[0]));
    assert.deepEqual(nums, Array.from({ length: nums.length }, (_, i) => i + 1));
    assert.equal(nums.length, def.split('\n').filter((l) => /^\d+\. /.test(l)).length - 1);
  });

  await t('G-B engine on: block sits between rules and card; conflicting rules removed; safety kept', () => {
    const db = seed(true);
    setInstruction(db, 'rp-balanced', 1, ENGINE);
    const b = cases(db)['plain-system'];
    const sys = b.messages[0];
    assert.equal(sys.role, 'system');
    const text = sys.content;
    const iRules = text.indexOf('규칙:\n1. ');
    const iEngine = text.indexOf('### 서술 지침\n# 합성 서술 엔진');
    const iCard = text.indexOf('### 캐릭터: 테스트캐');
    assert.ok(iRules >= 0 && iEngine > iRules && iCard > iEngine, `order rules<engine<card: ${iRules},${iEngine},${iCard}`);
    assert.equal(text.split('### 서술 지침').length - 1, 1, 'engine block exactly once');
    assert.ok(text.includes('- 유저 대필 금지. 입력=시도.'), '{{user}} substituted with persona name');
    assert.ok(!text.includes('{{user}}'));
    assert.ok(text.includes(PROFILE_INSTRUCTION_ADAPTER.replaceAll('{{user}}', '유저')));
    assert.ok(!text.includes(PROSE_ORDER_SENTENCE));
    assert.ok(!text.includes(LENGTH_HINT_TEXT));
    assert.ok(text.includes(ANTI_REPEAT) && text.includes(MINORS_RULE) && text.includes(DEFAULT_CONTENT_POLICY));
    // everything after the engine block is the pre-0023 tail
    const off = cases(seed(false))['plain-system'].messages[0].content;
    assert.equal(text.slice(iCard), off.slice(off.indexOf('### 캐릭터: 테스트캐')));
    assert.deepEqual(roleContent(b.messages.slice(1)), roleContent(cases(seed(false))['plain-system'].messages.slice(1)));
  });

  await t('G-B merge mode: engine carried once inside the first user turn', () => {
    const db = seed(true);
    setInstruction(db, 'rp-merge', 1, ENGINE);
    const b = cases(db)['plain-merge'];
    assert.equal(b.messages[0].role, 'user');
    assert.equal(b.messages[0].content.split('### 서술 지침').length - 1, 1);
    assert.ok(!b.messages.some((m) => m.role === 'system'));
  });

  await t('G-C budget: own section; fixed/lore/memory unchanged; recent budget shrinks by exactly est', () => {
    const offDb = seed(true);
    const onDb = seed(true);
    setInstruction(onDb, 'rp-balanced', 1, ENGINE);
    const off = cases(offDb)['plain-system'].budget;
    const on = cases(onDb)['plain-system'].budget;
    const sec = on.sections.find((s) => s.name === '서술 지침');
    assert.ok(sec && sec.kind === 'system');
    assert.ok(!off.sections.some((s) => s.name === '서술 지침'));
    const onSys = cases(onDb)['plain-system'].messages[0].content;
    const block = onSys.slice(onSys.indexOf('### 서술 지침'), onSys.indexOf('\n\n### 캐릭터:'));
    assert.equal(sec!.est_tokens, estimateTokens(block, 1.173));
    assert.equal(sec!.budget, sec!.est_tokens);
    assert.ok(sec!.note!.startsWith('프로필 rp-balanced · sha256 '));
    assert.ok(sec!.note!.includes(createHash('sha256').update(ENGINE).digest('hex').slice(0, 8)));
    assert.ok(!sec!.note!.includes('LITE 권장'));
    for (const name of ['활성 로어', '고정 기억+요약']) {
      assert.equal(on.sections.find((s) => s.name === name)!.budget, off.sections.find((s) => s.name === name)!.budget, name);
    }
    const fixedOn = on.sections.find((s) => s.name === '시스템 규칙+카드+페르소나+장면')!;
    const fixedOff = off.sections.find((s) => s.name === '시스템 규칙+카드+페르소나+장면')!;
    assert.equal(fixedOn.budget, fixedOff.budget);
    assert.ok(fixedOn.est_tokens < fixedOff.est_tokens, 'engine-mode rules are shorter');
    const recentOn = on.sections.find((s) => s.name === '최근 대화')!;
    const recentOff = off.sections.find((s) => s.name === '최근 대화')!;
    const choices = on.sections.find((s) => s.name === '선택지 출력 계약')!;
    assert.ok(choices.est_tokens > 0);
    assert.equal(recentOff.budget - recentOn.budget, sec!.est_tokens + choices.est_tokens + (fixedOn.est_tokens - fixedOff.est_tokens));
  });

  await t('G-C near the limit: every accepted prompt fits the hard limit; every refusal exceeds it', () => {
    const HARD = 16384 - 800;
    for (const name of ['rp-balanced', 'rp-merge']) {
      const db = seed(true);
      let accepted = 0;
      let refused = 0;
      for (let length = 14000; length <= 20000; length += 100) {
        setInstruction(db, name, 1, '가'.repeat(length));
        const built = name === 'rp-merge' ? cases(db)['plain-merge'] : cases(db)['plain-system'];
        const actual = built.messages.reduce((sum, message) => sum + estimateMessageTokens(message.content, 1.173), 0);
        if (built.budget.instruction_overflow) {
          refused++;
          assert.equal(built.budget.instruction_overflow.available, HARD);
          assert.ok(built.budget.instruction_overflow.required > HARD, `${name} length=${length}: refused within the limit`);
        } else {
          accepted++;
          assert.ok(actual <= HARD, `${name} length=${length}: ${actual} > ${HARD}`);
        }
      }
      assert.ok(accepted > 0 && refused > 0, `${name}: must cover both sides of the boundary`);
      db.close();
    }
  });

  await t('G-C oversized instruction → included whole, with an explicit budget warning', () => {
    const db = seed(true);
    const big = `${ENGINE}\n${'인과만 고정한다. '.repeat(900)}`;
    setInstruction(db, 'rp-balanced', 1, big);
    const b = cases(db)['plain-system'];
    const sec = b.budget.sections.find((s) => s.name === '서술 지침')!;
    assert.ok(sec.est_tokens > Math.floor(b.budget.available * PROFILE_INSTRUCTION_WARN_SHARE));
    assert.match(sec.note!, /예산의 \d+% — LITE 권장/);
    assert.ok(b.messages[0].content.includes(big.trim().replaceAll('{{user}}', '유저')), 'never truncated');
    assert.equal(Object.hasOwn(b.budget, 'instruction_overflow'), false, 'big but fitting → no overflow');
  });

  await t('G-O no instruction / fitting instruction → budget has no instruction_overflow key', () => {
    for (const b of Object.values(cases(seed(false)))) assert.equal(Object.hasOwn(b.budget, 'instruction_overflow'), false);
    const db = seed(true);
    setInstruction(db, 'rp-balanced', 1, ENGINE);
    for (const b of Object.values(cases(db))) assert.equal(Object.hasOwn(b.budget, 'instruction_overflow'), false);
  });

  await t('G-O 20000-char instruction at 16384 context → overflow reported, prompt still assembled (report only)', () => {
    const db = seed(true);
    const huge = '가'.repeat(20000);
    setInstruction(db, 'rp-balanced', 1, huge);
    const b = cases(db)['plain-system'];
    const o = b.budget.instruction_overflow!;
    assert.ok(o, 'overflow reported');
    assert.equal(o.profile, 'rp-balanced');
    assert.equal(o.available, 16384 - 800, 'hard limit, not the packing budget');
    assert.ok(o.required > o.available);
    const sec = b.budget.sections.find((x) => x.name === '서술 지침')!;
    assert.equal(o.instruction_tokens, sec.est_tokens);
    assert.match(sec.note!, /컨텍스트 초과 — 생성 거부/);
    // OOC turns never carry the instruction, so they never overflow on its account.
    assert.equal(Object.hasOwn(cases(db).ooc.budget, 'instruction_overflow'), false);
  });

  await t('G-D OOC turn ignores the engine: prompt == HEAD OOC pin', () => {
    const db = seed(true);
    setInstruction(db, 'rp-balanced', 1, ENGINE);
    const b = cases(db).ooc;
    assert.equal(sha(roleContent(b.messages)), PIN.ooc);
    assert.ok(!b.budget.sections.some((s) => s.name === '서술 지침'));
  });

  await t('G-L P0: long histories with a LITE-size instruction are never refused; a huge one still is', () => {
    const syntheticBudgetBlock =
      '합성 예산 검증 문장. 가상 항목의 출력 순서를 유지한다. SYNTHETIC-001.';
    const LITE_SIZE = `${syntheticBudgetBlock}\n`.repeat(21);
    const HARD = 16384 - 800;
    let refused = 0;
    let checked = 0;
    let packedTight = 0;
    for (let seed = 0; seed < 40; seed++) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-pi-long-'));
      const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
      db.prepare("INSERT INTO settings (key, value) VALUES ('token_calibration', '1.173')").run();
      db.prepare("INSERT INTO model_profiles (name, max_tokens, instruction_enabled, instruction_text) VALUES ('rp-lite', 800, 1, ?)").run(LITE_SIZE);
      db.prepare("INSERT INTO model_profiles (name, max_tokens, instruction_enabled, instruction_text) VALUES ('rp-huge', 800, 1, ?)").run('가'.repeat(20000));
      db.prepare("INSERT INTO characters (id, name, created_at, updated_at) VALUES ('c', '서', 't', 't')").run();
      db.prepare("INSERT INTO conversations (id, character_id, profile_name, prompt_version, created_at, updated_at) VALUES ('v', 'c', 'rp-lite', 'p', 't', 't')").run();
      const ins = db.prepare("INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, created_at) VALUES (?, 'v', ?, ?, ?, 'complete', '{}', ?)");
      let parent: string | null = null;
      let rnd = seed * 7919 + 1;
      const r = () => (rnd = (rnd * 48271) % 2147483647) / 2147483647;
      for (let i = 0; i < 300; i++) {
        const role = i % 2 ? 'assistant' : 'user';
        ins.run(`m${i}`, parent, role, (role === 'user' ? '"대사" ' : '서술 ').repeat(5 + Math.floor(r() * 120)), String(i).padStart(5, '0'));
        parent = `m${i}`;
      }
      const conv = db.prepare("SELECT * FROM conversations WHERE id = 'v'").get() as any;
      const history = db.prepare("SELECT * FROM messages WHERE conversation_id = 'v' ORDER BY created_at").all() as any[];
      const b = buildPrompt(db as any, conv, history, 16384, 'm');
      const actual = b.messages.reduce((sum, m) => sum + estimateMessageTokens(m.content, 1.173), 0);
      checked++;
      if (b.budget.instruction_overflow) refused++;
      assert.ok(actual <= HARD, `seed ${seed}: ${actual} > ${HARD}`);
      if (actual > b.budget.available) packedTight++;
      if (seed % 10 === 0) assert.ok(buildPrompt(db as any, conv, history, 16384, 'm', 'rp-huge').budget.instruction_overflow, `seed ${seed}: huge must be refused`);
      db.close();
    }
    assert.equal(refused, 0, `${refused}/${checked} ordinary long-history turns refused`);
    // Proves the case the old `available` threshold refused is actually exercised here.
    assert.ok(packedTight > 0, 'fixture must pack past `available` (the P0 regime)');
  });

  // ── API ────────────────────────────────────────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-pi-api-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  const app = Fastify({ logger: false });
  await app.register(settingsRoutes({ db } as unknown as Ctx));
  await app.ready();
  const put = (name: string, body: unknown) => app.inject({ method: 'PUT', url: `/api/profiles/${name}`, payload: body as object });
  const base = { temperature: 0.8, top_p: 0.95, max_tokens: 800, stop: [], system_mode: 'system', notes: '합성' };
  const stored = (name: string) => db.prepare('SELECT instruction_enabled, instruction_text FROM model_profiles WHERE name = ?').get(name);

  await t('API: PUT creates a profile with instruction; GET returns the fields', async () => {
    const r = await put('rp-engine-test', { ...base, instruction_enabled: true, instruction_text: ENGINE });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(stored('rp-engine-test'), { instruction_enabled: 1, instruction_text: ENGINE });
    const list = (await app.inject({ method: 'GET', url: '/api/profiles' })).json() as Array<{ name: string; instruction_enabled: number; instruction_text: string }>;
    const p = list.find((x) => x.name === 'rp-engine-test')!;
    assert.equal(p.instruction_enabled, 1);
    assert.equal(p.instruction_text, ENGINE);
  });

  await t('API: PUT without instruction fields (pre-0023 client) keeps the stored instruction', async () => {
    const r = await put('rp-engine-test', { ...base, temperature: 0.7 });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(stored('rp-engine-test'), { instruction_enabled: 1, instruction_text: ENGINE });
    assert.equal((db.prepare("SELECT temperature FROM model_profiles WHERE name='rp-engine-test'").get() as { temperature: number }).temperature, 0.7);
  });

  await t('API: disabling keeps text; 0/1 and booleans both accepted; explicit null clears text', async () => {
    assert.equal((await put('rp-engine-test', { ...base, instruction_enabled: 0 })).statusCode, 200);
    assert.deepEqual(stored('rp-engine-test'), { instruction_enabled: 0, instruction_text: ENGINE });
    assert.equal((await put('rp-engine-test', { ...base, instruction_enabled: 1 })).statusCode, 200);
    assert.deepEqual(stored('rp-engine-test'), { instruction_enabled: 1, instruction_text: ENGINE });
    assert.equal((await put('rp-engine-test', { ...base, instruction_enabled: false, instruction_text: null })).statusCode, 200);
    assert.deepEqual(stored('rp-engine-test'), { instruction_enabled: 0, instruction_text: null });
  });

  await t('API: bounds — >20000 chars and non 0/1 enabled rejected; create without fields defaults off', async () => {
    assert.equal((await put('rp-engine-test', { ...base, instruction_text: 'x'.repeat(20001) })).statusCode, 400);
    assert.equal((await put('rp-engine-test', { ...base, instruction_enabled: 2 })).statusCode, 400);
    assert.equal((await put('rp-plain-test', base)).statusCode, 200);
    assert.deepEqual(stored('rp-plain-test'), { instruction_enabled: 0, instruction_text: null });
  });

  await app.close();
  db.close();
  console.log(`PASS=${passed}`);
}

main().catch((e) => {
  console.error('RED', e);
  process.exit(1);
});
