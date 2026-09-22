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
