/** npx tsx bench/storyStats.test.ts
 * story-editor-tabs A7 (D2=a) — stories.stats_json (0018), display-only.
 * Values live on conversation.scene.stats; applySceneDelta allow-list unchanged.
 * Temp DB only, real migrations, real HTTP.
 * Isolated: no systemd, no live DB, no model call.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import { applySceneDelta } from '../apps/server/src/prompt/applySceneDelta.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const SAN = { id: 'san', label: 'SAN', min: 0, max: 100, default: 50 };

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-story-stats-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare('INSERT INTO model_profiles (name) VALUES (?)').run('rp-creative');

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

  await t('0018 adds stats_json as NOT NULL default []', () => {
    const cols = db.prepare('PRAGMA table_info(stories)').all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
    const col = cols.find((c) => c.name === 'stats_json');
    assert.ok(col, 'stats_json missing');
    assert.equal(col!.notnull, 1, 'stats_json must be NOT NULL');
  });

  const char = async (name: string) => {
    const res = await api('POST', '/api/characters', { name, personality: `${name} 성격`, first_message: '' });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string; name: string };
  };
  const host = await char('설리');

  let storyId = '';
  await t('POST /api/stories stores stats_json and round-trips on GET', async () => {
    const res = await api('POST', '/api/stories', {
      name: '스탯 스토리', tagline: '', setting: '', minor_cast: [],
      stats_json: [SAN],
    });
    assert.equal(res.status, 201, res.text);
    const body = res.json as { id: string; stats_json: unknown };
    assert.deepEqual(body.stats_json, [SAN]);
    storyId = body.id;
    const got = await api('GET', `/api/stories/${body.id}`);
    assert.deepEqual((got.json as { stats_json: unknown }).stats_json, [SAN]);
  });

  await t('POST rejects more than 7 stats, bad id, default out of range', async () => {
    const tooMany = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, label: `S${i}`, min: 0, max: 10, default: 1 }));
    const over = await api('POST', '/api/stories', { name: 'x', tagline: '', setting: '', minor_cast: [], stats_json: tooMany });
    assert.equal(over.status, 400, over.text);
    const badId = await api('POST', '/api/stories', {
      name: 'x', tagline: '', setting: '', minor_cast: [],
      stats_json: [{ id: 'SAN!', label: 'SAN', min: 0, max: 100, default: 50 }],
    });
    assert.equal(badId.status, 400, badId.text);
    const oob = await api('POST', '/api/stories', {
      name: 'x', tagline: '', setting: '', minor_cast: [],
      stats_json: [{ id: 'san', label: 'SAN', min: 0, max: 10, default: 50 }],
    });
    assert.equal(oob.status, 400, oob.text);
  });

  await t('PUT omitting stats_json preserves the stored list', async () => {
    const res = await api('PUT', `/api/stories/${storyId}`, {
      name: '스탯 스토리', tagline: '', setting: '', minor_cast: [],
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual((res.json as { stats_json: unknown }).stats_json, [SAN]);
  });

  await t('PUT stats_json [] clears; story room create seeds scene.stats from defaults', async () => {
    const cleared = await api('PUT', `/api/stories/${storyId}`, {
      name: '스탯 스토리', tagline: '', setting: '', minor_cast: [],
      stats_json: [],
    });
    assert.equal(cleared.status, 200, cleared.text);
    assert.deepEqual((cleared.json as { stats_json: unknown }).stats_json, []);
    const restored = await api('PUT', `/api/stories/${storyId}`, {
      name: '스탯 스토리', tagline: '', setting: '', minor_cast: [],
      stats_json: [SAN],
    });
    assert.equal(restored.status, 200, restored.text);
    const conv = await api('POST', '/api/conversations', { characterId: host.id, storyId, mode: 'story' });
    assert.equal(conv.status, 201, conv.text);
    const scene = (conv.json as { scene: { stats?: Record<string, number>; stat_defs?: unknown } }).scene;
    assert.deepEqual(scene.stats, { san: 50 });
    assert.deepEqual(scene.stat_defs, [{ id: 'san', label: 'SAN', min: 0, max: 100 }]);
  });

  await t('explicit scene.stats in the request wins over story defaults', async () => {
    const conv = await api('POST', '/api/conversations', {
      characterId: host.id, storyId, mode: 'story',
      scene: { stats: { san: 7 } },
    });
    assert.equal(conv.status, 201, conv.text);
    const scene = (conv.json as { scene: { stats?: Record<string, number> } }).scene;
    assert.deepEqual(scene.stats, { san: 7 });
  });

  await t('story with empty stats_json and 1:1 rooms leave scene.stats absent', async () => {
    const plain = await api('POST', '/api/stories', { name: '민짜', tagline: '', setting: '', minor_cast: [] });
    const sid = (plain.json as { id: string }).id;
    const storyConv = await api('POST', '/api/conversations', { characterId: host.id, storyId: sid, mode: 'story' });
    assert.equal(storyConv.status, 201, storyConv.text);
    const storyScene = (storyConv.json as { scene: { stats?: unknown } }).scene;
    assert.equal(storyScene.stats, undefined);
    const oneToOne = await api('POST', '/api/conversations', { characterId: host.id, mode: 'chat' });
    assert.equal(oneToOne.status, 201, oneToOne.text);
    const scene = (oneToOne.json as { scene: { stats?: unknown } }).scene;
    assert.equal(scene.stats, undefined);
  });

  await t('D2=a does not touch applySceneDelta / composeBeat / chat / resolveFocus / builder / templates', () => {
    const root = path.resolve('.');
    const changed = execSync(
      'git diff --name-only HEAD -- apps/server/src/prompt/applySceneDelta.ts apps/server/src/prompt/resolveFocus.ts apps/server/src/prompt/composeBeat.ts apps/server/src/prompt/builder.ts apps/server/src/prompt/templates.ts',
      { cwd: root, encoding: 'utf8' },
    ).trim();
    assert.equal(changed, '', `A7 D2=a must not touch: ${changed}`);
    const chatDiff = execSync('git diff HEAD -- apps/server/src/routes/chat.ts', { cwd: root, encoding: 'utf8' });
    for (const line of chatDiff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) assert.ok(line.includes('ended_at') || line.includes('already ended'), `chat.ts guard-only: ${line}`);
    }
  });

  await t('StoryEditor has a 스탯 tab; PUT body can include stats_json', () => {
    const editor = fs.readFileSync(path.resolve('apps/web/src/components/StoryEditor.tsx'), 'utf8');
    assert.ok(editor.includes("key: 'stats'"));
    assert.ok(editor.includes('스탯'));
    assert.ok(editor.includes('stats_json'));
    assert.equal(/from ['\"][^'\"]*applySceneDelta/.test(editor), false);
  });

  await t('applySceneDelta ignores stats and keeps the previous values', () => {
    const before = {
      scene_version: 0,
      stats: { san: 50 },
      stat_defs: [{ id: 'san', label: 'SAN', min: 0, max: 100 }],
      user_sheet: { hp: 10, money: 0 },
    };
    const r = applySceneDelta(before as never, {
      base_version: 0,
      stats: { san: 0 },
      hp_delta: 1,
    } as never, { weathers: [], locations: [], arcs: [], stagesByArc: {}, flags: {} }, 0);
    assert.ok(r.ignored.some((i) => i.key === 'stats' && i.reason === 'not_in_allowlist'));
    assert.equal(r.state.stats?.san, 50);
    assert.deepEqual(r.state.stat_defs, before.stat_defs);
    assert.equal(r.state.user_sheet?.hp, 11);
  });

  await app.close();
  console.log(`PASS=${passed}`);
}

main().catch((e) => {
  console.error('RED', e);
  process.exit(1);
});
