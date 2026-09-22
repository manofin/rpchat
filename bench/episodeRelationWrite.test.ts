/** npx tsx bench/episodeRelationWrite.test.ts
 * episode-relation-write — stamp rel_* on rollup-episode INSERT (reuse 0022).
 * Temp DB only. Mock model.complete — no live LLM, no live DB, no deploy.
 * LIVE_NO_TOUCH checklist item.
 *
 * Locks: persona-switch prior immutable + rel_character_id stable;
 * rollup source = this conversation's scenes only; txn atomicity;
 * extra SELECT for stamp = 0 (handler source guard); drafts await approval.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { memoryRoutes } from '../apps/server/src/routes/memory.ts';
import { loadApprovedEpisodeCandidates } from '../apps/server/src/prompt/builder.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

async function main() {
  await t('LIVE_NO_TOUCH: this bench uses temp DB + mock model only', () => {
    assert.ok(true);
  });

  await t('extra-query-0: rollup handler stamps from existing conv only', () => {
    const src = fs.readFileSync('apps/server/src/routes/memory.ts', 'utf8');
    const start = src.indexOf("'/api/conversations/:id/rollup-episode'");
    assert.ok(start > 0);
    const end = src.indexOf('});', src.indexOf('db.transaction(() => {', start)) + 3;
    const handler = src.slice(start, end);
    // Exactly one loadConversation in the handler (the existing gate).
    const loads = handler.match(/loadConversation\(/g) ?? [];
    assert.equal(loads.length, 1, `expected 1 loadConversation, got ${loads.length}`);
    // INSERT binds conv.character_id / conv.persona_id — no fresh SELECT for stamp.
    assert.match(handler, /rel_character_id, rel_persona_id/);
    assert.match(handler, /conv\.character_id, conv\.persona_id/);
    // No characters/personas SELECT added for stamping inside the handler body.
    assert.equal((handler.match(/FROM characters/gi) ?? []).length, 0);
    assert.equal((handler.match(/FROM personas/gi) ?? []).length, 0);
    // Scene SELECT still conversation-scoped (rollup source lock).
    assert.match(
      handler,
      /SELECT \* FROM summaries WHERE conversation_id = \? AND tier = 'scene' AND status = 'approved' AND rolled_up_into IS NULL/,
    );
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-episode-relation-write-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('summary', null, 0.3, 0.9, 600, '[]', 'system', 'bench');
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', 'bench');

  let completeCalls = 0;
  let lastPrompt = '';
  const model = {
    complete: async (p: GenParams): Promise<GenResult> => {
      completeCalls++;
      lastPrompt = JSON.stringify(p.messages);
      return {
        text: JSON.stringify({ episode: `episode-draft-${completeCalls}` }),
        finishReason: 'stop',
        usage: null,
        ttftMs: 1,
        totalMs: 1,
      };
    },
    stream: async () => {
      throw new Error('stream unused');
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
  await app.register(conversationRoutes(ctx));
  await app.register(memoryRoutes(ctx));
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

  function insertScene(convId: string, id: string, content: string) {
    const t0 = new Date().toISOString();
    db.prepare(
      `INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier)
       VALUES (?, ?, ?, NULL, NULL, 'approved', ?, 'scene')`,
    ).run(id, convId, content, t0);
  }

  const charRes = await api('POST', '/api/characters', {
    name: 'RelChar',
    personality: 'p',
    first_message: '',
  });
  assert.equal(charRes.status, 201, charRes.text);
  const character = charRes.json as { id: string };

  const personaA = await api('POST', '/api/personas', { name: 'PersonaA' });
  assert.equal(personaA.status, 201, personaA.text);
  const a = personaA.json as { id: string };
  const personaB = await api('POST', '/api/personas', { name: 'PersonaB' });
  assert.equal(personaB.status, 201, personaB.text);
  const b = personaB.json as { id: string };

  const convRes = await api('POST', '/api/conversations', {
    characterId: character.id,
    personaId: a.id,
    mode: 'chat',
  });
  assert.equal(convRes.status, 201, convRes.text);
  const conv = convRes.json as { id: string; character_id: string; persona_id: string | null };
  assert.equal(conv.character_id, character.id);
  assert.equal(conv.persona_id, a.id);

  insertScene(conv.id, 'sc-a1', 'scene A1');
  insertScene(conv.id, 'sc-a2', 'scene A2');

  await t('happy: persona set → rel_* match conv after rollup', async () => {
    const res = await api('POST', `/api/conversations/${conv.id}/rollup-episode?force=1`);
    assert.equal(res.status, 200, res.text);
    const body = res.json as {
      episode: {
        id: string;
        rel_character_id: string | null;
        rel_persona_id: string | null;
        tier: string;
      };
      rolledScenes: string[];
    };
    assert.equal(body.episode.tier, 'episode');
    assert.equal(body.episode.rel_character_id, character.id);
    assert.equal(body.episode.rel_persona_id, a.id);
    assert.deepEqual(body.rolledScenes.sort(), ['sc-a1', 'sc-a2'].sort());
  });

  const epA = db
    .prepare(`SELECT id, rel_character_id, rel_persona_id FROM summaries WHERE tier='episode' AND conversation_id=? ORDER BY created_at ASC`)
    .get(conv.id) as { id: string; rel_character_id: string; rel_persona_id: string };

  await t('new stamped episode stays outside prompt candidates until explicit approval', () => {
    assert.deepEqual(loadApprovedEpisodeCandidates(db, conv), []);
    db.prepare("UPDATE summaries SET status='approved' WHERE id=?").run(epA.id);
    assert.deepEqual(loadApprovedEpisodeCandidates(db, conv).map((row) => row.id), [epA.id]);
    db.prepare("UPDATE summaries SET status='rejected' WHERE id=?").run(epA.id);
    assert.deepEqual(loadApprovedEpisodeCandidates(db, conv), [], 'rejected episode must not inject');
    db.prepare("UPDATE summaries SET status='draft' WHERE id=?").run(epA.id);
  });

  await t('atomicity: episode row exists AND rolled scenes point at it', () => {
    assert.ok(epA?.id);
    const rolled = db
      .prepare(`SELECT id, rolled_up_into FROM summaries WHERE id IN ('sc-a1','sc-a2') ORDER BY id`)
      .all() as Array<{ id: string; rolled_up_into: string | null }>;
    assert.equal(rolled.length, 2);
    for (const s of rolled) assert.equal(s.rolled_up_into, epA.id);
  });

  // Foreign conversation with its own scenes — must never be rolled into `conv`.
  const otherConvRes = await api('POST', '/api/conversations', {
    characterId: character.id,
    personaId: a.id,
    mode: 'chat',
  });
  assert.equal(otherConvRes.status, 201, otherConvRes.text);
  const other = otherConvRes.json as { id: string };
  insertScene(other.id, 'sc-foreign', 'FOREIGN SCENE MUST NOT ROLL');

  await t('rollup source = this conversation scenes only (foreign excluded)', async () => {
    insertScene(conv.id, 'sc-a3', 'scene A3');
    const beforeForeign = db
      .prepare(`SELECT rolled_up_into FROM summaries WHERE id='sc-foreign'`)
      .get() as { rolled_up_into: string | null };
    assert.equal(beforeForeign.rolled_up_into, null);

    const res = await api('POST', `/api/conversations/${conv.id}/rollup-episode?force=1`);
    assert.equal(res.status, 200, res.text);
    const body = res.json as { episode: { id: string; content: string }; rolledScenes: string[] };
    assert.deepEqual(body.rolledScenes, ['sc-a3']);
    assert.equal(body.episode.content.includes('FOREIGN'), false);
    assert.ok(lastPrompt.includes('scene A3'));
    assert.equal(lastPrompt.includes('FOREIGN SCENE MUST NOT ROLL'), false, 'model input must exclude foreign scenes');
    const foreign = db
      .prepare(`SELECT rolled_up_into, conversation_id FROM summaries WHERE id='sc-foreign'`)
      .get() as { rolled_up_into: string | null; conversation_id: string };
    assert.equal(foreign.rolled_up_into, null);
    assert.equal(foreign.conversation_id, other.id);
  });

  await t('persona switch: prior episode immutable; new row new persona; rel_character_id stable', async () => {
    const patch = await api('PATCH', `/api/conversations/${conv.id}`, { personaId: b.id });
    assert.equal(patch.status, 200, patch.text);
    const patched = patch.json as { persona_id: string; character_id: string };
    assert.equal(patched.persona_id, b.id);
    assert.equal(patched.character_id, character.id);

    insertScene(conv.id, 'sc-b1', 'scene B1');
    const res = await api('POST', `/api/conversations/${conv.id}/rollup-episode?force=1`);
    assert.equal(res.status, 200, res.text);
    const body = res.json as {
      episode: { id: string; rel_character_id: string | null; rel_persona_id: string | null };
    };

    const prior = db
      .prepare(`SELECT rel_character_id, rel_persona_id FROM summaries WHERE id=?`)
      .get(epA.id) as { rel_character_id: string; rel_persona_id: string };
    assert.equal(prior.rel_persona_id, a.id, 'prior episode persona must stay A');
    assert.equal(prior.rel_character_id, character.id);

    assert.equal(body.episode.rel_persona_id, b.id);
    assert.equal(body.episode.rel_character_id, character.id);
    assert.equal(body.episode.rel_character_id, prior.rel_character_id);
  });

  await t('null persona → rel_persona_id IS NULL, rel_character_id set', async () => {
    const clear = await api('PATCH', `/api/conversations/${conv.id}`, { personaId: null });
    assert.equal(clear.status, 200, clear.text);
    const cleared = clear.json as { persona_id: string | null };
    assert.equal(cleared.persona_id, null);

    insertScene(conv.id, 'sc-n1', 'scene null persona');
    const res = await api('POST', `/api/conversations/${conv.id}/rollup-episode?force=1`);
    assert.equal(res.status, 200, res.text);
    const body = res.json as {
      episode: { rel_character_id: string | null; rel_persona_id: string | null };
    };
    assert.equal(body.episode.rel_character_id, character.id);
    assert.equal(body.episode.rel_persona_id, null);
  });

  await t('scene update failure rolls back episode insert and leaves the source scene unrolled', async () => {
    insertScene(conv.id, 'sc-fail', 'scene transaction failure');
    const before = db.prepare('SELECT * FROM summaries ORDER BY id').all();
    db.exec(`CREATE TRIGGER fail_rollup_update BEFORE UPDATE OF rolled_up_into ON summaries
      WHEN OLD.id = 'sc-fail' BEGIN SELECT RAISE(ABORT, 'fixture rollup update failure'); END`);
    try {
      const res = await api('POST', `/api/conversations/${conv.id}/rollup-episode?force=1`);
      assert.equal(res.status, 500, res.text);
      assert.deepEqual(db.prepare('SELECT * FROM summaries ORDER BY id').all(), before);
    } finally {
      db.exec('DROP TRIGGER fail_rollup_update');
    }
  });

  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed (completeCalls=${completeCalls})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
