/**
 * Isolated 1–3 stage speaker router for Bench-A.
 * Not apps/server/src/prompt/cast.ts (that is F9C).
 * Stage 4 = no unique 1–3 decision. Does not call a model (Bench-Latency / F9C).
 * DB query 0. Live generate 0.
 */
import type { CastMember, RouterInput, RouterOutput } from './types.ts';

function speaking(cast: CastMember[]): CastMember[] {
  return cast.filter((c) => c.role !== 'background');
}

function mentioned(text: string, m: CastMember): boolean {
  if (m.name && text.includes(m.name)) return true;
  return m.aliases.some((a) => a.length > 0 && text.includes(a));
}

function dutyHit(text: string, m: CastMember): boolean {
  return m.duties.some((d) => d.length > 0 && text.includes(d));
}

function scoresFor(winnerId: string, cast: CastMember[]): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const c of cast) {
    if (c.id === winnerId) scores[c.id] = 95;
    else if (c.role === 'background') scores[c.id] = 0;
    else scores[c.id] = 20;
  }
  return scores;
}

function decide(stage: 1 | 2 | 3, winnerId: string, cast: CastMember[]): RouterOutput {
  return {
    decided_stage: stage,
    scores: scoresFor(winnerId, cast),
    main_speaker_id: winnerId,
    llm_reached: false,
  };
}

export function pickSpeaker(input: RouterInput): RouterOutput {
  const text = input.user_text;
  const active = speaking(input.cast);

  const named = active.filter((m) => mentioned(text, m));
  if (named.length === 1) return decide(1, named[0].id, input.cast);

  const duty = active.filter((m) => dutyHit(text, m));
  if (duty.length === 1) return decide(2, duty[0].id, input.cast);

  const place = input.scene.place ?? '';
  const atPlace = place ? active.filter((m) => m.place === place) : [];
  if (atPlace.length === 1) return decide(3, atPlace[0].id, input.cast);

  const zeros: Record<string, number> = {};
  for (const c of input.cast) zeros[c.id] = 0;
  return {
    decided_stage: 4,
    scores: zeros,
    main_speaker_id: null,
    llm_reached: true,
  };
}
