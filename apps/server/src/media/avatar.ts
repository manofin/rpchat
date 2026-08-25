/** F3 avatar lock (2026-08-25): 2MB, jpeg/png/webp, magic-byte sniff. No convert. */

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const FROST_CHARACTER_ID = 'f89ace9b-8684-4d97-96dc-e00c4b25a819';

export type AvatarKind = 'jpeg' | 'png' | 'webp';

export const AVATAR_MIME: Record<AvatarKind, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export const AVATAR_EXT: Record<AvatarKind, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
};

export class AvatarReject extends Error {
  constructor(
    public status: 400 | 403 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = 'AvatarReject';
  }
}

export function sniffAvatar(buf: Buffer): AvatarKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export function inspectAvatar(buf: Buffer): AvatarKind {
  if (!buf || buf.length === 0) throw new AvatarReject(400, 'empty');
  if (buf.length > AVATAR_MAX_BYTES) throw new AvatarReject(413, 'too large');
  const kind = sniffAvatar(buf);
  if (!kind) throw new AvatarReject(415, 'unsupported type');
  return kind;
}

export function publicAvatarPath(characterId: string, kind: AvatarKind): string {
  return `/media/avatars/${characterId}.${AVATAR_EXT[kind]}`;
}
