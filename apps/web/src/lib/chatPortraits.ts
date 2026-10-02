import type { Message } from '../types';
import { hasEventContract } from './chatEvents';
import { groupChatTurns, visualAssistantOrder } from './chatLayout';

/** Only use the persisted server selection; never infer an outfit/emotion asset. */
export function messagePortrait(message: Message): { src: string; name: string; actorId: string } | null {
  if (message.role !== 'assistant' || !hasEventContract(message)) return null;
  const actor = message.events.find((event) => event.type === 'dialogue');
  const src = message.meta.image_url;
  if (!actor?.actorName || !actor.actorId || !src || !/^\/media\/assets\/[^/?#]+\/[^/?#]+\/\d+\.webp$/.test(src)) return null;
  return { src, name: actor.actorName, actorId: actor.actorId };
}

/** Each turn introduces a selected portrait once per actor, until its asset changes. */
export function portraitMessageIds(messages: Message[], reorder: boolean): Set<string> {
  const ids = new Set<string>();
  for (const turn of groupChatTurns(messages)) {
    const selected = new Map<string, string>();
    for (const message of visualAssistantOrder(turn.assistants, reorder)) {
      const portrait = messagePortrait(message);
      if (!portrait || selected.get(portrait.actorId) === portrait.src) continue;
      selected.set(portrait.actorId, portrait.src);
      ids.add(message.id);
    }
  }
  return ids;
}
