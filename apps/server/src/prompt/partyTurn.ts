/**
 * PartyTurn — server-internal normalized view of a finished beat's blocks.
 *
 * Additive only: callers that already consume BeatBlock[] keep doing so.
 * This module maps; it does not parse a script, talk to a model, touch DB/SSE,
 * reorder, or drop blocks.
 */
import type { BeatBlock } from './renderBeat.js';

export type PartyMode = 'focused' | 'ensemble';

export type PartyBlock =
  | { kind: 'header'; text: string }
  | { kind: 'narration'; text: string }
  | { kind: 'dialogue'; speakerId: string | null; speakerName: string | null; text: string }
  | { kind: 'thought'; speakerId: string | null; speakerName: string | null; text: string }
  | { kind: 'info'; text: string }
  | { kind: 'ui'; payload: unknown }
  // hunter leftovers: keep, do not drop
  | { kind: 'panel'; text: string }
  | { kind: 'system'; text: string };

export type PartyTurn = {
  mode: PartyMode;
  blocks: PartyBlock[];
};

function uiPayload(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function mapBlock(b: BeatBlock): PartyBlock {
  switch (b.kind) {
    case 'header':
      return { kind: 'header', text: b.text };
    case 'narration':
      return { kind: 'narration', text: b.text };
    case 'line':
      return {
        kind: 'dialogue',
        speakerId: b.speaker_character_id,
        speakerName: b.speaker_name,
        text: b.text,
      };
    case 'thought':
      return {
        kind: 'thought',
        speakerId: b.speaker_character_id,
        speakerName: b.speaker_name,
        text: b.text,
      };
    case 'info':
      return { kind: 'info', text: b.text };
    case 'ui':
      return { kind: 'ui', payload: uiPayload(b.text) };
    case 'panel':
      return { kind: 'panel', text: b.text };
    case 'system':
      return { kind: 'system', text: b.text };
    default: {
      const leftover = b as BeatBlock;
      return { kind: leftover.kind, text: leftover.text } as PartyBlock;
    }
  }
}

/** Pure mapper. Does not mutate `blocks` or the objects inside it. */
export function partyTurnFromBlocks(
  mode: PartyMode,
  blocks: readonly BeatBlock[],
): PartyTurn {
  return { mode, blocks: blocks.map(mapBlock) };
}
