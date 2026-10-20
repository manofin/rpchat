import { many, type DB } from '../db/index.js';
import { isMemoryAnchorMessage, isSideModeMessage } from '../db/sideMode.js';
import type { ConversationRow, StoredMessageRow, SummaryRow } from '../types.js';

export type SummaryBranchScope = 'current' | 'other' | 'unlinked';
type ScopeMessage = Pick<StoredMessageRow, 'id' | 'parent_id' | 'role' | 'meta_json'>;

/** Provenance only: membership does not mean approval, factual truth, or prompt inclusion. */
export function summaryScopeForConversation(db: DB, conv: Pick<ConversationRow, 'id' | 'head_message_id'>) {
  const rows = many<ScopeMessage>(db, 'SELECT id, parent_id, role, meta_json FROM messages WHERE conversation_id = ?', conv.id);
  const byId = new Map(rows.map(row => [row.id, row]));
  const children = new Map<string, string[]>();
  const stack: Array<{ id: string; exit: boolean }> = [];
  for (const row of rows) {
    if (row.parent_id === null) stack.push({ id: row.id, exit: false });
    else {
      const siblings = children.get(row.parent_id) ?? [];
      siblings.push(row.id);
      children.set(row.parent_id, siblings);
    }
  }
  // Rooted DFS intervals answer ancestry without retaining a full path per summary.
  // Cycles and broken/cross-conversation parent chains have no reachable root.
  const entered = new Map<string, number>();
  const exited = new Map<string, number>();
  let order = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (item.exit) { exited.set(item.id, order++); continue; }
    if (entered.has(item.id)) continue;
    entered.set(item.id, order++);
    stack.push({ id: item.id, exit: true });
    for (const id of children.get(item.id) ?? []) stack.push({ id, exit: false });
  }
  const ancestor = (from: string, until: string) =>
    entered.has(from) && entered.has(until)
    && entered.get(from)! <= entered.get(until)! && exited.get(until)! <= exited.get(from)!;
  function evidence(id: string): boolean {
    const row = byId.get(id);
    if (!row || !entered.has(id) || isSideModeMessage(row)) return false;
    try { return !isMemoryAnchorMessage(row); } catch { return false; }
  }
  return (summary: Pick<SummaryRow, 'conversation_id' | 'covers_from_message_id' | 'covers_until_message_id'>): SummaryBranchScope => {
    const until = summary.covers_until_message_id;
    const from = summary.covers_from_message_id;
    if (summary.conversation_id !== conv.id || !until || !evidence(until)) return 'unlinked';
    if (from && (!evidence(from) || !ancestor(from, until))) return 'unlinked';
    if (conv.head_message_id && !entered.has(conv.head_message_id)) return 'unlinked';
    return conv.head_message_id && ancestor(until, conv.head_message_id) ? 'current' : 'other';
  };
}
