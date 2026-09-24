/** npx tsx bench/profileInstructionParty.test.ts
 * profile-instruction (0023) — party IC calls (beat N/F/E, dialog S).
 *
 *   G-A bytes   → no profile instruction ⇒ attachInjectToIcPass output == HEAD 7b189b3 pins
 *                 for N/F/E/S × {no inject, inject} + tight-budget shrink
 *   G-P place   → `## 서술 지침` once per call, immediately before that call's `## 규칙`;
 *                 inject still right after `## 규칙`; the call's output contract (sentence /
 *                 dialogue-line limits) kept; removing the block restores the HEAD bytes
 *   G-P budget  → recent narrations shrink first; block + inject never truncated; throw when full
 *   G-E2E beat  → conv.profile_name drives it: N/F(/E) carry the block once; scene delta and
 *                 Pass C carry none; per-call sampling unchanged; log records profile + sha
 *   G-E2E room  → story default seeds the room; a room-level profile change wins next turn
 *   G-E2E S     → dialog Pass S carries the block once; delta / Pass C none
 *   source      → one attach family; C / delta never wrapped; format modules untouched
 *
 * Pins come from /tmp party-pin fixture copied verbatim below (see planning_documents/
 * profile-instruction/party-pin.mts). Isolated: temp DB, fake model, no systemd, no live DB.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import { chatRoutes } from '../apps/server/src/routes/chat.ts';
import { attachInjectToIcPass, insertProfileInstructionBeforeRules } from '../apps/server/src/prompt/injectContext.ts';
import { renderProfileInstruction } from '../apps/server/src/prompt/templates.ts';
import { estimateTokens } from '../apps/server/src/prompt/tokens.ts';
import { passFWith, planBeat, planPassE } from '../apps/server/src/prompt/composeBeat.ts';
import { planDialogBeat } from '../apps/server/src/prompt/composeDialog.ts';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.ts';
import { THOUGHT_MARKER } from '../apps/server/src/prompt/passes.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.ts';

let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const src = (rel: string) => fs.readFileSync(path.resolve(rel), 'utf8');

// ── HEAD 7b189b3 pins (party-pin fixture) ─────────────────────────────────
const PIN: Record<string, string> = {
  'N|none': '5f43a04ccf06da01bcbb6d79390e48e39c36ec980f7fc614fb8e6839a82fde1b',
  'N|inject': '9986bab1e89c7858fc0b1013b682f2f90a5b0336474129d323f5a81fbf0e22e2',
  'F|none': 'eae4ecde3cd0cd4200024badb962e9ed463f193c5c7dec52cc7595204f64854f',
  'F|inject': 'ffa08b26579b5a45a366a980825ac0a6cac63efdedf18cb738e4cfa591a2bac5',
  'S|none': 'e50eb064d6913e05a5a8c7222dd2325e165fc7aa9dbde9b16367ff28816374f9',
  'S|inject': 'f04fcffe7639a0fcf99128f5c06f3daba077f7fd185fce479bf710cc1a244b7b',
  'E0|none': 'b6c438ec3dd32c70d0daf8d398e531b6fc314a326b8cbc34dca609dcb3587b42',
  'E0|inject': '29ba64ebf7620002b8f82363c2e9616217e2d8d5efc77ebf156dcb6e7b7b1193',
  'N|inject|tight': '371455bf6af592c944a6c7ff7ed38829a44edef793374563bb73546ebaf50ab0',
  'N|inject|tight|dropped': '391552c099c101b131feaf24c5795a6a15bc8ec82015424e0d2b4274a369a0bf',
};

const member = (o: any) => ({ aliases: [], duties: [], place: '교실', role: 'secondary', ...o });
const CAST = [
  member({ id: 'nari', name: '나리', duties: ['이야기'] }),
  member({ id: 'sera', name: '세라', duties: ['교칙'] }),
  member({ id: 'hayeon', name: '하연', duties: ['수업'], role: 'main' }),
  member({ id: 'luna', name: '루나', talkativeness: 0.9 }),
];
const SCENE = { location: '교실', arc: 'entry', stage: 'reg', clock_minutes: 577, day_index: 12, weekday: '화', weather: '맑음', scene_version: 0,
  present_ids: ['nari', 'sera', 'hayeon', 'luna'], roster: { nari: { emotion: '😡', outfit: '교복' }, sera: { emotion: '🙂', outfit: '교복' } } };
const CAT = catalogFromStory(JSON.stringify({ places: [{ id: '교실', default_focus: 'hayeon' }], arcs: ['entry'], stagesByArc: { entry: ['reg', 'class'] },
  weathers: ['맑음'], flags: { rulebreak: { owner_duty: '교칙' } }, stages: { class: { closer_duty: '수업' } }, outfits: ['교복'], emotions: { '😡': 8, '🙂': 2 } }));
const CARDS = Object.fromEntries(CAST.map((m: any) => [m.id, { name: m.name, personality: `${m.name}의 성격` }]));
const beatIn: any = { conversation_id: 'pin', scene: SCENE, catalog: CAT, current_version: 0, user_text: '나리, 네 이야기 말인데.', user_name: '황지명',
  cast: CAST, cards: CARDS, main_character_id: 'hayeon', message_id: 'm1', patch: { base_version: 0, flags: { rulebreak: true } },
  content_policy: '성인 이용자 대상이다.', recent_narrations: ['오래된 서술 한 줄.', '중간 서술 한 줄.', '최신 서술 한 줄.'] };
const plan = planBeat(beatIn);
const narration = '황지명이 나리 옆자리에 앉았다.';
const extras = planPassE(beatIn, plan, narration, '"……짝꿍?"');
const dPlan = planDialogBeat({ ...beatIn, conversation_id: 'pin-d', scene: { ...SCENE, format: 'dialog' }, patch: undefined, message_id: undefined });
const PROMPTS: Record<string, string> = { N: plan.pass_n, F: passFWith(beatIn, plan, narration)!, S: dPlan.pass_s };
extras.forEach((e: any, k: number) => { PROMPTS[`E${k}`] = e.prompt; });
const INJECT = 'PIN_INJECT: keep tension.';
const BIG = 100000;

// Synthetic instruction (never the private engine text). Carries {{user}} / {{char}} and a
// stray `## 규칙` heading to prove the inject slot is not captured.
const MARK = 'ENGINE_MARK_7Q';
const ENGINE = `# ${MARK} 합성 엔진\n## CORE\n- {{user}} 대필 금지. {{char}} 시점.\n## 규칙\n- 엔진 내부 규칙\n`;
const block = (charName: string) => renderProfileInstruction(ENGINE, '## 서술 지침', charName, '황지명');

// Each call's own output contract lines that must survive the insertion.
const CONTRACT: Record<string, RegExp> = {
  N: /- \d+문장 이내\. 서술문만 쓴다\./,
  F: /속마음이 있으면 맨 마지막 줄에만/,
  S: /- 대사 줄은 모두 합쳐 \d+줄을 넘기지 않는다\./,
  E0: /- \d+~\d+문장\. 짧게 끼어들고 끝낸다\./,
};

async function main() {
  await t('fixture reproduces the pin set (1 Pass E)', () => {
    assert.equal(extras.length, 1);
    assert.deepEqual(Object.keys(PROMPTS).sort(), ['E0', 'F', 'N', 'S']);
  });

  await t('G-A no profile instruction (absent / null / "") → HEAD pins for every call × inject', () => {
    for (const [k, p] of Object.entries(PROMPTS)) {
      for (const profileInstruction of [undefined, null, ''] as const) {
        const opts = profileInstruction === undefined ? { promptTokenBudget: BIG } : { promptTokenBudget: BIG, profileInstruction };
        assert.equal(sha(attachInjectToIcPass(p, null, opts).prompt), PIN[`${k}|none`], `${k}|none (${String(profileInstruction)})`);
        assert.equal(sha(attachInjectToIcPass(p, INJECT, opts).prompt), PIN[`${k}|inject`], `${k}|inject (${String(profileInstruction)})`);
      }
    }
    const full = attachInjectToIcPass(plan.pass_n, INJECT, { promptTokenBudget: BIG }).prompt;
    const tight = attachInjectToIcPass(plan.pass_n, INJECT, { promptTokenBudget: estimateTokens(full) - 3, profileInstruction: null });
    assert.equal(sha(tight.prompt), PIN['N|inject|tight']);
    assert.equal(sha(String(tight.droppedRecent)), PIN['N|inject|tight|dropped']);
  });

  await t('G-P block once, right before the call\'s own ## 규칙; inject right after it; contract kept', () => {
    for (const [k, p] of Object.entries(PROMPTS)) {
      const b = block(k === 'F' ? '하연' : '');
      const out = attachInjectToIcPass(p, INJECT, { promptTokenBudget: BIG, profileInstruction: b }).prompt;
      assert.equal(count(out, '## 서술 지침'), 1, `${k}: block once`);
      assert.equal(count(out, MARK), 1, `${k}: engine text once`);
      assert.ok(out.includes(`${b}\n\n## 규칙\n${INJECT}\n`), `${k}: block ⟶ ## 규칙 ⟶ inject`);
      const afterBlock = out.slice(out.indexOf(`${b}\n\n## 규칙\n`) + b.length);
      assert.match(afterBlock, CONTRACT[k], `${k}: output contract kept after the block`);
      // Removing the block gives back exactly the HEAD inject bytes.
      assert.equal(sha(out.replace(`${b}\n\n`, '')), PIN[`${k}|inject`], `${k}: only the block was added`);
      const noInject = attachInjectToIcPass(p, null, { promptTokenBudget: BIG, profileInstruction: b }).prompt;
      assert.equal(sha(noInject.replace(`${b}\n\n`, '')), PIN[`${k}|none`], `${k}: block alone`);
    }
  });

  await t('G-P {{user}} → persona name, {{char}} → the call\'s actor; adapter present', () => {
    const f = block('하연');
    assert.ok(f.includes('- 황지명 대필 금지. 하연 시점.'));
    assert.ok(!f.includes('{{user}}') && !f.includes('{{char}}'));
    assert.ok(f.includes('이 요청의 규칙이 정한 출력 형식·길이·화자 제한은 서술 지침보다 우선한다.'));
    assert.ok(block('').includes('- 황지명 대필 금지.  시점.'), 'N/S: {{char}} → "" (dialog-path convention)');
  });

  await t('G-P budget: recent narrations drop first; block + inject intact; throw when nothing left', () => {
    const b = block('');
    const full = attachInjectToIcPass(plan.pass_n, INJECT, { promptTokenBudget: BIG, profileInstruction: b }).prompt;
    const tight = attachInjectToIcPass(plan.pass_n, INJECT, { promptTokenBudget: estimateTokens(full) - 3, profileInstruction: b });
    assert.ok(tight.droppedRecent >= 1);
    assert.ok(!tight.prompt.includes('오래된 서술 한 줄.'), 'oldest dropped first');
    assert.ok(tight.prompt.includes(b) && tight.prompt.includes(INJECT));
    assert.throws(
      () => attachInjectToIcPass(plan.pass_n, INJECT, { promptTokenBudget: 10, profileInstruction: b }),
      /profile instruction \+ inject_instruction exceed pass prompt budget .*neither is truncated/,
    );
    // inject-only error text is unchanged
    assert.throws(() => attachInjectToIcPass(plan.pass_n, INJECT, { promptTokenBudget: 10 }), /inject is never truncated/);
  });

  await t('G-P missing ## 규칙 fails closed', () => {
    assert.throws(() => insertProfileInstructionBeforeRules('no header here', block('')), /missing ## 규칙/);
    assert.equal(insertProfileInstructionBeforeRules('no header here', null), 'no header here');
  });

  await t('source: one attach family; C / delta never wrapped; format modules untouched', () => {
    const chat = src('apps/server/src/routes/chat.ts');
    const calls = chat.match(/attachInjectToIcPass\([^\n]*/g) ?? [];
    assert.equal(calls.length, 4, calls.join('\n'));
    for (const c of calls) assert.ok(c.includes('profileInstruction: icInstruction.forCall('), c);
    assert.equal(/attachInjectToIcPass\(\s*(passCWith|renderSceneDeltaPrompt)/.test(chat), false);
    assert.equal(/renderProfileInstruction\(/.test(chat.slice(chat.indexOf('function partyProfileInstruction'), chat.indexOf('function withDeadline'))), true);
    const helper = chat.slice(chat.indexOf('function partyProfileInstruction'), chat.indexOf('function withDeadline'));
    assert.ok(helper.includes('loadProfile(db, conv.profile_name)'), 'room profile, not story default');
    assert.ok(!chat.includes('default_profile_name'), 'chat.ts never reads story/character defaults');
    for (const rel of ['passes.ts', 'composeBeat.ts', 'dialogScript.ts', 'composeDialog.ts', 'beatChoices.ts', 'sceneDeltaPrompt.ts']) {
      const body = src(`apps/server/src/prompt/${rel}`);
      for (const needle of ['instruction_text', 'profileInstruction', 'renderProfileInstruction', '서술 지침']) {
        assert.equal(body.includes(needle), false, `${rel} must not know about ${needle}`);
      }
    }
  });

  // ── E2E: fake model, real routes ─────────────────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-pi-party-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  const ins = db.prepare(`INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes, instruction_enabled, instruction_text) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  ins.run('rp-balanced', null, 0.8, 0.95, 800, '[]', 'system', null, 0, null);
  // Deliberately odd sampling: party calls must NOT pick these up.
  ins.run('rp-engine', null, 0.11, 0.22, 33, '[]', 'system', '합성 엔진', 1, ENGINE);

  const captured: GenParams[] = [];
  const cap = (p: GenParams) => captured.push({ model: p.model, messages: p.messages.map((m) => ({ role: m.role, content: m.content })), temperature: p.temperature, top_p: p.top_p, max_tokens: p.max_tokens, stop: p.stop });
  const streamChunks = ['"', '……짝꿍?', '"\n', `${THOUGHT_MARKER} `, '왜 안 피하지.'];
  const model = {
    complete: async (p: GenParams): Promise<GenResult> => {
      cap(p);
      const prompt = String(p.messages?.[0]?.content ?? '');
      if (prompt.includes('장면 진행 판정기')) return { text: '{"base_version":0,"flags":{"rulebreak":true}}', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
      if (prompt.startsWith('너는 장면 서술자다')) return { text: '황지명이 나리 옆자리에 앉았다.', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
      if (prompt.includes('입력 초안')) return { text: '<choices>["*끄덕이며* 알겠어.","*물러서며* 잠깐.","*보며* 말해."]</choices>', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
      return { text: '"교칙이야."', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
    },
    stream: async (p: GenParams, onToken: (d: string) => void): Promise<GenResult> => {
      cap(p);
      const prompt = String(p.messages?.[0]?.content ?? '');
      const text = prompt.startsWith('너는 이 장면의 서술자다')
        ? '교실이 조용해졌다.\n파티나리|그래서?\n<choices>["*끄덕이며* 응.","*물러서며* 아니.","*보며* 왜?"]</choices>'
        : streamChunks.join('');
      onToken(text);
      return { text, finishReason: 'stop', usage: { prompt_tokens: 20, completion_tokens: 10 }, ttftMs: 1, totalMs: 2 };
    },
    listModels: async () => ['test-model'],
  };
  const ctx = {
    db,
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
  const origin = `http://127.0.0.1:${(app.addresses()[0] as { port: number }).port}`;
  const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${origin}${url}`, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: unknown = text;
    try { json = text ? JSON.parse(text) : null; } catch { /* sse */ }
    return { status: res.status, json, text };
  };

  const mkChar = async (name: string, tags: string[]) => {
    const r = await api('POST', '/api/characters', { name, personality: `${name} 성격`, first_message: '', tags });
    assert.equal(r.status, 201, r.text);
    return r.json as { id: string };
  };
  const nari = await mkChar('파티나리', ['party:duty=이야기', 'party:place=교실', 'party:outfit=교복']);
  const sera = await mkChar('파티세라', ['party:duty=교칙', 'party:place=교실', 'party:outfit=교복']);
  const hayeon = await mkChar('파티하연', ['party:duty=수업', 'party:place=교실', 'party:outfit=교복']);
  const storyRes = await api('POST', '/api/stories', {
    name: '합성 파티', tagline: 'S반', setting: '교실', minor_cast: [], default_profile_name: 'rp-engine',
    scene_catalog: { places: [{ id: '교실', name: 'S반 교실', default_focus: 'hayeon' }], weathers: ['맑음'], arcs: ['entry'], stagesByArc: { entry: ['reg'] },
      flags: { rulebreak: { owner_stage: 'reg', owner_duty: '교칙' } }, outfits: ['교복'], emotions: { '🙂': 2 }, duties: { 교칙: { slot: '질서' } } },
  });
  assert.equal(storyRes.status, 201, storyRes.text);
  const storyId = (storyRes.json as { id: string }).id;
  for (const [id, order] of [[hayeon.id, 0], [nari.id, 1], [sera.id, 2]] as const) {
    assert.equal((await api('POST', `/api/stories/${storyId}/characters`, { characterId: id, sortOrder: order })).status, 201);
  }

  type Kind = 'delta' | 'N' | 'F' | 'E' | 'S' | 'C';
  const kindOf = (prompt: string): Kind => {
    if (prompt.includes('장면 진행 판정기')) return 'delta';
    if (prompt.startsWith('너는 장면 서술자다')) return 'N';
    if (prompt.startsWith('너는 이 장면의 서술자다')) return 'S';
    if (/^너는 '[^']+' 한 명만 연기한다\. 이번 턴에 끼어들 근거는/.test(prompt)) return 'E';
    if (/^너는 '[^']+' 한 명만 연기한다\./.test(prompt)) return 'F';
    if (prompt.includes('입력 초안')) return 'C';
    throw new Error(`unclassified prompt: ${prompt.slice(0, 60)}`);
  };
  const send = async (convId: string) => {
    captured.length = 0;
    const r = await api('POST', `/api/conversations/${convId}/messages`, { content: '파티하연, 네 이야기 말인데.' });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.text.includes('"type":"done"'), 'turn finished');
    return captured.map((p) => ({ kind: kindOf(String(p.messages[0].content)), p }));
  };
  const lastLog = (convId: string) => JSON.parse((db.prepare(`SELECT budget_json FROM generation_log WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(convId) as { budget_json: string }).budget_json);
  const sampling = (calls: Array<{ kind: Kind; p: GenParams }>) => calls.map(({ kind, p }) => `${kind}:${p.temperature}/${p.top_p}/${p.max_tokens}`);

  let beatConv = '';
  let baselineSampling: string[] = [];

  await t('E2E beat, room on rp-balanced → no block anywhere, no log key', async () => {
    const r = await api('POST', '/api/conversations', { characterId: hayeon.id, storyId, mode: 'story', profileName: 'rp-balanced' });
    assert.equal(r.status, 201, r.text);
    const calls = await send((r.json as { id: string }).id);
    for (const { p } of calls) assert.ok(!String(p.messages[0].content).includes('## 서술 지침'));
    assert.equal(lastLog((r.json as { id: string }).id).profile_instruction, undefined);
    baselineSampling = sampling(calls);
    assert.ok(calls.some((c) => c.kind === 'E'), `fixture should open a Pass E: ${calls.map((c) => c.kind).join(',')}`);
  });

  await t('E2E beat, story default rp-engine → N/F/E once each; delta & C none; sampling untouched; log', async () => {
    const r = await api('POST', '/api/conversations', { characterId: hayeon.id, storyId, mode: 'story' });
    assert.equal(r.status, 201, r.text);
    beatConv = (r.json as { id: string }).id;
    assert.equal((db.prepare('SELECT profile_name FROM conversations WHERE id = ?').get(beatConv) as { profile_name: string }).profile_name, 'rp-engine');
    const calls = await send(beatConv);
    const kinds = calls.map((c) => c.kind);
    for (const k of ['delta', 'N', 'F', 'E', 'C'] as const) assert.ok(kinds.includes(k), `${k} ran: ${kinds.join(',')}`);
    for (const { kind, p } of calls) {
      const prompt = String(p.messages[0].content);
      const want = kind === 'N' || kind === 'F' || kind === 'E' ? 1 : 0;
      assert.equal(count(prompt, MARK), want, `${kind}: engine count`);
      assert.equal(count(prompt, '## 서술 지침'), want, `${kind}: block count`);
    }
    const f = calls.find((c) => c.kind === 'F')!;
    // no persona rows in this DB → userName falls back to '나'; focus is the addressed 파티하연
    assert.ok(String(f.p.messages[0].content).includes('- 나 대필 금지. 파티하연 시점.'), 'F: {{user}}=persona fallback, {{char}}=focus');
    for (const e of calls.filter((c) => c.kind === 'E')) {
      const actor = /^너는 '([^']+)'/.exec(String(e.p.messages[0].content))![1];
      assert.ok(String(e.p.messages[0].content).includes(`- 나 대필 금지. ${actor} 시점.`), `E: {{char}}=${actor}`);
    }
    assert.deepEqual(sampling(calls), baselineSampling, 'per-call sampling, never the profile (0.11/0.22/33)');
    const log = lastLog(beatConv);
    assert.deepEqual(log.profile_instruction, { profile: 'rp-engine', sha256_8: createHash('sha256').update(ENGINE).digest('hex').slice(0, 8) });
    assert.ok(log.beat_log, 'beat_log kept');
  });

  await t('E2E room-level change wins: PATCH profile → rp-balanced, next turn has no block', async () => {
    assert.equal((await api('PATCH', `/api/conversations/${beatConv}`, { profileName: 'rp-balanced' })).status, 200);
    const calls = await send(beatConv);
    for (const { p } of calls) assert.equal(count(String(p.messages[0].content), MARK), 0);
    assert.equal(lastLog(beatConv).profile_instruction, undefined);
    // and back on: the room value, not the story default, is what is read each turn
    db.prepare("UPDATE stories SET default_profile_name = NULL WHERE id = ?").run(storyId);
    assert.equal((await api('PATCH', `/api/conversations/${beatConv}`, { profileName: 'rp-engine' })).status, 200);
    const again = await send(beatConv);
    assert.equal(again.filter((c) => count(String(c.p.messages[0].content), MARK) === 1).length, again.filter((c) => ['N', 'F', 'E'].includes(c.kind)).length);
    db.prepare("UPDATE stories SET default_profile_name = 'rp-engine' WHERE id = ?").run(storyId);
  });

  await t('E2E dialog Pass S carries the block once; delta & C none', async () => {
    const r = await api('POST', '/api/conversations', { characterId: hayeon.id, storyId, mode: 'story', scene: { format: 'dialog' } });
    assert.equal(r.status, 201, r.text);
    const convId = (r.json as { id: string }).id;
    const calls = await send(convId);
    assert.ok(calls.some((c) => c.kind === 'S'), calls.map((c) => c.kind).join(','));
    for (const { kind, p } of calls) assert.equal(count(String(p.messages[0].content), MARK), kind === 'S' ? 1 : 0, kind);
    assert.equal(lastLog(convId).profile_instruction?.profile, 'rp-engine');
    assert.ok(lastLog(convId).dialog_log, 'dialog_log kept');
  });

  await app.close();
  db.close();
  console.log(`PASS=${passed}`);
}

main().catch((e) => {
  console.error('RED', e);
  process.exit(1);
});
