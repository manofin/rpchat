/**
 * story-editor-tabs A9 (D3=a): client-only slash macros.
 * Stored in localStorage per story id. Never sent on PUT /api/stories.
 * inject-macro-client (ADR §6.4): mode insert|inject; inject posts inject_instruction only.
 */

export const SHORTCUT_MAX = 20;
export const SHORTCUT_STORAGE_PREFIX = 'rpchat.shortcuts.';

/**
 * Client mirror of apps/server/src/prompt/injectContext.ts INJECT_INSTRUCTION_MAX.
 * Keep in sync — server still hard-rejects over max on send (defense in depth).
 */
export const INJECT_INSTRUCTION_MAX = 800;

export type ShortcutMode = 'insert' | 'inject';

export type Shortcut = { name: string; text: string; mode?: ShortcutMode };

export type ShortcutKv = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type ShortcutSubmitResolved = {
  content: string;
  inject_instruction?: string;
  matched: string | null;
  mode?: ShortcutMode;
};

const NAME_RE = /^[^\s/]{1,32}$/;

export function shortcutStorageKey(storyId: string): string {
  return `${SHORTCUT_STORAGE_PREFIX}${storyId}`;
}

export function normalizeShortcutName(raw: string): string | null {
  const trimmed = raw.trim();
  const name = trimmed.startsWith('/') ? trimmed.slice(1).trim() : trimmed;
  if (!NAME_RE.test(name)) return null;
  return name;
}

function normalizeMode(raw: unknown): ShortcutMode {
  return raw === 'inject' ? 'inject' : 'insert';
}

export function parseShortcuts(raw: string | null | undefined): Shortcut[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const out: Shortcut[] = [];
    const seen = new Set<string>();
    for (const item of v) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as { name?: unknown; text?: unknown; mode?: unknown };
      const name = typeof rec.name === 'string' ? normalizeShortcutName(rec.name) : null;
      const text = typeof rec.text === 'string' ? rec.text : '';
      if (!name || !text || seen.has(name)) continue;
      seen.add(name);
      const mode = normalizeMode(rec.mode);
      // Legacy localStorage entries omit mode → insert; keep omit for insert to stay byte-stable.
      out.push(mode === 'inject' ? { name, text, mode: 'inject' } : { name, text });
      if (out.length >= SHORTCUT_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeShortcuts(entries: Shortcut[]): string {
  return JSON.stringify(parseShortcuts(JSON.stringify(entries)));
}

export function upsertShortcut(
  entries: Shortcut[],
  nameRaw: string,
  text: string,
  mode?: ShortcutMode,
): { ok: true; entries: Shortcut[] } | { ok: false; entries: Shortcut[]; reason?: 'inject_too_long' | 'invalid' | 'full' } {
  const name = normalizeShortcutName(nameRaw);
  const body = text; // keep user whitespace inside the body; reject empty
  const resolvedMode = mode ?? 'insert';
  if (!name || !body.trim()) return { ok: false, entries, reason: 'invalid' };
  if (resolvedMode === 'inject' && body.length > INJECT_INSTRUCTION_MAX) {
    return { ok: false, entries, reason: 'inject_too_long' };
  }
  const entry: Shortcut =
    resolvedMode === 'inject' ? { name, text: body, mode: 'inject' } : { name, text: body };
  const idx = entries.findIndex((e) => e.name === name);
  if (idx >= 0) {
    const next = entries.slice();
    next[idx] = entry;
    return { ok: true, entries: next };
  }
  if (entries.length >= SHORTCUT_MAX) return { ok: false, entries, reason: 'full' };
  return { ok: true, entries: [...entries, entry] };
}

export function removeShortcut(entries: Shortcut[], nameRaw: string): Shortcut[] {
  const name = normalizeShortcutName(nameRaw);
  if (!name) return entries;
  return entries.filter((e) => e.name !== name);
}

/**
 * Expand leading `/name` into the draft for **insert** shortcuts only.
 * Inject matches must not rewrite the draft (command body stays out of the input).
 */
export function expandLeadingShortcut(
  draft: string,
  entries: Shortcut[],
  opts?: { bare?: boolean },
): { text: string; matched: string | null } {
  const bare = opts?.bare !== false;
  const m = draft.match(/^(\s*)\/([^\s]+)(\s*)([\s\S]*)$/);
  if (!m) return { text: draft, matched: null };
  if (!bare && !m[3]) return { text: draft, matched: null };
  const name = m[2];
  const hit = entries.find((e) => e.name === name);
  if (!hit) return { text: draft, matched: null };
  if (normalizeMode(hit.mode) === 'inject') return { text: draft, matched: null };
  const rest = m[4];
  if (!rest) return { text: hit.text, matched: name };
  const gap = m[3].length ? m[3] : ' ';
  return { text: hit.text + gap + rest, matched: name };
}

/**
 * Parse lock for submit (ADR §6.4):
 * - insert → expand into content only (no inject_instruction)
 * - inject → inject_instruction = entry.text; content = remaining speech only (never entry.text)
 * - `/name` alone in inject → content '' (empty); must not fall back to command body
 */
export function resolveShortcutSubmit(draft: string, entries: Shortcut[]): ShortcutSubmitResolved {
  const m = draft.match(/^(\s*)\/([^\s]+)(\s*)([\s\S]*)$/);
  if (!m) return { content: draft, matched: null };
  const name = m[2];
  const hit = entries.find((e) => e.name === name);
  if (!hit) return { content: draft, matched: null };
  const mode = normalizeMode(hit.mode);
  if (mode === 'inject') {
    const speech = (m[4] ?? '').trim();
    return {
      content: speech,
      inject_instruction: hit.text,
      matched: name,
      mode: 'inject',
    };
  }
  const expanded = expandLeadingShortcut(draft, entries);
  return { content: expanded.text, matched: expanded.matched, mode: 'insert' };
}

export function readShortcuts(
  storyId: string | null | undefined,
  storage?: ShortcutKv | null,
): Shortcut[] {
  if (!storyId) return [];
  try {
    const kv = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    if (!kv) return [];
    return parseShortcuts(kv.getItem(shortcutStorageKey(storyId)));
  } catch {
    return [];
  }
}

export function persistShortcuts(
  storyId: string,
  entries: Shortcut[],
  storage?: ShortcutKv | null,
): void {
  try {
    const kv = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    if (!kv) return;
    kv.setItem(shortcutStorageKey(storyId), serializeShortcuts(entries));
  } catch {
    /* private mode / no storage */
  }
}
