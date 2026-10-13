import { parseMessageMeta } from './messageMeta.js';
import type { MessageRow, StoredMessageRow } from '../types.js';

export type SideMode = 'summary' | 'community';
export type SideModeMeta = { mode: SideMode; prompt: string; anchor_message_id: string | null };

export function isSideModeMessage(row: Pick<MessageRow, 'meta_json'>): boolean {
  return parseMessageMeta(row.meta_json).side_mode !== undefined;
}

/** Both marks are required. One without the other is a corrupt row. */
export function isMemoryAnchorMessage(row: Pick<StoredMessageRow, 'role' | 'meta_json'>): boolean {
  const marked = parseMessageMeta(row.meta_json).memory_anchor !== undefined;
  const role = row.role === 'memory-anchor';
  if (marked !== role) throw new Error('memory anchor marks disagree');
  return marked && role;
}

/** SQL readers must exclude even malformed side metadata, just like the typed reader. */
export function mainMessageSql(column = 'meta_json'): string {
  return `(CASE WHEN json_valid(${column}) THEN json_type(${column}, '$.side_mode') END IS NULL AND CASE WHEN json_valid(${column}) THEN json_type(${column}, '$.memory_anchor') END IS NULL)`;
}

export function sideModeVisible(row: MessageRow, pathIds: ReadonlySet<string>, head: string | null): boolean {
  const meta = parseMessageMeta(row.meta_json).side_mode;
  if (!meta || !['summary', 'community'].includes(meta.mode)) return false;
  return meta.anchor_message_id === null ? head === null : pathIds.has(meta.anchor_message_id);
}
