/** npx tsx bench/injectMacro1to1.test.ts
 * inject-macro-1to1 — attach InjectContext to 1:1 buildPrompt (ADR §6.2).
 * Temp/memory DB + light Fastify. LIVE_NO_TOUCH. Party path still unconsumed.
 *
 *   non-OOC + inject → system has instruction AND STORY_CHOICES
 *   isOoc + inject   → inject absent; OOC_INSTRUCTION present
 *   omit inject      → baseline choices; no 주입 지침 section
 *   budget           → inject in used/sections; long inject keeps full instruction; recent drops more
 *   no persist       → user content ≠ instruction (API)
 *   party            → source + GenParams: inject never in party prompts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { DB } from '../apps/server/src/db/index.js';
import { openDb } from '../apps/server/src/db/index.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { buildPrompt } from '../apps/server/src/prompt/builder.js';
import {
  OOC_INSTRUCTION,
  STORY_CHOICES_INSTRUCTION,
  substitute,
} from '../apps/server/src/prompt/templates.js';
import { PROMPT_VERSION } from '../apps/server/src/config.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { ConversationRow, MessageRow } from '../apps/server/src/types.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function parseSse(raw: string): Array<{ type: string; [k: string]: unknown }> {
  const out: Array<{ type: string; [k: string]: unknown }> = [];
  for (const block of raw.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try {
      out.push(JSON.parse(line.slice(6)));
    } catch {
      /* keepalive */
    }
  }
  return out;
}

function flattenGenMessages(captured: GenParams[]): string {
  return captured
    .flatMap((p) => p.messages.map((m) => `${m.role}\n${m.content}`))
    .join('\n---\n');
}

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
      story_id TEXT, story_applied_at TEXT, story_name_snapshot TEXT, story_setting_snapshot TEXT, story_minor_cast_snapshot TEXT,
      story_participant_ids_snapshot TEXT, story_opening_snapshot TEXT, story_endings_snapshot TEXT, ended_at TEXT, reached_ending_id TEXT
    );
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, status TEXT, created_at TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY, conversation_id TEXT, character_id TEXT, content TEXT, source TEXT, status TEXT, importance INTEGER, scope TEXT, evidence_message_ids_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE summaries (id TEXT PRIMARY KEY, conversation_id TEXT, content TEXT, covers_until_message_id TEXT, covers_from_message_id TEXT, status TEXT, created_at TEXT, tier TEXT, rolled_up_into TEXT, rel_character_id TEXT, rel_persona_id TEXT);
    CREATE TABLE lorebooks (id TEXT PRIMARY KEY, character_id TEXT, story_id TEXT);
    CREATE TABLE lore_entries (id TEXT PRIMARY KEY, lorebook_id TEXT, title TEXT, content TEXT, keywords_json TEXT, secondary_keys_json TEXT, selective INTEGER, always_on INTEGER, priority INTEGER, token_cap INTEGER, enabled INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('token_calibration','1.0');
  `);
  db.prepare(`INSERT INTO personas VALUES (?,?,?,?,?,?,?,?,?)`).run(
    'p1',
    '유저',
    '호칭1',
    '외형1',
    '페르소나성격',
    '관계1',
    1,
    '0001',
    '0001',
  );
  return db;
}

function convBase(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: 'conv1',
    character_id: 'c1',
    persona_id: 'p1',
    title: '',
    mode: 'chat',
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
    story_id: null,
    story_applied_at: null,
    story_name_snapshot: null,
    story_setting_snapshot: null,
    story_minor_cast_snapshot: null,
    story_participant_ids_snapshot: null,
    story_opening_snapshot: null,
    story_endings_snapshot: null,
    ended_at: null,
    reached_ending_id: null,
    ...over,
  } as ConversationRow;
}

function msg(id: string, role: 'user' | 'assistant', content: string, created_at: string): MessageRow {
  return {
    id,
    conversation_id: 'conv1',
    parent_id: null,
    role,
    content,
    status: 'complete',
    created_at,
    metadata_json: null,
  } as MessageRow;
}

function systemText(b: ReturnType<typeof buildPrompt>): string {
  return String(b.messages.find((m) => m.role === 'system')?.content ?? '');
}

const CHOICES_MARKER = '<choices>';
const INJECT_MARKER = 'INJECT_1TO1_MARKER_KEEP_INTACT_XYZ';
const INJECT_FULL = `${INJECT_MARKER}: never speak for the user; keep tension high.`;

async function main() {
  const db = seed();
  const conv = convBase();
  const choicesExpected = substitute(STORY_CHOICES_INSTRUCTION, '테스트캐', '유저');

  await t('non-OOC + inject → system has instruction AND STORY_CHOICES (choices then inject)', () => {
    const hist = [msg('m1', 'user', '안녕', '0001')];
    const b = buildPrompt(db, conv, hist, 8192, 'test-model', undefined, {
      inject: { instruction: INJECT_FULL },
    });
    const text = systemText(b);
    assert.equal(b.isOoc, false);
    assert.ok(text.includes(INJECT_FULL), 'instruction must be fully present');
    assert.ok(text.includes(CHOICES_MARKER), 'choices tag must be present');
    assert.ok(text.includes(choicesExpected.slice(0, 40)), 'choices instruction body present');
    const choicesIdx = text.indexOf(CHOICES_MARKER);
    const injectIdx = text.indexOf(INJECT_MARKER);
    assert.ok(choicesIdx >= 0 && injectIdx > choicesIdx, `order: choices then inject (${choicesIdx},${injectIdx})`);
    const sec = b.budget.sections.find((s) => s.name === '주입 지침');
    assert.ok(sec, 'budget section 주입 지침');
    assert.ok((sec!.est_tokens as number) > 0);
    assert.equal(sec!.kind, 'system');
  });

  await t('isOoc + inject → inject absent; OOC_INSTRUCTION present; isOoc not set by inject', () => {
    const hist = [msg('m1', 'user', '(OOC) 설정 확인', '0001')];
    const b = buildPrompt(db, conv, hist, 8192, 'test-model', undefined, {
      inject: { instruction: INJECT_FULL },
    });
    const text = systemText(b);
    assert.equal(b.isOoc, true);
    assert.ok(!text.includes(INJECT_MARKER), 'inject must not appear on OOC');
    assert.ok(!text.includes(INJECT_FULL));
    assert.ok(text.includes(OOC_INSTRUCTION), 'OOC_INSTRUCTION required');
    assert.ok(!text.includes(CHOICES_MARKER), 'choices skipped on OOC');
    assert.equal(
      b.budget.sections.some((s) => s.name === '주입 지침'),
      false,
    );
  });

  await t('omit inject → baseline choices; no inject section / marker', () => {
    const hist = [msg('m1', 'user', '그냥 인사', '0001')];
    const b = buildPrompt(db, conv, hist, 8192, 'test-model');
    const text = systemText(b);
    assert.equal(b.isOoc, false);
    assert.ok(text.includes(CHOICES_MARKER));
    assert.ok(!text.includes(INJECT_MARKER));
    assert.equal(
      b.budget.sections.some((s) => s.name === '주입 지침'),
      false,
    );
  });

  await t('null instruction inject → same as omit (no section)', () => {
    const hist = [msg('m1', 'user', 'null inject', '0001')];
    const b = buildPrompt(db, conv, hist, 8192, 'test-model', undefined, {
      inject: { instruction: null },
    });
    assert.equal(
      b.budget.sections.some((s) => s.name === '주입 지침'),
      false,
    );
    assert.ok(!systemText(b).includes(INJECT_MARKER));
  });

  await t('budget: inject reflected; long inject+history keeps full instruction; more recent drops', () => {
    // Tight context + long history → inject pressure shrinks recent.
    const pad = 'KEEP_THIS_WHOLE_INSTRUCTION_UNTRUNCATED ';
    let longInject = INJECT_MARKER + ': ' + pad.repeat(12);
    if (longInject.length > 800) longInject = longInject.slice(0, 800);
    assert.ok(longInject.length <= 800, `inject length ${longInject.length}`);
    assert.ok(longInject.includes(INJECT_MARKER));

    const hist: MessageRow[] = [];
    for (let i = 0; i < 40; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      hist.push(
        msg(
          `h${i}`,
          role,
          `긴 대화 턴 ${i}: ` + '대화내용패딩ABCDEFGHIJKLMNOP '.repeat(8),
          String(1000 + i).padStart(4, '0'),
        ),
      );
    }
    // last must be user for a normal turn
    hist.push(msg('h_last', 'user', '지금 말해줘', '9999'));

    const ctxTokens = 1800;
    const without = buildPrompt(db, conv, hist, ctxTokens, 'test-model');
    const withInj = buildPrompt(db, conv, hist, ctxTokens, 'test-model', undefined, {
      inject: { instruction: longInject },
    });

    const text = systemText(withInj);
    assert.ok(text.includes(longInject), 'instruction must not be cut');
    assert.ok(text.includes(INJECT_MARKER));

    const injSec = withInj.budget.sections.find((s) => s.name === '주입 지침');
    assert.ok(injSec && injSec.est_tokens > 0);

    const recentWithout = without.budget.sections.find((s) => s.kind === 'recent')!;
    const recentWith = withInj.budget.sections.find((s) => s.kind === 'recent')!;
    assert.ok(
      recentWith.budget < recentWithout.budget,
      `recent budget should shrink under inject (${recentWith.budget} vs ${recentWithout.budget})`,
    );
    assert.ok(
      withInj.budget.dropped_messages > without.budget.dropped_messages ||
        withInj.budget.included_messages < without.budget.included_messages,
      `expect more drops or fewer included: dropped ${without.budget.dropped_messages}->${withInj.budget.dropped_messages}, included ${without.budget.included_messages}->${withInj.budget.included_messages}`,
    );
  });

  // --- source-level party-unconsumed ---
  await t('party early-return does not pass inject into generateBeat/Dialog/Hunter', () => {
    const chatSrc = fs.readFileSync('apps/server/src/routes/chat.ts', 'utf8');
    // Locate the partyCast early-return block and the 1:1 buildPrompt call.
    const partyBlockMatch = chatSrc.match(
      /if \(partyCast && partyCast\.length\) \{[\s\S]*?return generateBeat\([^;]+;/,
    );
    assert.ok(partyBlockMatch, 'party early-return block missing');
    const partyBlock = partyBlockMatch![0];
    assert.ok(!/\binject\b/.test(partyBlock), 'party early-return must not wire inject');
    assert.ok(
      chatSrc.includes('buildPrompt(db, convNow, history, config.model.contextTokens, ctx.resolvedModel(), undefined, { inject })'),
      '1:1 path must pass { inject } into buildPrompt',
    );
    // Party pass renderers take no InjectContext.
    for (const fn of ['generateBeat', 'generateDialog', 'generateHunter'] as const) {
      const re = new RegExp(`async function ${fn}\\([\\s\\S]*?\\)\\s*\\{`);
      const m = chatSrc.match(re);
      assert.ok(m, `${fn} signature missing`);
      assert.ok(!/\binject\b/i.test(m![0]), `${fn} must not accept inject`);
    }
  });

  // --- Fastify: no-persist + 1:1 attach + party unconsumed ---
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-inject-macro-1to1-'));
  const liveDb = openDb(tmp, path.resolve('apps/server/migrations'));
  liveDb
    .prepare(
      `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  const streamChunks = ['「Hey—', ' wait.」 ', '*tilts their head.*'];
  const capturedParams: GenParams[] = [];
  const model = {
    stream: async (p: GenParams, onToken: (delta: string) => void): Promise<GenResult> => {
      capturedParams.push({
        model: p.model,
        messages: p.messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: p.temperature,
        top_p: p.top_p,
        max_tokens: p.max_tokens,
        stop: p.stop,
      });
      for (const c of streamChunks) {
        onToken(c);
        await new Promise((r) => setImmediate(r));
      }
      return {
        text: streamChunks.join(''),
        finishReason: 'stop',
        usage: { prompt_tokens: 12, completion_tokens: 8 },
        ttftMs: 1,
        totalMs: 2,
      };
    },
    complete: async (p: GenParams): Promise<GenResult> => {
      capturedParams.push({
        model: p.model,
        messages: p.messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: p.temperature,
        top_p: p.top_p,
        max_tokens: p.max_tokens,
        stop: p.stop,
      });
      const prompt = String(p.messages?.[0]?.content ?? '');
      if (prompt.includes('장면 진행 판정기')) {
        return { text: '{"base_version":0}', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
      }
      if (prompt.includes('서술') || prompt.includes('군중') || prompt.startsWith('당신은 카메라')) {
        return {
          text: '황지명이 나리 옆자리에 앉았다.',
          finishReason: 'stop',
          usage: null,
          ttftMs: 1,
          totalMs: 2,
        };
      }
      return { text: '"교칙이야."', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 2 };
    },
    listModels: async () => ['test-model'],
  };

  const ctx = {
    db: liveDb,
    model: model as unknown as Ctx['model'],
    queue: new GenerationQueue(1),
    log: { error() {}, info() {}, warn() {}, debug() {} } as unknown as Ctx['log'],
    resolvedModel: () => 'test-model',
    setResolvedModel: () => {},
    health: async () => ({ ok: true, checkedAt: 't', latencyMs: 0, models: ['test-model'] }),
  } as Ctx;

  const app = Fastify({ logger: false });
  await app.register(characterRoutes(ctx));
  await app.register(storyRoutes(ctx));
  await app.register(conversationRoutes(ctx));
  await app.register(chatRoutes(ctx));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.addresses()[0] as { port: number };
  const origin = `http://127.0.0.1:${addr.port}`;

  async function api(method: string, url: string, body?: unknown) {
    const res = await fetch(`${origin}${url}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, text };
  }

  const charRes = await api('POST', '/api/characters', {
    name: '나리',
    personality: '교실에서 장난을 치지만 친구를 챙긴다. 반말.',
    first_message: '*창가에 기대어 웃었다.* 「{{user}}, 또 늦었네. 나 {{char}}야.」',
    description: '2학년. 짧은 단발.',
    speech_style: '반말, 짧게.',
    scenario: '방과 후 교실',
    example_dialogue: '',
    taboos: '사용자를 대신해 말하지 않는다.',
    tagline: '창가의 2학년',
    tags: [],
  });
  assert.equal(charRes.status, 201, charRes.text);
  const soloChar = charRes.json as { id: string };

  const personaRes = await api('POST', '/api/personas', {
    name: '하준',
    personality: '과묵한 전학생.',
    address_as: '하준아',
    appearance: '회색 후드',
    relationship: '같은 반',
    is_default: true,
  });
  assert.equal(personaRes.status, 201, personaRes.text);
  const persona = personaRes.json as { id: string };

  await t('API 1:1: content ≠ instruction; instruction appears in GenParams system; not persisted', async () => {
    const convRes = await api('POST', '/api/conversations', {
      characterId: soloChar.id,
      personaId: persona.id,
      mode: 'chat',
      title: '1to1-attach',
    });
    assert.equal(convRes.status, 201, convRes.text);
    const c = convRes.json as { id: string };
    const userLine = '창가 자리, 나 앉아도 돼?';
    const instruction = `  ${INJECT_MARKER}: attach on 1:1 only.  `;

    capturedParams.length = 0;
    const res = await fetch(`${origin}/api/conversations/${c.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: userLine, inject_instruction: instruction }),
    });
    assert.equal(res.status, 200, `expected SSE 200, got ${res.status}`);
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.type === 'done'), 'done missing');

    const flat = flattenGenMessages(capturedParams);
    assert.ok(flat.includes(INJECT_MARKER), '1:1 GenParams must include instruction');
    assert.ok(flat.includes(CHOICES_MARKER) || flat.includes('입력 초안'), 'choices coexist');

    const detail = await api('GET', `/api/conversations/${c.id}`);
    const msgs = (detail.json as any).messages as Array<{ role: string; content: string; meta?: unknown }>;
    const user = msgs.find((m) => m.role === 'user' && m.content === userLine);
    assert.ok(user);
    assert.notEqual(user!.content, instruction.trim());
    assert.ok(!user!.content.includes(INJECT_MARKER));
    assert.ok(!JSON.stringify(msgs).includes(INJECT_MARKER), 'must not persist instruction into history');
  });

  // Party setup (minimal catalog like partyBeatPersist)
  const CATALOG = {
    places: [{ id: '교실', name: 'S반 교실', default_focus: 'nari' }, { id: '사무실' }],
    weathers: ['맑음'],
    arcs: ['entry'],
    stagesByArc: { entry: ['reg', 'class'] },
    flags: { rulebreak: { owner_stage: 'reg', owner_duty: '교칙' } },
    stages: { class: { closer_duty: '수업' } },
    outfits: ['교복'],
    emotions: { '😡': 8, '🙂': 2 },
    duties: { 교칙: { slot: '질서' } },
  };

  const mkPartyChar = async (name: string, tags: string[]) => {
    const res = await api('POST', '/api/characters', {
      name,
      personality: `${name} 성격`,
      first_message: '',
      tags,
    });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string; name: string };
  };

  const nari = await mkPartyChar('파티나리', [
    'party:duty=이야기',
    'party:alias=나리쨩',
    'party:place=교실',
    'party:outfit=교복',
  ]);
  const sera = await mkPartyChar('파티세라', ['party:duty=교칙', 'party:place=교실', 'party:outfit=교복']);
  const hayeon = await mkPartyChar('파티하연', ['party:duty=수업', 'party:place=교실', 'party:outfit=교복']);
  const luna = await mkPartyChar('파티루나', ['party:talkative=0.8', 'party:place=교실']);
  const yura = await mkPartyChar('파티유라', ['party:talkative=0.4', 'party:place=교실']);

  const storyRes = await api('POST', '/api/stories', {
    name: '히어로 아카데미-inject1to1',
    tagline: 'S반',
    setting: '교실',
    minor_cast: [],
    scene_catalog: CATALOG,
  });
  assert.equal(storyRes.status, 201, storyRes.text);
  const story = storyRes.json as { id: string };
  for (const [id, order] of [
    [hayeon.id, 0],
    [nari.id, 1],
    [sera.id, 2],
    [luna.id, 3],
    [yura.id, 4],
  ] as const) {
    const add = await api('POST', `/api/stories/${story.id}/characters`, {
      characterId: id,
      sortOrder: order,
    });
    assert.equal(add.status, 201, add.text);
  }

  await t('party path + inject → unconsumed (omit≡inject GenParams; marker absent)', async () => {
    const startA = await api('POST', '/api/conversations', {
      characterId: hayeon.id,
      storyId: story.id,
      mode: 'story',
    });
    assert.equal(startA.status, 201, startA.text);
    const convA = (startA.json as { id: string }).id;

    const startB = await api('POST', '/api/conversations', {
      characterId: hayeon.id,
      storyId: story.id,
      mode: 'story',
    });
    assert.equal(startB.status, 201, startB.text);
    const convB = (startB.json as { id: string }).id;

    const userLine = '나리, 네 이야기 말인데.';
    const partyMarker = 'PARTY_INJECT_MUST_NOT_APPEAR_QQQ';

    capturedParams.length = 0;
    const omitRes = await fetch(`${origin}/api/conversations/${convA}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: userLine }),
    });
    assert.equal(omitRes.status, 200, await omitRes.clone().text());
    await omitRes.text();
    const omitSnap = JSON.stringify(
      capturedParams.map((p) => p.messages.map((m) => ({ role: m.role, content: m.content }))),
    );

    capturedParams.length = 0;
    const injRes = await fetch(`${origin}/api/conversations/${convB}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: userLine,
        inject_instruction: `${partyMarker}: party must ignore.`,
      }),
    });
    assert.equal(injRes.status, 200, await injRes.clone().text());
    const injEvents = parseSse(await injRes.text());
    assert.ok(injEvents.some((e) => e.type === 'done'));
    const injFlat = flattenGenMessages(capturedParams);
    const injSnap = JSON.stringify(
      capturedParams.map((p) => p.messages.map((m) => ({ role: m.role, content: m.content }))),
    );

    assert.ok(!injFlat.includes(partyMarker), 'party GenParams must not contain inject instruction');
    assert.ok(!injFlat.includes('PARTY_INJECT_MUST_NOT_APPEAR'));
    // Ambient extras pick is nondeterministic across convs; strip that line then compare.
    const stripAmbient = (s: string) =>
      s.replace(/- 이번 턴에 몸짓으로 존재감만 드러낼 사람: [^\n]*/g, '- 이번 턴에 몸짓으로 존재감만 드러낼 사람: <stripped>');
    assert.equal(
      stripAmbient(injSnap),
      stripAmbient(omitSnap),
      'party prompts must match omit vs inject (aside from ambient extras lottery)',
    );
    // No inject prepended before ## 규칙 (marker already absent; also no unique inject-only prefix)
    assert.equal(injFlat.includes(partyMarker + '\n## 규칙'), false);
  });

  await app.close();
  liveDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  db.close();
  console.log(`PASS=${passed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
