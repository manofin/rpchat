/**
 * C6 character-authoring draft autosave. Client-only localStorage.
 * Never sent on POST/PUT /api/characters.
 */

import type { Character } from '../types';

export const CHARACTER_DRAFT_NEW_KEY = 'rpchat.characterDraft.new';
export const CHARACTER_DRAFT_KEY_PREFIX = 'rpchat.characterDraft.';
export const CHARACTER_DRAFT_DEBOUNCE_MS = 300;

export type Kv = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type CharacterDraft = Omit<
  Character,
  'id' | 'created_at' | 'updated_at' | 'archived' | 'conversation_count' | 'last_chat_at'
>;

const STRING_FIELDS = [
  'name',
  'tagline',
  'description',
  'personality',
  'speech_style',
  'scenario',
  'first_message',
  'example_dialogue',
  'taboos',
] as const;

function resolveKv(storage?: Kv | null): Kv | null {
  return storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
}

export function characterDraftStorageKey(characterId: string | null | undefined): string {
  if (characterId == null || characterId === '') return CHARACTER_DRAFT_NEW_KEY;
  return CHARACTER_DRAFT_KEY_PREFIX + encodeURIComponent(characterId);
}

export function isCharacterDraft(value: unknown): value is CharacterDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  for (const key of STRING_FIELDS) {
    if (typeof rec[key] !== 'string') return false;
  }
  if (rec.avatar !== null && typeof rec.avatar !== 'string') return false;
  if (!Array.isArray(rec.tags) || !rec.tags.every((t) => typeof t === 'string')) return false;
  return true;
}

export function parseCharacterDraft(raw: string | null | undefined): CharacterDraft | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isCharacterDraft(value) ? value : null;
  } catch {
    return null;
  }
}

export function readCharacterDraft(
  characterId: string | null | undefined,
  storage?: Kv | null,
): CharacterDraft | null {
  try {
    const kv = resolveKv(storage);
    if (!kv) return null;
    return parseCharacterDraft(kv.getItem(characterDraftStorageKey(characterId)));
  } catch {
    return null;
  }
}

export function writeCharacterDraft(
  characterId: string | null | undefined,
  draft: CharacterDraft,
  storage?: Kv | null,
): void {
  try {
    const kv = resolveKv(storage);
    if (!kv) return;
    kv.setItem(characterDraftStorageKey(characterId), JSON.stringify(draft));
  } catch {
    /* private mode / quota / no storage */
  }
}

export function removeCharacterDraft(
  characterId: string | null | undefined,
  storage?: Kv | null,
): void {
  try {
    const kv = resolveKv(storage);
    if (!kv) return;
    kv.removeItem(characterDraftStorageKey(characterId));
  } catch {
    /* private mode / no storage */
  }
}

export function flushCharacterDraft(
  characterId: string | null | undefined,
  draft: CharacterDraft,
  flags: { dirty: boolean; suppress: boolean },
  storage?: Kv | null,
): void {
  if (!flags.dirty || flags.suppress) return;
  writeCharacterDraft(characterId, draft, storage);
}
