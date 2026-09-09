/** Display-only. Reads `meta.choices` as given — never invents or rewrites copy. */
export function visibleChoices(choices: string[] | null | undefined, cap = 3): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of choices ?? []) {
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}
