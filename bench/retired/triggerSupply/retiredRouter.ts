// PROD_IMPORT_FORBIDDEN — frozen evidence for a closed measurement.
// Nothing under apps/** may import this file. See bench/retiredFreeze.test.ts.
/**
 * Frozen copy of the retired product router `apps/server/src/prompt/pickSpeaker.ts`,
 * as it stood when the `f9-trigger-supply` measurements were run (2026-09-02).
 *
 * f9-focus-eligible deleted that module: the beat contract replaces scoring and
 * the stage-4 LLM fallback with a server-decided focus. The measurements in this
 * directory are closed and their results are on disk, so re-pointing them at the
 * new resolver would make the scripts report numbers that no longer match the
 * recorded run. Freezing the old code here keeps the closed measurement
 * reproducible without giving the retired router a second life in product code.
 *
 * Do not import this from apps/**. Do not "fix" it to match the beat contract.
 */

export type CastRole = 'main' | 'secondary' | 'background';

export type CastMember = {
  id: string;
  name: string;
  aliases: string[];
  duties: string[];
  place: string;
  home_places?: string[];
  role: CastRole;
};

export type RouterScene = { place?: string; location?: string };
export type RouterInput = { user_text: string; scene: RouterScene; cast: CastMember[] };
export type RouterOutput = {
  scores: Record<string, number>;
  decided_stage: 1 | 2 | 3 | 4;
  main_speaker_id: string | null;
  llm_reached: boolean;
};

const WIN = 95;
const OTHER = 20;

function mentioned(m: CastMember, text: string): boolean {
  if (m.name && text.includes(m.name)) return true;
  return m.aliases.some((a) => a.length > 0 && text.includes(a));
}

function dutyHit(m: CastMember, text: string): boolean {
  return m.duties.some((d) => d.length > 0 && text.includes(d));
}

function scenePlace(scene: RouterScene): string {
  const loc = scene.location?.trim() ?? '';
  if (loc) return loc;
  return scene.place?.trim() ?? '';
}

function zeros(cast: CastMember[]): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const m of cast) scores[m.id] = 0;
  return scores;
}

function winScores(cast: CastMember[], winnerId: string): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const m of cast) {
    if (m.id === winnerId) scores[m.id] = WIN;
    else if (m.role === 'background') scores[m.id] = 0;
    else scores[m.id] = OTHER;
  }
  return scores;
}

function decide(stage: 1 | 2 | 3, winnerId: string, cast: CastMember[]): RouterOutput {
  return { scores: winScores(cast, winnerId), decided_stage: stage, main_speaker_id: winnerId, llm_reached: false };
}

export function pickSpeaker(input: RouterInput): RouterOutput {
  const speaking = input.cast.filter((m) => m.role !== 'background');

  const named = speaking.filter((m) => mentioned(m, input.user_text));
  if (named.length === 1) return decide(1, named[0].id, input.cast);

  const byDuty = speaking.filter((m) => dutyHit(m, input.user_text));
  if (byDuty.length === 1) return decide(2, byDuty[0].id, input.cast);

  const place = scenePlace(input.scene);
  const atPlace = place ? speaking.filter((m) => m.place === place) : [];
  if (atPlace.length === 1) return decide(3, atPlace[0].id, input.cast);

  return { scores: zeros(input.cast), decided_stage: 4, main_speaker_id: null, llm_reached: true };
}
