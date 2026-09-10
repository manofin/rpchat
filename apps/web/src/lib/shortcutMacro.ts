/**
 * story-editor-tabs A9 (D3=a): client-only slash macros.
 * Stored in localStorage per story id. Never sent on PUT /api/stories.
 */

export const SHORTCUT_MAX = 20;
export const SHORTCUT_STORAGE_PREFIX = 'rpchat.shortcuts.';

export type Shortcut = { name: string; text: string };

export type ShortcutKv = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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

export function parseShortcuts(raw: string | null | undefined): Shortcut[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const out: Shortcut[] = [];
    const seen = new Set<string>();
    for (const item of v) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as { name?: unknown; text?: unknown };
      const name = typeof rec.name === 'string' ? normalizeShortcutName(rec.name) : null;
      const text = typeof rec.text === 'string' ? rec.text : '';
      if (!name || !text || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, text });
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
): { ok: true; entries: Shortcut[] } | { ok: false; entries: Shortcut[] } {
  const name = normalizeShortcutName(nameRaw);
  const body = text; // keep user whitespace inside the body; reject empty
  if (!name || !body.trim()) return { ok: false, entries };
  const idx = entries.findIndex((e) => e.name === name);
  if (idx >= 0) {
    const next = entries.slice();
    next[idx] = { name, text: body };
    return { ok: true, entries: next };
  }
  if (entries.length >= SHORTCUT_MAX) return { ok: false, entries };
  return { ok: true, entries: [...entries, { name, text: body }] };
}

export function removeShortcut(entries: Shortcut[], nameRaw: string): Shortcut[] {
  const name = normalizeShortcutName(nameRaw);
  if (!name) return entries;
  return entries.filter((e) => e.name !== name);
}

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
  const rest = m[4];
  if (!rest) return { text: hit.text, matched: name };
  const gap = m[3].length ? m[3] : ' ';
  return { text: hit.text + gap + rest, matched: name };
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
