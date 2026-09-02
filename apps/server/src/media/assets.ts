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
 * Pure except for the explicit filesystem check in `resolveAssetPath`.
 */
import fs from 'node:fs';
import path from 'node:path';

export const ASSET_MIME = 'image/webp';
/** Same ceiling as F3 avatars. A scene asset has no reason to be larger. */
export const ASSET_MAX_BYTES = 2 * 1024 * 1024;

/** WEBP magic bytes: "RIFF" ... "WEBP". Same sniff the avatar path uses. */
export function isWebp(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  );
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

/**
 * Resolves a request to an on-disk file, or null.
 *
 * null covers every rejection — bad segment, bad index, missing file, a resolved
 * path that landed outside the root, or bytes that are not actually WEBP. The
 * caller turns all of them into the same `404 application/json`, so a probe
 * cannot distinguish "no such character" from "traversal blocked".
 */
export function resolveAssetPath(root: string, ref: AssetRef): string | null {
  if (!isSafeAssetSegment(ref.characterId)) return null;
  if (!isSafeAssetSegment(ref.outfit)) return null;
  if (!isAssetIndex(ref.n)) return null;

  const full = path.resolve(root, ref.characterId, ref.outfit, `${ref.n}.webp`);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;

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
