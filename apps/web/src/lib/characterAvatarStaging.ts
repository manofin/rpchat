/** Unsaved-character avatar staging. Server sniff remains the verdict. */

export const STAGED_AVATAR_MAX_BYTES = 8 * 1024 * 1024;
export const STAGED_AVATAR_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type StagedAvatarReject = 'too-large' | 'bad-type';

export function isAvatarFileInputVisible(
  characterId: string | null | undefined,
  frostCharacterId: string,
): boolean {
  return characterId !== frostCharacterId;
}

export function validateStagedAvatarFile(file: { size: number; type: string }): StagedAvatarReject | null {
  if (file.size > STAGED_AVATAR_MAX_BYTES) return 'too-large';
  if (file.type !== '' && !(STAGED_AVATAR_ALLOWED_TYPES as readonly string[]).includes(file.type)) {
    return 'bad-type';
  }
  return null;
}
