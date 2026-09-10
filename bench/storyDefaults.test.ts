/** npx tsx bench/storyDefaults.test.ts
 * story-editor-tabs A12 — stories.default_profile_name / default_format (0017).
 * Creation-time fallback only: routes/conversations.ts reads these when the
 * client omits profileName/scene.format at POST /api/conversations. Nothing in
 * buildPrompt/composeBeat/resolveFocus/chat.ts reads them — the fence at the
 * bottom asserts that. Temp DB only, real migrations, real HTTP.
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
import type { Ctx } from '../apps/server/src/ctx.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-story-defaults-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  // openDb only runs migrations, not seed() — live DBs always have model_profiles
  // seeded before a user can reach the story editor, so this mirrors that order.
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

  await t('0017 adds default_profile_name and default_format as nullable columns', () => {
    const cols = db.prepare('PRAGMA table_info(stories)').all() as Array<{ name: string; notnull: number }>;
    for (const name of ['default_profile_name', 'default_format']) {
      const col = cols.find((c) => c.name === name);
      assert.ok(col, `${name} missing`);
      assert.equal(col!.notnull, 0, `${name} must be nullable`);
    }
  });

  const char = async (name: string) => {
    const res = await api('POST', '/api/characters', { name, personality: `${name} 성격`, first_message: '' });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string; name: string };
  };
  const host = await char('설리');

  let storyWithDefaults: { id: string };
  await t('POST /api/stories stores default_profile_name + default_format, round-trips on GET', async () => {
    const res = await api('POST', '/api/stories', {
      name: '기본값 스토리', tagline: '', setting: '', minor_cast: [],
      default_profile_name: 'rp-creative', default_format: 'dialog',
    });
    assert.equal(res.status, 201, res.text);
    const body = res.json as { id: string; default_profile_name: string | null; default_format: string | null };
    assert.equal(body.default_profile_name, 'rp-creative');
    assert.equal(body.default_format, 'dialog');
    storyWithDefaults = { id: body.id };
    const got = await api('GET', `/api/stories/${body.id}`);
    const gotBody = got.json as { default_profile_name: string | null; default_format: string | null };
    assert.equal(gotBody.default_profile_name, 'rp-creative');
    assert.equal(gotBody.default_format, 'dialog');
  });

  await t('PUT can clear both back to null (always-write, not omit=preserve)', async () => {
    const res = await api('PUT', `/api/stories/${storyWithDefaults.id}`, {
      name: '기본값 스토리', tagline: '', setting: '', minor_cast: [],
      default_profile_name: null, default_format: null,
    });
    assert.equal(res.status, 200, res.text);
    const body = res.json as { default_profile_name: string | null; default_format: string | null };
    assert.equal(body.default_profile_name, null);
    assert.equal(body.default_format, null);
    // restore for the remaining tests
    await api('PUT', `/api/stories/${storyWithDefaults.id}`, {
      name: '기본값 스토리', tagline: '', setting: '', minor_cast: [],
      default_profile_name: 'rp-creative', default_format: 'dialog',
    });
  });

  await t('story room create with no profileName/scene.format falls back to the story defaults', async () => {
    const res = await api('POST', '/api/conversations', { characterId: host.id, storyId: storyWithDefaults.id, mode: 'story' });
    assert.equal(res.status, 201, res.text);
    const conv = res.json as { profile_name: string; scene: { format?: string } };
    assert.equal(conv.profile_name, 'rp-creative');
    assert.equal(conv.scene.format, 'dialog');
  });

  await t('explicit profileName/scene.format in the request always wins over story defaults', async () => {
    const res = await api('POST', '/api/conversations', {
      characterId: host.id, storyId: storyWithDefaults.id, mode: 'story',
      profileName: 'rp-balanced', scene: { format: 'hunter' },
    });
    assert.equal(res.status, 201, res.text);
    const conv = res.json as { profile_name: string; scene: { format?: string } };
    assert.equal(conv.profile_name, 'rp-balanced');
    assert.equal(conv.scene.format, 'hunter');
  });

  await t('story with no defaults set behaves exactly as before this slice', async () => {
    const plainStory = await api('POST', '/api/stories', { name: '민짜 스토리', tagline: '', setting: '', minor_cast: [] });
    const story = plainStory.json as { id: string; default_profile_name: string | null; default_format: string | null };
    assert.equal(story.default_profile_name, null);
    assert.equal(story.default_format, null);
    const res = await api('POST', '/api/conversations', { characterId: host.id, storyId: story.id, mode: 'story' });
    const conv = res.json as { profile_name: string; scene: { format?: string } };
    assert.equal(conv.profile_name, 'rp-balanced');
    assert.equal(conv.scene.format, undefined, 'absent, not defaulted — byte-identical to pre-A12 scene_json');
  });

  await t('1:1 room (no storyId) is unaffected even though a story elsewhere has defaults set', async () => {
    const res = await api('POST', '/api/conversations', { characterId: host.id, mode: 'chat' });
    assert.equal(res.status, 201, res.text);
    const conv = res.json as { profile_name: string; scene: { format?: string } };
    assert.equal(conv.profile_name, 'rp-balanced');
    assert.equal(conv.scene.format, undefined);
  });

  await t('story-editor-tabs A12 does not touch the F9/1:1-frozen files', () => {
    const root = path.resolve('.');
    const changed = execSync(
      'git diff --name-only HEAD -- apps/server/src/prompt/resolveFocus.ts apps/server/src/routes/chat.ts apps/server/src/prompt/composeBeat.ts apps/server/src/prompt/builder.ts apps/server/src/prompt/templates.ts',
      { cwd: root, encoding: 'utf8' },
    ).trim();
    assert.equal(changed, '', `A12 must not touch: ${changed}`);
  });

  await app.close();
  console.log(`PASS=${passed}`);
}

main().catch((e) => {
  console.error('RED', e);
  process.exit(1);
});
