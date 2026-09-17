/**
 * Display-only filter for character tags on public surfaces (home chips/cards,
 * character detail). Authors still see/edit raw tags in CharacterEditor.
 *
 * Must stay in sync with apps/server/src/prompt/tagsCatalog.ts prefixes
 * (today only `party:` — no scene:/format: tag prefixes).
 */
export const INTERNAL_TAG_PREFIXES = ['party:'] as const;

export function isPublicTag(t: string): boolean {
  const tag = t.trim();
  if (!tag) return false;
  for (const prefix of INTERNAL_TAG_PREFIXES) {
    if (tag.startsWith(prefix)) return false;
  }
  return true;
}

export function publicTags(tags: string[] | null | undefined): string[] {
  if (!tags?.length) return [];
  return tags.filter(isPublicTag);
}
