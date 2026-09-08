import { eligibleExtras, type ExtraRejectReason } from './eligibleExtras.js';
import { MAX_EXTRAS } from './assignSpeakers.js';
import type { CastMember } from './cast.js';
import type { Scene } from '../types.js';

export type StoryExtraRejectReason =
  | ExtraRejectReason
  | 'no_focus'
  | 'solo_cast'
  | 'cap';

export type ApprovedStoryExtra = {
  character_id: string;
  name: string;
};

export type ApproveStoryExtrasResult = {
  approved: ApprovedStoryExtra[];
  eligible_ids: string[];
  rejected: Array<{ id: string; reason: StoryExtraRejectReason }>;
  k_opened: number;
};

export type ApproveStoryExtrasInput = {
  cast: CastMember[];
  scene: Scene;
  focus_id: string | null;
  user_id?: string | null;
  previous_extra_ids?: string[];
};

function rejectAll(
  cast: CastMember[],
  reason: StoryExtraRejectReason,
): ApproveStoryExtrasResult {
  return {
    approved: [],
    eligible_ids: [],
    rejected: cast.map((c) => ({ id: c.id, reason })),
    k_opened: 0,
  };
}

/**
 * Story-room extra policy (ADR-F8e C1 + C-focus-β). Isolated: generate path
 * does not import this. 1:1 extra policy lives in a separate module.
 * Call itself means story-room; there is no non-story input.
 */
export function approveStoryExtras(input: ApproveStoryExtrasInput): ApproveStoryExtrasResult {
  const { cast, scene, focus_id } = input;
  if (focus_id == null) return rejectAll(cast, 'no_focus');

  const uniqueIds = new Set(cast.map((c) => c.id));
  if (uniqueIds.size <= 1) return rejectAll(cast, 'solo_cast');

  const { eligible_ids, rejected } = eligibleExtras({
    cast,
    scene,
    focus_id,
    user_id: input.user_id ?? null,
    previous_extra_ids: input.previous_extra_ids ?? [],
  });

  const extraRejected: Array<{ id: string; reason: StoryExtraRejectReason }> = [...rejected];
  const approved: ApprovedStoryExtra[] = [];
  for (const id of eligible_ids) {
    if (approved.length >= MAX_EXTRAS) {
      extraRejected.push({ id, reason: 'cap' });
      continue;
    }
    const m = cast.find((c) => c.id === id);
    if (!m) continue;
    approved.push({ character_id: m.id, name: m.name });
  }

  return {
    approved,
    eligible_ids,
    rejected: extraRejected,
    k_opened: approved.length,
  };
}
