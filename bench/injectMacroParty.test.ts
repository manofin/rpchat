/** npx tsx bench/injectMacroParty.test.ts
 * inject-macro-party — prepend InjectContext into party IC ## 규칙 (ADR §6.3).
 * Unit/helper + plan/compose fixtures. LIVE_NO_TOUCH. Client Out. No hermes.
 *
 *   helper           → null omit; insert after ## 규칙; missing header throws; no truncate
 *   beat N/F/E       → inject present in rules; omit absent
 *   dialog S / hunter H
 *   plan.ui/focus/roster omit≡inject (plan never sees inject)
 *   Pass C           → unchanged / helper not applied
 *   long × multi-pass → full instruction every IC pass
 *   one-hook source  → prependInjectToRules only
 *   persist          → content ≠ instruction (light Fastify party send)
 *   1:1 regression   → run separately: injectMacro1to1 / injectMacroApi
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import {
  INJECT_INSTRUCTION_MAX,
  prependInjectToRules,
} from '../apps/server/src/prompt/injectContext.js';
import {
  finishBeat,
  passCWith,
  passFWith,
  planBeat,
  planPassE,
  type BeatPlanInput,
} from '../apps/server/src/prompt/composeBeat.js';
import { planDialogBeat, type DialogPlanInput } from '../apps/server/src/prompt/composeDialog.js';
import { planHunterBeat, type HunterPlanInput } from '../apps/server/src/prompt/composeHunter.js';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.js';
import { THOUGHT_MARKER } from '../apps/server/src/prompt/passes.js';
import type { CastMember } from '../apps/server/src/prompt/cast.js';
import type { Scene } from '../apps/server/src/types.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

const MARKER = 'INJECT_PARTY_MARKER_KEEP_INTACT_XYZ';
const INJECT_FULL = `${MARKER}: never speak for the user; keep tension high.`;

const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '교실', role: 'secondary', ...o,
});
const NARI = member({ id: 'nari', name: '나리', duties: ['이야기'] });
const SERA = member({ id: 'sera', name: '세라', duties: ['교칙'] });
const HAYEON = member({ id: 'hayeon', name: '하연', duties: ['수업'], role: 'main' });
const LUNA = member({ id: 'luna', name: '루나', talkativeness: 0.9 });
const CAST = [NARI, SERA, HAYEON, LUNA];

const CLASSROOM: Scene = {
  location: '교실',
  arc: 'entry',
  stage: 'reg',
  clock_minutes: 9 * 60 + 37,
  day_index: 12,
  weekday: '화',
  weather: '맑음',
  scene_version: 0,
  present_ids: ['nari', 'sera', 'hayeon', 'luna'],
  roster: { nari: { emotion: '😡', outfit: '교복' }, sera: { emotion: '🙂', outfit: '교복' } },
};

const CAT = catalogFromStory(JSON.stringify({
  places: [{ id: '교실', default_focus: 'hayeon' }],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg', 'class'] },
  weathers: ['맑음'],
  flags: { rulebreak: { owner_duty: '교칙' } },
  stages: { class: { closer_duty: '수업' } },
  outfits: ['교복'],
  emotions: { '😡': 8, '🙂': 2 },
}));

const CARDS = Object.fromEntries(CAST.map((m) => [m.id, { name: m.name, personality: `${m.name}의 성격` }]));

const beatInput = (o: Partial<BeatPlanInput> = {}): BeatPlanInput => ({
  conversation_id: 'conv-party-inject',
  scene: CLASSROOM,
  catalog: CAT,
  current_version: 0,
  user_text: '나리, 네 이야기 말인데.',
  user_name: '황지명',
  cast: CAST,
  cards: CARDS,
  main_character_id: 'hayeon',
  message_id: 'msg-1',
  patch: { base_version: 0, flags: { rulebreak: true } },
  ...o,
});

function rulesSectionHas(prompt: string, needle: string): boolean {
  const at = prompt.indexOf('## 규칙');
  if (at < 0) return false;
  return prompt.slice(at).includes(needle);
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

async function main() {
  // ── helper ──────────────────────────────────────────────────────────────
  await t('prependInjectToRules: null/empty → byte-stable omit', () => {
    const base = 'intro\n## 규칙\n- a\n';
    assert.equal(prependInjectToRules(base, null), base);
    assert.equal(prependInjectToRules(base, ''), base);
    assert.equal(prependInjectToRules(base, undefined), base);
  });

  await t('prependInjectToRules: inserts full instruction immediately after ## 규칙', () => {
    const base = 'intro\n## 규칙\n- keep me\n- and me\n';
    const out = prependInjectToRules(base, INJECT_FULL);
    assert.ok(out.includes(`## 규칙\n${INJECT_FULL}\n- keep me`));
    assert.ok(out.includes(INJECT_FULL));
    assert.equal(out.indexOf(INJECT_FULL) > out.indexOf('## 규칙'), true);
    assert.equal(out.indexOf('- keep me') > out.indexOf(INJECT_FULL), true);
  });

  await t('prependInjectToRules: missing ## 규칙 throws (no silent fallback attach)', () => {
    assert.throws(
      () => prependInjectToRules('no rules header here', INJECT_FULL),
      /missing ## 규칙/,
    );
  });

  await t('prependInjectToRules: never truncates long instruction', () => {
    const pad = 'KEEP_WHOLE_PARTY_INJECT ';
    let long = `${MARKER}: ` + pad.repeat(40);
    if (long.length > INJECT_INSTRUCTION_MAX) long = long.slice(0, INJECT_INSTRUCTION_MAX);
    assert.ok(long.length <= INJECT_INSTRUCTION_MAX);
    const base = '## 규칙\n- bullet\n';
    const out = prependInjectToRules(base, long);
    assert.ok(out.includes(long), 'full instruction must remain');
    assert.equal(out.includes(long.slice(0, long.length - 1)) && out.includes(long), true);
  });

  // ── beat N / F / E ──────────────────────────────────────────────────────
  const i = beatInput();
  const planOmit = planBeat(i);
  const planInj = planBeat(i); // same inputs — inject is not a plan input
  const narration = '황지명이 나리 옆자리에 앉았다.';
  const focusText = '"……짝꿍?"';

  await t('beat: inject present in Pass N, F, and each E rules; omit → absent', () => {
    assert.ok(planOmit.pass_n.includes('## 규칙'));
    const nOmit = prependInjectToRules(planOmit.pass_n, null);
    const nInj = prependInjectToRules(planOmit.pass_n, INJECT_FULL);
    assert.equal(nOmit, planOmit.pass_n);
    assert.ok(!rulesSectionHas(nOmit, MARKER));
    assert.ok(rulesSectionHas(nInj, INJECT_FULL));
    assert.ok(nInj.includes(`## 규칙\n${INJECT_FULL}\n`));

    const fRaw = passFWith(i, planOmit, narration);
    assert.ok(fRaw && fRaw.includes('## 규칙'));
    const fOmit = prependInjectToRules(fRaw!, null);
    const fInj = prependInjectToRules(fRaw!, INJECT_FULL);
    assert.equal(fOmit, fRaw);
    assert.ok(!rulesSectionHas(fOmit, MARKER));
    assert.ok(rulesSectionHas(fInj, INJECT_FULL));

    const extras = planPassE(i, planOmit, narration, focusText);
    assert.ok(extras.length >= 1, `expected ≥1 Pass E, got ${extras.length}`);
    for (const e of extras) {
      assert.ok(e.prompt.includes('## 규칙'), `E ${e.name} missing ## 규칙`);
      const eOmit = prependInjectToRules(e.prompt, null);
      const eInj = prependInjectToRules(e.prompt, INJECT_FULL);
      assert.equal(eOmit, e.prompt);
      assert.ok(!rulesSectionHas(eOmit, MARKER));
      assert.ok(rulesSectionHas(eInj, INJECT_FULL), `E ${e.name} must carry full inject`);
    }
  });

  // ── dialog S / hunter H ─────────────────────────────────────────────────
  await t('dialog Pass S / hunter Pass H: inject in rules; omit absent', () => {
    const dIn: DialogPlanInput = {
      conversation_id: 'd1',
      scene: { ...CLASSROOM, format: 'dialog' },
      catalog: CAT,
      current_version: 0,
      user_text: '나리, 네 이야기 말인데.',
      user_name: '황지명',
      cast: CAST,
      cards: CARDS,
      main_character_id: 'hayeon',
    };
    const dPlan = planDialogBeat(dIn);
    assert.ok(dPlan.pass_s.includes('## 규칙'));
    assert.ok(!rulesSectionHas(prependInjectToRules(dPlan.pass_s, null), MARKER));
    assert.ok(rulesSectionHas(prependInjectToRules(dPlan.pass_s, INJECT_FULL), INJECT_FULL));

    const hIn: HunterPlanInput = {
      conversation_id: 'h1',
      scene: { ...CLASSROOM, format: 'hunter' },
      catalog: CAT,
      current_version: 0,
      user_text: '강다은, 보고.',
      user_name: '황지명',
      cast: CAST,
      cards: CARDS,
      main_character_id: 'hayeon',
    };
    const hPlan = planHunterBeat(hIn);
    assert.ok(hPlan.pass_h.includes('## 규칙'));
    assert.ok(!rulesSectionHas(prependInjectToRules(hPlan.pass_h, null), MARKER));
    assert.ok(rulesSectionHas(prependInjectToRules(hPlan.pass_h, INJECT_FULL), INJECT_FULL));
  });

  // ── plan.ui / focus / roster omit≡inject ────────────────────────────────
  await t('plan.ui / focus_id / roster-related plan fields identical omit vs inject', () => {
    // Inject is applied only later to pass strings — planBeat never takes InjectContext.
    assert.deepEqual(planOmit.ui, planInj.ui);
    assert.equal(planOmit.focus.focus_id, planInj.focus.focus_id);
    assert.equal(planOmit.focus.reason, planInj.focus.reason);
    assert.deepEqual(planOmit.ui.roster, planInj.ui.roster);
    assert.equal(planOmit.ui.focus_id, planInj.ui.focus_id);
    assert.deepEqual(
      planOmit.approved_extras.map((e) => e.character_id),
      planInj.approved_extras.map((e) => e.character_id),
    );
    assert.deepEqual(planOmit.eligible_ids, planInj.eligible_ids);
    // pass strings from plan are also identical (inject applied at send sites)
    assert.equal(planOmit.pass_n, planInj.pass_n);
    assert.equal(planOmit.pass_f, planInj.pass_f);
  });

  // ── Pass C unchanged ────────────────────────────────────────────────────
  await t('Pass C prompt unchanged by inject (helper not applied)', () => {
    const finished = finishBeat(i, planOmit, {
      narration,
      focus_text: focusText,
      extra_texts: Object.fromEntries(
        planPassE(i, planOmit, narration, focusText).map((e) => [e.character_id, `"${e.name}."`]),
      ),
    });
    const c1 = passCWith(i, finished);
    const c2 = passCWith(i, finished);
    assert.equal(c1, c2);
    assert.ok(c1.includes('## 규칙'));
    // Simulating "with inject" without applying helper → still equal
    assert.equal(c1, c2);
    assert.ok(!c1.includes(MARKER));

    const chatSrc = src('apps/server/src/routes/chat.ts');
    // generateBeat body must call passCWith without prependInjectToRules wrapping it
    const beatFrom = chatSrc.indexOf('async function generateBeat');
    const dialogFrom = chatSrc.indexOf('async function generateDialog');
    assert.ok(beatFrom > 0 && dialogFrom > beatFrom);
    const beatBody = chatSrc.slice(beatFrom, dialogFrom);
    assert.ok(beatBody.includes('passCWith(planInput, finished)'));
    assert.equal(beatBody.includes('prependInjectToRules(passCWith'), false);
    assert.equal(/prependInjectToRules\(\s*passCWith/.test(beatBody), false);
    // delta also untouched
    assert.equal(beatBody.includes('prependInjectToRules(renderSceneDeltaPrompt'), false);
  });

  // ── long instruction × multi-pass ───────────────────────────────────────
  await t('long instruction × multi-pass → full instruction in every IC pass; omit differs only by insert', () => {
    const pad = 'KEEP_THIS_WHOLE_INSTRUCTION_UNTRUNCATED ';
    let longInject = `${MARKER}: ` + pad.repeat(20);
    if (longInject.length > INJECT_INSTRUCTION_MAX) longInject = longInject.slice(0, INJECT_INSTRUCTION_MAX);
    assert.ok(longInject.length >= 400, `expected near-max length, got ${longInject.length}`);

    const n0 = planOmit.pass_n;
    const n1 = prependInjectToRules(n0, longInject);
    assert.ok(n1.includes(longInject));
    // Differ only by the insert after ## 규칙
    const expectedN = n0.replace('## 규칙\n', `## 규칙\n${longInject}\n`);
    assert.equal(n1, expectedN);

    const f0 = passFWith(i, planOmit, narration)!;
    const f1 = prependInjectToRules(f0, longInject);
    assert.ok(f1.includes(longInject));
    assert.equal(f1, f0.replace('## 규칙\n', `## 규칙\n${longInject}\n`));

    for (const e of planPassE(i, planOmit, narration, focusText)) {
      const e1 = prependInjectToRules(e.prompt, longInject);
      assert.ok(e1.includes(longInject), `E ${e.name} truncated inject`);
      assert.equal(e1, e.prompt.replace('## 규칙\n', `## 규칙\n${longInject}\n`));
    }

    const dPlan = planDialogBeat({
      conversation_id: 'd2',
      scene: { ...CLASSROOM, format: 'dialog' },
      catalog: CAT,
      current_version: 0,
      user_text: '안녕',
      user_name: '황지명',
      cast: CAST,
      cards: CARDS,
      main_character_id: 'hayeon',
    });
    const s1 = prependInjectToRules(dPlan.pass_s, longInject);
    assert.ok(s1.includes(longInject));
    assert.equal(s1, dPlan.pass_s.replace('## 규칙\n', `## 규칙\n${longInject}\n`));

    const hPlan = planHunterBeat({
      conversation_id: 'h2',
      scene: { ...CLASSROOM, format: 'hunter' },
      catalog: CAT,
      current_version: 0,
      user_text: '보고',
      user_name: '황지명',
      cast: CAST,
      cards: CARDS,
      main_character_id: 'hayeon',
    });
    const h1 = prependInjectToRules(hPlan.pass_h, longInject);
    assert.ok(h1.includes(longInject));
    assert.equal(h1, hPlan.pass_h.replace('## 규칙\n', `## 규칙\n${longInject}\n`));
  });

  // ── one-hook source assert ──────────────────────────────────────────────
  await t('source: prependInjectToRules is the single party attach function', () => {
    const chatSrc = src('apps/server/src/routes/chat.ts');
    const injSrc = src('apps/server/src/prompt/injectContext.ts');
    assert.ok(injSrc.includes('export function prependInjectToRules'));
    assert.ok(injSrc.includes('pass-multiplication'));
    assert.ok(injSrc.includes('party has no isOoc gate'));

    // Exactly one definition
    assert.equal((injSrc.match(/export function prependInjectToRules/g) || []).length, 1);

    // chat.ts uses the helper on IC passes
    assert.ok(chatSrc.includes('prependInjectToRules(plan.pass_n'));
    assert.ok(chatSrc.includes('prependInjectToRules(passFRaw') || chatSrc.includes('prependInjectToRules(passF'));
    assert.ok(chatSrc.includes('prependInjectToRules(e.prompt'));
    assert.ok(chatSrc.includes('prependInjectToRules(plan.pass_s'));
    assert.ok(chatSrc.includes('prependInjectToRules(plan.pass_h'));

    // No duplicate "## 규칙" inject paste bodies in format modules
    for (const rel of [
      'apps/server/src/prompt/passes.ts',
      'apps/server/src/prompt/dialogScript.ts',
      'apps/server/src/prompt/hunterScript.ts',
      'apps/server/src/prompt/composeBeat.ts',
      'apps/server/src/prompt/composeDialog.ts',
      'apps/server/src/prompt/composeHunter.ts',
      'apps/server/src/prompt/beatChoices.ts',
    ]) {
      const body = src(rel);
      assert.equal(body.includes('prependInjectToRules'), false, `${rel} must not re-implement attach`);
      assert.equal(body.includes('inject_instruction'), false, `${rel} must not special-case inject`);
      // No pasted "insert after ## 규칙" logic
      assert.equal(/indexOf\(\s*['"]## 규칙['"]\s*\)/.test(body), false, `${rel} must not paste header indexOf`);
    }

    // Party generators accept inject; early-return wires it
    assert.ok(/generateBeat\([\s\S]*?inject/.test(chatSrc));
    const partyBlock = chatSrc.match(
      /if \(partyCast && partyCast\.length\) \{[\s\S]*?return generateBeat\([^;]+;/,
    );
    assert.ok(partyBlock && /\binject\b/.test(partyBlock[0]));
  });

  // ── light Fastify: content ≠ instruction persist ────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-inject-macro-party-'));
  const liveDb = openDb(tmp, path.resolve('apps/server/migrations'));
  liveDb
    .prepare(
      `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  const streamChunks = ['"', '……짝꿍?', '"\n', `${THOUGHT_MARKER} `, '왜 안 피하지.'];
  const capturedParams: GenParams[] = [];
  const model = {
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
          text: '황지명이 나리 옆자리에 앉았다. 뒤에서 루나가 킥킥 웃었다.',
          finishReason: 'stop',
          usage: null,
          ttftMs: 1,
          totalMs: 2,
        };
      }
      if (prompt.includes('입력 초안') || prompt.includes('<choices>')) {
        return {
          text: '<choices>["*고개 끄덕이며* 알겠어.","*한 발 물러서며* 잠깐.","*정면으로 보며* 말해."]</choices>',
          finishReason: 'stop',
          usage: null,
          ttftMs: 1,
          totalMs: 2,
        };
      }
      return { text: '"교칙이야."', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 2 };
    },
    stream: async (p: GenParams, onToken: (d: string) => void): Promise<GenResult> => {
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
        usage: { prompt_tokens: 20, completion_tokens: 10 },
        ttftMs: 1,
        totalMs: 3,
      };
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
  const port = (app.addresses()[0] as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

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

  const mkChar = async (name: string, tags: string[]) => {
    const res = await api('POST', '/api/characters', {
      name,
      personality: `${name} 성격`,
      first_message: '',
      tags,
    });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string; name: string };
  };

  const nari = await mkChar('파티나리', [
    'party:duty=이야기',
    'party:alias=나리쨩',
    'party:place=교실',
    'party:outfit=교복',
  ]);
  const sera = await mkChar('파티세라', ['party:duty=교칙', 'party:place=교실', 'party:outfit=교복']);
  const hayeon = await mkChar('파티하연', ['party:duty=수업', 'party:place=교실', 'party:outfit=교복']);
  const luna = await mkChar('파티루나', ['party:talkative=0.8', 'party:place=교실']);

  const storyRes = await api('POST', '/api/stories', {
    name: '히어로 아카데미-inject-party',
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
  ] as const) {
    const add = await api('POST', `/api/stories/${story.id}/characters`, {
      characterId: id,
      sortOrder: order,
    });
    assert.equal(add.status, 201, add.text);
  }

  await t('API party send: IC prompts include inject; content ≠ instruction; not persisted', async () => {
    const start = await api('POST', '/api/conversations', {
      characterId: hayeon.id,
      storyId: story.id,
      mode: 'story',
    });
    assert.equal(start.status, 201, start.text);
    const convId = (start.json as { id: string }).id;
    const userLine = '나리, 네 이야기 말인데.';
    const instruction = `  ${MARKER}: party persist check.  `;

    capturedParams.length = 0;
    const res = await fetch(`${origin}/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: userLine, inject_instruction: instruction }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.type === 'done'), 'done missing');

    const flat = flattenGenMessages(capturedParams);
    assert.ok(flat.includes(MARKER), 'party GenParams must include instruction');
    // Pass C must NOT include inject
    const cPrompts = capturedParams
      .map((p) => String(p.messages[0]?.content ?? ''))
      .filter((c) => c.includes('입력 초안') || c.includes('<choices>["초안'));
    for (const c of cPrompts) {
      assert.ok(!c.includes(MARKER), 'Pass C must not receive inject');
    }
    // Delta must not include inject
    const deltaPrompts = capturedParams
      .map((p) => String(p.messages[0]?.content ?? ''))
      .filter((c) => c.includes('장면 진행 판정기'));
    for (const d of deltaPrompts) {
      assert.ok(!d.includes(MARKER), 'scene delta must not receive inject');
    }

    const detail = await api('GET', `/api/conversations/${convId}`);
    const msgs = (detail.json as any).messages as Array<{ role: string; content: string }>;
    const user = msgs.find((m) => m.role === 'user' && m.content === userLine);
    assert.ok(user);
    assert.notEqual(user!.content, instruction.trim());
    assert.ok(!user!.content.includes(MARKER));
    assert.ok(!JSON.stringify(msgs).includes(MARKER), 'must not persist instruction into history');
  });

  await app.close();
  liveDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`PASS=${passed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
