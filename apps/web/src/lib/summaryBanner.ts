/**
 * Summary-banner trigger + later-suppress (web-only).
 * New-message count after the latest on-path approved covers_until.
 * Does not read budget.dropped_messages. Server compaction is unchanged.
 */
export const SUMMARY_BANNER_NEW_MESSAGE_THRESHOLD = 24;

export type SummaryBannerPathMessage = { id: string };

export type SummaryBannerSummary = {
  status: string;
  covers_until_message_id: string | null;
  covers_from_message_id?: string | null;
  conversation_id?: string;
};

export type BannerKv = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** Most advanced on-path approved covers_until id, or null. */
export function resolveBannerWatermarkId(
  path: SummaryBannerPathMessage[],
  summaries: SummaryBannerSummary[],
  conversationId: string,
): string | null {
  const indexById = new Map<string, number>();
  for (let i = 0; i < path.length; i++) indexById.set(path[i].id, i);

  let bestIdx: number | null = null;
  let bestId: string | null = null;
  for (const s of summaries) {
    if (s.status !== 'approved') continue;
    if (s.conversation_id != null && s.conversation_id !== conversationId) continue;
    const untilId = s.covers_until_message_id;
    if (!untilId) continue;
    const untilIdx = indexById.get(untilId);
    if (untilIdx === undefined) continue;
    const fromId = s.covers_from_message_id;
    if (fromId) {
      const fromIdx = indexById.get(fromId);
      if (fromIdx === undefined) continue;
      if (fromIdx > untilIdx) continue;
    }
    if (bestIdx === null || untilIdx > bestIdx) {
      bestIdx = untilIdx;
      bestId = untilId;
    }
  }
  return bestId;
}

export function countMessagesAfterWatermark(
  path: SummaryBannerPathMessage[],
  watermarkId: string | null,
): number {
  if (!watermarkId) return path.length;
  const idx = path.findIndex((m) => m.id === watermarkId);
  if (idx < 0) return path.length;
  return path.length - idx - 1;
}

export function summaryBannerStorageKey(conversationId: string, watermarkId: string | null): string {
  return `rpchat.summarySuggest.wm.${conversationId}.${watermarkId ?? 'none'}`;
}

function readItem(storage: BannerKv | null | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function isSummaryBannerSuppressed(
  conversationId: string,
  watermarkId: string | null,
  storage: BannerKv,
  localStorage?: BannerKv | null,
): boolean {
  try {
    if (localStorage) {
      try {
        localStorage.getItem(`rpchat.summarySuggest.${conversationId}`);
      } catch {
        /* leftover localStorage must not throw */
      }
    }
    const raw = readItem(storage, summaryBannerStorageKey(conversationId, watermarkId));
    return raw != null && raw !== '';
  } catch {
    return false;
  }
}

export function suppressSummaryBanner(
  conversationId: string,
  watermarkId: string | null,
  storage: BannerKv,
): void {
  try {
    storage.setItem(summaryBannerStorageKey(conversationId, watermarkId), '1');
  } catch {
    /* private mode */
  }
}

export function shouldShowSummaryBanner(input: {
  path: SummaryBannerPathMessage[];
  summaries: SummaryBannerSummary[];
  conversationId: string;
  droppedMessages?: number;
  generating?: boolean;
  loading?: boolean;
  storage: BannerKv;
  localStorage?: BannerKv | null;
  threshold?: number;
}): boolean {
  void input.droppedMessages;
  if (input.generating || input.loading) return false;
  const threshold = input.threshold ?? SUMMARY_BANNER_NEW_MESSAGE_THRESHOLD;
  const wm = resolveBannerWatermarkId(input.path, input.summaries, input.conversationId);
  const n = countMessagesAfterWatermark(input.path, wm);
  if (n < threshold) return false;
  if (isSummaryBannerSuppressed(input.conversationId, wm, input.storage, input.localStorage)) return false;
  return true;
}
