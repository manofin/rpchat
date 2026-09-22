import { get } from './api';
import type { CharacterStoryLink, Story } from '../types';

export async function loadCharacterStories(characterId: string, getFn: typeof get = get): Promise<{ stories: Story[]; failed: boolean }> {
  const links = await getFn<CharacterStoryLink[]>(`/api/characters/${encodeURIComponent(characterId)}/stories`);
  const ids = [...new Set(links.filter((link) => !link.archived).map((link) => link.id))];
  const results = await Promise.allSettled(ids.map((id) => getFn<Story>(`/api/stories/${encodeURIComponent(id)}`)));
  return {
    stories: results.flatMap((result) => result.status === 'fulfilled' && !result.value.archived ? [result.value] : []),
    failed: results.some((result) => result.status === 'rejected'),
  };
}
