/** npx tsx bench/characterStories.test.ts
 * C4 character→story reverse lookup. Temp DB + real routes. No live DB, no model, no deploy.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import { overLimitFields } from '../apps/web/src/lib/characterFieldLimits.ts';
import { hasIncompleteExamplePairs } from '../apps/web/src/lib/characterExamplePairs.ts';

const require2 = createRequire(import.meta.url);
const dir = path.dirname(fileURLToPath(import.meta.url));
const editorPath = path.join(dir, '..', 'apps/web/src/components/CharacterEditor.tsx');
const charRoutePath = path.join(dir, '..', 'apps/server/src/routes/characters.ts');
const storiesRoutePath = path.join(dir, '..', 'apps/server/src/routes/stories.ts');

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const LINK_KEYS = ['id', 'name', 'tagline', 'archived', 'role', 'sort_order'];
const FORBIDDEN_STORY_FIELDS = ['scene_catalog', 'opening', 'openings_extra', 'endings'];

function listHandlerSrc(charSrc: string): string {
  const startTok = "app.get('/api/characters', async () => {";
  const endTok = "app.post('/api/characters'";
  const start = charSrc.indexOf(startTok);
  const end = charSrc.indexOf(endTok);
  assert.ok(start >= 0, 'GET /api/characters list handler start missing');
  assert.ok(end > start, 'GET /api/characters list handler end missing');
  return charSrc.slice(start, end);
}

function gitShow(file: string): string {
  return execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8', cwd: path.join(dir, '..') });
}

function insertChar(db: ReturnType<typeof openDb>, id: string, name = id) {
  db.prepare(
    `INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, name, '', '', '', '', '', '', '', '', '[]', 't0', 't0');
}

function insertStory(
  db: ReturnType<typeof openDb>,
  id: string,
  name: string,
  archived: number,
  updatedAt: string,
  createdAt = updatedAt,
  tagline = '',
) {
  db.prepare(
    `INSERT INTO stories (id, name, tagline, setting, minor_cast, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, name, tagline, '', '[]', archived, createdAt, updatedAt);
}

function mapRow(db: ReturnType<typeof openDb>, storyId: string, characterId: string, sortOrder = 0) {
  db.prepare(`INSERT INTO story_characters (story_id, character_id, role, sort_order) VALUES (?,?,?,?)`).run(
    storyId,
    characterId,
    'main',
    sortOrder,
  );
}

function fakeCtx(db: ReturnType<typeof openDb>): Ctx {
  return {
    db,
    model: {
      complete: async () => {
        throw new Error('C4 must not call the model');
      },
    } as unknown as Ctx['model'],
    queue: { activeList: [] } as unknown as Ctx['queue'],
    log: console as unknown as Ctx['log'],
    resolvedModel: () => 'm',
    setResolvedModel: () => {},
    health: async () => ({ ok: true, checkedAt: 't', latencyMs: 0, models: [] }),
  } as Ctx;
}

async function buildApp(db: ReturnType<typeof openDb>) {
  const ctx = fakeCtx(db);
  const app = Fastify({ logger: false });
  await app.register(characterRoutes(ctx));
  await app.register(storyRoutes(ctx));
  return app;
}

function helperSrc(editorSrc: string): string {
  const startTok = '/* C4-story-link-helpers */';
  const endTok = '/* C4-story-link-helpers-end */';
  const start = editorSrc.indexOf(startTok);
  const end = editorSrc.indexOf(endTok);
  assert.ok(start >= 0, 'C4 helper start marker missing');
  assert.ok(end > start, 'C4 helper end marker missing');
  return editorSrc.slice(start, end + endTok.length);
}

function loadHelpers(editorSrc: string) {
  const src = helperSrc(editorSrc);
  const wrapped = `
    ${src}
    export const __all = { loadCharacterStoryLinks, loadCharacterStoryUi, addCharacterStoryLink, removeCharacterStoryLink };
  `;
  const { transformSync } = require2('esbuild');
  const js = transformSync(wrapped, { loader: 'ts', format: 'cjs' }).code;
  const exported: {
    __all?: {
      loadCharacterStoryLinks: (
        id: string | null | undefined,
        getFn: <T>(path: string) => Promise<T>,
      ) => Promise<unknown[]>;
      loadCharacterStoryUi: (
        id: string | null | undefined,
        getFn: <T>(path: string) => Promise<T>,
      ) => Promise<{ links: unknown[]; catalog: unknown[] }>;
      addCharacterStoryLink: (
        storyId: string,
        characterId: string,
        postFn: (path: string, body: unknown) => Promise<unknown>,
        getFn: <T>(path: string) => Promise<T>,
      ) => Promise<unknown[]>;
      removeCharacterStoryLink: (
        storyId: string,
        characterId: string,
        delFn: (path: string) => Promise<unknown>,
        getFn: <T>(path: string) => Promise<T>,
        confirmFn: (msg: string, opts?: { danger?: boolean; okLabel?: string }) => Promise<boolean>,
      ) => Promise<unknown[] | null>;
    };
  } = {};
  const moduleObj = { exports: exported };
  new Function('exports', 'module', 'require', js)(exported, moduleObj, require2);
  const all = exported.__all ?? (moduleObj.exports as { __all: typeof exported.__all }).__all;
  assert.ok(all, 'C4 helpers failed to bind');
  return all!;
}

function tabSection(editor: string, key: string, next: string | null): string {
  const startTok = `tab === '${key}'`;
  const start = editor.indexOf(startTok);
  assert.ok(start >= 0, `tab === '${key}' missing`);
  const endTok = next ? `tab === '${next}'` : '← 이전';
  const end = editor.indexOf(endTok, start + startTok.length);
  assert.ok(end > start, `end marker missing after ${key}`);
  return editor.slice(start, end);
}

function bindSave(editorSrc: string, ctx: {
  d: Record<string, unknown>;
  character: { id: string } | null;
  requests: Array<{ method: string; url: string; body: unknown }>;
  toasts: unknown[];
  onSavedCalls: unknown[];
}) {
  const start = editorSrc.indexOf('async function save()');
  const end = editorSrc.indexOf('function restoreDraft()');
  assert.ok(start >= 0 && end > start, 'save() slice missing');
  const saveSrc = editorSrc.slice(start, end);
  const wrapped = `
    export function bind(ctx: any) {
      const d = ctx.d;
      const character = ctx.character;
      const exampleMode = 'raw';
      const exampleRows: any[] = [];
      const stagedFileRef = { current: null };
      const suppressRef = { current: false };
      const dirtyRef = { current: false };
      function setSaving(_v: boolean) {}
      function clearTimer() {}
      function clearStagedAvatar() {}
      function setPendingDraft(_v: any) {}
      function removeCharacterDraft() {}
      function hasIncompleteExamplePairs() { return false; }
      const overLimitFields = ctx.overLimitFields;
      const ui = { toast(msg: unknown, kind?: unknown) { ctx.toasts.push({ msg, kind }); } };
      function onSaved(saved: unknown) { ctx.onSavedCalls.push(saved); }
      async function put(url: string, body: unknown) {
        ctx.requests.push({ method: 'PUT', url, body });
        return { id: character.id, ...((body && typeof body === 'object') ? body : {}) };
      }
      async function post(url: string, body: unknown) {
        ctx.requests.push({ method: 'POST', url, body });
        return { id: 'new-id', ...((body && typeof body === 'object') ? body : {}) };
      }
      async function postBinary() { throw new Error('C4 save must not upload'); }
      ${saveSrc}
      return { save };
    }
  `;
  const { transformSync } = require2('esbuild');
  const js = transformSync(wrapped, { loader: 'ts', format: 'cjs' }).code;
  const exported: { bind?: (c: unknown) => { save: () => Promise<void> } } = {};
  const moduleObj = { exports: exported };
  new Function('exports', 'module', 'require', js)(exported, moduleObj, require2);
  const bind = exported.bind ?? (moduleObj.exports as { bind: typeof exported.bind }).bind;
  assert.equal(typeof bind, 'function');
  const bindCtx = ctx as typeof ctx & { overLimitFields: typeof overLimitFields };
  bindCtx.overLimitFields = overLimitFields;
  return bind!(bindCtx);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-c4-stories-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  const app = await buildApp(db);

  insertChar(db, 'c1', '서리');
  insertChar(db, 'c-empty', '빈캐릭');
  insertStory(db, 's-active', '활성스토리', 0, 't2', 't0', '활탯말');
  insertStory(db, 's-arch', '보관스토리', 1, 't9', 't0', '보관탯말');
  insertStory(db, 's-older', '오래된스토리', 0, 't1', 't0', '옛탯말');
  insertStory(db, 's-newer', '새스토리', 0, 't3', 't0', '새탯말');
  mapRow(db, 's-active', 'c1', 1);
  mapRow(db, 's-arch', 'c1', 2);
  mapRow(db, 's-older', 'c1', 3);
  mapRow(db, 's-newer', 'c1', 0);

  await t('1 GET /api/characters/:id/stories returns hosted stories', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/characters/c1/stories' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(body));
    assert.ok(body.some((s) => s.id === 's-active'));
    const active = body.find((s) => s.id === 's-active')!;
    assert.equal(active.name, '활성스토리');
    assert.equal(active.tagline, '활탯말');
    assert.equal(active.archived, false);
    assert.equal(active.role, 'main');
    assert.equal(active.sort_order, 1);
    for (const key of LINK_KEYS) assert.ok(key in active, `missing ${key}`);
  });

  await t('2 archived stories are excluded', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/characters/c1/stories' });
    const body = res.json() as Array<{ id: string }>;
    assert.equal(body.some((s) => s.id === 's-arch'), false);
  });

  await t('3 same character on archived+active returns only active', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/characters/c1/stories' });
    const ids = (res.json() as Array<{ id: string }>).map((s) => s.id);
    assert.equal(ids.includes('s-active'), true);
    assert.equal(ids.includes('s-arch'), false);
  });

  await t('4 no mappings returns empty array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/characters/c-empty/stories' });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), []);
  });

  await t('5 missing character is 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/characters/no-such/stories' });
    assert.equal(res.statusCode, 404);
  });

  await t('6 response omits scene_catalog/opening/openings_extra/endings', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/characters/c1/stories' });
    const body = res.json() as Array<Record<string, unknown>>;
    assert.ok(body.length > 0);
    for (const row of body) {
      for (const k of FORBIDDEN_STORY_FIELDS) assert.equal(k in row, false, k);
      const keys = Object.keys(row).sort();
      assert.deepEqual(keys, [...LINK_KEYS].sort());
    }
  });

  await t('7 sort is deterministic (updated_at DESC, id)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/characters/c1/stories' });
    const ids = (res.json() as Array<{ id: string }>).map((s) => s.id);
    assert.deepEqual(ids, ['s-newer', 's-active', 's-older']);
  });

  const storiesSrc = fs.readFileSync(storiesRoutePath, 'utf8');
  const storiesHead = gitShow('apps/server/src/routes/stories.ts');
  const charSrc = fs.readFileSync(charRoutePath, 'utf8');
  const editorSrc = fs.readFileSync(editorPath, 'utf8');

  await t('8 existing POST /api/stories/:id/characters source unchanged', () => {
    const tok = "app.post<{ Params: { id: string } }>('/api/stories/:id/characters'";
    const a = storiesSrc.indexOf(tok);
    const b = storiesHead.indexOf(tok);
    assert.ok(a >= 0 && b >= 0, 'POST mapping route missing');
    const aEnd = storiesSrc.indexOf("app.delete<{ Params: { id: string; characterId: string } }>(", a);
    const bEnd = storiesHead.indexOf("app.delete<{ Params: { id: string; characterId: string } }>(", b);
    assert.ok(aEnd > a && bEnd > b, 'POST mapping end missing');
    assert.equal(storiesSrc.slice(a, aEnd), storiesHead.slice(b, bEnd));
  });

  await t('9 existing DELETE .../characters/:characterId source unchanged', () => {
    const tok = "app.delete<{ Params: { id: string; characterId: string } }>(";
    const a = storiesSrc.indexOf(tok);
    const b = storiesHead.indexOf(tok);
    assert.ok(a >= 0 && b >= 0, 'DELETE mapping route missing');
    const aEnd = storiesSrc.indexOf('// ---- 주입 미리보기', a);
    const bEnd = storiesHead.indexOf('// ---- 주입 미리보기', b);
    assert.ok(aEnd > a && bEnd > b, 'DELETE mapping end missing');
    assert.equal(storiesSrc.slice(a, aEnd), storiesHead.slice(b, bEnd));
  });

  await t('10 no new write route was added', () => {
    assert.equal(storiesSrc, storiesHead, 'stories.ts must be untouched');
    assert.equal(/app\.(post|put|patch|delete)[\s\S]{0,120}\/stories/.test(charSrc), false);
    assert.ok(charSrc.includes("app.get<{ Params: { id: string } }>('/api/characters/:id/stories'"));
  });

  await t('11 story_characters schema/migrations unchanged', () => {
    const migDiff = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'apps/server/migrations'], {
      encoding: 'utf8',
      cwd: path.join(dir, '..'),
    }).trim();
    assert.equal(migDiff, '');
    const mig = fs.readFileSync(path.join(dir, '..', 'apps/server/migrations/0008_stories.sql'), 'utf8');
    assert.equal(mig, gitShow('apps/server/migrations/0008_stories.sql'));
    assert.match(mig, /CREATE TABLE story_characters/);
  });

  insertChar(db, 'c-write', '쓰기캐릭');
  insertStory(db, 's-write', '쓰리스토리', 0, 't5', 't5', '쓰기탯말');

  await t('12 add via existing POST is reflected in reverse list', async () => {
    const postRes = await app.inject({
      method: 'POST',
      url: '/api/stories/s-write/characters',
      payload: { characterId: 'c-write' },
    });
    assert.equal(postRes.statusCode, 201, postRes.body);
    const list = await app.inject({ method: 'GET', url: '/api/characters/c-write/stories' });
    assert.equal(list.statusCode, 200);
    const ids = (list.json() as Array<{ id: string }>).map((s) => s.id);
    assert.deepEqual(ids, ['s-write']);
  });

  await t('13 duplicate add is 409', async () => {
    const postRes = await app.inject({
      method: 'POST',
      url: '/api/stories/s-write/characters',
      payload: { characterId: 'c-write' },
    });
    assert.equal(postRes.statusCode, 409, postRes.body);
  });

  await t('14 delete via existing DELETE drops the mapping', async () => {
    const delRes = await app.inject({
      method: 'DELETE',
      url: '/api/stories/s-write/characters/c-write',
    });
    assert.equal(delRes.statusCode, 200, delRes.body);
    const list = await app.inject({ method: 'GET', url: '/api/characters/c-write/stories' });
    assert.deepEqual(list.json(), []);
  });

  await t('15 deleting a missing mapping is 404', async () => {
    const delRes = await app.inject({
      method: 'DELETE',
      url: '/api/stories/s-write/characters/c-write',
    });
    assert.equal(delRes.statusCode, 404, delRes.body);
  });

  const helpers = loadHelpers(editorSrc);
  const draft = { name: '초안', tagline: 'x' };

  await t('16 unsaved character issues 0 server requests', async () => {
    const calls: string[] = [];
    const getFn = async <T>(path: string): Promise<T> => {
      calls.push(path);
      throw new Error(`unexpected GET ${path}`);
    };
    const ui = await helpers.loadCharacterStoryUi(undefined, getFn);
    const links = await helpers.loadCharacterStoryLinks(null, getFn);
    assert.deepEqual(ui, { links: [], catalog: [] });
    assert.deepEqual(links, []);
    assert.deepEqual(calls, []);
    const effectStart = editorSrc.indexOf('useEffect(() => {\n    if (!open || !character?.id)');
    assert.ok(effectStart >= 0, 'unsaved guard effect missing');
  });

  await t('17 fetch failure does not throw the editor', async () => {
    const getFn = async <T>(_path: string): Promise<T> => {
      throw new Error('network down');
    };
    let threw = false;
    let result: { links: unknown[]; catalog: unknown[] } | undefined;
    try {
      result = await helpers.loadCharacterStoryUi('c1', getFn);
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
    assert.deepEqual(result, { links: [], catalog: [] });
  });

  await t('18 story-link UI does not call set() (draft unchanged)', async () => {
    assert.equal(/\bset\(/.test(helperSrc(editorSrc)), false);
    const addSrcStart = editorSrc.indexOf('async function addLinkedStory()');
    const addSrcEnd = editorSrc.indexOf('async function removeLinkedStory(');
    const remSrcEnd = editorSrc.indexOf('return (', addSrcEnd);
    assert.ok(addSrcStart >= 0 && addSrcEnd > addSrcStart && remSrcEnd > addSrcEnd);
    const uiFns = editorSrc.slice(addSrcStart, remSrcEnd);
    assert.equal(/\bset\(/.test(uiFns), false);
    const before = { ...draft };
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const getFn = async <T>(url: string): Promise<T> => {
      calls.push({ method: 'GET', url });
      return [] as T;
    };
    const postFn = async (url: string, body: unknown) => {
      calls.push({ method: 'POST', url, body });
      return { ok: true };
    };
    const delFn = async (url: string) => {
      calls.push({ method: 'DELETE', url });
      return { ok: true };
    };
    await helpers.addCharacterStoryLink('s-write', 'c-write', postFn, getFn);
    await helpers.removeCharacterStoryLink('s-write', 'c-write', delFn, getFn, async () => true);
    assert.deepEqual(draft, before);
    assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/api/stories/s-write/characters'));
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === '/api/stories/s-write/characters/c-write'));
  });

  await t('19 save payload does not include story list', async () => {
    const ctx = {
      d: {
        name: '저장캐릭',
        tagline: '',
        avatar: null,
        description: '',
        personality: '',
        speech_style: '',
        scenario: '',
        first_message: '',
        example_dialogue: '',
        taboos: '',
        play_guide: '',
        tags: [],
      },
      character: { id: 'c1' },
      requests: [] as Array<{ method: string; url: string; body: unknown }>,
      toasts: [] as unknown[],
      onSavedCalls: [] as unknown[],
    };
    const { save } = bindSave(editorSrc, ctx);
    await save();
    assert.equal(ctx.requests.length, 1);
    assert.equal(ctx.requests[0].method, 'PUT');
    const body = ctx.requests[0].body as Record<string, unknown>;
    assert.equal('stories' in body, false);
    assert.equal('linkedStories' in body, false);
    assert.equal('storyCatalog' in body, false);
    assert.deepEqual(body, ctx.d);
    void hasIncompleteExamplePairs;
  });

  await t('20 TokenChips field= count is 8', () => {
    const n = editorSrc.split('<TokenChips field="').length - 1;
    assert.equal(n, 8);
  });

  await t("21 detail tab slice has 0 '말투' and 0 LorePanel", () => {
    const detail = tabSection(editorSrc, 'detail', 'lore');
    assert.equal(detail.includes('말투'), false);
    assert.equal(detail.includes('LorePanel'), false);
    assert.ok(detail.includes('설명 / 배경'));
    assert.ok(detail.includes('태그'));
    assert.ok(detail.includes('연결된 스토리'));
  });

  await t('22 CharacterEditor.tsx has 0 as unknown', () => {
    assert.equal(editorSrc.includes('as unknown'), false);
  });

  await t('list handler GET /api/characters still has 0 story_characters', () => {
    assert.equal(listHandlerSrc(charSrc).includes('story_characters'), false);
  });

  await app.close();
  db.close();
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
