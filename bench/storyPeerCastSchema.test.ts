/** npx tsx bench/storyPeerCastSchema.test.ts
 * ADR-F8e story-peer-cast-schema — story_participant_ids_snapshot column + write-on-create.
 * Schema-only slice: no resolveFocus/generate-path behavior change, no StoryPage/POST-body
 * change (that is story-peer-cast-start-ui, a later token). Temp DB only, real migrations.
 * Isolated: no systemd, no live DB, no model call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-peer-cast-schema-'));
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
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, text };
  }

  const char = async (name: string) => {
    const res = await api('POST', '/api/characters', { name, personality: `${name} 성격`, first_message: '' });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string; name: string };
  };

  await t('0013 adds story_participant_ids_snapshot as a nullable column', () => {
    const cols = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string; notnull: number }>;
    const col = cols.find((c) => c.name === 'story_participant_ids_snapshot');
    assert.ok(col, 'column missing');
    assert.equal(col!.notnull, 0, 'must be nullable — no backfill for existing rows');
  });

  const hayeon = await char('하연');
  const nari = await char('나리');
  const sera = await char('세라');

  const storyRes = await api('POST', '/api/stories', { name: '평행 교실', tagline: '', setting: '교실', minor_cast: [] });
  assert.equal(storyRes.status, 201, storyRes.text);
  const story = storyRes.json as { id: string };

  for (const [id, order] of [[hayeon.id, 0], [nari.id, 1]] as const) {
    const add = await api('POST', `/api/stories/${story.id}/characters`, { characterId: id, sortOrder: order });
    assert.equal(add.status, 201, add.text);
  }

  await t('story room create snapshots host + roster ids, deduped, without touching character_id', async () => {
    const res = await api('POST', '/api/conversations', { characterId: hayeon.id, storyId: story.id, mode: 'story' });
    assert.equal(res.status, 201, res.text);
    const conv = res.json as { character_id: string; story_participant_ids_snapshot: string | null };
    assert.equal(conv.character_id, hayeon.id, 'character_id stays the display/legacy field, unchanged by this slice');
    const ids = JSON.parse(conv.story_participant_ids_snapshot!) as string[];
    assert.deepEqual(ids, [hayeon.id, nari.id]);
  });

  await t('host not (yet) rostered via story_characters is still included in the snapshot', async () => {
    const res = await api('POST', '/api/conversations', { characterId: sera.id, storyId: story.id, mode: 'story' });
    assert.equal(res.status, 201, res.text);
    const conv = res.json as { story_participant_ids_snapshot: string | null };
    const ids = JSON.parse(conv.story_participant_ids_snapshot!) as string[];
    assert.deepEqual(ids, [sera.id, hayeon.id, nari.id]);
  });

  await t('1:1 room (no storyId) leaves the snapshot null — no participant concept there', async () => {
    const res = await api('POST', '/api/conversations', { characterId: hayeon.id, mode: 'chat' });
    assert.equal(res.status, 201, res.text);
    const conv = res.json as { story_participant_ids_snapshot: string | null };
    assert.equal(conv.story_participant_ids_snapshot, null);
  });

  await t('explicit compat policy: rows written before this column existed read back null, no backfill', () => {
    const t0 = new Date(0).toISOString();
    db.prepare(
      `INSERT INTO conversations (id, character_id, title, mode, profile_name, scene_json, prompt_version, created_at, updated_at)
       VALUES (?, ?, '', 'story', 'rp-balanced', '{}', 'pv', ?, ?)`,
    ).run('pre-existing-conv', hayeon.id, t0, t0);
    const row = db.prepare('SELECT story_participant_ids_snapshot FROM conversations WHERE id = ?').get('pre-existing-conv') as {
      story_participant_ids_snapshot: string | null;
    };
    assert.equal(row.story_participant_ids_snapshot, null, 'no automatic backfill for rows that predate this migration');
  });

  await t('0013 SQL still only adds the participant snapshot column', () => {
    const sql = fs.readFileSync('apps/server/migrations/0013_story_participant_snapshot.sql', 'utf8');
    assert.match(sql, /story_participant_ids_snapshot/);
    assert.equal(/opening_json/.test(sql), false);
    assert.equal(/story_opening_snapshot/.test(sql), false);
  });

  await app.close();
  console.log(`PASS=${passed}`);
}

main().catch((e) => {
  console.error('RED', e);
  process.exit(1);
});
