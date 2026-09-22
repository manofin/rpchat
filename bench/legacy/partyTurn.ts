// Historical client behavior retained for migration parity tests; never imported by the app.
/**
 * B-2 S2 — client PartyBlock mapper.
 * Twin of apps/server/src/prompt/partyTurn.ts partyTurnFromBlocks, per message row.
 * Wire unchanged: block_kind + speaker meta + content → PartyBlock.
 * Streaming is not a block field; the renderer receives it separately.
 */

export type PartyBlock =
  | { kind: 'header'; text: string }
  | { kind: 'narration'; text: string }
  | { kind: 'dialogue'; speakerId: string | null; speakerName: string | null; text: string }
  | { kind: 'thought'; speakerId: string | null; speakerName: string | null; text: string }
  | { kind: 'info'; text: string }
  | { kind: 'ui'; payload: unknown }
  | { kind: 'panel'; text: string }
  | { kind: 'system'; text: string };

export type PartyBlockKind = PartyBlock['kind'];

export type PartyMessageMeta = {
  block_kind?:
    | 'header'
    | 'narration'
    | 'line'
    | 'thought'
    | 'info'
    | 'ui'
    | 'panel'
    | 'system';
  speaker_character_id?: string;
  speaker_name?: string;
};

export type PartyMessageLike = {
  content: string;
  meta?: PartyMessageMeta | null;
};

function uiPayload(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** S1 server mapper twin: one persisted row → one PartyBlock. No block_kind → not a party row. */
export function partyBlockFromMessage(m: PartyMessageLike): PartyBlock | null {
  const kind = m.meta?.block_kind;
  if (!kind) return null;
  const text = m.content;
  const speakerId = m.meta?.speaker_character_id ?? null;
  const speakerName = m.meta?.speaker_name ?? null;
  switch (kind) {
    case 'header':
      return { kind: 'header', text };
    case 'narration':
      return { kind: 'narration', text };
    case 'line':
      return { kind: 'dialogue', speakerId, speakerName, text };
    case 'thought':
      return { kind: 'thought', speakerId, speakerName, text };
    case 'info':
      return { kind: 'info', text };
    case 'ui':
      return { kind: 'ui', payload: uiPayload(text) };
    case 'panel':
      return { kind: 'panel', text };
    case 'system':
      return { kind: 'system', text };
    default:
      return null;
  }
}
