/** npx tsx bench/characterAssetsWrite.test.ts
 * C8 D2=(a) D4=(a): scene-asset upload/list/delete via Fastify inject.
 * Shared path helper in media/assets.ts. Temp DATA_DIR. No live DB, no model, no deploy.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { mediaRoutes } from '../apps/server/src/routes/media.js';
import { config } from '../apps/server/src/config.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import {
  ASSET_MAX_BYTES,
  ASSET_MAX_COUNT,
  isWebp,
  resolveAssetPath,
  resolvedAssetFile,
} from '../apps/server/src/media/assets.js';
import { FROST_CHARACTER_ID } from '../apps/server/src/media/avatar.js';

const require2 = createRequire(import.meta.url);
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const editorPath = path.join(root, 'apps/web/src/components/CharacterEditor.tsx');
const assetsPath = path.join(root, 'apps/server/src/media/assets.ts');
const typesPath = path.join(root, 'apps/web/src/types.ts');
const ONLY = process.env.C8_ONLY ?? '';
const SKIP_MUTATION = process.env.C8_SKIP_MUTATION === '1';

let passed = 0;
let failed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  if (ONLY && !name.includes(ONLY)) return;
  try {
    await fn();
    passed++;
    console.log(`ok ${passed} ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${failed} ${name}`);
    console.error(err);
    if (!ONLY) throw err;
  }
}

function tinyWebp(): Buffer {
  const buf = Buffer.alloc(12);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(4, 4);
  buf.write('WEBP', 8);
  return buf;
}

function fakePng(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

function insertChar(db: ReturnType<typeof openMigratedDb>, id: string, name = id) {
  db.prepare(
    `INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, name, '', '', '', '', '', '', '', '', '[]', 't0', 't0');
}

function fakeCtx(db: ReturnType<typeof openMigratedDb>): Ctx {
  return {
    db,
    model: {
      complete: async () => {
        throw new Error('C8 must not call the model');
      },
    } as unknown as Ctx['model'],
    queue: { activeList: [] } as unknown as Ctx['queue'],
    log: console as unknown as Ctx['log'],
    resolvedModel: () => 'm',
    setResolvedModel: () => {},
    health: async () => ({ ok: true, checkedAt: 't', latencyMs: 0, models: [] }),
  } as Ctx;
}

async function withApp(fn: (args: {
  app: ReturnType<typeof Fastify>;
  db: ReturnType<typeof openMigratedDb>;
  tmp: string;
  assetRoot: string;
}) => Promise<void>) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c8-assets-'));
  const orig = config.dataDir;
  config.dataDir = tmp;
  const db = openMigratedDb(tmp, path.resolve(root, 'apps/server/migrations'));
  const assetRoot = path.join(tmp, 'media', 'assets');
  const app = Fastify({ logger: false });
  await app.register(characterRoutes(fakeCtx(db)));
  await app.register(mediaRoutes(path.join(tmp, 'media')));
  try {
    await fn({ app, db, tmp, assetRoot });
  } finally {
    await app.close();
    db.close();
    config.dataDir = orig;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function helperSrc(editorSrc: string): string {
  const startTok = '/* C8-asset-helpers */';
  const endTok = '/* C8-asset-helpers-end */';
  const start = editorSrc.indexOf(startTok);
  const end = editorSrc.indexOf(endTok);
  assert.ok(start >= 0, 'C8 helper start marker missing');
  assert.ok(end > start, 'C8 helper end marker missing');
  return editorSrc.slice(start, end + endTok.length);
}

function loadHelpers(editorSrc: string) {
  const src = helperSrc(editorSrc);
  const wrapped = `
    ${src}
    export const __all = { loadCharacterAssets, uploadCharacterAsset, deleteCharacterAsset };
  `;
  const { transformSync } = require2('esbuild');
  const js = transformSync(wrapped, { loader: 'ts', format: 'cjs' }).code;
  const exported: { __all?: Record<string, unknown> } = {};
  const moduleObj = { exports: exported };
  new Function('exports', 'module', 'require', js)(exported, moduleObj, require2);
  const all = exported.__all ?? (moduleObj.exports as { __all: Record<string, unknown> }).__all;
  assert.equal(typeof all.loadCharacterAssets, 'function');
  assert.equal(typeof all.uploadCharacterAsset, 'function');
  assert.equal(typeof all.deleteCharacterAsset, 'function');
  return all as {
    loadCharacterAssets: (
      characterId: string | null | undefined,
      getFn: <T>(p: string) => Promise<T>,
    ) => Promise<Array<{ outfit: string; files: number[] }>>;
    uploadCharacterAsset: (
      characterId: string,
      outfit: string,
      n: string,
      body: Blob,
      postBinaryFn: (p: string, body: Blob, contentType: string) => Promise<unknown>,
      getFn: <T>(p: string) => Promise<T>,
    ) => Promise<Array<{ outfit: string; files: number[] }>>;
    deleteCharacterAsset: (
      characterId: string,
      outfit: string,
      n: string,
      delFn: (p: string) => Promise<unknown>,
      getFn: <T>(p: string) => Promise<T>,
      confirmFn: (msg: string, opts?: { danger?: boolean; okLabel?: string }) => Promise<boolean>,
    ) => Promise<Array<{ outfit: string; files: number[] }> | null>;
  };
}

async function main() {
await t('guard read-resolve .. .. is null', async () => {
  await withApp(async ({ assetRoot }) => {
    fs.mkdirSync(assetRoot, { recursive: true });
    const planted = path.resolve(assetRoot, '..', '..', '0.webp');
    fs.writeFileSync(planted, tinyWebp());
    assert.equal(resolveAssetPath(assetRoot, { characterId: '..', outfit: '..', n: '0' }), null);
    assert.equal(resolvedAssetFile(assetRoot, { characterId: '..', outfit: '..', n: '0' }), null);
    assert.equal(resolvedAssetFile(assetRoot, { characterId: 'c-c8', outfit: '..', n: '0' }), null);
  });
});

await t('guard write outfit .. 404', async () => {
  await withApp(async ({ app, db, tmp }) => {
    insertChar(db, 'c-c8');
    const res = await app.inject({
      method: 'POST',
      url: '/api/characters/c-c8/assets/%2e%2e/0',
      headers: { 'content-type': 'image/webp' },
      payload: tinyWebp(),
    });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(resolvedAssetFile(path.join(tmp, 'media', 'assets'), { characterId: 'c-c8', outfit: '..', n: '0' }), null);
  });
});

await t('missing character POST 404', async () => {
  await withApp(async ({ app }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/characters/no-such/assets/default/0',
      headers: { 'content-type': 'image/webp' },
      payload: tinyWebp(),
    });
    assert.equal(res.statusCode, 404, res.body);
  });
});

await t('frost POST/DELETE 403', async () => {
  await withApp(async ({ app, db }) => {
    insertChar(db, FROST_CHARACTER_ID, '서리');
    const post = await app.inject({
      method: 'POST',
      url: `/api/characters/${FROST_CHARACTER_ID}/assets/default/0`,
      headers: { 'content-type': 'image/webp' },
      payload: tinyWebp(),
    });
    assert.equal(post.statusCode, 403, post.body);
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/characters/${FROST_CHARACTER_ID}/assets/default/0`,
    });
    assert.equal(del.statusCode, 403, del.body);
  });
});

await t('non-webp and fake magic 415', async () => {
  await withApp(async ({ app, db }) => {
    insertChar(db, 'c-c8');
    const png = await app.inject({
      method: 'POST',
      url: '/api/characters/c-c8/assets/default/0',
      headers: { 'content-type': 'image/webp' },
      payload: fakePng(),
    });
    assert.equal(png.statusCode, 415, png.body);
    const fake = Buffer.alloc(12, 0);
    fake.write('RIFF', 0);
    fake.write('XXXX', 8);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/characters/c-c8/assets/default/0',
      headers: { 'content-type': 'image/webp' },
      payload: fake,
    });
    assert.equal(bad.statusCode, 415, bad.body);
    assert.equal(isWebp(fakePng()), false);
  });
});

await t('oversize 413', async () => {
  await withApp(async ({ app, db }) => {
    insertChar(db, 'c-c8');
    const buf = Buffer.alloc(ASSET_MAX_BYTES + 1);
    buf.write('RIFF', 0);
    buf.write('WEBP', 8);
    const res = await app.inject({
      method: 'POST',
      url: '/api/characters/c-c8/assets/default/0',
      headers: { 'content-type': 'image/webp' },
      payload: buf,
    });
    assert.equal(res.statusCode, 413, res.body);
  });
});

await t('noncanonical index 08/-1/10000 404', async () => {
  await withApp(async ({ app, db }) => {
    insertChar(db, 'c-c8');
    for (const n of ['08', '-1', '10000']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/characters/c-c8/assets/default/${n}`,
        headers: { 'content-type': 'image/webp' },
        payload: tinyWebp(),
      });
      assert.equal(res.statusCode, 404, `${n} ${res.body}`);
    }
  });
});

await t('slash nul 0x7f length-65 404', async () => {
  await withApp(async ({ app, db }) => {
    insertChar(db, 'c-c8');
    const cases = [
      encodeURIComponent('a/b'),
      encodeURIComponent('a\\b'),
      encodeURIComponent('\0'),
      encodeURIComponent('\x7f'),
      'a'.repeat(65),
    ];
    for (const outfit of cases) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/characters/c-c8/assets/${outfit}/0`,
        headers: { 'content-type': 'image/webp' },
        payload: tinyWebp(),
      });
      assert.ok(res.statusCode === 404 || res.statusCode === 400, `${outfit} ${res.statusCode} ${res.body}`);
    }
  });
});

await t('lifecycle upload list overwrite delete rmdir', async () => {
  await withApp(async ({ app, db, assetRoot }) => {
    insertChar(db, 'c-c8');
    const outfit = encodeURIComponent('교복');
    const post1 = await app.inject({
      method: 'POST',
      url: `/api/characters/c-c8/assets/${outfit}/0`,
      headers: { 'content-type': 'image/webp' },
      payload: tinyWebp(),
    });
    assert.equal(post1.statusCode, 200, post1.body);
    const listed = await app.inject({ method: 'GET', url: '/api/characters/c-c8/assets' });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(JSON.parse(listed.body), [{ outfit: '교복', files: [0] }]);
    const disk = path.join(assetRoot, 'c-c8', '교복', '0.webp');
    assert.equal(fs.existsSync(disk), true);
    const served = await app.inject({
      method: 'GET',
      url: `/media/assets/c-c8/${outfit}/0.webp`,
    });
    assert.equal(served.statusCode, 200, served.body);
    assert.equal(served.headers['content-type'], 'image/webp');
    const post2 = await app.inject({
      method: 'POST',
      url: `/api/characters/c-c8/assets/${outfit}/0`,
      headers: { 'content-type': 'image/webp' },
      payload: tinyWebp(),
    });
    assert.equal(post2.statusCode, 200, post2.body);
    const listed2 = await app.inject({ method: 'GET', url: '/api/characters/c-c8/assets' });
    assert.deepEqual(JSON.parse(listed2.body), [{ outfit: '교복', files: [0] }]);
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/characters/c-c8/assets/${outfit}/0`,
    });
    assert.equal(del.statusCode, 200, del.body);
    const listed3 = await app.inject({ method: 'GET', url: '/api/characters/c-c8/assets' });
    assert.deepEqual(JSON.parse(listed3.body), []);
    assert.equal(fs.existsSync(disk), false);
    assert.equal(fs.existsSync(path.join(assetRoot, 'c-c8', '교복')), false);
    assert.equal(fs.existsSync(path.join(assetRoot, 'c-c8')), false);
  });
});

await t('quota 50 then 400; overwrite existing still 200', async () => {
  await withApp(async ({ app, db, assetRoot }) => {
    insertChar(db, 'c-c8');
    const dir = path.join(assetRoot, 'c-c8', 'default');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < ASSET_MAX_COUNT; i++) {
      fs.writeFileSync(path.join(dir, `${i}.webp`), tinyWebp());
    }
    const extra = await app.inject({
      method: 'POST',
      url: `/api/characters/c-c8/assets/default/${ASSET_MAX_COUNT}`,
      headers: { 'content-type': 'image/webp' },
      payload: tinyWebp(),
    });
    assert.equal(extra.statusCode, 400, extra.body);
    const over = await app.inject({
      method: 'POST',
      url: '/api/characters/c-c8/assets/default/0',
      headers: { 'content-type': 'image/webp' },
      payload: tinyWebp(),
    });
    assert.equal(over.statusCode, 200, over.body);
  });
});

await t('editor contracts: 5 tabs, TokenChips 8, as unknown 0, setup assets, no set()', () => {
  const editor = fs.readFileSync(editorPath, 'utf8');
  const types = fs.readFileSync(typesPath, 'utf8');
  assert.match(types, /export interface CharacterAssetGroup/);
  const labels = [...editor.matchAll(/label: '([^']+)'/g)].map((x) => x[1]);
  const tabBlock = /const TABS: Array<\{ key: Tab; label: string \}> = \[([\s\S]*?)\];/.exec(editor);
  assert.ok(tabBlock);
  const tabLabels = [...tabBlock![1].matchAll(/label: '([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual(tabLabels, ['설정', '인트로', '프롬프트', '상세', '로어']);
  assert.equal((editor.match(/<TokenChips field="/g) ?? []).length, 8);
  assert.equal(editor.includes('as unknown'), false);
  const setupStart = editor.indexOf("tab === 'setup'");
  const setupEnd = editor.indexOf("tab === 'intro'");
  const setup = editor.slice(setupStart, setupEnd);
  assert.ok(setup.includes('상황 이미지'), 'setup missing 상황 이미지');
  assert.ok(setup.includes('loadCharacterAssets') || setup.includes('assetGroups'), 'setup missing asset UI state');
  const helpers = helperSrc(editor);
  assert.equal(/\bset\(/.test(helpers), false, 'C8 helpers must not call set()');
  void labels;
});

await t('editor helpers load/upload/delete do not touch draft', async () => {
  const editor = fs.readFileSync(editorPath, 'utf8');
  const helpers = loadHelpers(editor);
  const draft = { name: 'x' };
  const before = { ...draft };
  const calls: Array<{ method: string; url: string }> = [];
  const getFn = async <T>(url: string): Promise<T> => {
    calls.push({ method: 'GET', url });
    return [] as T;
  };
  const postBinaryFn = async (url: string, _body: Blob, _ct: string) => {
    calls.push({ method: 'POST', url });
    return { ok: true };
  };
  const delFn = async (url: string) => {
    calls.push({ method: 'DELETE', url });
    return { ok: true };
  };
  await helpers.loadCharacterAssets('c-c8', getFn);
  await helpers.uploadCharacterAsset(
    'c-c8',
    '교복',
    '0',
    new Blob([new Uint8Array(tinyWebp())]),
    postBinaryFn,
    getFn,
  );
  const cancelled = await helpers.deleteCharacterAsset('c-c8', '교복', '0', delFn, getFn, async () => false);
  assert.equal(cancelled, null);
  await helpers.deleteCharacterAsset('c-c8', '교복', '0', delFn, getFn, async () => true);
  assert.deepEqual(draft, before);
  assert.ok(calls.some((c) => c.method === 'GET' && c.url === '/api/characters/c-c8/assets'));
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.includes('/api/characters/c-c8/assets/')));
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('/api/characters/c-c8/assets/')));
});

if (!SKIP_MUTATION && !ONLY) {
  await t('mutation: gut shared helper fails guard read+write', () => {
    const original = fs.readFileSync(assetsPath, 'utf8');
    assert.ok(original.includes('function resolvedAssetFile'), 'resolvedAssetFile missing');
    const mutated = original
      .replace(
        'if (!isSafeAssetSegment(ref.characterId)) return null;',
        'if (false && !isSafeAssetSegment(ref.characterId)) return null;',
      )
      .replace(
        'if (!isSafeAssetSegment(ref.outfit)) return null;',
        'if (false && !isSafeAssetSegment(ref.outfit)) return null;',
      )
      .replace(
        'if (!full.startsWith(rootResolved + path.sep)) return null;',
        'if (false && !full.startsWith(rootResolved + path.sep)) return null;',
      );
    assert.notEqual(mutated, original, 'mutation did not change assets.ts');
    try {
      fs.writeFileSync(assetsPath, mutated);
      const child = spawnSync('npx', ['tsx', 'bench/characterAssetsWrite.test.ts'], {
        cwd: root,
        env: { ...process.env, C8_SKIP_MUTATION: '1', C8_ONLY: 'guard' },
        encoding: 'utf8',
      });
      console.log(`MUT_GUARD_EC:${child.status}`);
      if (child.stdout) console.log(child.stdout);
      if (child.stderr) console.log(child.stderr);
      assert.notEqual(child.status, 0, 'gutted helper must fail guard tests (proves no duplicated checks)');
      assert.match(child.stdout ?? '', /FAIL .*guard read-resolve/, 'read bench must FAIL after helper gut');
      assert.match(child.stdout ?? '', /FAIL .*guard write/, 'write bench must FAIL after helper gut');
    } finally {
      fs.writeFileSync(assetsPath, original);
    }
  });
}

console.log(`passed ${passed}`);
if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
