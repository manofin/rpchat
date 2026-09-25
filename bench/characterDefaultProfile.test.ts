/** npx tsx bench/characterDefaultProfile.test.ts
 * profile-instruction (0023) — characters.default_profile_name.
 *
 *   API         → POST/PUT store it; unknown profile → 400 (not an FK 500); PUT without the
 *                 field keeps it (pre-0023 clients); explicit null clears it
 *   precedence  → POST /api/conversations: explicit > story default > character default > rp-balanced,
 *                 resolved once and stored in conversations.profile_name
 *   FK          → deleting the profile sets the character default to NULL
 *   preview     → /prompt-preview uses the character default (its 서술 지침 section shows)
 *
 * Temp DB, real migrations, real routes. Isolated: no systemd, no live DB, no model call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-char-default-profile-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  const ins = db.prepare('INSERT INTO model_profiles (name, instruction_enabled, instruction_text) VALUES (?, ?, ?)');
  ins.run('rp-balanced', 0, null);
  ins.run('rp-creative', 0, null);
  ins.run('rp-engine', 1, '# 합성 엔진\n- {{user}} 대필 금지.');
  ins.run('rp-doomed', 0, null);

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
  await app.ready();
  const api = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: object) => {
    const r = await app.inject({ method, url, payload: body });
    return { status: r.statusCode, json: r.body ? r.json() : null, text: r.body };
  };
  const stored = (id: string) => (db.prepare('SELECT default_profile_name AS v FROM characters WHERE id = ?').get(id) as { v: string | null }).v;
  const card = (name: string, extra: object = {}) => ({ name, personality: `${name} 성격`, first_message: '', ...extra });

  let withDefault = '';
  let plain = '';

  await t('POST stores default_profile_name; unknown profile → 400, nothing inserted', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS c FROM characters').get() as { c: number }).c;
    const bad = await api('POST', '/api/characters', card('없는프로필', { default_profile_name: 'rp-nope' }));
    assert.equal(bad.status, 400, bad.text);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM characters').get() as { c: number }).c, before);
    const ok = await api('POST', '/api/characters', card('기본있음', { default_profile_name: 'rp-engine' }));
    assert.equal(ok.status, 201, ok.text);
    withDefault = (ok.json as { id: string; default_profile_name: string }).id;
    assert.equal((ok.json as { default_profile_name: string }).default_profile_name, 'rp-engine');
    const p = await api('POST', '/api/characters', card('기본없음'));
    assert.equal(p.status, 201, p.text);
    plain = (p.json as { id: string }).id;
    assert.equal(stored(plain), null);
  });

  await t('PUT without the field keeps it; explicit null clears; unknown → 400 and unchanged', async () => {
    assert.equal((await api('PUT', `/api/characters/${withDefault}`, card('기본있음', { tagline: '수정' }))).status, 200);
    assert.equal(stored(withDefault), 'rp-engine');
    assert.equal((await api('PUT', `/api/characters/${withDefault}`, card('기본있음', { default_profile_name: 'rp-nope' }))).status, 400);
    assert.equal(stored(withDefault), 'rp-engine');
    assert.equal((await api('PUT', `/api/characters/${plain}`, card('기본없음', { default_profile_name: 'rp-creative' }))).status, 200);
    assert.equal(stored(plain), 'rp-creative');
    assert.equal((await api('PUT', `/api/characters/${plain}`, card('기본없음', { default_profile_name: null }))).status, 200);
    assert.equal(stored(plain), null);
  });

  const storyWith = await api('POST', '/api/stories', { name: '기본 있는 스토리', tagline: '', setting: '설정', minor_cast: [], default_profile_name: 'rp-creative' });
  const storyWithout = await api('POST', '/api/stories', { name: '기본 없는 스토리', tagline: '', setting: '설정', minor_cast: [] });
  assert.equal(storyWith.status, 201, storyWith.text);
  assert.equal(storyWithout.status, 201, storyWithout.text);
  for (const s of [storyWith, storyWithout]) {
    for (const [cid, order] of [[withDefault, 0], [plain, 1]] as const) {
      assert.equal((await api('POST', `/api/stories/${(s.json as { id: string }).id}/characters`, { characterId: cid, sortOrder: order })).status, 201);
    }
  }
  const create = async (body: object) => {
    const r = await api('POST', '/api/conversations', body);
    assert.equal(r.status, 201, r.text);
    const id = (r.json as { id: string }).id;
    return (db.prepare('SELECT profile_name FROM conversations WHERE id = ?').get(id) as { profile_name: string }).profile_name;
  };

  await t('precedence: explicit > story default > character default > rp-balanced (stored on the room)', async () => {
    assert.equal(await create({ characterId: withDefault }), 'rp-engine', 'character default');
    assert.equal(await create({ characterId: withDefault, profileName: 'rp-balanced' }), 'rp-balanced', 'explicit wins');
    assert.equal(await create({ characterId: withDefault, storyId: (storyWith.json as { id: string }).id, mode: 'story' }), 'rp-creative', 'story default over character');
    assert.equal(await create({ characterId: withDefault, storyId: (storyWithout.json as { id: string }).id, mode: 'story' }), 'rp-engine', 'story without default → character');
    assert.equal(await create({ characterId: plain }), 'rp-balanced', 'no defaults → pre-0023 value');
  });

  await t('prompt-preview uses the character default: 서술 지침 section present only there', async () => {
    const on = await api('GET', `/api/characters/${withDefault}/prompt-preview`);
    assert.equal(on.status, 200, on.text);
    const secs = (on.json as { sections: Array<{ name: string; note?: string }> }).sections;
    const s = secs.find((x) => x.name === '서술 지침');
    assert.ok(s && s.note!.startsWith('프로필 rp-engine'));
    const off = await api('GET', `/api/characters/${plain}/prompt-preview`);
    assert.ok(!(off.json as { sections: Array<{ name: string }> }).sections.some((x) => x.name === '서술 지침'));
  });

  await t('FK: deleting the profile sets the character default to NULL', () => {
    db.prepare("UPDATE characters SET default_profile_name = 'rp-doomed' WHERE id = ?").run(plain);
    db.prepare("DELETE FROM model_profiles WHERE name = 'rp-doomed'").run();
    assert.equal(stored(plain), null);
  });

  await app.close();
  db.close();
  console.log(`PASS=${passed}`);
}

main().catch((e) => {
  console.error('RED', e);
  process.exit(1);
});
