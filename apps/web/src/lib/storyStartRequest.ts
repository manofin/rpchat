/**
 * Story-room create body (web-only).
 * ORDER_CONTRACT: keep the user's selection order; prepend characterId
 * only when it is absent from the roster. Dedup by first occurrence.
 * characterId is the display/legacy slot, not a focus privilege.
 * openingId: omit or blank = default stories.opening_json; extra id is sent as-is.
 */
import type { Character, Story, StoryStartRequest } from '../types';

export type { StoryStartRequest };

/** Saved cast order remains authoritative; archived/unavailable cards cannot start new rooms. */
export function activeStoryCast(story: Story, characters: Character[]) {
  const available = new Set(characters.filter((c) => !c.archived).map((c) => c.id));
  const seen = new Set<string>();
  return (story.characters ?? []).filter((c) => {
    if (!available.has(c.character_id) || seen.has(c.character_id)) return false;
    seen.add(c.character_id);
    return true;
  });
}

/**
 * ADR-F8d §4.1 stays: the start character becomes the room owner and the owner
 * is always in the first scene. The web picks that owner from the SELECTED
 * opening instead of the roster head: first present_ids entry (front to back)
 * that is currently hosted. Default = '' → story.opening; an extra id →
 * openings_extra[].opening_json. Damaged/absent extra, empty present_ids, or
 * no hosted match → hosted[0] (previous fixed behavior).
 */
export function selectStoryOpening(story: Story, openingId?: string): unknown | null {
  const pick = openingId?.trim();
  if (!pick) return story.opening ?? null;
  const hit = (story.openings_extra ?? []).find((e) => e.id === pick);
  if (!hit) return null;
  try {
    const doc = JSON.parse(hit.opening_json) as unknown;
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

export function pickStoryStartCharacter(input: {
  story: Story;
  hostedIds: string[];
  openingId?: string;
}): string {
  const hosted = new Set(input.hostedIds);
  const doc = selectStoryOpening(input.story, input.openingId) as { present_ids?: unknown } | null;
  if (doc && Array.isArray(doc.present_ids)) {
    for (const id of doc.present_ids) {
      if (typeof id === 'string' && hosted.has(id)) return id;
    }
  }
  return input.hostedIds[0] ?? '';
}

export function buildStoryStartRequest(input: {
  characterId: string;
  storyId: string;
  selectedIds: string[];
  openingId?: string;
}): StoryStartRequest {
  const seen = new Set<string>();
  const participantIds: string[] = [];
  const push = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    participantIds.push(id);
  };
  for (const id of input.selectedIds) push(id);
  if (input.characterId && !seen.has(input.characterId)) {
    participantIds.unshift(input.characterId);
  }
  const body: StoryStartRequest = {
    characterId: input.characterId,
    storyId: input.storyId,
    mode: 'story',
    participantIds,
  };
  const openingId = input.openingId?.trim();
  if (openingId) body.openingId = openingId;
  return body;
}
