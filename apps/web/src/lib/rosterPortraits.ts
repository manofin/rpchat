import type { BeatUiData } from '../components/view';

export type RosterPortrait = { id: string; name: string; chip: string; image_url: string };
type StoredPortrait = { id?: unknown; name?: unknown; image_url?: unknown; emotion?: unknown };

const localAsset = (value: unknown): value is string =>
  typeof value === 'string' && /^\/media\/assets\/[^/?#]+\/[^/?#]+\/\d+\.webp$/.test(value);

/** Join current roster authority to separately stored server-selected assets. */
export function rosterPortraitOptions(ui: BeatUiData | null, stored: readonly StoredPortrait[] | null | undefined): RosterPortrait[] {
  if (!ui?.roster?.length || !Array.isArray(stored)) return [];
  const byId = new Map(stored.flatMap(row => typeof row.id === 'string' && typeof row.name === 'string' && localAsset(row.image_url)
    ? [[row.id, { name: row.name, image_url: row.image_url }] as const] : []));
  return ui.roster.flatMap(row => {
    const portrait = byId.get(row.id);
    if (!portrait || row.locked || portrait.name !== row.name) return [];
    return [{ id: row.id, name: row.name, chip: row.chip, image_url: portrait.image_url }];
  });
}
