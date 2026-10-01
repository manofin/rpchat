/** TSX_TSCONFIG_PATH=apps/web/tsconfig.json npx tsx bench/orphanOpsList.test.ts
 * LOCK-StoryOrphanOpsList P2 — read-only ops discovery of orphan stories.
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
import { StoryOrphanOpsView } from '../apps/web/src/pages/StoryOrphanOpsPage.tsx';
import { SettingsNavigationRow } from '../apps/web/src/components/settings.tsx';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

type OrphanRow = {
  id: string;
  name: string;
  archived: boolean;
  room_n: number;
  updated_at: string;
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-orphan-ops-'));
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

  const mkStory = async (name: string) => {
    const res = await api('POST', '/api/stories', { name, tagline: '', setting: '셋', minor_cast: [] });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string; name: string; archived: boolean; updated_at: string };
  };

  const addRoster = async (storyId: string, characterId: string, sortOrder = 0) => {
    const res = await api('POST', `/api/stories/${storyId}/characters`, { characterId, sortOrder });
    assert.equal(res.status, 201, res.text);
  };

  const unlink = async (storyId: string, characterId: string) => {
    const res = await api('DELETE', `/api/stories/${storyId}/characters/${characterId}`);
    assert.equal(res.status, 200, res.text);
  };

  const mkRoom = async (storyId: string, characterId: string) => {
    const res = await api('POST', '/api/conversations', {
      characterId, storyId, mode: 'story', participantIds: [characterId],
    });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string };
  };

  const host = await char('호스트');

  const orphanA = await mkStory('고아-A');
  await addRoster(orphanA.id, host.id, 0);
  await mkRoom(orphanA.id, host.id);
  await mkRoom(orphanA.id, host.id);
  await unlink(orphanA.id, host.id);

  const withRoster = await mkStory('로스터-있음');
  await addRoster(withRoster.id, host.id, 0);
  await mkRoom(withRoster.id, host.id);

  const emptyNoRooms = await mkStory('빈-무대화');

  const orphanArch = await mkStory('고아-보관');
  await addRoster(orphanArch.id, host.id, 0);
  await mkRoom(orphanArch.id, host.id);
  await unlink(orphanArch.id, host.id);
  db.prepare('UPDATE stories SET archived = 1, updated_at = ? WHERE id = ?').run('2099-01-01T00:00:00.000Z', orphanArch.id);

  const orphanHi = await mkStory('고아-다대화');
  await addRoster(orphanHi.id, host.id, 0);
  await mkRoom(orphanHi.id, host.id);
  await mkRoom(orphanHi.id, host.id);
  await mkRoom(orphanHi.id, host.id);
  await unlink(orphanHi.id, host.id);
  db.prepare('UPDATE stories SET updated_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', orphanHi.id);
  db.prepare('UPDATE stories SET updated_at = ? WHERE id = ?').run('2020-06-01T00:00:00.000Z', orphanA.id);

  const onlyArchRooms = await mkStory('빈-보관대화만');
  await addRoster(onlyArchRooms.id, host.id, 0);
  const archRoom = await mkRoom(onlyArchRooms.id, host.id);
  await unlink(onlyArchRooms.id, host.id);
  db.prepare('UPDATE conversations SET archived = 1 WHERE id = ?').run(archRoom.id);

  await t('orphan (0 roster, rooms>0) appears with correct room_n / archived', async () => {
    const res = await api('GET', '/api/stories/orphans');
    assert.equal(res.status, 200, res.text);
    const rows = res.json as OrphanRow[];
    const row = rows.find((r) => r.id === orphanA.id);
    assert.ok(row, 'orphanA listed');
    assert.equal(row!.name, '고아-A');
    assert.equal(row!.room_n, 2);
    assert.equal(row!.archived, false);
    assert.ok(typeof row!.updated_at === 'string' && row!.updated_at.length > 0);
  });

  await t('roster>0 excluded even with rooms', async () => {
    const res = await api('GET', '/api/stories/orphans');
    const rows = res.json as OrphanRow[];
    assert.equal(rows.some((r) => r.id === withRoster.id), false);
  });

  await t('empty roster + 0 non-archived rooms excluded', async () => {
    const res = await api('GET', '/api/stories/orphans');
    const rows = res.json as OrphanRow[];
    assert.equal(rows.some((r) => r.id === emptyNoRooms.id), false);
    assert.equal(rows.some((r) => r.id === onlyArchRooms.id), false);
  });

  await t('archived story that is orphan still listed with archived:true', async () => {
    const res = await api('GET', '/api/stories/orphans');
    const rows = res.json as OrphanRow[];
    const row = rows.find((r) => r.id === orphanArch.id);
    assert.ok(row, 'archived orphan listed');
    assert.equal(row!.archived, true);
    assert.equal(row!.room_n, 1);
  });

  await t('sort: higher room_n first; tie-break updated_at DESC', async () => {
    const res = await api('GET', '/api/stories/orphans');
    const rows = res.json as OrphanRow[];
    assert.ok(rows.length >= 3);
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      if (prev.room_n !== cur.room_n) {
        assert.ok(prev.room_n > cur.room_n, `room_n order ${prev.room_n} >= ${cur.room_n}`);
      } else {
        assert.ok(prev.updated_at >= cur.updated_at, `updated_at DESC on tie`);
      }
    }
    assert.equal(rows[0].id, orphanHi.id, '3 rooms first');
    const idxA = rows.findIndex((r) => r.id === orphanA.id);
    const idxArch = rows.findIndex((r) => r.id === orphanArch.id);
    assert.ok(idxA >= 0 && idxArch >= 0);
    assert.ok(idxA < idxArch, '2 rooms before 1 room');
  });

  await t('empty -> []', async () => {
    db.prepare('DELETE FROM story_characters').run();
    db.prepare('DELETE FROM conversations').run();
    db.prepare('DELETE FROM stories').run();
    const res = await api('GET', '/api/stories/orphans');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, []);
  });

  await t('UI: list -> detail deep-link; empty copy exact; no POST restore on page', () => {
    const navigated: string[] = [];
    const html = renderToStaticMarkup(React.createElement(StoryOrphanOpsView, {
      items: [{ id: 's1', name: '테스트', archived: true, room_n: 3, updated_at: 't' }],
      onOpenStory: (id: string) => { navigated.push(`/story/${id}`); },
    }));
    assert.match(html, /테스트/);
    assert.match(html, /대화 3개/);
    assert.match(html, /보관/);

    const view = StoryOrphanOpsView({
      items: [{ id: 'abc', name: '딥링크', archived: false, room_n: 2, updated_at: 't' }],
      onOpenStory: (id: string) => { navigated.push(`/story/${id}`); },
    }) as React.ReactElement;
    const buttons = React.Children.toArray((view.props as { children: React.ReactNode }).children);
    const btn = buttons[0] as React.ReactElement<{ onClick: () => void }>;
    btn.props.onClick();
    assert.deepEqual(navigated.filter((x) => x === '/story/abc'), ['/story/abc']);

    const emptyHtml = renderToStaticMarkup(React.createElement(StoryOrphanOpsView, {
      items: [],
      onOpenStory: () => {},
    }));
    assert.equal(emptyHtml.includes('고아 스토리가 없습니다.'), true);

    const pageSrc = fs.readFileSync(path.resolve('apps/web/src/pages/StoryOrphanOpsPage.tsx'), 'utf8');
    assert.equal(/POST|restore-characters|restore-candidates/.test(pageSrc), false);
    assert.match(pageSrc, /\/api\/stories\/orphans/);

    const navHtml = renderToStaticMarkup(React.createElement(SettingsNavigationRow, {
      title: '고아 스토리',
      href: '/settings/orphans',
    }));
    assert.match(navHtml, /고아 스토리/);
  });

  await t('source assert: only GET /api/stories/orphans; no orphans write endpoints', () => {
    const storiesSrc = fs.readFileSync(path.resolve('apps/server/src/routes/stories.ts'), 'utf8');
    assert.match(storiesSrc, /app\.get\('\/api\/stories\/orphans'/);
    assert.equal(/app\.(post|put|delete)\(['`]\/api\/stories\/orphans/.test(storiesSrc), false);
    const orphansIdx = storiesSrc.indexOf("app.get('/api/stories/orphans'");
    const idIdx = storiesSrc.indexOf("app.get<{ Params: { id: string } }>('/api/stories/:id'");
    assert.ok(orphansIdx > 0 && idIdx > orphansIdx, 'orphans before :id');
    const migrations = fs.readdirSync(path.resolve('apps/server/migrations'));
    assert.equal(migrations.some((f) => f.toLowerCase().includes('orphan')), false);
    const appSrc = fs.readFileSync(path.resolve('apps/web/src/App.tsx'), 'utf8');
    assert.match(appSrc, /\/settings\/orphans/);
    const settingsSrc = fs.readFileSync(path.resolve('apps/web/src/pages/SettingsPage.tsx'), 'utf8');
    assert.match(settingsSrc, /고아 스토리/);
    assert.match(settingsSrc, /\/settings\/orphans/);
  });

  await app.close();
  console.log(`passed ${passed}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
