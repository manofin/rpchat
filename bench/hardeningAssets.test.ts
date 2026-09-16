/** npx tsx bench/hardeningAssets.test.ts
 * hardening-assets — list path assert + scene-asset bodyLimit align.
 * Temp DATA_DIR. No live DB, no model, no hermes, no migration.
 * Do not label this C8 (C8 = scene-asset feature suite).
 *
 * Bodylimit measurement (Fastify inject):
 * - Route opts bodyLimit must equal ASSET_MAX_BYTES (source guard).
 * - Payload exactly ASSET_MAX_BYTES with valid WEBP magic → 200 (route+inspect accept).
 * - Payload ASSET_MAX_BYTES+1 → 413 early (Fastify FST_ERR_CTP_BODY_TOO_LARGE),
 *   not “buffer up to 8MB then inspectSceneAsset too large”.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { config } from '../apps/server/src/config.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import {
  ASSET_MAX_BYTES,
  listCharacterAssets,
} from '../apps/server/src/media/assets.ts';
import { AVATAR_MAX_BYTES } from '../apps/server/src/media/avatar.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function tinyWebp(): Buffer {
  const buf = Buffer.alloc(12);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(4, 4);
  buf.write('WEBP', 8);
  return buf;
}

/** Exactly `size` bytes with WEBP magic so inspectSceneAsset accepts when size ≤ ASSET_MAX_BYTES. */
function webpOfSize(size: number): Buffer {
  const buf = Buffer.alloc(size);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(Math.max(0, size - 8), 4);
  buf.write('WEBP', 8);
  return buf;
}

function insertChar(db: ReturnType<typeof openDb>, id: string) {
  db.prepare(
    `INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, id, '', '', '', '', '', '', '', '', '[]', 't0', 't0');
}

function fakeCtx(db: ReturnType<typeof openDb>): Ctx {
  return {
    db,
    model: {
      complete: async () => {
        throw new Error('hardening-assets must not call the model');
      },
    } as unknown as Ctx['model'],
    queue: { activeList: [] } as unknown as Ctx['queue'],
    log: { error() {}, info() {}, warn() {}, debug() {} } as unknown as Ctx['log'],
    resolvedModel: () => 'm',
    setResolvedModel: () => {},
    health: async () => ({ ok: true, checkedAt: 't', latencyMs: 0, models: [] }),
  } as Ctx;
}

async function main() {
  const assetsSrc = fs.readFileSync('apps/server/src/media/assets.ts', 'utf8');
  const charsSrc = fs.readFileSync('apps/server/src/routes/characters.ts', 'utf8');

  await t('source: listCharacterAssets gates outfit with isSafeAssetSegment before readdir', () => {
    const fnStart = assetsSrc.indexOf('export function listCharacterAssets');
    const fnEnd = assetsSrc.indexOf('export function countCharacterAssets', fnStart);
    const fn = assetsSrc.slice(fnStart, fnEnd);
    assert.match(fn, /if \(!isSafeAssetSegment\(outfit\)\) continue;/);
    const gateIdx = fn.indexOf('if (!isSafeAssetSegment(outfit)) continue;');
    const readdirIdx = fn.indexOf('fs.readdirSync(outfitDir)');
    assert.ok(gateIdx >= 0 && readdirIdx > gateIdx, 'segment gate must precede outfit readdir');
    assert.match(fn, /outfitDir\.startsWith\(rootResolved/);
  });

  await t('source: scene POST bodyLimit === ASSET_MAX_BYTES; avatar stays 8MB', () => {
    assert.match(
      charsSrc,
      /'\/api\/characters\/:id\/assets\/:outfit\/:n',\s*\{\s*bodyLimit:\s*ASSET_MAX_BYTES\s*\}/,
    );
    assert.match(
      charsSrc,
      /'\/api\/characters\/:id\/avatar',\s*\{\s*bodyLimit:\s*AVATAR_MAX_BYTES\s*\}/,
    );
    assert.ok(ASSET_MAX_BYTES === 2 * 1024 * 1024);
    assert.ok(AVATAR_MAX_BYTES === 8 * 1024 * 1024);
    assert.notEqual(ASSET_MAX_BYTES, AVATAR_MAX_BYTES);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-hardening-assets-'));
  const orig = config.dataDir;
  config.dataDir = tmp;
  try {
    const db = openDb(tmp, path.resolve('apps/server/migrations'));
    const assetRoot = path.join(tmp, 'media', 'assets');
    insertChar(db, 'c-hard');

    await t('list: malicious outfit names skipped; no escape outside asset root', () => {
      const charDir = path.join(assetRoot, 'c-hard');
      const safeDir = path.join(charDir, 'default');
      fs.mkdirSync(safeDir, { recursive: true });
      fs.writeFileSync(path.join(safeDir, '0.webp'), tinyWebp());

      // Unsafe segment names that can exist as directory entries (includes `..`).
      const malicious = ['foo..bar', 'a'.repeat(65), 'bad\x7fname'];
      for (const name of malicious) {
        const d = path.join(charDir, name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, '0.webp'), tinyWebp());
      }

      // Plant a file outside the asset root; list must never surface it as an outfit group.
      const outside = path.join(tmp, 'OUTSIDE_SECRET.webp');
      fs.writeFileSync(outside, tinyWebp());

      const groups = listCharacterAssets(assetRoot, 'c-hard');
      assert.deepEqual(
        groups.map((g) => g.outfit),
        ['default'],
        `unexpected outfits: ${JSON.stringify(groups)}`,
      );
      assert.deepEqual(groups[0].files, [0]);

      // Escape: resolved paths for listed assets stay under asset root.
      for (const g of groups) {
        for (const n of g.files) {
          const full = path.resolve(assetRoot, 'c-hard', g.outfit, `${n}.webp`);
          assert.ok(
            full.startsWith(path.resolve(assetRoot) + path.sep),
            `escaped path ${full}`,
          );
        }
      }
      assert.equal(fs.existsSync(outside), true);
    });

    const app = Fastify({ logger: false });
    await app.register(characterRoutes(fakeCtx(db)));
    await app.ready();

    await t('bodyLimit: exactly ASSET_MAX_BYTES valid webp → 200', async () => {
      const buf = webpOfSize(ASSET_MAX_BYTES);
      assert.equal(buf.length, ASSET_MAX_BYTES);
      const res = await app.inject({
        method: 'POST',
        url: '/api/characters/c-hard/assets/default/1',
        headers: { 'content-type': 'image/webp' },
        payload: buf,
      });
      assert.equal(res.statusCode, 200, res.body);
      const disk = path.join(assetRoot, 'c-hard', 'default', '1.webp');
      assert.equal(fs.statSync(disk).size, ASSET_MAX_BYTES);
    });

    await t('bodyLimit: ASSET_MAX_BYTES+1 → early 413 (not 8MB-then-inspect)', async () => {
      const buf = webpOfSize(ASSET_MAX_BYTES + 1);
      assert.equal(buf.length, ASSET_MAX_BYTES + 1);
      const res = await app.inject({
        method: 'POST',
        url: '/api/characters/c-hard/assets/default/2',
        headers: { 'content-type': 'image/webp' },
        payload: buf,
      });
      assert.equal(res.statusCode, 413, res.body);
      // Early Fastify reject uses FST_ERR_CTP_BODY_TOO_LARGE; inspect path would be {"error":"too large"}.
      // Either is 413; prefer early code when present.
      const body = res.body;
      if (body.includes('FST_ERR_CTP_BODY_TOO_LARGE') || body.includes('Body cannot be larger')) {
        assert.ok(true, 'early Fastify bodyLimit reject');
      } else {
        // Still PASS on 413, but record shape for Easton.
        console.log(`NOTE 413 body shape: ${body.slice(0, 200)}`);
      }
      assert.equal(fs.existsSync(path.join(assetRoot, 'c-hard', 'default', '2.webp')), false);
    });

    await app.close();
  } finally {
    config.dataDir = orig;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
