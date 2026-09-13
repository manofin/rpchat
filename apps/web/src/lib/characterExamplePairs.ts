/**
 * Strict example_dialogue pair parse/serialize.
 * Storage/API remain a single plaintext string; pairs are UI-only.
 */

export type ExamplePair = {
  user: string;
  char: string;
};

export type ParseExampleDialogueResult =
  | { ok: true; pairs: ExamplePair[] }
  | { ok: false };

export type ExampleEditorInit =
  | { mode: 'structured'; pairs: ExamplePair[] }
  | { mode: 'raw'; raw: string };

const USER_PREFIX = '{{user}}: ';
const CHAR_PREFIX = '{{char}}: ';

export function isUtteranceEmpty(value: string): boolean {
  return value.trim().length === 0;
}

export function isExamplePairIncomplete(pair: ExamplePair): boolean {
  const userEmpty = isUtteranceEmpty(pair.user);
  const charEmpty = isUtteranceEmpty(pair.char);
  return userEmpty !== charEmpty;
}

export function hasIncompleteExamplePairs(pairs: readonly ExamplePair[]): boolean {
  return pairs.some(isExamplePairIncomplete);
}

export function serializeExamplePairs(pairs: readonly ExamplePair[]): string {
  const chunks: string[] = [];
  for (const pair of pairs) {
    if (isUtteranceEmpty(pair.user) && isUtteranceEmpty(pair.char)) continue;
    chunks.push(`${USER_PREFIX}${pair.user}\n${CHAR_PREFIX}${pair.char}`);
  }
  return chunks.join('\n');
}

export function parseExampleDialogue(raw: string): ParseExampleDialogueResult {
  if (typeof raw !== 'string') return { ok: false };
  if (raw === '') return { ok: false };

  const lines = raw.split('\n');
  const speakers: Array<'user' | 'char'> = [];
  const texts: string[] = [];
  for (const line of lines) {
    if (line.startsWith(USER_PREFIX)) {
      speakers.push('user');
      texts.push(line.slice(USER_PREFIX.length));
      continue;
    }
    if (line.startsWith(CHAR_PREFIX)) {
      speakers.push('char');
      texts.push(line.slice(CHAR_PREFIX.length));
      continue;
    }
    return { ok: false };
  }

  const n = speakers.length;
  if (n < 2 || n % 2 !== 0) return { ok: false };
  if (speakers[0] !== 'user') return { ok: false };
  if (speakers[n - 1] !== 'char') return { ok: false };
  for (let i = 0; i < n; i++) {
    if (speakers[i] !== (i % 2 === 0 ? 'user' : 'char')) return { ok: false };
  }

  const pairs: ExamplePair[] = [];
  for (let i = 0; i < n; i += 2) {
    pairs.push({ user: texts[i], char: texts[i + 1] });
  }
  if (serializeExamplePairs(pairs) !== raw) return { ok: false };
  return { ok: true, pairs };
}

export function initialExampleEditorState(raw: string): ExampleEditorInit {
  if (raw === '') return { mode: 'structured', pairs: [{ user: '', char: '' }] };
  const parsed = parseExampleDialogue(raw);
  if (parsed.ok) return { mode: 'structured', pairs: parsed.pairs };
  return { mode: 'raw', raw };
}
