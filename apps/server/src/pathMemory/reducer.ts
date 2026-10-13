import { structuralPath, type MessageTree } from './tree.js';

export type AcceptedEffect = Readonly<{ effect_id: string; anchor_message_id: string }>;
export type MemoryEvent = Readonly<{ event_id: string; sequence: number }> & (
  Readonly<{ action: 'propose' | 'reject' }> |
  Readonly<{ action: 'accept'; effect: AcceptedEffect }>
);
export type ReplayState = Readonly<{
  lastSequence: number;
  acceptedEffects: readonly AcceptedEffect[];
}>;

/** Pages are disjoint consecutive ranges of positive sequence numbers; gaps are allowed. */
export function replayEvents(events: readonly MemoryEvent[], previous: ReplayState = { lastSequence: 0, acceptedEffects: [] }): ReplayState {
  let lastSequence = previous.lastSequence;
  const acceptedEffects = [...previous.acceptedEffects];
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence) {
      throw new Error('event sequence must strictly increase across pages');
    }
    lastSequence = event.sequence;
    if (event.action === 'accept') acceptedEffects.push(event.effect);
  }
  return { lastSequence, acceptedEffects };
}

export function effectsAtHead(tree: MessageTree, state: ReplayState, head: string | null): readonly AcceptedEffect[] {
  const path = new Set(structuralPath(tree, head).map(row => row.id));
  return state.acceptedEffects.filter(effect => path.has(effect.anchor_message_id));
}

export function activeEffects(tree: MessageTree, events: readonly MemoryEvent[], head: string | null): readonly AcceptedEffect[] {
  return effectsAtHead(tree, replayEvents(events), head);
}
