/** npx tsx bench/adventureInvalidState.test.ts */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { chatRoutes } from '../apps/server/src/routes/chat.ts';
import { adventureRoutes } from '../apps/server/src/routes/adventure.ts';
import { adventureStateIssue, INVALID_ADVENTURE_MESSAGE, renderAdventureState } from '../apps/server/src/adventure/state.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}
const T = '2026-10-15 00:00:00';
const PROMPT = '2026.08.22-r1+story+compact+roster+opening';
const USER_CANARY = 'USER_CANARY_7Q';
const ADV_CANARY = 'ADV_CANARY_7Q';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-invalid-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
let calls = 0;
const seen: string[] = [];
const fastifyChunks: string[] = [];
const ctxWarns: unknown[][] = [];
const logStream = new Writable({
  write(chunk, _enc, cb) {
    fastifyChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    cb();
  },
});
const model = {
  complete: async (p: GenParams): Promise<GenResult> => {
    calls++;
    seen.push(p.messages.map((m) => m.content).join('\n'));
    return { text: 'null', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
  },
  stream: async (p: GenParams, cb: (d: string) => void) => {
    calls++;
    seen.push(p.messages.map((m) => m.content).join('\n'));
    cb('나리 | 응답');
    return { text: '나리 | 응답', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
  },
  listModels: async () => ['test-model'],
};
const ctx = {
  db, model, queue: new GenerationQueue(1),
  log: {
    error() {}, info() {}, debug() {},
    warn(...args: unknown[]) { ctxWarns.push(args); },
  },
  resolvedModel: () => 'test-model', setResolvedModel() {},
  health: async () => ({ ok: true, checkedAt: T, latencyMs: 0, models: ['test-model'] }),
  effectiveDataDir: tmp,
} as unknown as Ctx;
const app = Fastify({ logger: { level: 'warn', stream: logStream } });
async function main() {
for (const route of [characterRoutes, conversationRoutes, chatRoutes, adventureRoutes]) await app.register(route(ctx));

let snapshotReads = 0;
function S(id: string): string {
  const stored = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown>;
  assert.ok(stored, `conversation ${id} exists`);
  console.log(`diag timestamps ${JSON.stringify({ read: ++snapshotReads, conversationId: id, updated_at: stored.updated_at, last_message_at: stored.last_message_at })}`);
  const conv = { ...stored };
  delete conv.updated_at;
  delete conv.last_message_at;
  assert.deepEqual(Object.keys(stored).filter(key => !(key in conv)).sort(), ['last_message_at', 'updated_at']);
  assert.deepEqual(Object.keys(conv), Object.keys(stored).filter(key => key !== 'updated_at' && key !== 'last_message_at'));
  for (const key of Object.keys(conv)) assert.deepEqual(conv[key], stored[key], `S retains ${key}`);
  const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(id);
  return JSON.stringify({ conv, msgs });
}
function sDiff(before: string, after: string): string {
  if (before === after) return '';
  const b = JSON.parse(before) as { conv: Record<string, unknown> | null; msgs: unknown[] };
  const a = JSON.parse(after) as { conv: Record<string, unknown> | null; msgs: unknown[] };
  const keys = new Set([...Object.keys(b.conv ?? {}), ...Object.keys(a.conv ?? {})]);
  const cols = [...keys].filter((k) => JSON.stringify(b.conv?.[k]) !== JSON.stringify(a.conv?.[k]));
  const msgs = JSON.stringify(b.msgs) === JSON.stringify(a.msgs) ? '' : ' msgs';
  return `${cols.map((k) => `conv.${k}`).join(',')}${msgs}`;
}
function resetLogs() {
  fastifyChunks.length = 0;
  ctxWarns.length = 0;
}
function warnRecords(): Array<Record<string, unknown>> {
  const recs: Array<Record<string, unknown>> = [];
  for (const line of fastifyChunks.join('').split('\n')) {
    if (!line.trim()) continue;
    try { recs.push(JSON.parse(line) as Record<string, unknown>); }
    catch { recs.push({ msg: line, unparsed: true }); }
  }
  for (const args of ctxWarns) recs.push({ source: 'ctx', args });
  return recs;
}
function combinedLogText(): string {
  return JSON.stringify({ fastify: fastifyChunks.join(''), ctx: ctxWarns });
}
const PINO_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'v', 'reqId', 'req']);
function logProblems(conversationId: string, headId: string | null): string[] {
  const recs = warnRecords();
  const problems: string[] = [];
  if (recs.length !== 1) problems.push(`warns ${recs.length} ${combinedLogText().slice(0, 500)}`);
  else {
    const rec = recs[0];
    if (rec.msg !== 'invalid adventure state refused') problems.push(`msg ${String(rec.msg)}`);
    if (rec.code !== 'invalid_adventure_state') problems.push(`code ${String(rec.code)}`);
    if (rec.conversationId !== conversationId) problems.push(`conversationId ${String(rec.conversationId)}`);
    if (rec.headId !== headId) problems.push(`headId ${String(rec.headId)} expected ${String(headId)}`);
    const extra = Object.keys(rec).filter((k) => !PINO_KEYS.has(k) && k !== 'code' && k !== 'conversationId' && k !== 'headId');
    if (extra.length) problems.push(`extra ${extra.join(',')}`);
  }
  const blob = combinedLogText();
  const adv = blob.split(ADV_CANARY).length - 1;
  const user = blob.split(USER_CANARY).length - 1;
  if (adv !== 0) problems.push(`ADV_CANARY x${adv}`);
  if (user !== 0) problems.push(`USER_CANARY x${user}`);
  return problems;
}

function seed(id: string, adventure: unknown) {
  db.prepare(`INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, archived, created_at, updated_at, play_guide) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`).run(id + '-c', '나리', '창가', '설명', '성격', '말투', '장면', '', '', '', '[]', T, T, '');
  const scene = adventure === undefined ? { scene_version: 0 } : { scene_version: 0, adventure };
  db.prepare(`INSERT INTO conversations (id, character_id, title, mode, profile_name, scene_json, head_message_id, prompt_version, favorite, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,0,0,?,?)`).run(id, id + '-c', id, 'chat', 'rp-balanced', JSON.stringify(scene), id + '-m', PROMPT, T, T);
  db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at) VALUES (?,?,null,'assistant','안녕','complete','{}',0,?)`).run(id + '-m', id, T);
}
function seedG1(id: string, adventure: unknown) {
  db.prepare(`INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, archived, created_at, updated_at, play_guide) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`).run(id + '-c', '나리', '창가', '설명', '성격', '말투', '장면', '', '', '', '[]', T, T, '');
  const scene: Record<string, unknown> = { scene_version: 0, marker: ADV_CANARY };
  if (adventure !== undefined) {
    scene.adventure = adventure;
  }
  db.prepare(`INSERT INTO conversations (id, character_id, title, mode, profile_name, scene_json, head_message_id, prompt_version, favorite, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,0,0,?,?)`).run(id, id + '-c', id, 'chat', 'rp-balanced', JSON.stringify(scene), id + '-m', PROMPT, T, T);
  db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at) VALUES (?,?,null,'assistant','안녕','complete','{}',0,?)`).run(id + '-m', id, T);
}
function okAdv(currency: string, balance = 11) {
  return { version: 1, revision: 1, currency, balance, registration: null, rank: '', experience: 0, skills: [] as string[], quests: [] as unknown[], items: [] as unknown[] };
}
function damagedAdv() {
  return { version: 1, revision: 1, currency: ADV_CANARY, balance: -1, registration: null, rank: '', experience: 0, skills: [] as string[], quests: [] as unknown[], items: [] as unknown[] };
}
function sceneOf(present: string[], adventure: unknown, format?: 'dialog') {
  return { scene_version: 1, location: '교실', present_ids: present, ...(format ? { format } : {}), adventure };
}
function seedParty(id: string, format: 'dialog' | undefined, cacheAdventure: unknown, afterAdventure: unknown, beforeAdventure: unknown, sibling: boolean) {
  const c1 = `${id}-c1`;
  const c2 = `${id}-c2`;
  const sid = `${id}-s`;
  db.prepare(`INSERT INTO stories (id, name, tagline, setting, minor_cast, archived, created_at, updated_at, scene_catalog, opening_json, stats_json, openings_extra_json, endings_json) VALUES (?,?,?,?,?,0,?,?,?,?,?,?,?)`).run(sid, '이야기', '', 'WORLD', '[]', T, T, '{"places":[{"id":"교실"}]}', '{}', '{}', '[]', '[]');
  for (const [cid, name, role, ord] of [[c1, '나리', 'host', 0], [c2, '세라', 'cast', 1]] as const) {
    db.prepare(`INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, archived, created_at, updated_at, play_guide) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`).run(cid, name, '창가', '설명', '성격', '말투', '장면', '', '', '', '["party:place=교실"]', T, T, '');
    db.prepare(`INSERT INTO story_characters (story_id, character_id, role, sort_order) VALUES (?,?,?,?)`).run(sid, cid, role, ord);
  }
  const present = [c1, c2];
  const snap = { schema_version: 1, before_delta: sceneOf(present, beforeAdventure, format), after_delta: sceneOf(present, afterAdventure, format) };
  const head = `${id}-a`;
  db.prepare(`INSERT INTO conversations (id, character_id, title, mode, profile_name, scene_json, head_message_id, prompt_version, favorite, archived, created_at, updated_at, story_id, story_participant_ids_snapshot) VALUES (?,?,?,?,?,?,?,?,0,0,?,?,?,?)`).run(id, c1, id, 'story', 'rp-balanced', JSON.stringify(sceneOf(present, cacheAdventure, format)), head, PROMPT, T, T, sid, JSON.stringify(present));
  db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at) VALUES (?,?,null,'assistant','나리 | 이전','complete',?,0,?)`).run(head, id, JSON.stringify({ beat_seq: 0, scene_state: snap }), T);
  if (sibling) {
    const bad = sceneOf(present, damagedAdv(), format);
    db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at) VALUES (?,?,null,'assistant','다른 가지','complete',?,0,?)`).run(`${id}-sib`, id, JSON.stringify({ beat_seq: 0, scene_state: { schema_version: 1, before_delta: bad, after_delta: bad } }), T);
  }
}
function seedG3(id: string) {
  const c1 = `${id}-c1`;
  const c2 = `${id}-c2`;
  const sid = `${id}-s`;
  db.prepare(`INSERT INTO stories (id, name, tagline, setting, minor_cast, archived, created_at, updated_at, scene_catalog, opening_json, stats_json, openings_extra_json, endings_json) VALUES (?,?,?,?,?,0,?,?,?,?,?,?,?)`).run(sid, '이야기', '', 'WORLD', '[]', T, T, '{"places":[{"id":"교실"}]}', '{}', '{}', '[]', '[]');
  for (const [cid, name, role, ord] of [[c1, '나리', 'host', 0], [c2, '세라', 'cast', 1]] as const) {
    db.prepare(`INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, archived, created_at, updated_at, play_guide) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`).run(cid, name, '창가', '설명', '성격', '말투', '장면', '', '', '', '["party:place=교실"]', T, T, '');
    db.prepare(`INSERT INTO story_characters (story_id, character_id, role, sort_order) VALUES (?,?,?,?)`).run(sid, cid, role, ord);
  }
  const present = [c1, c2];
  const damaged = sceneOf(present, damagedAdv(), 'dialog');
  const snap = { schema_version: 1, before_delta: damaged, after_delta: damaged };
  const meta = JSON.stringify({ beat_seq: 0, scene_state: snap });
  db.prepare(`INSERT INTO conversations (id, character_id, title, mode, profile_name, scene_json, head_message_id, prompt_version, favorite, archived, created_at, updated_at, story_id, story_participant_ids_snapshot) VALUES (?,?,?,?,?,?,?,?,0,0,?,?,?,?)`).run(id, c1, id, 'story', 'rp-balanced', JSON.stringify(damaged), `${id}-a1`, PROMPT, T, T, sid, JSON.stringify(present));
  db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at) VALUES (?,?,null,'assistant','나리 | 앞','complete',?,0,?)`).run(`${id}-a0`, id, meta, T);
  db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at) VALUES (?,?,?,'user',?,'complete','{}',0,?)`).run(`${id}-u`, id, `${id}-a0`, USER_CANARY, T);
  db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at) VALUES (?,?,?,'assistant','나리 | 현재','complete',?,0,?)`).run(`${id}-a1`, id, `${id}-u`, meta, T);
}

db.prepare(`INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, instruction_enabled) VALUES ('rp-balanced', 'test-model', 0.8, 0.95, 400, '[]', 'system', 0)`).run();
seed('absent', undefined);
seed('bad', { version: 2 });
seed('zero', 0);
seed('text', 'broken');
seed('arr', []);
seed('other', undefined);

await t('absent adventure still generates and does not use the invalid code', async () => {
  calls = 0;
  const before = db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get('absent') as { scene_json: string };
  const otherBefore = S('other');
  const res = await app.inject({ method: 'POST', url: '/api/conversations/absent/messages', payload: { content: '안녕' } });
  assert.ok(res.statusCode < 500, res.body.slice(0, 200));
  assert.equal(res.body.includes('invalid_adventure_state'), false);
  assert.ok(calls > 0, 'model was called');
  assert.equal(S('other'), otherBefore);
  assert.equal(before.scene_json.includes('adventure'), false);
});

for (const id of ['bad', 'zero', 'text', 'arr']) {
  await t(`invalid ${id} is 409 and preserves the row`, async () => {
    calls = 0;
    const before = db.prepare('SELECT scene_json, head_message_id FROM conversations WHERE id = ?').get(id) as { scene_json: string; head_message_id: string };
    const msgs = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(id) as { n: number };
    const res = await app.inject({ method: 'POST', url: `/api/conversations/${id}/messages`, payload: { content: '안녕' } });
    assert.equal(res.statusCode, 409, res.body.slice(0, 300));
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'invalid_adventure_state');
    assert.equal(body.error, INVALID_ADVENTURE_MESSAGE);
    assert.equal(calls, 0);
    const after = db.prepare('SELECT scene_json, head_message_id FROM conversations WHERE id = ?').get(id) as { scene_json: string; head_message_id: string };
    assert.equal(after.scene_json, before.scene_json);
    assert.equal(after.head_message_id, before.head_message_id);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(id) as { n: number }).n, msgs.n);
  });
}

await t('other room still generates after an invalid room was refused', async () => {
  calls = 0;
  const res = await app.inject({ method: 'POST', url: '/api/conversations/other/messages', payload: { content: '다른 방' } });
  assert.ok(res.statusCode < 500, res.body.slice(0, 200));
  assert.equal(res.body.includes('invalid_adventure_state'), false);
  assert.ok(calls > 0);
});

await t('state API does not treat a broken object as empty initialize', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/conversations/bad/adventure-actions', payload: {
    expected_head_id: 'bad-m', expected_scene_version: 0, idempotency_key: '11111111-1111-1111-1111-111111111111',
    action: { kind: 'initialize', currency: '원', balance: 1, rank: '', experience: 0, skills: [] },
  } });
  assert.equal(res.statusCode, 409, res.body.slice(0, 300));
  assert.equal(JSON.parse(res.body).code, 'invalid_adventure_state');
  const row = db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get('bad') as { scene_json: string };
  assert.equal(JSON.parse(row.scene_json).adventure.version, 2);
});

await t('G1 absent key still generates', async () => {
  seedG1('g1-absent', undefined);
  calls = 0;
  const res = await app.inject({ method: 'POST', url: '/api/conversations/g1-absent/messages', payload: { content: '안녕' } });
  assert.ok(res.statusCode < 500, res.body.slice(0, 200));
  assert.equal(res.body.includes('invalid_adventure_state'), false);
  assert.ok(calls > 0, 'model was called');
});

const items61 = {
  version: 1, revision: 1, currency: ADV_CANARY, balance: 1, registration: null, rank: '', experience: 0, skills: [] as string[],
  quests: [] as unknown[],
  items: Array.from({ length: 61 }, (_, i) => ({ id: `i${i}`, name: `물품${i}`, quantity: 1, ownership: 'owned', owner: '나리', terms: '보유', source: '획득' })),
};
const g1Cases: Array<[string, unknown]> = [
  ['null', null],
  ['false', false],
  ['zero', 0],
  ['empty', ''],
  ['arr', []],
  ['obj', {}],
  ['neg', { version: 1, revision: 1, currency: ADV_CANARY, balance: -1, registration: null, rank: '', experience: 0, skills: [], quests: [], items: [] }],
  ['items', items61],
  ['stage', { version: 1, revision: 1, currency: ADV_CANARY, balance: 1, registration: null, rank: '', experience: 0, skills: [], quests: [{ id: 'q', title: '의뢰', terms: '조건', reward: null, stage: 'bogus' }], items: [] }],
  ['extra', { version: 1, revision: 1, currency: '원', balance: 1, registration: null, rank: '', experience: 0, skills: [], quests: [], items: [], extra: ADV_CANARY }],
];
const g1Controls: Array<[string, unknown]> = [
  ['neg', okAdv(ADV_CANARY, 0)],
  ['items', { ...items61, items: items61.items.slice(0, 60) }],
  ['stage', { ...okAdv(ADV_CANARY, 1), quests: [{ id: 'q', title: '의뢰', terms: '조건', reward: null, stage: 'offered' }] }],
  ['extra', okAdv('원', 1)],
];
for (const [suffix, control] of g1Controls) {
  await t(`G1 ${suffix} control isolates the invalid field`, () => {
    assert.equal(adventureStateIssue(control), 'ok', suffix);
    assert.equal(adventureStateIssue(g1Cases.find(([name]) => name === suffix)![1]), 'invalid', suffix);
  });
}
for (const [suffix, adventure] of g1Cases) {
  const id = `g1-${suffix}`;
  seedG1(id, adventure);
  await t(`G1 ${suffix} is 409, calls 0, S preserved, one warn`, async () => {
    calls = 0;
    const before = S(id);
    const otherBefore = S('other');
    resetLogs();
    const res = await app.inject({ method: 'POST', url: `/api/conversations/${id}/messages`, payload: { content: USER_CANARY } });
    const body = JSON.parse(res.body) as { code?: string; error?: string };
    const problems: string[] = [];
    if (res.statusCode !== 409) problems.push(`status ${res.statusCode} ${res.body.slice(0, 180)}`);
    if (body.code !== 'invalid_adventure_state') problems.push(`code ${String(body.code)}`);
    if (body.error !== INVALID_ADVENTURE_MESSAGE) problems.push('error text');
    if (calls !== 0) problems.push(`calls ${calls}`);
    const after = S(id);
    if (after !== before) problems.push(`S ${sDiff(before, after)}`);
    if (S('other') !== otherBefore) problems.push('other S');
    problems.push(...logProblems(id, `${id}-m`));
    const ct = String(res.headers['content-type'] ?? '');
    if (!ct.startsWith('application/json')) problems.push(`ct ${ct}`);
    assert.equal(problems.length, 0, problems.join(' | '));
  });
}

async function assertBranchRefusal(id: string, headId: string) {
  calls = 0;
  const before = S(id);
  const otherBefore = S('other');
  resetLogs();
  const res = await app.inject({ method: 'POST', url: `/api/conversations/${id}/messages`, payload: { content: USER_CANARY } });
  const body = JSON.parse(res.body) as { code?: string };
  const problems: string[] = [];
  if (res.statusCode !== 409 || body.code !== 'invalid_adventure_state') problems.push(`status ${res.statusCode} ${res.body.slice(0, 180)}`);
  if (calls !== 0) problems.push(`calls ${calls}`);
  const after = S(id);
  if (after !== before) problems.push(`S ${sDiff(before, after)}`);
  if (S('other') !== otherBefore) problems.push('other S');
  problems.push(...logProblems(id, headId));
  assert.equal(problems.length, 0, problems.join(' | '));
}

for (const format of [undefined, 'dialog'] as const) {
  const label = format ?? 'beat';
  const bad = `g2-${label}-bad`;
  seedParty(bad, format, damagedAdv(), damagedAdv(), damagedAdv(), false);
  await t(`G2 ${label} damaged current snapshot is 409 and preserves S`, async () => {
    await assertBranchRefusal(bad, `${bad}-a`);
  });

  const cached = `g2-${label}-cache`;
  const good = okAdv('원A', 11);
  seedParty(cached, format, damagedAdv(), good, good, false);
  await t(`G2 ${label} cache damage with valid snapshot A still generates rendered A`, async () => {
    calls = 0;
    seen.length = 0;
    const res = await app.inject({ method: 'POST', url: `/api/conversations/${cached}/messages`, payload: { content: '나리, 계속' } });
    assert.equal(res.body.includes('invalid_adventure_state'), false, res.body.slice(0, 240));
    assert.ok(calls > 0, `status ${res.statusCode} body ${res.body.slice(0, 240)}`);
    const rendered = renderAdventureState(good as never);
    assert.ok(rendered, 'renderAdventureState(A)');
    assert.ok(seen.join('\n').includes(rendered!), 'prompt missing renderAdventureState(A)');
  });

  const other = `g2-${label}-other`;
  seedParty(other, format, good, good, good, true);
  await t(`G2 ${label} other-branch damage still generates`, async () => {
    calls = 0;
    const res = await app.inject({ method: 'POST', url: `/api/conversations/${other}/messages`, payload: { content: '나리, 계속' } });
    assert.equal(res.body.includes('invalid_adventure_state'), false, res.body.slice(0, 240));
    assert.ok(calls > 0, `status ${res.statusCode} body ${res.body.slice(0, 240)}`);
  });
}

seedG3('g3');
const g3Routes: Array<[string, string, Record<string, unknown>]> = [
  ['messages', '/api/conversations/g3/messages', { content: USER_CANARY }],
  ['regenerate', '/api/conversations/g3/regenerate', { messageId: 'g3-a1', content: USER_CANARY }],
  ['branch', '/api/conversations/g3/branch', { messageId: 'g3-u', content: USER_CANARY }],
  ['continue', '/api/conversations/g3/continue', { messageId: 'g3-a1' }],
];
for (const [name, url, payload] of g3Routes) {
  await t(`G3 ${name} is 409 json, calls 0, S preserved, one warn`, async () => {
    calls = 0;
    const before = S('g3');
    const otherBefore = S('other');
    resetLogs();
    const res = await app.inject({ method: 'POST', url, payload });
    let code = '';
    try { code = (JSON.parse(res.body) as { code?: string }).code ?? ''; } catch { code = 'non-json'; }
    const ct = String(res.headers['content-type'] ?? '');
    const problems: string[] = [];
    if (res.statusCode !== 409) problems.push(`status ${res.statusCode} body ${res.body.slice(0, 220)}`);
    if (code !== 'invalid_adventure_state') problems.push(`code ${code}`);
    if (calls !== 0) problems.push(`calls ${calls}`);
    const after = S('g3');
    if (after !== before) problems.push(`S ${sDiff(before, after)}`);
    if (S('other') !== otherBefore) problems.push('other S');
    if (!ct.startsWith('application/json')) problems.push(`ct ${ct}`);
    if (res.body.split('\n').some((line) => line.startsWith('data:'))) problems.push('sse line');
    problems.push(...logProblems('g3', 'g3-a1'));
    console.log(`diag G3 ${name} status=${res.statusCode} calls=${calls} ct=${ct} s=${sDiff(before, after) || 'same'} warns=${warnRecords().length}`);
    assert.equal(problems.length, 0, problems.join(' | '));
  });
}

seedG1('g5', { version: 2, leak: ADV_CANARY });
const g5Actions = [
  ['initialize', { kind: 'initialize', currency: '원', balance: 1, rank: '', experience: 0, skills: [] }],
  ['register', { kind: 'register', organization: '길드', fee: 1 }],
  ['payment', { kind: 'payment', direction: 'pay', amount: 1, counterpart: '상점', reason: '물품' }],
] as const;
for (const [name, action] of g5Actions) {
  await t(`G5 ${name} on damaged state is 409 and preserves S`, async () => {
    calls = 0;
    const before = S('g5');
    const otherBefore = S('other');
    resetLogs();
    const res = await app.inject({ method: 'POST', url: '/api/conversations/g5/adventure-actions', payload: {
      expected_head_id: 'g5-m', expected_scene_version: 0, idempotency_key: randomUUID(), action,
    } });
    const body = JSON.parse(res.body) as { code?: string; error?: string };
    const problems: string[] = [];
    if (res.statusCode !== 409) problems.push(`status ${res.statusCode} ${res.body.slice(0, 180)}`);
    if (body.code !== 'invalid_adventure_state') problems.push(`code ${String(body.code)}`);
    if (body.error !== INVALID_ADVENTURE_MESSAGE) problems.push('error text');
    if (calls !== 0) problems.push(`calls ${calls}`);
    const after = S('g5');
    if (after !== before) problems.push(`S ${sDiff(before, after)}`);
    if (S('other') !== otherBefore) problems.push('other S');
    problems.push(...logProblems('g5', 'g5-m'));
    assert.equal(problems.length, 0, problems.join(' | '));
  });
}

await t('G5 schema-invalid action is 400 and preserves S', async () => {
  const before = S('g5');
  const otherBefore = S('other');
  resetLogs();
  const res = await app.inject({ method: 'POST', url: '/api/conversations/g5/adventure-actions', payload: { action: { kind: 'nope' } } });
  assert.equal(res.statusCode, 400, res.body.slice(0, 200));
  assert.equal(S('g5'), before, sDiff(before, S('g5')));
  assert.equal(S('other'), otherBefore);
});

await app.close();
console.log(`ok ${passed} done`);
}
main().catch((err) => { console.error(err); process.exit(1); });
