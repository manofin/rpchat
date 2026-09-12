export const CHAR_TOKEN = '{{char}}' as const;
export const USER_TOKEN = '{{user}}' as const;
export const INSERTABLE_TOKENS = [CHAR_TOKEN, USER_TOKEN] as const;
export type InsertableToken = (typeof INSERTABLE_TOKENS)[number];

export const TOKEN_CHIP_FIELDS = [
  'tagline',
  'description',
  'personality',
  'speech_style',
  'scenario',
  'taboos',
  'first_message',
  'example_dialogue',
] as const;
export type TokenChipField = (typeof TOKEN_CHIP_FIELDS)[number];

export type TokenInsertResult = {
  text: string;
  caret: number;
};

export type TokenCaretNode = {
  isConnected: boolean;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
};

function clampOffset(value: number, length: number): number {
  if (value < 0) return 0;
  if (value > length) return length;
  return value | 0;
}

export function insertCharacterToken(
  text: string,
  token: string,
  selectionStart?: number | null,
  selectionEnd?: number | null,
): TokenInsertResult {
  const src = text ?? '';
  const tok = token ?? '';
  if (
    typeof selectionStart !== 'number' || typeof selectionEnd !== 'number'
    || !Number.isFinite(selectionStart) || !Number.isFinite(selectionEnd)
  ) {
    const next = src + tok;
    return { text: next, caret: next.length };
  }
  const len = src.length;
  let start = clampOffset(selectionStart, len);
  let end = clampOffset(selectionEnd, len);
  if (start > end) {
    const swap = start;
    start = end;
    end = swap;
  }
  const next = src.slice(0, start) + tok + src.slice(end);
  return { text: next, caret: start + tok.length };
}

export function applyTokenCaretRestore(
  liveNode: TokenCaretNode | null | undefined,
  expectedNode: TokenCaretNode | null | undefined,
  caret: number,
): void {
  if (!liveNode || !expectedNode) return;
  if (liveNode !== expectedNode) return;
  if (!liveNode.isConnected) return;
  try {
    liveNode.focus();
    liveNode.setSelectionRange(caret, caret);
  } catch {
    /* unmounted or non-text control — never throw the editor */
  }
}
