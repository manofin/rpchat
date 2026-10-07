import type { Character, ConversationDetail, Story } from '../types';

export type AudienceActor = { id: string; name: string; description: string; available: boolean };
export type MessageAudience = { visibility: 'public' } | { visibility: 'private'; recipient_ids: string[]; observer_ids?: string[] };

export async function loadAudienceActors(detail: ConversationDetail, get: <T>(url: string) => Promise<T>): Promise<AudienceActor[]> {
  const conv = detail.conversation;
  let ids: string[];
  if (conv.story_participant_ids_snapshot != null) {
    const value: unknown = JSON.parse(conv.story_participant_ids_snapshot);
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) throw new Error('인물 목록을 확인할 수 없습니다.');
    ids = value;
  } else if (conv.story_id) {
    const story = await get<Story>(`/api/stories/${encodeURIComponent(conv.story_id)}`);
    ids = (story.characters ?? []).map(actor => actor.character_id);
  } else ids = [detail.character.id];
  return Promise.all([...new Set(ids)].map(async id => {
    try {
      const actor = id === detail.character.id ? detail.character : await get<Character>(`/api/characters/${encodeURIComponent(id)}`);
      return { id, name: actor.name, description: actor.tagline || actor.description.slice(0, 80), available: true };
    } catch { return { id, name: '이름 확인 불가', description: '', available: false }; }
  }));
}

export function actorLabel(id: string, actors: AudienceActor[]): string {
  if (id === 'user') return '나';
  if (id === 'gm') return '서술자';
  const actor = actors.find(row => row.id === id);
  if (!actor) return '이름 확인 불가';
  const same = actors.filter(row => row.name === actor.name).sort((a,b) => a.id.localeCompare(b.id));
  return same.length > 1 ? `${actor.name} (인물 ${same.findIndex(row => row.id === id) + 1})` : actor.name;
}

export function audienceLabel(audience: MessageAudience | undefined, actors: AudienceActor[]): string | null {
  if (!audience) return null;
  if (audience.visibility === 'public') return '공개';
  if (audience.visibility !== 'private' || !Array.isArray(audience.recipient_ids) || audience.recipient_ids.some(id => typeof id !== 'string')
    || (audience.observer_ids !== undefined && (!Array.isArray(audience.observer_ids) || audience.observer_ids.some(id => typeof id !== 'string')))) return '공개 범위 확인 불가';
  const names = [...new Set(audience.recipient_ids)].map(id => actorLabel(id, actors));
  const readers = names.length ? `${names.join('·')}만 아는 내용` : '내용 수신자 없음';
  const observers = [...new Set(audience.observer_ids ?? [])].filter(id => !audience.recipient_ids.includes(id));
  return `비공개 · ${readers}${observers.length ? ` · ${observers.map(id => actorLabel(id, actors)).join('·')}에게는 대화가 있었다는 사실만 전달` : ''}`;
}
