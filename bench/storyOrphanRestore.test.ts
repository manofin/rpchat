/** TSX_TSCONFIG_PATH=apps/web/tsconfig.json npx tsx bench/storyOrphanRestore.test.ts
 * LOCK-StoryOrphanRestore P1 — preview → select → apply into story_characters only.
 * Temp DB + Fastify. No live HTTP / systemd / DB / deploy / restart.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import { StoryDetailView } from '../apps/web/src/pages/StoryPage.tsx';
import { storyFixture, character, nodes, one, button } from './helpers/storyUiHarness.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-orphan-restore-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
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

  const yuki = await char('유키');
  const emma = await char('엠마');
  const gadget = await char('가젯');
  const archived = await char('옛이름');
  await api('DELETE', `/api/characters/${archived.id}`); // soft-archive

  const storyRes = await api('POST', '/api/stories', { name: '창공-픽스처', tagline: '', setting: '하늘', minor_cast: [] });
  assert.equal(storyRes.status, 201, storyRes.text);
  const story = storyRes.json as { id: string };

  // Roster empty (orphan). Create rooms via API then clear any accidental roster? POST conversations
  // with storyId requires hosted character for inject path but create allows host not in roster.
  // Link then unlink to create rooms with snapshots, OR insert conversations directly.

  // Map hosts briefly so create can include roster peers, then wipe roster → orphan with rooms.
  for (const [id, order] of [[yuki.id, 0], [emma.id, 1], [gadget.id, 2]] as const) {
    const add = await api('POST', `/api/stories/${story.id}/characters`, { characterId: id, sortOrder: order });
    assert.equal(add.status, 201, add.text);
  }

  const room1 = await api('POST', '/api/conversations', {
    characterId: yuki.id, storyId: story.id, mode: 'story',
    participantIds: [yuki.id, emma.id],
  });
  assert.equal(room1.status, 201, room1.text);
  const conv1 = room1.json as {
    id: string;
    story_id: string;
    story_name_snapshot: string | null;
    story_participant_ids_snapshot: string | null;
  };
  // Seed archived + missing into snapshot (create path drops unknown/archived); mirrors live orphan rooms.
  db.prepare('UPDATE conversations SET story_participant_ids_snapshot = ? WHERE id = ?').run(
    JSON.stringify([yuki.id, emma.id, archived.id, 'missing-char-id']),
    conv1.id,
  );

  const room2 = await api('POST', '/api/conversations', {
    characterId: gadget.id, storyId: story.id, mode: 'story',
    participantIds: [gadget.id, emma.id],
  });
  assert.equal(room2.status, 201, room2.text);
  const conv2 = room2.json as {
    id: string;
    story_id: string;
    story_name_snapshot: string | null;
    story_participant_ids_snapshot: string | null;
  };

  // Archived room must be ignored by candidate extract
  const roomArchived = await api('POST', '/api/conversations', {
    characterId: yuki.id, storyId: story.id, mode: 'story',
    participantIds: [yuki.id],
  });
  assert.equal(roomArchived.status, 201, roomArchived.text);
  const convArch = roomArchived.json as { id: string };
  db.prepare('UPDATE conversations SET archived = 1 WHERE id = ?').run(convArch.id);

  // Unlink all roster → orphan
  for (const id of [yuki.id, emma.id, gadget.id]) {
    const del = await api('DELETE', `/api/stories/${story.id}/characters/${id}`);
    assert.equal(del.status, 200, del.text);
  }
  const emptyStory = await api('GET', `/api/stories/${story.id}`);
  assert.equal(((emptyStory.json as { characters: unknown[] }).characters ?? []).length, 0);

  const snapBefore = db.prepare(
    `SELECT id, story_id, story_name_snapshot, story_participant_ids_snapshot FROM conversations WHERE story_id = ? ORDER BY id`,
  ).all(story.id) as Array<{
    id: string; story_id: string; story_name_snapshot: string | null; story_participant_ids_snapshot: string | null;
  }>;

  await t('preview candidates unions host+snapshot, dedupes, flags archived/missing, ignores archived rooms', async () => {
    const res = await api('GET', `/api/stories/${story.id}/restore-candidates`);
    assert.equal(res.status, 200, res.text);
    const body = res.json as {
      story_id: string;
      room_n: number;
      candidates: Array<{ character_id: string; name: string | null; status: string; selectable: boolean }>;
    };
    assert.equal(body.story_id, story.id);
    assert.equal(body.room_n, 2, 'archived room excluded');
    const byId = new Map(body.candidates.map((c) => [c.character_id, c]));
    assert.equal(byId.size, body.candidates.length, 'deduped');
    assert.equal(byId.get(yuki.id)?.status, 'active');
    assert.equal(byId.get(emma.id)?.status, 'active');
    assert.equal(byId.get(gadget.id)?.status, 'active');
    assert.equal(byId.get(archived.id)?.status, 'archived');
    assert.equal(byId.get(archived.id)?.selectable, true);
    assert.equal(byId.get('missing-char-id')?.status, 'missing');
    assert.equal(byId.get('missing-char-id')?.selectable, false);
    assert.equal(byId.get('missing-char-id')?.name, null);
    // active first
    assert.equal(body.candidates[0].status, 'active');
  });

  await t('apply selected inserts only chosen ids; unselected stay out', async () => {
    const res = await api('POST', `/api/stories/${story.id}/restore-characters`, {
      characterIds: [yuki.id, emma.id],
    });
    assert.equal(res.status, 200, res.text);
    const body = res.json as {
      inserted: string[];
      already: string[];
      skipped: string[];
      characters: Array<{ character_id: string; name: string }>;
    };
    assert.deepEqual(new Set(body.inserted), new Set([yuki.id, emma.id]));
    assert.deepEqual(body.already, []);
    const names = body.characters.map((c) => c.character_id).sort();
    assert.deepEqual(names, [emma.id, yuki.id].sort());
    // gadget was candidate but not selected
    assert.equal(names.includes(gadget.id), false);
    const get = await api('GET', `/api/stories/${story.id}`);
    const chars = (get.json as { characters: Array<{ character_id: string }> }).characters.map((c) => c.character_id).sort();
    assert.deepEqual(chars, [emma.id, yuki.id].sort());
  });

  await t('idempotent re-apply reports already; no duplicate rows', async () => {
    const res = await api('POST', `/api/stories/${story.id}/restore-characters`, {
      characterIds: [yuki.id, emma.id],
    });
    assert.equal(res.status, 200, res.text);
    const body = res.json as { inserted: string[]; already: string[] };
    assert.deepEqual(new Set(body.already), new Set([yuki.id, emma.id]));
    assert.deepEqual(body.inserted, []);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM story_characters WHERE story_id = ?').get(story.id) as { n: number }).n;
    assert.equal(n, 2);
  });

  await t('snapshots and story_id unchanged after apply', () => {
    const snapAfter = db.prepare(
      `SELECT id, story_id, story_name_snapshot, story_participant_ids_snapshot FROM conversations WHERE story_id = ? ORDER BY id`,
    ).all(story.id) as typeof snapBefore;
    assert.deepEqual(snapAfter, snapBefore);
    // also include archived-room row identity
    for (const row of snapBefore) {
      assert.equal(row.story_id, story.id);
      assert.ok(row.story_name_snapshot);
    }
  });

  await t('reject non-candidate characterId with 400', async () => {
    const outsider = await char('외부인');
    const res = await api('POST', `/api/stories/${story.id}/restore-characters`, {
      characterIds: [outsider.id],
    });
    assert.equal(res.status, 400);
    assert.equal((res.json as { error: string }).error, 'not a restore candidate');
  });

  await t('missing candidate in apply is skipped without FK crash', async () => {
    const res = await api('POST', `/api/stories/${story.id}/restore-characters`, {
      characterIds: ['missing-char-id'],
    });
    assert.equal(res.status, 200, res.text);
    const body = res.json as { skipped: string[]; inserted: string[] };
    assert.deepEqual(body.skipped, ['missing-char-id']);
    assert.deepEqual(body.inserted, []);
  });

  await t('roster>0 UI hides orphan notice and restore CTA', () => {
    const html = renderToStaticMarkup(React.createElement(StoryDetailView, {
      story: storyFixture(),
      characters: [character('b'), character('a')],
      roomCount: 4,
      onViewRooms() {},
      onRestoreCast() {},
      onAddCast() {},
    }));
    assert.match(html, /story-cast-grid/);
    assert.equal(html.includes('등장인물 복원'), false);
    assert.equal(html.includes('story-orphan-notice'), false);
  });

  await t('empty roster + 0 rooms keeps empty copy without restore CTA', () => {
    const html = renderToStaticMarkup(React.createElement(StoryDetailView, {
      story: storyFixture({ characters: [] }),
      characters: [],
      roomCount: 0,
      onViewRooms() {},
      onRestoreCast() {},
      onAddCast() {},
    }));
    assert.match(html, /아직 등록된 등장 캐릭터가 없습니다/);
    assert.equal(html.includes('등장인물 복원'), false);
  });

  await t('P0 CTA2 wired: restore enabled, no auto wording; endpoints present; no migrate', () => {
    const pageSrc = fs.readFileSync(path.resolve('apps/web/src/pages/StoryPage.tsx'), 'utf8');
    const storiesSrc = fs.readFileSync(path.resolve('apps/server/src/routes/stories.ts'), 'utf8');
    assert.match(pageSrc, /onClick=\{onRestoreCast\}/);
    assert.equal(pageSrc.includes('자동'), false);
    assert.match(storiesSrc, /\/api\/stories\/:id\/restore-candidates/);
    assert.match(storiesSrc, /\/api\/stories\/:id\/restore-characters/);
    const migrations = fs.readdirSync(path.resolve('apps/server/migrations'));
    assert.equal(migrations.some((f) => f.toLowerCase().includes('orphan') || f.toLowerCase().includes('restore')), false);
    const view = StoryDetailView({
      story: storyFixture({ characters: [] }),
      roomCount: 2,
      onViewRooms() {},
      onRestoreCast() {},
      onAddCast() {},
    });
    const restore = one(view, button('등장인물 복원'));
    assert.equal(typeof restore.props.onClick, 'function');
    assert.equal(restore.props.disabled, undefined);
  });

  await app.close();
  console.log(`passed ${passed}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
