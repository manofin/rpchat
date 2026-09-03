/**
 * f9-focus-eligible — who the turn is aimed at (`Notes_260902_210901.txt` §4.1).
 *
 * The focus is decided by the server. There is no scoring, no model call, and no
 * random fallback: when nothing in the four rules names somebody, the turn has
 * **no focus** and therefore no dialogue slot at all — narration only.
 *
 * That last outcome is the point of this module. The retired router's stage 4
 * ("ambiguous → ask an LLM") and `assignSpeakers`' unconditional fall back to the
 * conversation's main character both encoded "if candidates exist, someone
 * speaks". §2 lists that as the thing to discard, because it is what makes every
 * turn a conversation even when the scene calls for silence.
 *
 * Pure: no DB, no fetch, no model. Deterministic.
 */
import { canSpeak, type CastMember } from './cast.js';
import type { PartyCatalog } from './applySceneDelta.js';
import type { Scene } from '../types.js';

export type FocusReason =
  | 'targeted'        // 1. the user named them
  | 'unresolved'      // 2. they were left hanging last beat
  | 'default_focus'   // 3. the location's default
  | 'conversation_partner' // 3b. the character this chat was opened as
  | 'none';           // 4. nobody — narration-only beat

export type FocusResult = {
  focus_id: string | null;
  reason: FocusReason;
  /** Ids that matched the user's text. 2+ means ambiguity, which yields no focus. */
  matched_ids: string[];
};

/**
 * Korean particles stripped before an exact name match, so "나리가" and "나리에게"
 * both resolve to 나리 without turning the match into a substring search (which
 * would let 세라 match inside 세라핌).
 */
const PARTICLES = [
  '에게서', '한테서', '이라고', '라고', '에게', '한테', '께서', '이랑', '하고',
  '은', '는', '이', '가', '을', '를', '와', '과', '랑', '아', '야', '의', '도', '만', '께',
];

/** §4.1-3 second person. Only ever *confirms* the previous focus, never creates one. */
const SECOND_PERSON = ['너', '넌', '네가', '니가', '당신', '그대', '자네'];

/** Includes `*` so ST-style stage directions (`*나리의 귓가에 속삭이며*`) still name-match. */
const TOKEN_SPLIT = /[\s,.!?;:"'()[\]{}<>~…·「」『』“”‘’*\-—]+/u;

function stripParticle(token: string): string {
  for (const p of PARTICLES) {
    if (token.length > p.length && token.endsWith(p)) return token.slice(0, -p.length);
  }
  return token;
}

/** Every surface form of the user's message that could be a name. */
function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(TOKEN_SPLIT)) {
    const token = raw.trim();
    if (!token) continue;
    out.add(token);
    const bare = token.startsWith('@') ? token.slice(1) : token;
    if (bare) {
      out.add(bare);
      out.add(stripParticle(bare));
    }
    out.add(stripParticle(token));
  }
  out.delete('');
  return out;
}

/**
 * §4.1-1. Exact match on id, name or alias — never a substring. An `@` prefix is
 * accepted but not required, so both "@나리" and "나리, 왜?" target 나리.
 */
export function targetedIds(text: string, cast: CastMember[]): string[] {
  if (!text) return [];
  const tokens = tokensOf(text);
  const hits: string[] = [];
  for (const m of cast) {
    if (!canSpeak(m)) continue;
    const forms = [m.id, m.name, ...(m.aliases ?? [])].filter((f) => f);
    if (forms.some((f) => tokens.has(f)) && !hits.includes(m.id)) hits.push(m.id);
  }
  return hits;
}

/**
 * ST/Risu stage directions sit in *asterisks*. A name there is who the user
 * aimed at; a name in the spoken remainder is often a topic ("나리 씨랑 친해질게"
 * while facing 하연). Concatenate every well-formed *span*; unmatched stars
 * contribute nothing.
 */
export function actionDirectionText(text: string): string {
  if (!text || !text.includes('*')) return '';
  const spans: string[] = [];
  const re = /\*([^*\n]+)\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) spans.push(m[1]);
  return spans.join(' ');
}

/** True when the message uses second person as a standalone token. */
export function usesSecondPerson(text: string): boolean {
  if (!text) return false;
  const tokens = tokensOf(text);
  return SECOND_PERSON.some((p) => tokens.has(p));
}

function presentIds(scene: Scene): string[] | null {
  return Array.isArray(scene.present_ids) ? scene.present_ids : null;
}

/** A candidate must exist, be able to speak, be unlocked, and be in the room. */
function selectable(id: string, cast: CastMember[], scene: Scene): boolean {
  const m = cast.find((c) => c.id === id);
  if (!m || !canSpeak(m) || m.locked) return false;
  const present = presentIds(scene);
  return present ? present.includes(id) : true;
}

function result(focus_id: string | null, reason: FocusReason, matched: string[]): FocusResult {
  return { focus_id, reason, matched_ids: matched };
}

/**
 * §4.1 priority. The first rule that yields a single selectable character wins;
 * nothing falls through to chance.
 *
 *   1. the user aimed at someone (@ / name / alias, or second person + last focus)
 *   2. the party left unresolved by the previous beat
 *   3. the location's declared default focus
 *   3b. the character this chat was opened as, when they can speak here
 *   4. otherwise: no focus, no dialogue slot
 *
 * Ambiguity is silence, not a coin flip: when the message names two present
 * characters, rule 1 yields nobody rather than picking one. This is the single
 * line that keeps "모호하면 LLM" from creeping back in.
 */
export function resolveFocus(input: {
  user_text: string;
  scene: Scene;
  cast: CastMember[];
  catalog?: Pick<PartyCatalog, 'places'>;
  /** Character id this conversation was opened as. Not ST-Natural random. */
  main_character_id?: string | null;
}): FocusResult {
  const { scene, cast } = input;
  const text = input.user_text ?? '';

  // 1. explicit targeting.
  //
  // Rules 1-3 each either yield a focus or pass to the next: an *unusable*
  // candidate (absent, locked, background) is not a decision, so naming someone
  // who is not in the room lets the location's default answer instead of putting
  // words in an absent character's mouth.
  //
  // Genuine ambiguity is the exception and stops here rather than falling
  // through. Two people in the room were both addressed; picking one would be a
  // guess, and guessing is the behaviour this module exists to remove.
  const named = targetedIds(text, cast).filter((id) => selectable(id, cast, scene));
  const aimed = targetedIds(actionDirectionText(text), cast).filter((id) => selectable(id, cast, scene));
  // A single name inside *stage direction* is the aim, even if speech mentions
  // someone else. Two names inside the direction stay ambiguous. No direction
  // (or no name in it) keeps the whole-message rule.
  if (aimed.length === 1) return result(aimed[0], 'targeted', aimed);
  if (aimed.length > 1) return result(null, 'none', aimed);
  if (named.length === 1) return result(named[0], 'targeted', named);
  if (named.length > 1) return result(null, 'none', named);

  const lastFocus = scene.last_beat?.focus_id ?? null;

  // 1b. second person with no name: only ever re-confirms the standing focus.
  // With no previous focus it creates nothing — a pronoun is not an introduction.
  if (usesSecondPerson(text) && lastFocus && selectable(lastFocus, cast, scene)) {
    return result(lastFocus, 'targeted', [lastFocus]);
  }

  // 2. whoever the previous beat left hanging
  const unresolved = (scene.last_beat?.unresolved ?? []).filter((id) => selectable(id, cast, scene));
  if (unresolved.length === 1) return result(unresolved[0], 'unresolved', []);
  if (unresolved.length > 1) return result(null, 'none', []);

  // 3. the location's default focus
  const here = scene.location ?? scene.place ?? '';
  const place = here ? (input.catalog?.places ?? []).find((p) => p.id === here) : undefined;
  const fallback = place?.default_focus;
  if (fallback && selectable(fallback, cast, scene)) {
    return result(fallback, 'default_focus', []);
  }

  // 3b. this chat's partner. Opening a 서리 conversation and saying 안녕하세요
  // is talking to 서리 — not a random draw, and not assignSpeakers stuffing
  // main in after a null focus.
  const partner = input.main_character_id ?? null;
  if (partner && selectable(partner, cast, scene)) {
    return result(partner, 'conversation_partner', []);
  }

  // 4. narration only
  return result(null, 'none', []);
}
