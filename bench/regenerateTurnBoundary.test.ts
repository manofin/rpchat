/**
 * npx tsx bench/regenerateTurnBoundary.test.ts
 * regenerate-turn-boundary — a multi-row turn regenerates as a turn.
 *
 * The defect this locks out is not subtle once it is on screen. A beat turn is
 * five or six rows chained under one another, so the `parent_id` of its last row
 * is the middle of its own turn. Regenerating from there left the first four rows
 * on the active path and appended a second header, narration, line and thought
 * after them: one user input answered twice, in one unbroken path, with two
 * `beat_seq: 0` blocks between the same pair of user messages.
 *
 * It was unreachable from the UI — beat blocks other than `line` return before the
 * controls row, so no ↻ button is ever rendered on the one row `isLastAssistant`
 * is true for — but reachable from the API, which is where these tests live and
 * where bench/narrationContinuity.test.ts had been calling it all along (from the
 * header, which happened to be the one target that produced a clean turn).
 *
 * The assertions are about path *shape*, because "a regenerate happened" is
 * exactly what the broken version also satisfied.
 *
 * Fake model at the I/O edge only. Temp DB, never the live DB.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import { resolveTurnStart } from '../apps/server/src/db/tree.js';
import { THOUGHT_MARKER } from '../apps/server/src/prompt/passes.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { MessageRow } from '../apps/server/src/types.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const CATALOG = {
  places: [{ id: '교실', name: 'S반 교실', default_focus: 'nari' }],
  weathers: ['맑음'],
  arcs: ['entry'],
  duties: { 교칙: { slot: '질서' } },
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-regen-boundary-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  let gen = 0;
  const model = {
    complete: async (p: GenParams): Promise<GenResult> => {
      const prompt = String(p.messages?.[0]?.content ?? '');
      const ok = (text: string): GenResult => ({ text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 });
      if (prompt.includes('장면 진행 판정기')) return ok('{"base_version":0}');
      if (prompt.includes('입력 초안만 쓴다')) return ok('<choices>["가","나","다"]</choices>');
      if (prompt.includes('너는 장면 서술자다')) { gen += 1; return ok(`서술${gen}.`); }
      // dialog Pass S / hunter Pass H write a whole turn in one call.
      if (prompt.includes('|')) return ok('INFO\n상태: 평온\n---\n나리 | "대사입니다."');
      return ok('"교칙이야."');
    },
    stream: async (_p: GenParams, onToken: (d: string) => void): Promise<GenResult> => {
      const chunks = ['"', '……짝꿍?', '"\n', `${THOUGHT_MARKER} `, '왜 안 피하지.'];
      for (const c of chunks) { onToken(c); await new Promise((r) => setImmediate(r)); }
      return { text: chunks.join(''), finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 3 };
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

  type Msg = { id: string; role: string; content: string; meta: Record<string, unknown> };
  const messagesOf = async (convId: string): Promise<Msg[]> =>
    ((await api('GET', `/api/conversations/${convId}`)).json as { messages: Msg[] }).messages;
  const send = async (convId: string, content: string) => {
    const res = await fetch(`${origin}/api/conversations/${convId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
    });
    assert.equal(res.status, 200);
    await res.text();
  };
  const regen = async (convId: string, messageId: string) => {
    const res = await fetch(`${origin}/api/conversations/${convId}/regenerate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId }),
    });
    const body = await res.text();
    return { status: res.status, body };
  };
  const char = async (name: string, tags: string[]) => {
    const res = await api('POST', '/api/characters', { name, personality: `${name} 성격`, first_message: '', tags });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string };
  };
  /** Assistant rows after the last user row — the turn currently on screen. */
  const lastTurn = (msgs: Msg[]) => {
    let cut = -1;
    msgs.forEach((m, i) => { if (m.role === 'user') cut = i; });
    return msgs.slice(cut + 1).filter((m) => m.role === 'assistant');
  };
  const kinds = (ms: Msg[]) => ms.map((m) => m.meta.block_kind);

  const nari = await char('나리', ['party:duty=이야기', 'party:place=교실']);
  const sera = await char('세라', ['party:duty=교칙', 'party:place=교실']);
  const hayeon = await char('하연', ['party:duty=수업', 'party:place=교실']);
  const storyRes = await api('POST', '/api/stories', {
    name: '히어로 아카데미', tagline: 'S반', setting: '교실', minor_cast: [], scene_catalog: CATALOG,
  });
  const story = (storyRes.json as { id: string }).id;
  for (const [id, order] of [[hayeon.id, 0], [nari.id, 1], [sera.id, 2]] as const) {
    await api('POST', `/api/stories/${story}/characters`, { characterId: id, sortOrder: order });
  }
  const newConv = async (fmt?: 'dialog' | 'hunter') => {
    const res = await api('POST', '/api/conversations', { characterId: hayeon.id, storyId: story, mode: 'story' });
    const id = (res.json as { id: string }).id;
    if (fmt) await api('PATCH', `/api/conversations/${id}`, { scene: { format: fmt } });
    return id;
  };

  // ── every block of a turn normalises to the same parent ─────────────────────

  await t('every block of a beat turn resolves to the same turn start', async () => {
    const conv = await newConv();
    await send(conv, '첫 턴');
    await send(conv, '둘째 턴');
    const turn = lastTurn(await messagesOf(conv));
    assert.deepEqual(kinds(turn), ['header', 'narration', 'line', 'thought', 'ui'], JSON.stringify(kinds(turn)));

    const rows = turn.map((m) => db.prepare('SELECT * FROM messages WHERE id = ?').get(m.id) as MessageRow);
    const resolved = rows.map((r) => resolveTurnStart(db, r));
    for (const [i, r] of resolved.entries()) {
      assert.equal(r.kind, 'multi', `${kinds(turn)[i]} → ${JSON.stringify(r)}`);
    }
    const starts = new Set(resolved.map((r) => (r as { startId: string }).startId));
    assert.equal(starts.size, 1, 'all five blocks must name one start block');
    assert.equal([...starts][0], turn[0].id, 'and it is the header');
    const parents = new Set(resolved.map((r) => (r as { parentId: string }).parentId));
    assert.equal(parents.size, 1, 'so they all regenerate from one parent');
  });

  // ── the active path after a regenerate ─────────────────────────────────────

  for (const target of ['header', 'narration', 'line', 'thought', 'ui'] as const) {
    await t(`regenerating a beat turn from its ${target} leaves one turn on the path`, async () => {
      const conv = await newConv();
      await send(conv, '첫 턴');
      await send(conv, '둘째 턴');
      const before = lastTurn(await messagesOf(conv));
      const hit = before.find((m) => m.meta.block_kind === target)!;
      assert.ok(hit, `${target} block exists`);

      const res = await regen(conv, hit.id);
      assert.equal(res.status, 200, res.body);

      const after = await messagesOf(conv);
      const turn = lastTurn(after);
      // The shape the old code produced: header/narration/line/thought twice.
      assert.deepEqual(kinds(turn), ['header', 'narration', 'line', 'thought', 'ui'], JSON.stringify(kinds(turn)));
      assert.equal(turn.filter((m) => m.meta.beat_seq === 0).length, 1, 'exactly one turn start on the path');
      const gens = new Set(turn.map((m) => m.meta.generation_id));
      assert.equal(gens.size, 1, 'one generation, not two spliced together');
      // The old turn is a sibling, not an ancestor.
      assert.equal(after.filter((m) => m.role === 'assistant' && m.meta.beat_seq === 0).length, 2,
        'two turns on the path total: turn 1 and the regenerated turn 2');
      // Head points at the new turn's last block.
      const conv2 = (await api('GET', `/api/conversations/${conv}`)).json as { conversation: { head_message_id: string } };
      assert.equal(conv2.conversation.head_message_id, turn[turn.length - 1].id);
    });
  }

  await t('the replaced turn survives as a sibling, off the path', async () => {
    const conv = await newConv();
    await send(conv, '첫 턴');
    await send(conv, '둘째 턴');
    const before = lastTurn(await messagesOf(conv));
    const abandonedIds = before.map((m) => m.id);
    await regen(conv, before.find((m) => m.meta.block_kind === 'ui')!.id);

    const onPath = new Set((await messagesOf(conv)).map((m) => m.id));
    for (const id of abandonedIds) {
      assert.equal(onPath.has(id), false, 'no block of the replaced turn stays on the active path');
      const row = db.prepare('SELECT id FROM messages WHERE id = ?').get(id);
      assert.ok(row, 'but it is still in the table — replaced, not deleted');
    }
  });

  await t('repeated regeneration keeps exactly one turn on the path', async () => {
    const conv = await newConv();
    await send(conv, '첫 턴');
    await send(conv, '둘째 턴');
    for (let i = 0; i < 3; i++) {
      const turn = lastTurn(await messagesOf(conv));
      const res = await regen(conv, turn[turn.length - 1].id);
      assert.equal(res.status, 200, res.body);
      const after = lastTurn(await messagesOf(conv));
      assert.deepEqual(kinds(after), ['header', 'narration', 'line', 'thought', 'ui'], `round ${i + 1}: ${JSON.stringify(kinds(after))}`);
      assert.equal(after.filter((m) => m.meta.beat_seq === 0).length, 1, `round ${i + 1}`);
    }
    // Four siblings under the same parent: the original plus three regenerations.
    const all = db.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND json_extract(meta_json,'$.beat_seq') = 0`,
    ).get(conv) as { n: number };
    assert.equal(all.n, 5, 'turn 1 + turn 2 original + 3 regenerations');
  });

  // ── dialog and hunter take the same path ───────────────────────────────────

  for (const fmt of ['dialog', 'hunter'] as const) {
    await t(`${fmt} turns regenerate as turns too`, async () => {
      const conv = await newConv(fmt);
      await send(conv, '첫 턴');
      await send(conv, '둘째 턴');
      const before = lastTurn(await messagesOf(conv));
      assert.ok(before.length > 1, `${fmt} writes a multi-row turn (${JSON.stringify(kinds(before))})`);
      const res = await regen(conv, before[before.length - 1].id);
      assert.equal(res.status, 200, res.body);
      const turn = lastTurn(await messagesOf(conv));
      assert.equal(turn.filter((m) => m.meta.beat_seq === 0).length, 1, JSON.stringify(kinds(turn)));
      const gens = new Set(turn.map((m) => m.meta.generation_id));
      assert.equal(gens.size, 1);
    });
  }

  // ── 1:1 is untouched ───────────────────────────────────────────────────────

  await t('a 1:1 turn is one row and still regenerates from its own parent', async () => {
    const solo = await char('서리', []);
    const res = await api('POST', '/api/conversations', { characterId: solo.id });
    const conv = (res.json as { id: string }).id;
    await send(conv, '안녕');
    const msgs = await messagesOf(conv);
    const assistant = msgs.filter((m) => m.role === 'assistant');
    assert.equal(assistant.length, 1, 'one assistant row per 1:1 turn');
    assert.equal(assistant[0].meta.block_kind, undefined, 'and no block_kind — the discriminator');

    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(assistant[0].id) as MessageRow;
    const t0 = resolveTurnStart(db, row);
    assert.equal(t0.kind, 'single');
    assert.equal((t0 as { parentId: string }).parentId, row.parent_id, 'unchanged behaviour: the row own parent');

    assert.equal((await regen(conv, assistant[0].id)).status, 200);
    const after = await messagesOf(conv);
    assert.equal(after.filter((m) => m.role === 'assistant').length, 1, 'still one assistant row on the path');
    assert.equal(after.filter((m) => m.role === 'user').length, 1);
  });

  // ── bad input and legacy shapes ────────────────────────────────────────────

  await t('unknown, foreign and user-role targets keep their existing contracts', async () => {
    const conv = await newConv();
    await send(conv, '첫 턴');
    const other = await newConv();
    await send(other, '남의 대화');

    assert.equal((await regen(conv, 'no-such-id')).status, 404);
    const foreign = (await messagesOf(other)).find((m) => m.meta.block_kind === 'ui')!;
    assert.equal((await regen(conv, foreign.id)).status, 404, 'a message from another conversation is not found here');
    const userRow = (await messagesOf(conv)).find((m) => m.role === 'user')!;
    assert.equal((await regen(conv, userRow.id)).status, 200, 'regenerating from a user message still continues under it');
  });

  await t('a multi-row chain with no reachable start is refused, not partially regenerated', () => {
    // The corrupted shape legacy rows can already be in: a block whose ancestors do
    // not contain its own turn start. Refusing beats guessing at a boundary.
    const conv = db.prepare('SELECT id FROM conversations LIMIT 1').get() as { id: string };
    const orphanId = 'orphan-block';
    db.prepare(
      `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at)
       VALUES (?,?,?,?,?,?,?,0,?)`,
    ).run(orphanId, conv.id, null, 'assistant', 'x', 'complete',
      JSON.stringify({ block_kind: 'ui', beat_seq: 4, generation_id: 'g-orphan' }), new Date().toISOString());
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(orphanId) as MessageRow;
    const r = resolveTurnStart(db, row);
    assert.equal(r.kind, 'unresolved');
    assert.equal((r as { reason: string }).reason, 'no_turn_start');
  });

  await t('a cycle and a foreign-generation ancestor are both refused', () => {
    const conv = db.prepare('SELECT id FROM conversations LIMIT 1').get() as { id: string };
    const now = new Date().toISOString();
    const ins = (id: string, parent: string | null, meta: object) => db.prepare(
      `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at)
       VALUES (?,?,?,?,?,?,?,0,?)`,
    ).run(id, conv.id, parent, 'assistant', 'x', 'complete', JSON.stringify(meta), now);

    // parent_id has a foreign key, so the loop is closed by UPDATE after both rows
    // exist — which is also the only way it could ever arise in the table.
    ins('cyc-a', null, { block_kind: 'line', beat_seq: 2, generation_id: 'g-cyc' });
    ins('cyc-b', 'cyc-a', { block_kind: 'line', beat_seq: 3, generation_id: 'g-cyc' });
    db.prepare('UPDATE messages SET parent_id = ? WHERE id = ?').run('cyc-b', 'cyc-a');
    const cyc = db.prepare('SELECT * FROM messages WHERE id = ?').get('cyc-a') as MessageRow;
    assert.equal((resolveTurnStart(db, cyc) as { reason: string }).reason, 'cycle');

    // A block spliced under another generation's row — the old defect's own output.
    ins('gen-parent', null, { block_kind: 'thought', beat_seq: 3, generation_id: 'g-old' });
    ins('gen-child', 'gen-parent', { block_kind: 'ui', beat_seq: 4, generation_id: 'g-new' });
    const spliced = db.prepare('SELECT * FROM messages WHERE id = ?').get('gen-child') as MessageRow;
    assert.equal((resolveTurnStart(db, spliced) as { reason: string }).reason, 'crossed_generation');
  });

  await t('a block chained directly under a user row without a start is refused', () => {
    const conv = db.prepare('SELECT id FROM conversations LIMIT 1').get() as { id: string };
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at)
       VALUES (?,?,?,?,?,?,?,0,?)`,
    ).run('u-row', conv.id, null, 'user', '입력', 'complete', '{}', now);
    db.prepare(
      `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at)
       VALUES (?,?,?,?,?,?,?,0,?)`,
    ).run('mid-block', conv.id, 'u-row', 'assistant', 'x', 'complete',
      JSON.stringify({ block_kind: 'line', beat_seq: 2, generation_id: 'g-mid' }), now);
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get('mid-block') as MessageRow;
    const r = resolveTurnStart(db, row);
    assert.equal(r.kind, 'unresolved');
    assert.equal((r as { reason: string }).reason, 'crossed_user_message');
  });

  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
