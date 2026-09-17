/**
 * Display-only structural parse for mixed narration/dialogue turns.
 * Never invents speaker names. Does not touch stored message bytes.
 */

export type TurnBlock =
  | { kind: 'narration'; text: string }
  | { kind: 'dialogue'; speaker: string | null; text: string };

/** Cleared `[Name] : "speech"` / `「speech」` / `『speech』` only — no ambiguous guesses. */
const DIALOGUE_RE =
  /\[([^\]\n]{1,40})\]\s*:\s*(「([^」]*)」|『([^』]*)』|"([^"\n]*)"|“([^”]*)”)/g;

function pushNarration(out: TurnBlock[], text: string) {
  if (!text) return;
  // Preserve internal whitespace; trim only all-empty chunks.
  if (!text.trim()) {
    if (out.length) out.push({ kind: 'narration', text });
    return;
  }
  out.push({ kind: 'narration', text });
}

/**
 * Split mixed prose into narration / dialogue blocks when structure is clear.
 * While `streaming`, an unclosed dialogue pattern is kept as narration so styles
 * do not flicker mid-token.
 */
export function parseTurnBlocks(
  text: string,
  opts?: { streaming?: boolean },
): TurnBlock[] {
  if (!text) return [];
  const streaming = !!opts?.streaming;
  const out: TurnBlock[] = [];
  let last = 0;
  DIALOGUE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIALOGUE_RE.exec(text))) {
    const speaker = m[1]?.trim() || null;
    if (!speaker) continue; // never invent
    const spoken = m[3] ?? m[4] ?? m[5] ?? m[6] ?? '';
    if (m.index > last) pushNarration(out, text.slice(last, m.index));
    out.push({ kind: 'dialogue', speaker, text: spoken });
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  if (streaming && /\[[^\]\n]{1,40}\]\s*:\s*[「『"“][^」』"”]*$/.test(tail)) {
    // Incomplete dialogue while streaming — hold as narration for stability.
    pushNarration(out, tail);
  } else if (tail) {
    pushNarration(out, tail);
  }
  return out.length ? out : [{ kind: 'narration', text }];
}

/** Format a known speaker's line as `[Name] : "speech"` (display only). */
export function formatDialogueLine(speaker: string, speech: string): { speaker: string; speech: string } {
  return { speaker: speaker.trim(), speech };
}
