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

/** Orphan `</choices>` / dangling `<choices>…` at EOL only (Finley hotfix). */
function stripTrailingChoicesDebris(text: string): string {
  let out = text.replace(/\s+$/, '');
  for (;;) {
    const close = out.match(/\n?\s*<\/choices>\s*$/i);
    if (!close || close.index == null) break;
    out = out.slice(0, close.index).replace(/\s+$/, '');
  }
  // Trailing unmatched <choices>… with NO closing tag anywhere after the open.
  const open = out.match(/\n?\s*<choices>(?:(?!<\/choices>)[\s\S])*$/i);
  if (open && open.index != null) {
    out = out.slice(0, open.index).replace(/\s+$/, '');
  }
  return out;
}


/** Assistant leading `(OOC)` / `(OOC:` fuel — same contract as server stripLeadingOocFuel. */
function stripLeadingOocFuel(text: string): string {
  const detect = text.replace(/^\s+/, '');
  if (!/^\(OOC(?:\)|:)/i.test(detect)) return text;
  const endStar = detect.search(/\*{3}/);
  const endBlank = detect.search(/\n[ \t]*\n/);
  let end = detect.length;
  if (endStar >= 0) end = Math.min(end, endStar);
  if (endBlank >= 0) end = Math.min(end, endBlank);
  let rest = detect.slice(end);
  if (/^\*{3}/.test(rest)) rest = rest.replace(/^\*{3}[ \t]*/, '').replace(/^\n/, '');
  else if (/^\n[ \t]*\n/.test(rest)) rest = rest.replace(/^\n[ \t]*\n/, '');
  return rest.replace(/^\s+/, '');
}

function stripLeakTail(text: string): string {
  return stripLeadingOocFuel(stripTrailingChoicesDebris(stripTrailingBeatUiJson(text)));
}

/** Paired `<choices>…</choices>` anywhere. Trailing junk after the close is kept. */
export function stripPairedChoices(text: string): string {
  return text.replace(/<choices>[\s\S]*?<\/choices>/gi, '');
}

/** Display-only sanitize for ordinary / party text surfaces. */
export function sanitizeBubbleContent(content: string): string {
  if (!content) return content;
  return stripLeakTail(stripPairedChoices(content)).replace(/\s+$/, '');
}

const CHOICES_TAGS = ['<choices>', '</choices>'] as const;

/**
 * Streaming-only: hide a proper prefix of a known `<choices>` tag at EOL.
 * Once the suffix is no longer a prefix of those tags, the text is shown again.
 * Does not strip arbitrary HTML and does not change completed-bubble sanitize.
 */
export function hideIncompleteChoicesPrefix(text: string): string {
  if (!text) return text;
  const lower = text.toLowerCase();
  let hideLen = 0;
  for (const tag of CHOICES_TAGS) {
    const max = Math.min(lower.length, tag.length - 1);
    for (let n = max; n >= 1; n--) {
      if (tag.startsWith(lower.slice(lower.length - n))) {
        if (n > hideLen) hideLen = n;
        break;
      }
    }
  }
  if (hideLen === 0) return text;
  return text.slice(0, text.length - hideLen).replace(/\s+$/, '');
}

/** Display contract: completed bubbles keep sanitize; streaming also hides tag prefixes. */
export function displayBubbleContent(content: string, streaming = false): string {
  const shown = sanitizeBubbleContent(content);
  return streaming ? hideIncompleteChoicesPrefix(shown) : shown;
}
