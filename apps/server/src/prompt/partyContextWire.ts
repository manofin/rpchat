import { many, type DB } from '../db/index.js';
import type { CharacterRow, ConversationRow, Scene } from '../types.js';
import { buildPartyContext, renderPartyContextSections, PartyContextOverflowError, type PartyCard } from './partyContext.js';
import { resolveStory } from './resolveStory.js';
import { substitute } from './templates.js';
import { estimateTokens } from './tokens.js';

export { PartyContextOverflowError };
export const PARTY_CONTEXT_SHARE = 0.5;
export type WireSource = {
  storySnapshot: { setting: string; minorCast: string[] };
  cards: Record<string, PartyCard>;
  castIds: string[];
};
export type WireBudget = { inputLimitTokens: number; outputReserveTokens: number; calibration: number };
export type WireDiagnostic = ReturnType<typeof buildPartyContext>['diagnostics'];
export type WireRequest = { pass: string; diagnostics: WireDiagnostic };

/** Match builder.storyCastLine's coercion; raw strings are not cast objects. */
export function wireMinorLine(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as { name?: unknown; note?: unknown };
  const name = String(rec.name ?? '').trim();
  const note = String(rec.note ?? '').trim();
  if (!name && !note) return null;
  return `- ${name}: ${note}`;
}

export function preparePartyContextWire(db: DB, conv: ConversationRow, cast: readonly { id: string; name: string }[],
  userName: string, enabled: boolean): WireSource | null {
  if (!enabled) return null;
  const snapshot = resolveStory(conv);
  if (!snapshot) return null;
  const rows = cast.length ? many<CharacterRow>(db, `SELECT * FROM characters WHERE id IN (${cast.map(() => '?').join(',')})`,
    ...cast.map(c => c.id)) : [];
  const byId = new Map(rows.map(row => [row.id, row]));
  const cards: Record<string, PartyCard> = {};
  for (const actor of cast) {
    const row = byId.get(actor.id);
    cards[actor.id] = {
      name: row?.name ?? actor.name, tagline: row?.tagline ?? '', description: row?.description ?? '',
      personality: row?.personality ?? '', speech_style: row?.speech_style ?? '', taboos: row?.taboos ?? '',
      scenario: substitute(row?.scenario ?? '', row?.name ?? actor.name, userName),
    };
  }
  return {
    storySnapshot: { setting: substitute(snapshot.setting, '', userName),
      minorCast: (Array.isArray(snapshot.minorCast) ? snapshot.minorCast : []).flatMap(item => {
        const line = wireMinorLine(item);
        return line === null ? [] : [substitute(line, '', userName)];
      }) },
    cards, castIds: cast.map(c => c.id),
  };
}

export function wirePresentIds(cast: readonly { id: string }[], scene: Scene): string[] {
  return cast.filter(c => !Array.isArray(scene.present_ids) || scene.present_ids.includes(c.id)).map(c => c.id);
}

export function buildWireBlock(source: WireSource, allowedSpeakerIds: string[], presentIds: string[], budget: WireBudget) {
  const result = buildPartyContext({ storySnapshot: source.storySnapshot, cards: source.cards, allowedSpeakerIds, presentIds,
    sceneState: '', items: [], requestRecipients: ['public'], budget });
  return { block: `## 다대일 공통 맥락\n- 충돌하면 서버 확정 상태 > 현재 장면 > 스토리 설정 > 카드 배경 순으로 따른다.\n\n${renderPartyContextSections(result.sections)}`,
    diagnostics: result.diagnostics };
}

/** Rank the rendered required card fields; ties retain cast order. Build the maximum once. */
export function preflightWire(source: WireSource | null, count: number, budget: WireBudget): void {
  if (!source) return;
  const fields = [['name', '이름'], ['tagline', '한 줄 소개'], ['description', '설명'], ['personality', '성격'],
    ['speech_style', '말투'], ['taboos', '금기'], ['scenario', '배경']] as const;
  const largest = source.castIds.map((id, order) => {
    const text = fields.flatMap(([key, label]) => source.cards[id][key].trim() ? [`${label}: ${source.cards[id][key]}`] : []).join('\n');
    return { id, order, tokens: estimateTokens(`## 허용 화자 카드 [${id}]\n${text}`, budget.calibration) };
  }).sort((a, b) => b.tokens - a.tokens || a.order - b.order).slice(0, count).map(row => row.id);
  buildWireBlock(source, largest, source.castIds, budget);
}

export function wireOverflowBody(error: PartyContextOverflowError) {
  return { error: `스토리 맥락이 입력 한도를 넘어 생성하지 않았습니다 (${error.shortfallTokens}토큰 부족)`,
    code: error.code, shortfall_tokens: error.shortfallTokens };
}

export function wireLog(requests: WireRequest[]) {
  return { enabled: true, share: PARTY_CONTEXT_SHARE, requests };
}
