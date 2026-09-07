import { eligibleExtras, type ExtraRejectReason } from './eligibleExtras.js';
import type { CastMember } from './cast.js';
import type { Scene } from '../types.js';

/** ADR-F8e Fork C1: story-room extras cap. Same numeric as MAX_EXTRAS; not wired. */
const STORY_EXTRA_K = 2;

export type StoryExtraRejectReason =
  | ExtraRejectReason
  | 'no_focus'
  | 'not_story'
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
  story?: boolean;
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
 */
export function approveStoryExtras(input: ApproveStoryExtrasInput): ApproveStoryExtrasResult {
  const { cast, scene, focus_id } = input;
  if (input.story !== true) return rejectAll(cast, 'not_story');
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
    if (approved.length >= STORY_EXTRA_K) {
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
