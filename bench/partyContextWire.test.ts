import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import { config } from '../apps/server/src/config.js';
import { planBeat, planPassE, passFWith, type BeatPlanInput } from '../apps/server/src/prompt/composeBeat.js';
import { planDialogBeat, type DialogPlanInput } from '../apps/server/src/prompt/composeDialog.js';
import { buildDialogPrompt } from '../apps/server/src/prompt/dialogPrompt.js';
import { computeStoryInjection } from '../apps/server/src/prompt/builder.js';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.js';
import { renderSceneDeltaPrompt } from '../apps/server/src/prompt/sceneDeltaPrompt.js';
import { buildWireBlock, preparePartyContextWire, wireMinorLine, wirePresentIds, preflightWire, PARTY_CONTEXT_SHARE } from '../apps/server/src/prompt/partyContextWire.js';
import { getCalibration, estimateTokens } from '../apps/server/src/prompt/tokens.js';
import type { CastMember } from '../apps/server/src/prompt/cast.js';
import type { ConversationRow, Scene } from '../apps/server/src/types.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams } from '../apps/server/src/model/adapter.js';

const BASE = '76d0071efc63a2cce9233662342383334b750841';
const fixture = JSON.parse(fs.readFileSync('bench/fixtures/party-u1-wire/world.json', 'utf8'));
let assertions = 0, passed = 0;
const a = new Proxy(assert, { get(target, key) {
  const value = Reflect.get(target, key);
  return typeof value === 'function' ? (...args: unknown[]) => { assertions++; return Reflect.apply(value, target, args); } : value;
} });
async function t(name: string, fn: () => void | Promise<void>) {
  const before = assertions; await fn(); assert.ok(assertions > before, 'test without assertions');
  console.log(`ok ${++passed} ${name}`);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'party-wire-'));
const db = openMigratedDb(temp, path.resolve('apps/server/migrations'));
const calls: GenParams[] = [];
const result = (text: string) => ({ text, usage: null, finishReason: 'stop', ttftMs: 1, totalMs: 1 });
const model = {
  complete: async (p: GenParams) => {
    calls.push(p);
    const text = p.messages.map(m => m.content).join('\n');
    if (text.includes('장면 진행 판정기')) return result('null');
    if (text.includes('입력 초안만 쓴다')) return result('<choices>["조건 문의","보류","떠나기"]</choices>');
    return result('접수원은 종이를 정리한다.');
  },
  stream: async (p: GenParams, token: (s: string) => void) => {
    calls.push(p);
    const text = p.messages.some(m => m.content.includes('대본으로 쓴다')) ? '나리 | 조건을 먼저 확인해 주세요.' : '조건을 먼저 확인해 주세요.\n속마음: 기다리자.';
    token(text); return result(text);
  },
};
const app = Fastify();
const ctx = { db, model, queue: new GenerationQueue(1), resolvedModel: () => 'mock', effectiveDataDir: temp, log: app.log } as unknown as Ctx;
for (const route of [characterRoutes, storyRoutes, conversationRoutes, chatRoutes]) app.register(route(ctx));
const saved = { flag: config.partyContext, context: config.model.contextTokens };
const contextTokens = 8192;
let cast: CastMember[], cards: Record<string, any>, room: ConversationRow, storyId: string, personaId: string;
let beatInput: BeatPlanInput, dialogInput: DialogPlanInput;
const conv = (id: string) => db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow;
const messages = (id: string) => db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid').all(id);
async function api(method: 'POST' | 'PATCH', url: string, payload: object) {
  const r = await app.inject({ method, url, payload }); a.ok(r.statusCode < 400, `${r.statusCode}: ${r.body}`); return r.json();
}
function source(enabled = true, c = room) { return preparePartyContextWire(db, c, cast, '방문자', enabled); }
const budget = (reserve: number) => ({ inputLimitTokens: Math.floor(Math.max(512, contextTokens - reserve - 64) * PARTY_CONTEXT_SHARE), outputReserveTokens: reserve, calibration: getCalibration(db) });
function wiredBeat(input: BeatPlanInput, enabled: boolean) {
  const s = source(enabled); if (!s) return { ...input, party_context_blocks: null };
  const p = planBeat(input), present = wirePresentIds(input.cast, p.applied.state);
  const blocks: Record<string, string> = { __narration__: buildWireBlock(s, p.focus.focus_id ? [p.focus.focus_id] : [], present, budget(300)).block };
  if (p.focus.focus_id) blocks[p.focus.focus_id] = buildWireBlock(s, [p.focus.focus_id], present, budget(500)).block;
  for (const e of p.approved_extras) blocks[e.character_id] = buildWireBlock(s, [e.character_id], present, budget(220)).block;
  return { ...input, party_context_blocks: blocks };
}
function dialog(enabled: boolean, c = room, scene = dialogInput.scene, limit = contextTokens) {
  const s = source(enabled, c), input = { ...dialogInput, scene, omit_cards: !!s };
  const plan = planDialogBeat(input), legacy = planDialogBeat({ ...input, omit_cards: false });
  const built = buildDialogPrompt(db, c, [], plan.pass_s, input.user_text, limit, 'mock', { instruction: null }, scene,
    s ? { source: s, allowedIds: plan.speakers.map(sp => sp.id), presentIds: wirePresentIds(input.cast, plan.applied.state), legacyPassS: legacy.pass_s } : null);
  return { built, plan };
}
function onlyScenarios(text: string, ids: string[]) {
  for (const card of fixture.cards) {
    if (ids.includes(card.key)) a.ok(text.includes(`WIRE_SCN_${card.key}`), card.key);
    else a.ok(!text.includes(`WIRE_SCN_${card.key}`), `unexpected scenario ${card.key}`);
  }
}
async function newRoom(format: string, setting = fixture.setting) {
  const c = await api('POST', '/api/conversations', { characterId: cast[0].id, storyId, personaId, mode: 'story', scene: { format, location: '우체국', present_ids: cast.map(c => c.id) } });
  db.prepare('UPDATE conversations SET story_setting_snapshot=? WHERE id=?').run(setting, c.id);
  return conv(c.id);
}
async function send(id: string) {
  calls.length = 0;
  return app.inject({ method: 'POST', url: `/api/conversations/${id}/messages`, payload: { content: '나리, 조건을 알려 주세요.' } });
}
async function main() {
  config.model.contextTokens = contextTokens;
  db.prepare("INSERT INTO model_profiles (name,temperature,top_p,max_tokens,stop_json,system_mode) VALUES ('rp-balanced',.8,.95,400,'[]','system')").run();
  const created = [];
  for (const card of fixture.cards) created.push(await api('POST', '/api/characters', { ...card, key: undefined, first_message: '', tags: ['party:place=우체국'] }));
  cast = created.map(c => ({ id: c.id, name: c.name, aliases: [], duties: [], place: '우체국', role: 'main' }));
  cards = Object.fromEntries(created.map(c => [c.id, c]));
  const persona = await api('POST', '/api/personas', { name: '방문자' }); personaId = persona.id;
  const story = await api('POST', '/api/stories', { name: fixture.name, setting: fixture.setting, minor_cast: fixture.minorCast, scene_catalog: { places: [{ id: '우체국' }] } }); storyId = story.id;
  for (const [i, c] of cast.entries()) await api('POST', `/api/stories/${storyId}/characters`, { characterId: c.id, sortOrder: i });
  room = await newRoom('dialog');
  const scene: Scene = { location: '우체국', present_ids: cast.map(c => c.id) };
  const catalog = catalogFromStory(JSON.stringify({ places: [{ id: '우체국', default_focus: cast[0].id }] }));
  beatInput = { scene, catalog, current_version: 0, user_text: '나리, 조건을 알려 주세요.', user_name: '방문자', cast, cards, main_character_id: cast[0].id, story_room: true, participant_ids: cast.map(c => c.id) };
  dialogInput = { ...beatInput, separate_user_input: true };

  await t('off preserves N/F/E and dialog bytes with absent or null optional inputs', () => {
    config.partyContext = false;
    const off = wiredBeat(beatInput, config.partyContext), plan = planBeat(off), legacy = planBeat(beatInput);
    a.equal(plan.pass_n, legacy.pass_n); a.equal(plan.pass_f, legacy.pass_f);
    a.deepEqual(planPassE(off, plan, '서술', '답변'), planPassE(beatInput, legacy, '서술', '답변'));
    a.ok(plan.approved_extras.length > 0);
    a.equal(passFWith(off, plan, '서술'), passFWith(beatInput, legacy, '서술'));
    a.doesNotMatch(plan.pass_n + plan.pass_f, /## 다대일 공통 맥락/);
    const d = dialog(config.partyContext);
    const plain = buildDialogPrompt(db, room, [], planDialogBeat(dialogInput).pass_s, beatInput.user_text, contextTokens, 'mock', { instruction: null }, scene);
    a.deepEqual(d.built.messages, plain.messages); a.deepEqual(d.built.budget, plain.budget);
    a.doesNotMatch(JSON.stringify(d.built.messages), /## 다대일 공통 맥락/);
    a.equal(preparePartyContextWire(db, { ...room, story_applied_at: null }, cast, '방문자', true), null);
  });
  await t('environment flag enables only exact 1', () => {
    for (const [value, expected] of [['0', 'false'], ['true', 'false'], ['', 'false'], ['1', 'true']]) {
      const actual = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import {config} from './apps/server/src/config.ts'; console.log(config.partyContext)"], { encoding: 'utf8', env: { ...process.env, RPCHAT_PARTY_CONTEXT: value } });
      a.equal(actual.trim(), expected);
    }
  });
  await t('F includes whole setting, only focus scenario, names and substituted macros', () => {
    const input = wiredBeat(beatInput, true), plan = planBeat(input), text = passFWith(input, plan, '서술')!;
    a.equal(plan.focus.focus_id, cast[0].id); a.match(text, /WIRE_SETTING_HEAD 방문자/); a.match(text, /WIRE_SETTING_TAIL/);
    onlyScenarios(text, ['a']); a.match(text, /나리와 방문자의 합성 배경/); a.doesNotMatch(text, /\{\{(?:char|user)\}\}/);
    for (const c of cast) a.ok(text.includes(c.name));
  });
  await t('E contains only its own permitted scenario', () => {
    const input = wiredBeat(beatInput, true), plan = planBeat(input), extras = planPassE(input, plan, '서술', '답변');
    a.ok(extras.length > 0);
    for (const e of extras) onlyScenarios(e.prompt, [fixture.cards[cast.findIndex(c => c.id === e.character_id)].key]);
  });
  await t('N contains focus scenario; no-focus N contains setting without scenarios', () => {
    a.match(planBeat(wiredBeat(beatInput, true)).pass_n, /WIRE_SCN_a/);
    const input = { ...beatInput, user_text: '방 안을 둘러본다.' }, plan = planBeat(wiredBeat(input, true));
    a.equal(plan.focus.focus_id, null); a.match(plan.pass_n, /WIRE_SETTING_HEAD/); onlyScenarios(plan.pass_n, []);
  });
  await t('scene delta prompt is unchanged and has no story canary', () => {
    const before = renderSceneDeltaPrompt({ scene, catalog, userText: beatInput.user_text });
    wiredBeat(beatInput, true);
    a.equal(renderSceneDeltaPrompt({ scene, catalog, userText: beatInput.user_text }), before); a.doesNotMatch(before, /WIRE_SETTING_HEAD/);
  });
  await t('F/E common context replaces legacy card blocks', () => {
    const input = wiredBeat(beatInput, true), plan = planBeat(input);
    a.doesNotMatch(plan.pass_f!, /### 캐릭터: /);
    for (const e of planPassE(input, plan, '서술', '답변')) a.doesNotMatch(e.prompt, /### 캐릭터: /);
  });
  await t('dialog on retains setting tail that legacy F8b actually truncates', () => {
    const on = dialog(true), off = dialog(false);
    a.match(on.built.messages[0].content, /WIRE_SETTING_TAIL/); a.doesNotMatch(off.built.messages[0].content, /WIRE_SETTING_TAIL/);
    a.ok(off.built.budget.sections.some(s => s.note?.includes('절단')));
    a.ok(on.built.budget.est_total <= on.built.budget.available);
    const s = on.built.budget.sections.find(s => s.name === '페르소나+유저노트+스토리 설정')!;
    a.equal(s.kind, 'story'); a.ok(s.est_tokens > 0);
  });
  await t('dialog S includes allowed scenarios only with no duplicate card list', () => {
    const on = dialog(true); a.equal(on.plan.speakers.length, 3); a.doesNotMatch(on.plan.pass_s, /## 등장인물/);
    onlyScenarios(on.built.messages[0].content, on.plan.speakers.map(sp => fixture.cards[cast.findIndex(c => c.id === sp.id)].key));
  });
  await t('nonempty actor/narrator requests preserve exact bytes on/off', () => {
    const root = insertMessage(db, room.id, null, 'user', '과거 합성 입력', 'complete'); setHead(db, room.id, root.id);
    const entries = [ ['private-a', [cast[0].id], 'WIRE_PRIVATE_ACTOR'], ['private-n', [], 'WIRE_PRIVATE_NARRATOR'] ].map(([id, known_by, text]) => {
      db.prepare("INSERT INTO memories(id,conversation_id,content,source,status,importance,scope,evidence_message_ids_json,created_at,updated_at) VALUES(?,?,?,'user','pinned',3,'conversation',?,'2026-01-01','2026-01-01')").run(id, room.id, text, JSON.stringify([root.id]));
      return { memory_id: id, anchor_message_id: root.id, kind: 'fact', known_by, status: 'active' };
    });
    const scoped = { ...scene, dialog_context: { version: 1 as const, entries } } as Scene;
    const s = source()!, legacy = planDialogBeat({ ...dialogInput, scene: scoped }), plan = planDialogBeat({ ...dialogInput, scene: scoped, omit_cards: true });
    const old = buildDialogPrompt(db, room, [root], legacy.pass_s, beatInput.user_text, 32768, 'mock', { instruction: null }, scoped);
    const on = buildDialogPrompt(db, room, [root], plan.pass_s, beatInput.user_text, 32768, 'mock', { instruction: null }, scoped, { source: s, allowedIds: plan.speakers.map(sp => sp.id), presentIds: cast.map(c => c.id), legacyPassS: legacy.pass_s });
    a.ok(old.actor_requests.length > 0); a.ok(old.narrator_request);
    a.deepEqual(on.actor_requests, old.actor_requests); a.deepEqual(on.narrator_request, old.narrator_request);
    a.doesNotMatch(on.messages[0].content, /WIRE_PRIVATE_ACTOR|WIRE_PRIVATE_NARRATOR/);
  });
  await t('minor formatting matches builder coercion and drops invalid/empty objects', () => {
    const items = [{ name: '  갑 ', note: ' 메모 ' }, { name: '', note: '내용만' }, { name: '이름만', note: '' }, { name: '', note: '' }, null, 'invalid', 1];
    a.deepEqual(items.map(wireMinorLine), ['- 갑: 메모', '- : 내용만', '- 이름만: ', null, null, null, null]);
    const legacy = computeStoryInjection({ name: '', setting: '', minorCast: items }, 20000, 0, 1, '', '방문자')!;
    for (const line of items.map(wireMinorLine).filter(v => v !== null)) a.ok(legacy.text.includes(line));
    a.doesNotMatch(legacy.text, /invalid/);
    const s = source()!; a.equal(s.storySnapshot.minorCast.length, 3); a.match(s.storySnapshot.minorCast[1], /방문자/);
  });
  for (const format of ['beat', 'dialog']) await t(`${format} preflight rejects overflow before any model request and reclaims user`, async () => {
    config.partyContext = true;
    const c = await newRoom(format, fixture.overflowSetting), before = messages(c.id);
    const r = await send(c.id);
    a.equal(calls.length, 0, 'preflight must precede scene delta'); a.equal(r.statusCode, 422, r.body);
    a.equal(r.json().code, 'party_context_overflow'); a.ok(Number.isInteger(r.json().shortfall_tokens) && r.json().shortfall_tokens > 0);
    a.deepEqual(messages(c.id), before); a.equal(conv(c.id).head_message_id, c.head_message_id);
    a.equal(conv(c.id).scene_json, c.scene_json);
  });
  await t('off accepts the same oversized snapshot through legacy generation', async () => {
    config.partyContext = false;
    for (const format of ['beat', 'dialog']) {
      const c = await newRoom(format, fixture.overflowSetting), r = await send(c.id);
      a.equal(r.statusCode, 200, r.body); a.ok(calls.length > 0); a.ok(r.body.includes('"type":"done"'), r.body);
      a.doesNotMatch(calls.map(c => JSON.stringify(c.messages)).join('\n'), /## 다대일 공통 맥락/);
    }
  });
  await t('normal generation logs on-only N/F diagnostics without SSE addition', async () => {
    for (const enabled of [true, false]) {
      config.partyContext = enabled;
      const c = await newRoom('beat'), r = await send(c.id);
      a.equal(r.statusCode, 200, r.body); a.ok(r.body.includes('"type":"done"'), r.body);
      const log = db.prepare("SELECT budget_json FROM generation_log WHERE conversation_id=? AND finish_reason='beat' ORDER BY rowid DESC LIMIT 1").get(c.id) as { budget_json: string };
      const b = JSON.parse(log.budget_json);
      if (enabled) {
        a.equal(b.party_context.share, .5); a.ok(b.party_context.requests.some((v: any) => v.pass === 'N')); a.ok(b.party_context.requests.some((v: any) => v.pass === 'F'));
        for (const v of b.party_context.requests) { a.equal(v.diagnostics.usage, null); a.deepEqual(v.diagnostics.requestRecipients, ['public']); }
      } else a.equal(Object.hasOwn(b, 'party_context'), false);
      a.doesNotMatch(r.body, /"party_context"/);
      for (const request of calls.filter(p => p.max_tokens === 200)) a.doesNotMatch(JSON.stringify(request.messages), /WIRE_SETTING_HEAD/);
    }
  });
  await t('block construction is deterministic with pass-specific limits', () => {
    const s = source()!, ids = cast.map(c => c.id);
    a.deepEqual(buildWireBlock(s, [ids[0]], ids, budget(500)), buildWireBlock(s, [ids[0]], ids, budget(500)));
    a.equal(budget(300).inputLimitTokens, 3914); a.equal(budget(500).inputLimitTokens, 3814); a.equal(budget(220).inputLimitTokens, 3954);
    preflightWire(s, 1, budget(500)); preflightWire(s, 3, { ...budget(900), inputLimitTokens: 3614 });
    console.log('wire limits', JSON.stringify({ N: 3914, F: 3814, E: 3954, beat_preflight: 3814, S: 3614, dialog_preflight: 3614, calibration: 1 }));
  });
  await t('one-to-one templates and PROMPT_VERSION remain unchanged (builder.ts is guarded by the 1:1 byte benches)', () => {
    a.equal(execFileSync('git', ['diff', BASE, '--', 'apps/server/src/prompt/templates.ts'], { encoding: 'utf8' }), '');
    const original = execFileSync('git', ['show', `${BASE}:apps/server/src/config.ts`], { encoding: 'utf8' });
    const now = fs.readFileSync('apps/server/src/config.ts', 'utf8');
    a.equal(now.match(/^export const PROMPT_VERSION.*$/m)?.[0], original.match(/^export const PROMPT_VERSION.*$/m)?.[0]);
  });
  a.equal(passed, 17); console.log(`partyContextWire: ${passed} checks, ${assertions} assertions`);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  config.partyContext = saved.flag; config.model.contextTokens = saved.context;
  await app.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true });
});
