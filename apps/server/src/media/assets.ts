/**
 * f9-beat-render — local scene assets (`/media/assets/{char}/{outfit}/{n}.webp`).
 *
 * Mirrors the F3 avatar rules: explicit route, magic-byte sniff, no conversion,
 * no external outbound. The generator never produces a URL — `assetPathFor` picks
 * one from emotion × outfit, and this module only decides whether a request maps
 * to a real file inside the asset root.
 *
 * A missing file is a normal outcome, not an error state: the beat renders as
 * name + line with no image.
 *
 * Read (`resolveAssetPath`) and write share `resolvedAssetFile` — segment, index,
 * path.resolve, and root-prefix checks live in one place.
 */
import fs from 'node:fs';
import path from 'node:path';

export const ASSET_MIME = 'image/webp';
/** Same ceiling as F3 avatars. A scene asset has no reason to be larger. */
export const ASSET_MAX_BYTES = 2 * 1024 * 1024;
/** Per-character file cap (character directory tree, not per-outfit). */
export const ASSET_MAX_COUNT = 50;

export class AssetReject extends Error {
  constructor(
    public status: 400 | 403 | 404 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = 'AssetReject';
  }
}

/** WEBP magic bytes: "RIFF" ... "WEBP". Same sniff the avatar path uses. */
export function isWebp(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  );
}

export function inspectSceneAsset(buf: Buffer): void {
  if (!buf || buf.length === 0) throw new AssetReject(400, 'empty');
  if (buf.length > ASSET_MAX_BYTES) throw new AssetReject(413, 'too large');
  if (!isWebp(buf)) throw new AssetReject(415, 'unsupported type');
}

/**
 * A path segment is safe when it cannot escape the asset root or smuggle a
 * separator. Emptiness, `.`/`..`, any `..` substring, separators, NUL and control
 * bytes are all rejected. Korean and other non-ASCII names stay allowed — the
 * catalog decides which tokens exist, this only decides which are expressible.
 */
export function isSafeAssetSegment(v: string): boolean {
  if (!v || v.length > 64) return false;
  if (v === '.' || v === '..' || v.includes('..')) return false;
  for (const ch of v) {
    if (ch === '/' || ch === '\\') return false;
    if (ch.codePointAt(0)! < 0x20 || ch.codePointAt(0)! === 0x7f) return false;
  }
  return true;
}

/** Asset index `n`: a non-negative integer with no leading zeros or sign. */
export function isAssetIndex(v: string): boolean {
  return /^(0|[1-9][0-9]{0,3})$/.test(v);
}

export type AssetRef = { characterId: string; outfit: string; n: string };

export type CharacterAssetGroup = { outfit: string; files: number[] };

export function assetsRoot(dataDir: string): string {
  return path.join(dataDir, 'media', 'assets');
}

/**
 * Shared pre-path gate for read and write. Returns the resolved file path only
 * when every segment, the index, and the root prefix check pass. Does not
 * require the file to exist (write creates it).
 */
export function resolvedAssetFile(root: string, ref: AssetRef): string | null {
  if (!isSafeAssetSegment(ref.characterId)) return null;
  if (!isSafeAssetSegment(ref.outfit)) return null;
  if (!isAssetIndex(ref.n)) return null;

  const full = path.resolve(root, ref.characterId, ref.outfit, `${ref.n}.webp`);
  const rootResolved = path.resolve(root);
  if (!full.startsWith(rootResolved + path.sep)) return null;
  return full;
}

/**
 * Resolves a request to an on-disk file, or null.
 *
 * null covers every rejection — bad segment, bad index, missing file, a resolved
 * path that landed outside the root, or bytes that are not actually WEBP. The
 * caller turns all of them into the same `404 application/json`, so a probe
 * cannot distinguish "no such character" from "traversal blocked".
 */
export function resolveAssetPath(root: string, ref: AssetRef): string | null {
  const full = resolvedAssetFile(root, ref);
  if (!full) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > ASSET_MAX_BYTES) return null;

  return full;
}

/** Reads a resolved asset, returning null when the bytes are not WEBP. */
export function readAsset(fullPath: string): Buffer | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(fullPath);
  } catch {
    return null;
  }
  return isWebp(buf) ? buf : null;
}

export function listCharacterAssets(root: string, characterId: string): CharacterAssetGroup[] {
  if (!isSafeAssetSegment(characterId)) return [];
  const charDir = path.resolve(root, characterId);
  const rootResolved = path.resolve(root);
  if (!charDir.startsWith(rootResolved + path.sep)) return [];
  let outfits: string[];
  try {
    outfits = fs.readdirSync(charDir);
  } catch {
    return [];
  }
  const groups: CharacterAssetGroup[] = [];
  for (const outfit of outfits.sort((a, b) => a.localeCompare(b))) {
    const files: number[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(path.join(charDir, outfit));
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^(0|[1-9][0-9]{0,3})\.webp$/.exec(name);
      if (!m) continue;
      const full = resolvedAssetFile(root, { characterId, outfit, n: m[1] });
      if (!full) continue;
      try {
        if (!fs.statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      files.push(Number(m[1]));
    }
    if (files.length === 0) continue;
    files.sort((a, b) => a - b);
    groups.push({ outfit, files });
  }
  return groups;
}

export function countCharacterAssets(root: string, characterId: string): number {
  return listCharacterAssets(root, characterId).reduce((n, g) => n + g.files.length, 0);
}

export function rmdirIfEmpty(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* missing or not empty */
  }
}
