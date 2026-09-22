import type { ChatEvent, Message } from '../types';
import type { BeatUiData } from '../components/view';

export const EVENT_CONTRACT_UNAVAILABLE = '응답 표시 정보를 받지 못했습니다. 서버를 업데이트한 뒤 대화를 새로고침해 주세요.';

export function hasEventContract(message: Pick<Message, 'eventVersion' | 'events'>): message is { eventVersion: 1; events: ChatEvent[] } {
  return message.eventVersion === 1 && Array.isArray(message.events);
}

/** The server has decoded the panel; the client only accepts its display fields. */
export function eventUiData(event: ChatEvent): BeatUiData | null {
  if (event.type !== 'system' || (event.presentation !== 'ui' && event.presentation !== 'panel')) return null;
  const value = event.payload;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const stringList = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const sheet = data.user_sheet && typeof data.user_sheet === 'object' && !Array.isArray(data.user_sheet)
    ? data.user_sheet as Record<string, unknown> : null;
  return {
    location_badge: typeof data.location_badge === 'string' ? data.location_badge : null,
    intent_hint: typeof data.intent_hint === 'string' ? data.intent_hint : null,
    focus_id: typeof data.focus_id === 'string' ? data.focus_id : null,
    user_sheet: sheet ? {
      hp: typeof sheet.hp === 'number' ? sheet.hp : null,
      money: typeof sheet.money === 'number' ? sheet.money : null,
      gear: stringList(sheet.gear), inventory: stringList(sheet.inventory), traits: stringList(sheet.traits),
    } : null,
    custom_stats: Array.isArray(data.custom_stats) ? data.custom_stats.flatMap((value) => {
      if (!value || typeof value !== 'object' || typeof value.label !== 'string' || typeof value.value !== 'number') return [];
      return [{ label: value.label, value: value.value }];
    }) : [],
    roster: Array.isArray(data.roster) ? data.roster.flatMap((value) => {
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.chip !== 'string') return [];
      return [{ id: value.id, name: value.name, chip: value.chip, locked: value.locked === true, in_room: value.in_room === true }];
    }) : [],
  };
}
