/**
 * Client last-line defense for leaked `<choices>` / trailing BeatUi JSON in
 * ordinary bubbles (no block_kind / line). Does not touch real `block_kind:'ui'`
 * rows — those render via BeatUiPanel.
 */

function isBeatUiShape(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    'location_badge' in o ||
    'roster' in o ||
    'user_sheet' in o ||
    'intent_hint' in o ||
    'focus_id' in o ||
    'custom_stats' in o
  );
}

function stripTrailingBeatUiJson(text: string): string {
  const trimmed = text.replace(/\s+$/, '');
  const m = trimmed.match(/(\n|^)(\s*)(\{[\s\S]*\})\s*$/);
  if (!m || m.index == null) return text;
  try {
    const obj = JSON.parse(m[3]);
    if (!isBeatUiShape(obj)) return text;
    return trimmed.slice(0, m.index).replace(/\s+$/, '');
  } catch {
    return text;
  }
}

function findTerminalChoices(text: string): RegExpExecArray | null {
  const re = /<choices>\s*(\[[\s\S]*?\])\s*<\/choices>/gi;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length);
    if (/^\s*$/.test(after)) {
      last = m;
      continue;
    }
    const stripped = stripTrailingBeatUiJson(after);
    if (stripped.replace(/\s+/g, '') === '') last = m;
  }
  return last;
}

/** Display-only sanitize for ordinary assistant bubbles. */
export function sanitizeBubbleContent(content: string): string {
  if (!content) return content;
  const m = findTerminalChoices(content);
  let out = content;
  if (m && m.index != null) {
    out = content.slice(0, m.index) + content.slice(m.index + m[0].length);
  }
  out = stripTrailingBeatUiJson(out);
  return out.replace(/\s+$/, '');
}
