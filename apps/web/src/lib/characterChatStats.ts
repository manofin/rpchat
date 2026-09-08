/**
 * Character detail hero stats (web-only).
 * GET /api/characters/:id does not attach conversation_count / last_chat_at;
 * fall back to the already-fetched conversation list. Server contracts unchanged.
 *
 * Known client limit: listed conversations are capped at limit=200, so a
 * character with more than 200 unarchived chats may under-count when the
 * detail payload omits conversation_count.
 */
export function resolveConversationCount(
  detailCount: number | null | undefined,
  listedLength: number,
): number {
  return detailCount ?? listedLength;
}

export function resolveLastChatAt(
  lastChatAt: string | null | undefined,
  convs: { last_message_at?: string | null }[],
): string | null {
  if (lastChatAt) return lastChatAt;
  let best: string | null = null;
  for (const c of convs) {
    const t = c.last_message_at;
    if (!t) continue;
    if (best == null || t > best) best = t;
  }
  return best;
}

export function characterHeroEmpty(count: number): boolean {
  return count === 0;
}
