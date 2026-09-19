/**
 * B-2 S2 — render-contract plan from PartyBlock (new path).
 * Display-only: wrapSpeechMarks is not stored on the block.
 */

import { wrapSpeechMarks } from './speechMarks';
import {
  partyBlockFromMessage,
  type PartyBlock,
  type PartyMessageLike,
} from './partyTurn';

export type PartyRenderPlan =
  | { surface: 'plain'; text: string; streaming: boolean }
  | { surface: 'header'; text: string }
  | { surface: 'info'; text: string }
  | { surface: 'narration'; text: string; streaming: boolean }
  | { surface: 'thought-hidden' }
  | { surface: 'ui-raw'; raw: string }
  | {
      surface: 'dialogue';
      speakerId: string | null;
      speakerName: string | null;
      text: string;
      streaming: boolean;
    };

export function planFromBlock(
  block: PartyBlock | null,
  opts: { streaming?: boolean; fallbackText?: string } = {},
): PartyRenderPlan {
  const streaming = !!opts.streaming;
  if (!block) {
    return { surface: 'plain', text: opts.fallbackText ?? '', streaming };
  }
  switch (block.kind) {
    case 'header':
      return { surface: 'header', text: block.text };
    case 'info':
      return { surface: 'info', text: block.text };
    case 'narration':
      return { surface: 'narration', text: block.text, streaming };
    case 'thought':
      return { surface: 'thought-hidden' };
    case 'dialogue': {
      const text = streaming ? block.text : wrapSpeechMarks(block.text);
      return {
        surface: 'dialogue',
        speakerId: block.speakerId,
        speakerName: block.speakerName,
        text,
        streaming,
      };
    }
    case 'ui': {
      const raw = typeof block.payload === 'string' ? block.payload : JSON.stringify(block.payload);
      return { surface: 'ui-raw', raw };
    }
    case 'panel':
    case 'system':
      return { surface: 'ui-raw', raw: block.text };
    default:
      return { surface: 'plain', text: opts.fallbackText ?? '', streaming };
  }
}

export function partyRenderPlan(
  m: PartyMessageLike,
  opts: { streaming?: boolean } = {},
): PartyRenderPlan {
  const block = partyBlockFromMessage(m);
  return planFromBlock(block, { streaming: opts.streaming, fallbackText: m.content });
}

/** ui-raw: parsed JSON deep-equal when both parse; else string equal. Other surfaces: strict. */
export function plansEquivalent(a: PartyRenderPlan, b: PartyRenderPlan): boolean {
  if (a.surface !== b.surface) return false;
  if (a.surface === 'ui-raw' && b.surface === 'ui-raw') {
    try {
      return JSON.stringify(JSON.parse(a.raw)) === JSON.stringify(JSON.parse(b.raw));
    } catch {
      return a.raw === b.raw;
    }
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
