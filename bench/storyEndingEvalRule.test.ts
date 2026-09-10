/** npx tsx bench/storyEndingEvalRule.test.ts
 * ADR-F8h Slice 2 (story-ending-eval-rule): rule-only evaluator (LLM 0회) +
 * suggestion read + confirm re-validation (403/409, no 410) + idempotency.
 * Isolated: temp DB, ctx.model = {} (no model call possible), no systemd,
 * no live DB. No migration (conditions rides inside endings_json).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.ts';
import { setHead, insertMessage } from '../apps/server/src/db/tree.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import { EVALUATION_VERSION, countUserTurns, evalEndingRules } from '../apps/server/src/endingEval.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

async function main() {
  const evalSrc = fs.readFileSync('apps/server/src/endingEval.ts', 'utf8');
  const convSrc = fs.readFileSync('apps/server/src/routes/conversations.ts', 'utf8');

  await t('rule module never reads scene.turn_no (dialog/hunter counter, beat-absent)', () => {
    // Fence binds on code, not prose: the ADR reference above names turn_no.
    const code = evalSrc
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    assert.equal(code.includes('turn_no'), false);
  });

  await t('rule module cannot call the model: no model/queue/builder/fetch import', () => {
    assert.equal(/from\s+['"]\.\.\/(model|prompt\/builder)/.test(evalSrc), false);
    assert.equal(evalSrc.includes('GenerationQueue'), false);
    assert.equal(evalSrc.includes('fetch('), false);
    assert.equal(evalSrc.includes('ctx.model'), false);
  });

  await t('EVALUATION_VERSION is 1, integer server constant', () => {
    assert.equal(EVALUATION_VERSION, 1);
  });

  await t('countUserTurns is role-based: assistants never count, OOC excluded', () => {
    const rows = [
      { role: 'user', meta_json: '{}' },
      { role: 'assistant', meta_json: '{}' },
      { role: 'assistant', meta_json: '{}' },
      { role: 'assistant', meta_json: '{}' },
      { role: 'user', meta_json: '{"ooc":true}' },
      { role: 'user', meta_json: '{}' },
    ] as Parameters<typeof countUserTurns>[0];
    assert.equal(countUserTurns(rows), 2);
  });

  await t('conditions absent = not a candidate; narrative_hint never gates rules', () => {
    const r = evalEndingRules({ stats: { a: 1 } }, 99, undefined);
    assert.equal(r.candidate, false);
    assert.equal(r.pass, false);
    const h = evalEndingRules({}, 0, { narrative_hint: '무언가' });
    assert.equal(h.candidate, true);
    assert.equal(h.pass, true);
    assert.equal(h.ruleCount, 0);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-ending-eval-rule-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  const ctx = {
    db,
    model: {} as unknown as Ctx['model'],
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
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${(app.addresses()[0] as { port: number }).port}`;

  async function api(method: string, url: string, body?: unknown) {
    const res = await fetch(`${origin}${url}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, text };
  }

  const seenCodes = new Set<number>();
  const track = <T>(r: { status: number; json: T; text: string }) => { seenCodes.add(r.status); return r; };

  const ch = (await api('POST', '/api/characters', { name: '하연', personality: '반장', first_message: '인사' })).json as { id: string };
  const st = await api('POST', '/api/stories', { name: '교실', setting: '학교' });
  assert.equal(st.status, 201, st.text);
  const story = st.json as { id: string };
  const base = { name: '교실', tagline: '', setting: '학교', minor_cast: [] };
  const put = await api('PUT', `/api/stories/${story.id}`, {
    ...base,
    endings: [
      { id: 'e2', title: '두 번째 방과후', conditions: { min_turns: 2 } },
      { id: 'e3', title: '세 번째 방과후', conditions: { min_turns: 3 } },
      { id: 'stat', title: '우등상', conditions: { required_stats: { affection: { gte: 70 } } } },
      { id: 'lte', title: '잠행상', conditions: { required_stats: { suspicion: { lte: 20 } } } },
      { id: 'flag', title: '열쇠', conditions: { required_flags: ['met_sister'] } },
      { id: 'free', title: '열린 결말' },
    ],
  });
  assert.equal(put.status, 200, put.text);

  const room = await api('POST', '/api/conversations', { characterId: ch.id, storyId: story.id, mode: 'story' });
  assert.equal(room.status, 201, room.text);
  const roomId = (room.json as { id: string }).id;

  const sugg = (id: string) => api('GET', `/api/conversations/${id}/ending-suggestions`);
  const ids = (s: { suggestions: Array<{ ending_id: string }> }) => s.suggestions.map((x) => x.ending_id);
  const setScene = (id: string, scene: unknown) =>
    db.prepare('UPDATE conversations SET scene_json = ? WHERE id = ?').run(JSON.stringify(scene), id);

  const greet = db.prepare('SELECT head_message_id AS h FROM conversations WHERE id = ?').get(roomId) as { h: string };
  const u1 = insertMessage(db, roomId, greet.h, 'user', '첫 대사', 'complete', {});
  const a1 = insertMessage(db, roomId, u1.id, 'assistant', '응답', 'complete', {});
  setHead(db, roomId, a1.id);

  await t('1 user turn: min_turns:2 not suggested; turn_id echoes head', async () => {
    const r = await sugg(roomId);
    assert.equal(r.status, 200, r.text);
    const body = r.json as { turn_id: string; evaluation_version: number; suggestions: Array<{ ending_id: string; title: string; turn_id: string; evaluation_version: number; rule_count: number }> };
    assert.deepEqual(ids(body), []);
    assert.equal(body.turn_id, a1.id);
    assert.equal(body.evaluation_version, 1);
  });

  const u2 = insertMessage(db, roomId, a1.id, 'user', 'OOC 메모', 'complete', { ooc: true });
  const a2 = insertMessage(db, roomId, u2.id, 'assistant', '응답2', 'complete', {});
  setHead(db, roomId, a2.id);

  await t('OOC user msg does not count: e2 still absent, e3 absent', async () => {
    const body = (await sugg(roomId)).json as { suggestions: Array<{ ending_id: string }> };
    assert.deepEqual(ids(body), []);
  });

  const u3 = insertMessage(db, roomId, a2.id, 'user', '둘째 대사', 'complete', {});
  const a3 = insertMessage(db, roomId, u3.id, 'assistant', '응답3', 'complete', {});
  // Beat rooms emit several assistant rows per turn — count must not move.
  const a3b = insertMessage(db, roomId, a3.id, 'assistant', '나레이션', 'complete', {});
  const a3c = insertMessage(db, roomId, a3b.id, 'assistant', '대사', 'complete', {});
  setHead(db, roomId, a3c.id);

  await t('2 real turns: e2 suggested once; idempotent across calls', async () => {
    const first = (await sugg(roomId)).json as { turn_id: string; suggestions: Array<{ ending_id: string; title: string; turn_id: string; evaluation_version: number; rule_count: number }> };
    assert.deepEqual(ids(first), ['e2']);
    assert.equal(first.suggestions[0].title, '두 번째 방과후');
    assert.equal(first.suggestions[0].turn_id, a3c.id);
    assert.equal(first.suggestions[0].evaluation_version, 1);
    assert.equal(first.suggestions[0].rule_count, 1);
    assert.equal('confidence' in first.suggestions[0], false, 'confidence는 정렬·권한·임계값에 사용 금지 (관측용만)');
    const second = (await sugg(roomId)).json as typeof first;
    assert.deepEqual(second, first, 'same (room, turn, ending, version) → identical single suggestion');
  });

  await t('scene.turn_no=99 with 2 turns does not satisfy min_turns:3 (runtime proof)', async () => {
    setScene(roomId, { turn_no: 99, format: 'dialog' });
    const body = (await sugg(roomId)).json as { suggestions: Array<{ ending_id: string }> };
    assert.deepEqual(ids(body), ['e2']);
  });

  for (const format of ['beat', 'dialog', 'hunter', 'chat']) {
    const row = db.prepare('SELECT scene_json AS s FROM conversations WHERE id = ?').get(roomId) as { s: string };
    setScene(roomId, { ...JSON.parse(row.s), format });
    const body = (await sugg(roomId)).json as { suggestions: Array<{ ending_id: string }> };
    assert.deepEqual(ids(body), ['e2'], `format ${format} must not change the count`);
  }
  console.log(`ok ${++passed} turn count identical across beat/dialog/hunter/chat formats`);

  await t('missing stat = unmet (never 0): stat+lde absent, flag absent', async () => {
    setScene(roomId, { format: 'chat' });
    const r = track(await api('POST', `/api/conversations/${roomId}/end`, { endingId: 'stat' }));
    assert.equal(r.status, 403, r.text);
    assert.deepEqual((r.json as { error: string }).error, 'conditions not met');
    // lte would pass on a 0-coercion — absence must fail it too.
    const r2 = track(await api('POST', `/api/conversations/${roomId}/end`, { endingId: 'lte' }));
    assert.equal(r2.status, 403, r2.text);
    const r3 = track(await api('POST', `/api/conversations/${roomId}/end`, { endingId: 'flag' }));
    assert.equal(r3.status, 403, r3.text);
  });

  await t('stats+flags satisfied: suggested, ranked by rule count, confirm 200 with turnId', async () => {
    setScene(roomId, { stats: { affection: 80, suspicion: 5 }, flags: [{ key: 'met_sister' }] });
    const body = (await sugg(roomId)).json as { turn_id: string; suggestions: Array<{ ending_id: string; rule_count: number }> };
    // e2:1 rule, stat:1, lte:1, flag:1 — tie broken by ending_id; all present.
    assert.deepEqual(ids(body), ['e2', 'flag', 'lte', 'stat']);
    for (const s of body.suggestions) assert.equal(s.rule_count, 1);
    const r = track(await api('POST', `/api/conversations/${roomId}/end`, { endingId: 'stat', turnId: body.turn_id }));
    assert.equal(r.status, 200, r.text);
  });

  await t('ended room: suggestions empty, second end 409, no 410 anywhere', async () => {
    const body = (await sugg(roomId)).json as { suggestions: unknown[] };
    assert.deepEqual(body.suggestions, []);
    const r = track(await api('POST', `/api/conversations/${roomId}/end`, { endingId: 'e2' }));
    assert.equal(r.status, 409, r.text);
    assert.equal(seenCodes.has(410), false);
  });

  // Fresh room for staleness + D1 paths.
  const room2 = await api('POST', '/api/conversations', { characterId: ch.id, storyId: story.id, mode: 'story' });
  assert.equal(room2.status, 201, room2.text);
  const room2Id = (room2.json as { id: string }).id;
  const g2 = db.prepare('SELECT head_message_id AS h FROM conversations WHERE id = ?').get(room2Id) as { h: string };
  const w1 = insertMessage(db, room2Id, g2.h, 'user', '하나', 'complete', {});
  const x1 = insertMessage(db, room2Id, w1.id, 'assistant', '응', 'complete', {});
  const w2 = insertMessage(db, room2Id, x1.id, 'user', '둘', 'complete', {});
  const x2 = insertMessage(db, room2Id, w2.id, 'assistant', '응2', 'complete', {});
  setHead(db, room2Id, x2.id);
  const s2 = (await sugg(room2Id)).json as { turn_id: string; suggestions: Array<{ ending_id: string }> };
  assert.deepEqual(ids(s2), ['e2']);
  const staleTurn = s2.turn_id;
  const w3 = insertMessage(db, room2Id, x2.id, 'user', '셋', 'complete', {});
  const x3 = insertMessage(db, room2Id, w3.id, 'assistant', '응3', 'complete', {});
  setHead(db, room2Id, x3.id);

  await t('stale turnId → 409 stale suggestion; room stays open', async () => {
    const r = track(await api('POST', `/api/conversations/${room2Id}/end`, { endingId: 'e2', turnId: staleTurn }));
    assert.equal(r.status, 409, r.text);
    assert.deepEqual((r.json as { error: string }).error, 'stale suggestion');
    const row = db.prepare('SELECT ended_at FROM conversations WHERE id = ?').get(room2Id) as { ended_at: null };
    assert.equal(row.ended_at, null);
  });

  await t('manual reach without turnId skips stale, applies rules → 200', async () => {
    const r = track(await api('POST', `/api/conversations/${room2Id}/end`, { endingId: 'e2' }));
    assert.equal(r.status, 200, r.text);
  });

  const room3 = await api('POST', '/api/conversations', { characterId: ch.id, storyId: story.id, mode: 'story' });
  const room3Id = ((room3.json as { id: string }).id);

  await t('D1: conditions-absent ending confirms with 0 turns (F8g E2a)', async () => {
    const r = track(await api('POST', `/api/conversations/${room3Id}/end`, { endingId: 'free' }));
    assert.equal(r.status, 200, r.text);
  });

  const room4 = await api('POST', '/api/conversations', { characterId: ch.id, storyId: story.id, mode: 'story' });
  const room4Id = ((room4.json as { id: string }).id);

  await t('D1: conditions-present ending, unmet, manual path → 403 (no turnId)', async () => {
    const r = track(await api('POST', `/api/conversations/${room4Id}/end`, { endingId: 'e2' }));
    assert.equal(r.status, 403, r.text);
  });

  await t('unknown endingId 400; 1:1 room suggestions [] and end 400', async () => {
    const r = track(await api('POST', `/api/conversations/${room4Id}/end`, { endingId: 'nope' }));
    assert.equal(r.status, 400, r.text);
    const solo = await api('POST', '/api/conversations', { characterId: ch.id });
    assert.equal(solo.status, 201, solo.text);
    const soloId = (solo.json as { id: string }).id;
    const s = await sugg(soloId);
    assert.equal(s.status, 200, s.text);
    assert.deepEqual((s.json as { suggestions: unknown[] }).suggestions, []);
    const e = track(await api('POST', `/api/conversations/${soloId}/end`, { endingId: 'free' }));
    assert.equal(e.status, 400, e.text);
  });

  await t('410 never emitted on any path', () => {
    assert.equal(seenCodes.has(410), false, `codes seen: ${[...seenCodes].sort().join(',')}`);
    assert.ok(seenCodes.has(403) && seenCodes.has(409) && seenCodes.has(400) && seenCodes.has(200));
  });

  await app.close();
  console.log(`PASS=${passed}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
