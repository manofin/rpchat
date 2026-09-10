/** story-editor-tabs A7 (D2=a): display-only custom stats.
 * Definitions live on the story. Values live on conversation.scene.stats.
 * applySceneDelta is not the writer.
 */

export type StoryStatDef = {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
};

export type FrozenStatDef = {
  id: string;
  label: string;
  min: number;
  max: number;
};

export const STAT_MAX = 7;
export const STAT_ID_RE = /^[a-z0-9_]{1,20}$/;

export function formatCustomStats(
  stats: Record<string, number> | undefined,
  defs: FrozenStatDef[] | undefined,
): string[] {
  if (!defs?.length) return [];
  const out: string[] = [];
  for (const d of defs) {
    const v = stats?.[d.id];
    if (typeof v === 'number') out.push(`${d.label} ${v}`);
  }
  return out;
}

export function emptyStat(): StoryStatDef {
  return { id: '', label: '', min: 0, max: 100, default: 0 };
}
