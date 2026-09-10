/**
 * Story-room create body (web-only).
 * ORDER_CONTRACT: keep the user's selection order; prepend characterId
 * only when it is absent from the roster. Dedup by first occurrence.
 * characterId is the display/legacy slot, not a focus privilege.
 * openingId: omit or blank = default stories.opening_json; extra id is sent as-is.
 */
import type { StoryStartRequest } from '../types';

export type { StoryStartRequest };

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
