import { outputProfileLabel } from './conversationSettings';
import { shortModelLabel } from '../pages/HomePage';

/** Phase 1: one listed model means the endpoint cannot be switched in the app. */
export const SINGLE_ENDPOINT_GUIDANCE =
  '다른 모델을 사용하려면 별도 엔드포인트 설정 또는 서버 재기동이 필요합니다.';

export type PartyCertainty = 'party' | 'solo' | 'unknown';

/**
 * Client-side mirror of the generate gate, without roster membership.
 * Snapshot length ≥ 2 is party. Length 1 (or no story) is the 1:1 path.
 * A story room with a missing/invalid snapshot can still take the tagged party path.
 */
export function partyCertainty(conv: {
  story_id?: string | null;
  story_participant_ids_snapshot?: string | null;
}): PartyCertainty {
  if (!conv.story_id) return 'solo';
  const raw = conv.story_participant_ids_snapshot;
  if (raw == null || raw === '') return 'unknown';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unknown';
  }
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string')) return 'unknown';
  return parsed.length >= 2 ? 'party' : 'solo';
}

/** 1:1 may send profile.model; party, ending, and several passes ignore it. */
export function profileModelAsymmetry(
  profileModel: string | null | undefined,
  resolvedModel: string | null | undefined,
): boolean {
  const override = (profileModel ?? '').trim();
  if (!override) return false;
  return override !== (resolvedModel ?? '').trim();
}

export function settingsModelLines(input: {
  resolvedModel: string | null | undefined;
  models: readonly string[] | null | undefined;
}): { current: string; list: string; guidance: string | null } {
  const models = input.models ?? [];
  return {
    current: shortModelLabel(input.resolvedModel),
    list: models.map((id) => shortModelLabel(id)).join(', '),
    guidance: models.length === 1 ? SINGLE_ENDPOINT_GUIDANCE : null,
  };
}

export function chatModelSubtitle(input: {
  resolvedModel: string | null | undefined;
  resolvedKnown: boolean;
  profileName: string;
  profileModel: string | null | undefined;
  /** pending = not loaded; failed = cannot confirm the override; ready = field is known. */
  profileModelState: 'pending' | 'ready' | 'failed';
  party: PartyCertainty;
}): string {
  const tonePart = `출력/톤: ${outputProfileLabel(input.profileName)}`;
  if (!input.resolvedKnown) return `모델: … · ${tonePart}`;
  const label = shortModelLabel(input.resolvedModel);
  if (input.party !== 'solo') return `서버 기본 모델: ${label} · ${tonePart}`;
  if (input.profileModelState === 'pending') return `모델: … · ${tonePart}`;
  if (input.profileModelState === 'failed' || profileModelAsymmetry(input.profileModel, input.resolvedModel)) {
    return `서버 기본 모델: ${label} · ${tonePart}`;
  }
  return `모델: ${label} · ${tonePart}`;
}
