/** npx tsx bench/storyEndingConditions.test.ts
 * ADR-F8h Slice 1 (story-ending-conditions-schema): `conditions` inside
 * endings_json — zod/parser/400 rules and the snapshot round-trip. No migration
 * (the field rides inside the existing column), no evaluator, no API behaviour
 * change beyond authorship 400s. The rule engine is `story-ending-eval-rule`.
 * Isolated: temp DB, no systemd, no live DB, no model call.
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
import { storyRoutes, parseEndings } from '../apps/server/src/routes/stories.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const FULL = {
  min_turns: 40,
  required_stats: { affection: { gte: 70 }, suspicion: { lte: 20 } },
  required_flags: ['met_sister', 'letter_read'],
  narrative_hint: '두 사람이 서로의 이름을 다시 불렀다',
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-ending-conditions-'));
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

  const base = { name: '조건 스토리', tagline: '', setting: '', minor_cast: [] };
  const putEndings = (id: string, endings: unknown) => api('PUT', `/api/stories/${id}`, { ...base, endings });

  const created = await api('POST', '/api/stories', base);
  assert.equal(created.status, 201, created.text);
  const story = created.json as { id: string };

  await t('0021 does not exist — conditions rides inside endings_json', () => {
    const files = fs.readdirSync('apps/server/migrations').filter((f) => f.startsWith('0021'));
    assert.deepEqual(files, [], 'ADR-F8h §4: this slice adds no migration');
  });

  await t('PUT stores conditions and GET round-trips every sub-key', async () => {
    const res = await putEndings(story.id, [{ id: 'true_end', title: '재회', conditions: FULL }]);
    assert.equal(res.status, 200, res.text);
    const got = await api('GET', `/api/stories/${story.id}`);
    const endings = (got.json as { endings: Array<{ id: string; conditions?: unknown }> }).endings;
    assert.equal(endings.length, 1);
    assert.deepEqual(endings[0].conditions, FULL);
  });

  await t('an ending without conditions keeps the pre-F8h shape — key absent, not {}', async () => {
    const res = await putEndings(story.id, [
      { id: 'free_end', title: '자유 결말' },
      { id: 'true_end', title: '재회', conditions: FULL },
    ]);
    assert.equal(res.status, 200, res.text);
    const raw = (db.prepare('SELECT endings_json FROM stories WHERE id = ?').get(story.id) as { endings_json: string }).endings_json;
    const stored = JSON.parse(raw) as Array<Record<string, unknown>>;
    assert.equal('conditions' in stored[0], false, 'no conditions key at all for a plain ending');
    assert.deepEqual(stored[1].conditions, FULL);
  });

  await t('conditions: {} is 400 — it would gate D1 behind a check that always passes', async () => {
    const res = await putEndings(story.id, [{ id: 'e', title: 't', conditions: {} }]);
    assert.equal(res.status, 400, res.text);
  });

  await t('unknown key inside conditions is 400, never a silent strip', async () => {
    const res = await putEndings(story.id, [{ id: 'e', title: 't', conditions: { min_turns: 3, mood: 'sad' } }]);
    assert.equal(res.status, 400, res.text);
  });

  await t('min_turns 0 / negative / non-integer are 400', async () => {
    for (const bad of [0, -1, 2.5]) {
      const res = await putEndings(story.id, [{ id: 'e', title: 't', conditions: { min_turns: bad } }]);
      assert.equal(res.status, 400, `min_turns ${bad} must be rejected: ${res.text}`);
    }
  });

  await t('required_stats bound with neither gte nor lte is 400', async () => {
    const res = await putEndings(story.id, [{ id: 'e', title: 't', conditions: { required_stats: { affection: {} } } }]);
    assert.equal(res.status, 400, res.text);
  });

  await t('required_stats with gte > lte is 400 — unsatisfiable, never reachable', async () => {
    const res = await putEndings(story.id, [
      { id: 'e', title: 't', conditions: { required_stats: { affection: { gte: 90, lte: 10 } } } },
    ]);
    assert.equal(res.status, 400, res.text);
  });

  await t('duplicate required_flags is 400', async () => {
    const res = await putEndings(story.id, [{ id: 'e', title: 't', conditions: { required_flags: ['a', 'a'] } }]);
    assert.equal(res.status, 400, res.text);
  });

  await t('narrative_hint over 500 chars is 400', async () => {
    const res = await putEndings(story.id, [{ id: 'e', title: 't', conditions: { narrative_hint: '가'.repeat(501) } }]);
    assert.equal(res.status, 400, res.text);
  });

  await t('F8g omit=preserve still holds — a PUT without `endings` keeps conditions', async () => {
    await putEndings(story.id, [{ id: 'true_end', title: '재회', conditions: FULL }]);
    const res = await api('PUT', `/api/stories/${story.id}`, { ...base, setting: '수정됨' });
    assert.equal(res.status, 200, res.text);
    const endings = (res.json as { endings: Array<{ conditions?: unknown }> }).endings;
    assert.deepEqual(endings[0].conditions, FULL, 'omitting endings must not drop conditions');
  });

  await t('explicit [] still clears, conditions and all (F8g regression)', async () => {
    const res = await putEndings(story.id, []);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual((res.json as { endings: unknown[] }).endings, []);
    await putEndings(story.id, [{ id: 'true_end', title: '재회', conditions: FULL }]);
  });

  await t('room snapshot is the raw string — conditions frozen at creation (F8g E4a)', async () => {
    const char = await api('POST', '/api/characters', { name: '설리', personality: 'x', first_message: '' });
    const host = char.json as { id: string };
    const conv = await api('POST', '/api/conversations', { characterId: host.id, storyId: story.id, mode: 'story' });
    assert.equal(conv.status, 201, conv.text);
    const convId = (conv.json as { id: string }).id;
    const snap = (db.prepare('SELECT story_endings_snapshot FROM conversations WHERE id = ?').get(convId) as {
      story_endings_snapshot: string | null;
    }).story_endings_snapshot;
    const live = (db.prepare('SELECT endings_json FROM stories WHERE id = ?').get(story.id) as { endings_json: string }).endings_json;
    assert.equal(snap, live, 'raw copy, not a re-serialize');
    assert.deepEqual(parseEndings(snap)[0].conditions, FULL);

    // authoring edits after creation must not reach the frozen room
    await putEndings(story.id, [{ id: 'true_end', title: '재회', conditions: { min_turns: 999 } }]);
    const after = (db.prepare('SELECT story_endings_snapshot FROM conversations WHERE id = ?').get(convId) as {
      story_endings_snapshot: string | null;
    }).story_endings_snapshot;
    assert.equal(after, snap, 'snapshot is immutable');
    assert.deepEqual(parseEndings(after)[0].conditions, FULL);
    await putEndings(story.id, [{ id: 'true_end', title: '재회', conditions: FULL }]);
  });

  await t('parseEndings degrades a damaged conditions to undefined, not {}', () => {
    const damaged = JSON.stringify([
      { id: 'a', title: 'A', conditions: 'not-an-object' },
      { id: 'b', title: 'B', conditions: { min_turns: 0, required_flags: [] } },
      { id: 'c', title: 'C', conditions: [1, 2] },
    ]);
    for (const e of parseEndings(damaged)) {
      assert.equal(e.conditions, undefined, `${e.id}: an unusable conditions must read as absent`);
    }
  });

  await t('this slice ships no evaluator and no confirm-path change', () => {
    const root = path.resolve('.');
    const changed = execSync(
      'git diff --name-only HEAD -- apps/server/src/routes/chat.ts apps/server/src/prompt/builder.ts apps/server/src/prompt/composeBeat.ts apps/server/src/prompt/resolveFocus.ts apps/server/src/prompt/templates.ts',
      { cwd: root, encoding: 'utf8' },
    ).trim();
    assert.equal(changed, '', `conditions-schema must not touch: ${changed}`);
    const stories = fs.readFileSync('apps/server/src/routes/stories.ts', 'utf8');
    assert.equal(/conditions not met/.test(stories), false, '403 guard belongs to story-ending-eval-rule');
    const convs = fs.readFileSync('apps/server/src/routes/conversations.ts', 'utf8');
    assert.equal(/conditions/.test(convs), false, 'the /end route stays F8g-only in this slice');
  });

  await t('StoryEditor round-trips conditions instead of erasing them on save', () => {
    const src = fs.readFileSync('apps/web/src/components/StoryEditor.tsx', 'utf8');
    assert.match(src, /e\.conditions \? \{ conditions: e\.conditions \} : \{\}/);
    assert.equal(/conditions:\s*\{\s*min_turns/.test(src), false, 'no authoring UI in this slice');
  });

  await app.close();
  console.log(`PASS=${passed}`);
}

main().catch((e) => {
  console.error('RED', e);
  process.exit(1);
});
