import { createHash } from 'node:crypto';
import { type DB, many, one, parseJson, getSetting } from '../db/index.js';
import { parseMessageMeta } from '../db/messageMeta.js';
import type {
  BudgetReport, CharacterRow, ChatMessage, ConversationRow, InstructionOverflow, LoreEntryRow, MemoryRow, MessageRow, ModelProfile, PersonaRow, Scene, SummaryRow,
} from '../types.js';
import { estimateTokens, estimateMessageTokens, getCalibration, truncateToTokens } from './tokens.js';
import { loreEntryMatch } from './loreMatch.js';
import { MIN_EPISODE_TOKENS, SCENE_RECENT_GUARD, allocateSummaryBudget } from './summaryBudget.js';
import { effectiveCompactionEndIndex, resolveWatermarkIndex } from './compaction.js';
import { allocateUserContextBudget } from './userContextBudget.js';
import {
  DEFAULT_HEADER_POLICY, OOC_INSTRUCTION, STORY_CHOICES_INSTRUCTION, renderCharacter, renderEpisode, renderLore, renderMemories, renderPersona, renderProfileInstruction, renderRules, renderScene, renderState, renderStory, renderSummary, substitute,
} from './templates.js';
import { DEFAULT_PROMPT_POLICY, resolvePromptPolicy } from './promptPolicy.js';
import { resolveStory } from './resolveStory.js';
import { resolveOpening } from './storyOpening.js';
import type { InjectContext } from './injectContext.js';

export interface BuiltPrompt {
  messages: ChatMessage[];
  budget: BudgetReport;
  profile: ModelProfile;
  model: string;
  stop: string[];
  charName: string;
  userName: string;
  isOoc: boolean;
}

const SHARE = { fixed: 0.25, lore: 0.15, memory: 0.15 }; // 나머지(45%+여분)는 최근 대화
export const STORY_SETTING_SHARE = 0.7;
export const STORY_CAST_SHARE = 0.3;
const REPLY_MARGIN = 64;
/** 서술 지침이 available 의 이 비율을 넘으면 예산 note 에 경고(잘라 넣지는 않는다). */
export const PROFILE_INSTRUCTION_WARN_SHARE = 0.2;
const LORE_SCAN_MESSAGES = 6;

function storyCastLine(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as { name?: unknown; note?: unknown };
  const name = String(rec.name ?? '').trim();
  const note = String(rec.note ?? '').trim();
  if (!name && !note) return null;
  return `- ${name}: ${note}`;
}

export interface StoryInjection {
  text: string;
  estTokens: number;
  storyRoom: number;
  note?: string;
}

/**
 * 스토리 스냅샷 → 주입 텍스트/예산 계산 (순수 함수, DB 접근 0).
 * fixed 잔여(fixedBudget - fixedEst) 안에서: setting 0.7 truncate → 조연 잔여 prefix whole-or-drop.
 * buildPrompt §1b에서 추출 — story-inject-refactor, 로직/상수/순서 불변.
 */
export function computeStoryInjection(
  resolvedStory: { name: string; setting: string; minorCast: unknown[] } | null,
  fixedBudget: number,
  fixedEst: number,
  cal: number,
  charName: string,
  userName: string,
): StoryInjection | null {
  if (!resolvedStory) return null;
  const settingRaw = (resolvedStory.setting ?? '').trim();
  const castItems = Array.isArray(resolvedStory.minorCast) ? resolvedStory.minorCast : [];
  const hasSetting = !!settingRaw;
  const hasCast = castItems.some((it) => storyCastLine(it));
  const storyRoom = Math.max(0, fixedBudget - fixedEst);
  const settingCap = hasSetting && hasCast
    ? Math.floor(storyRoom * STORY_SETTING_SHARE)
    : hasSetting ? storyRoom : 0;
  const reservedCast = hasSetting && hasCast
    ? Math.floor(storyRoom * STORY_CAST_SHARE)
    : hasCast ? storyRoom : 0;
  let settingUsed = '';
  let settingTruncated = false;
  if (hasSetting) {
    if (settingCap <= 0) settingTruncated = true;
    else {
      settingUsed = truncateToTokens(settingRaw, settingCap, cal);
      settingTruncated = settingUsed !== settingRaw;
    }
  }
  const settingTokens = settingUsed ? estimateTokens(`### 스토리 설정\n${settingUsed}`, cal) : 0;
  const castRoom = hasCast ? Math.max(reservedCast, Math.max(0, storyRoom - settingTokens)) : 0;
  const includedCast: unknown[] = [];
  let droppedCast = 0;
  if (hasCast) {
    let usedCast = 0;
    let dropping = false;
    for (const item of castItems) {
      const line = storyCastLine(item);
      if (!line) continue;
      if (dropping) { droppedCast++; continue; }
      const t = estimateTokens(line, cal);
      if (usedCast + t > castRoom) {
        dropping = true;
        droppedCast++;
        continue;
      }
      includedCast.push(item);
      usedCast += t;
    }
  }
  const storyText = renderStory({ setting: settingUsed, minorCast: includedCast }, charName, userName);
  if (!storyText) return null;
  const storyEst = estimateTokens(storyText, cal);
  const notes: string[] = [];
  if (settingTruncated) notes.push('절단');
  if (droppedCast) notes.push(`조연 ${droppedCast}건 제외`);
  return { text: storyText, estTokens: storyEst, storyRoom, note: notes.length ? notes.join(', ') : undefined };
}

export function isOocMessage(m: MessageRow): boolean {
  return m.role === 'user' && /^\s*[\(\[]\s*ooc\s*[\)\]]/i.test(m.content);
}

export function loadProfile(db: DB, name: string): ModelProfile {
  return (
    one<ModelProfile>(db, 'SELECT * FROM model_profiles WHERE name = ?', name) ??
    one<ModelProfile>(db, 'SELECT * FROM model_profiles WHERE name = ?', 'rp-balanced') ??
    ({ name: 'fallback', model: null, temperature: 0.8, top_p: 0.95, max_tokens: 400, stop_json: '[]', system_mode: 'system', notes: null, instruction_enabled: 0, instruction_text: null } as ModelProfile)
  );
}

export function resolvePersona(db: DB, conv: ConversationRow): PersonaRow | null {
  // snapshot lock: applied_at non-null → frozen snapshot wins; live row is only the catalog pointer.
  if ((conv as any).persona_applied_at) {
    return {
      id: conv.persona_id ?? '',
      name: (conv as any).persona_name_snapshot ?? '나',
      address_as: (conv as any).persona_address_snapshot,
      appearance: (conv as any).persona_appearance_snapshot,
      personality: (conv as any).persona_personality_snapshot,
      relationship: (conv as any).persona_relationship_snapshot,
      is_default: 0,
      created_at: '',
      updated_at: '',
    } as PersonaRow;
  }
  if (conv.persona_id) {
    const p = one<PersonaRow>(db, 'SELECT * FROM personas WHERE id = ?', conv.persona_id);
    if (p) return p;
  }
  return one<PersonaRow>(db, 'SELECT * FROM personas WHERE is_default = 1 ORDER BY created_at LIMIT 1') ?? null;
}

/**
 * ADR §5 OR-by-union episode candidate SQL (prod path — never a single naive OR).
 * UNION (not UNION ALL) dedupes dual-match rows before ORDER BY / LIMIT.
 * NULL persona → rel_persona_id IS NULL bucket (never = NULL).
 */
export function episodeRelationInjectParts(personaId: string | null): {
  convSql: string;
  relSql: string;
  unionSql: string;
  querySql: string;
} {
  const convSql =
    `SELECT * FROM summaries WHERE conversation_id = ? AND tier = 'episode' AND status = 'approved'`;
  const relSql =
    personaId == null
      ? `SELECT * FROM summaries WHERE tier = 'episode' AND status = 'approved' AND rel_character_id = ? AND rel_persona_id IS NULL`
      : `SELECT * FROM summaries WHERE tier = 'episode' AND status = 'approved' AND rel_character_id = ? AND rel_persona_id = ?`;
  const unionSql = `${convSql} UNION ${relSql}`;
  return {
    convSql,
    relSql,
    unionSql,
    querySql: `${unionSql} ORDER BY created_at DESC LIMIT 5`,
  };
}

export function episodeRelationInjectBinds(
  conv: Pick<ConversationRow, 'id' | 'character_id' | 'persona_id'>,
): unknown[] {
  if (conv.persona_id == null) return [conv.id, conv.character_id];
  return [conv.id, conv.character_id, conv.persona_id];
}

/** Episode candidates for inject: conversation branch ∪ relation branch, deduped. */
export function loadApprovedEpisodeCandidates(
  db: DB,
  conv: Pick<ConversationRow, 'id' | 'character_id' | 'persona_id'>,
): SummaryRow[] {
  const { querySql } = episodeRelationInjectParts(conv.persona_id);
  return many<SummaryRow>(db, querySql, ...episodeRelationInjectBinds(conv));
}


/** Recent-turn kinds that are echo fuel for 1:1 (raw BeatUi JSON / header / thought). */
const ECHO_BLOCK_KINDS = new Set(['ui', 'header', 'thought']);

export function isEchoFuelMessage(m: Pick<MessageRow, 'meta_json'>): boolean {
  const kind = parseMessageMeta(m.meta_json).block_kind;
  return !!kind && ECHO_BLOCK_KINDS.has(kind);
}

/**
 * Natural-language stand-in for the latest `ui` block so party/room awareness
 * survives after raw BeatUi JSON is dropped from recent turns.
 */
export function partyContextFromHistory(history: Array<Pick<MessageRow, 'content' | 'meta_json'>>): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const meta = parseMessageMeta(history[i].meta_json);
    if (meta.block_kind !== 'ui') continue;
    try {
      const ui = JSON.parse(history[i].content) as {
        location_badge?: string | null;
        intent_hint?: string | null;
        roster?: Array<{ name?: string; in_room?: boolean; locked?: boolean }>;
      };
      if (!ui || typeof ui !== 'object') continue;
      const lines: string[] = [];
      if (ui.location_badge) lines.push(`장소: ${ui.location_badge}`);
      for (const r of ui.roster ?? []) {
        const name = String(r.name ?? '').trim();
        if (!name) continue;
        const where = r.in_room === false ? '자리 비움' : '방 안';
        const lock = r.locked ? ', 잠김' : '';
        lines.push(`- ${name} (${where}${lock})`);
      }
      if (ui.intent_hint) lines.push(`힌트: ${ui.intent_hint}`);
      if (!lines.length) continue;
      return `### 현재 장면·파티\n${lines.join('\n')}`;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 프롬프트 조립 (계획서 4.1 순서):
 * 시스템 규칙 → 캐릭터 카드 → 페르소나 → 장면 → 고정 기억 → 활성 로어 → 요약 → 최근 N개 → 현재 입력
 * history: 현재 활성 분기의 메시지(시간순). 마지막 원소가 현재 사용자 입력이어야 한다(인사 재생성 시 빈 배열).
 */

export function buildPrompt(db: DB, conv: ConversationRow, history: MessageRow[], contextTokens: number, defaultModel: string, profileName?: string, opts?: { diagnostics?: boolean; inject?: InjectContext }): BuiltPrompt {
  const character = one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', conv.character_id);
  if (!character) throw new Error('캐릭터를 찾을 수 없음');
  const persona = resolvePersona(db, conv);
  const profile = loadProfile(db, profileName ?? conv.profile_name);
  const cal = getCalibration(db);
  const contentPolicy = getSetting(db, 'content_policy', '');
  const charName = character.name;
  const userName = persona?.name || '나';
  const last = history[history.length - 1];
  const isOoc = !!last && isOocMessage(last);
  // PromptPolicy: OOC 턴은 항상 기본 정책(지침 미주입) — OOC 프롬프트는 프로필과 무관하게 바이트 불변.
  const policy = isOoc ? DEFAULT_PROMPT_POLICY : resolvePromptPolicy(profile);
  // 브랜치 스코프 가드: 스와이프/재생성으로 갈라진 다른 가지에서 만든 요약이 현재 경로로 새지 않도록,
  // covers_until_message_id 가 현재 활성 경로(history)에 실제로 있는 것만 후보로 인정한다.
  const pathIds = new Set(history.map((m) => m.id));

  const available = Math.max(512, contextTokens - profile.max_tokens - REPLY_MARGIN);
  const budgets = {
    fixed: Math.floor(available * SHARE.fixed),
    lore: Math.floor(available * SHARE.lore),
    memory: Math.floor(available * SHARE.memory),
  };
  const sections: BudgetReport['sections'] = [];
  let used = 0;

  // 1) 고정 블록: 규칙 + 캐릭터 + 페르소나 + 장면 + 유저노트
  const rules = renderRules(contentPolicy, charName, userName, DEFAULT_HEADER_POLICY, policy);
  const personaText = renderPersona(persona, charName, userName);
  const sceneText = renderScene(parseJson<Scene>(conv.scene_json, {}));
  // user_note: persona 다음 순위. 고정 블록 잔여분만 주입 (userContextBudget 정책, whole-or-nothing).
  const noteRaw = (conv.user_note ?? '').trim();
  const noteText = noteRaw ? `### 유저노트\n${noteRaw}` : null;
  const estFixed = (char: string, note: boolean) =>
    estimateTokens([rules, char, personaText, sceneText ?? '', note && noteText ? noteText : ''].join('\n\n'), cal);
  // ADR-F8d 3-A: story opening.scenario replaces the card scenario; they are not merged.
  const opening = isOoc ? null : resolveOpening(conv);
  const openingScenario = (opening?.scenario ?? '').trim();
  const cardForPrompt = openingScenario ? { ...character, scenario: openingScenario } : character;
  let charText = renderCharacter(cardForPrompt, charName, userName, true);
  let noteIncluded = true;
  let fixedEst = estFixed(charText, noteIncluded);
  let fixedNote: string | undefined;
  if (fixedEst > budgets.fixed) {
    const withoutEx = renderCharacter(cardForPrompt, charName, userName, false);
    const room = budgets.fixed - estFixed(withoutEx, true);
    if (room > 80) {
      charText = renderCharacter(cardForPrompt, charName, userName, true, truncateToTokens(character.example_dialogue, room - 20, cal));
      fixedNote = '예시 대화를 예산에 맞게 잘라 넣음';
    } else {
      charText = withoutEx;
      if (noteText) {
        const coreNoNote = estFixed(withoutEx, false);
        const noteCost = estFixed(withoutEx, true) - coreNoNote;
        const alloc = allocateUserContextBudget({
          totalBudget: budgets.fixed,
          profileTokens: coreNoNote,
          noteTokens: noteCost,
          profileCap: null,
          noteCap: null,
        });
        // helper models truncation; a note must be whole-or-nothing
        noteIncluded = alloc.noteIncluded && alloc.noteTokensUsed >= noteCost;
      }
      fixedEst = estFixed(withoutEx, noteIncluded);
      if (fixedEst > budgets.fixed) fixedNote = '예시 대화 제외 후에도 고정 블록이 예산 초과 (카드 본문 축약 권장)';
      else if (!noteIncluded && noteText) fixedNote = '유저노트 제외';
      else fixedNote = '예시 대화 제외';
    }
    if (noteIncluded) fixedEst = estFixed(charText, true);
  }
  sections.push({ name: '시스템 규칙+카드+페르소나+장면', est_tokens: fixedEst, budget: budgets.fixed, note: fixedNote, kind: 'system' });
  used += fixedEst;

  // 1a) 프로필 서술 지침: 고정·로어·기억 예산은 그대로 두고 used 에 먼저 넣어 최근 대화만 줄인다
  // (inject 와 같은 방식). 잘라 넣지 않는다. 지침이 없으면 섹션도 없다.
  const instructionRaw = policy.includeEngineInstruction ? (profile.instruction_text ?? '') : '';
  const profileInstructionText = instructionRaw ? renderProfileInstruction(instructionRaw, '### 서술 지침', charName, userName) : null;
  let instructionSection: BudgetReport['sections'][number] | null = null;
  if (profileInstructionText) {
    const est = estimateTokens(profileInstructionText, cal);
    const notes = [`프로필 ${profile.name}`, `sha256 ${createHash('sha256').update(instructionRaw).digest('hex').slice(0, 8)}`];
    if (est > Math.floor(available * PROFILE_INSTRUCTION_WARN_SHARE)) notes.push(`예산의 ${Math.round((est / available) * 100)}% — LITE 권장`);
    instructionSection = { name: '서술 지침', est_tokens: est, budget: est, note: notes.join(' · '), kind: 'system' };
    sections.push(instructionSection);
    used += est;
  }

  // 1b) 스토리 스냅샷: fixed 잔여. setting 0.7 truncate → 조연 잔여 prefix whole-or-drop. 라이브 stories 조회 없음.
  const resolvedStory = isOoc ? null : resolveStory(conv);
  const storyInjection = computeStoryInjection(resolvedStory, budgets.fixed, fixedEst, cal, charName, userName);
  const storyText: string | null = storyInjection ? storyInjection.text : null;
  if (storyInjection) {
    sections.push({ name: '스토리 설정', est_tokens: storyInjection.estTokens, budget: storyInjection.storyRoom, note: storyInjection.note, kind: 'story' });
    used += storyInjection.estTokens;
  }

  // 2) 활성 로어: 최근 발화 키워드 매칭 (결정론적)
  //
  // story-editor-tabs A8: candidate set = 전역(character_id IS NULL AND story_id
  // IS NULL) + 캐릭터 + 이 방의 story_id와 일치하는 스토리 로어북. A story
  // lorebook only ever exists with story_id set (lorebookForStory in
  // routes/stories.ts is its only writer), so `conv.story_id` NULL (every 1:1
  // room, and every pre-A8 conversation) makes `b.story_id = ?` never match and
  // leaves the global clause exactly as it read before this slice — byte-identical
  // candidate set, byte-identical assembled prompt.
  const scanText = history.slice(-LORE_SCAN_MESSAGES).map((m) => m.content).join('\n').toLowerCase();
  const entries = many<LoreEntryRow>(
    db,
    `SELECT e.* FROM lore_entries e JOIN lorebooks b ON b.id = e.lorebook_id
     WHERE e.enabled = 1 AND (
       b.character_id = ?
       OR (b.character_id IS NULL AND b.story_id IS NULL)
       OR b.story_id = ?
     )
     ORDER BY e.always_on DESC, e.priority DESC`,
    conv.character_id,
    conv.story_id,
  );
  const activeLore: Array<{ title: string; content: string }> = [];
  const droppedLore: string[] = [];
  const loreDiag: NonNullable<BudgetReport['diagnostics']>['lore'] = [];
  let loreEst = 0;
  for (const e of entries) {
    const match = loreEntryMatch({
      always_on: e.always_on,
      keywords: parseJson<string[]>(e.keywords_json, []),
      secondary_keys: parseJson<string[]>(e.secondary_keys_json, []),
      selective: e.selective,
      scanText,
    });
    if (!match.hit) {
      loreDiag.push({ title: e.title, alwaysOn: !!e.always_on, matched: match.matched, tokens: 0, included: false, status: 'no-match' });
      continue;
    }
    const content = truncateToTokens(e.content, e.token_cap, cal);
    const t = estimateTokens(`- [${e.title}] ${content}`, cal);
    const included = loreEst + t <= budgets.lore;
    loreDiag.push({ title: e.title, alwaysOn: !!e.always_on, matched: match.matched, tokens: t, included, status: included ? 'active' : 'dropped-budget' });
    if (!included) {
      droppedLore.push(e.title);
      continue;
    }
    activeLore.push({ title: e.title, content });
    loreEst += t;
  }
  const loreText = renderLore(activeLore);
  sections.push({ name: '활성 로어', est_tokens: loreEst, budget: budgets.lore, note: droppedLore.length ? `예산 초과로 제외: ${droppedLore.join(', ')}` : undefined, kind: 'lore' });
  used += loreEst;

  // 3) 고정 기억 + 요약
  const pinned = many<MemoryRow>(
    db,
    `SELECT * FROM memories WHERE status = 'pinned'
       AND ((scope = 'conversation' AND conversation_id = ?) OR (scope = 'character' AND character_id = ?))
     ORDER BY importance DESC, created_at ASC`,
    conv.id, conv.character_id,
  );
  const memItems: string[] = [];
  const droppedMemItems: string[] = [];
  const memDiag: NonNullable<BudgetReport['diagnostics']>['memories'] = [];
  let memEst = 0;
  const memCap = Math.floor(budgets.memory * 0.5);
  for (const m of pinned) {
    const t = estimateTokens(`- ${m.content}`, cal);
    if (memEst + t > memCap) {
      droppedMemItems.push(m.content);
      memDiag.push({ content: m.content, status: 'dropped-budget', importance: m.importance, tokens: t });
      continue;
    }
    memItems.push(m.content);
    memEst += t;
    memDiag.push({ content: m.content, status: 'included', importance: m.importance, tokens: t });
  }
  const summaryRow = pickOnPath(
    many<SummaryRow>(db, `SELECT * FROM summaries WHERE conversation_id = ? AND tier = 'whole' AND status = 'approved' ORDER BY created_at DESC LIMIT 5`, conv.id),
    pathIds,
  );
  const stateRow = pickOnPath(
    many<SummaryRow>(db, `SELECT * FROM summaries WHERE conversation_id = ? AND tier = 'state' AND status = 'approved' ORDER BY created_at DESC LIMIT 5`, conv.id),
    pathIds,
  );
  const sumBudget = Math.max(0, budgets.memory - memEst);
  const stateCap = Math.min(200, sumBudget);
  const stateRendered = renderState(stateRow?.content ?? null);
  const stateCore = stateRendered ? truncateToTokens(stateRendered, stateCap, cal) : null;
  const stateUnknownConstraint = '※ 현재 상태에 행방불명·미해결·미상으로 기재된 사실은 임의로 원인이나 주체를 지어내지 않고 알 수 없는 상태로 유지한다.';
  const stateText = stateCore ? `${stateCore}\n\n${stateUnknownConstraint}` : null;
  const stateEst = stateText ? estimateTokens(stateText, cal) : 0;
  // recentGuard 를 episode/scene 공용으로 먼저 정의 (상수는 summaryBudget.ts에서)
  const recentGuardIds = new Set(history.slice(-SCENE_RECENT_GUARD).map((m) => m.id));
  // episode: 최신 approved 1건, 예약(상태 후 잔여의 35%), recentGuard 적용
  const afterState = Math.max(0, sumBudget - stateEst);
  const episodeRow = pickEpisodeCandidate(
    loadApprovedEpisodeCandidates(db, conv),
    pathIds,
    conv.id,
  );
  let episodeText: string | null = null;
  let episodeEst = 0;
  if (episodeRow) {
    // 헬퍼로 cap/채택 판정(35% 예약 + MIN_EPISODE_TOKENS + recentGuard)을 계산하고,
    // 실측(truncate/estimateTokens)은 기존 경로 그대로 유지한다.
    const renderedFull = renderEpisode(episodeRow.content);
    const allocEp = allocateSummaryBudget({
      sumBudget,
      stateEst,
      episodeContentTokens: renderedFull ? estimateTokens(renderedFull, cal) : 0,
      wholeContentTokens: 0,
      episodeCoversUntil: episodeRow.covers_until_message_id,
      recentGuardIds: [...recentGuardIds],
    });
    if (allocEp.episodeUsed) {
      const truncated = renderedFull ? truncateToTokens(renderedFull, allocEp.episodeCap, cal) : null;
      const truncatedEst = truncated ? estimateTokens(truncated, cal) : 0;
      if (truncated && truncatedEst >= MIN_EPISODE_TOKENS) { episodeText = truncated; episodeEst = truncatedEst; }
    }
  }
  // whole: 상태·episode 예약 후 잔여
  const summaryText = summaryRow ? truncateToTokens(summaryRow.content, Math.max(0, sumBudget - stateEst - episodeEst), cal) : null;
  const wholeEstOnly = summaryText ? estimateTokens(summaryText, cal) : 0;
  let sceneBudget = Math.max(0, sumBudget - stateEst - episodeEst - wholeEstOnly);
  const sceneParts: string[] = [];
  let sceneEst = 0;
  if (sceneBudget > 0) {
    const scenes = many<SummaryRow>(db,
      `SELECT * FROM summaries WHERE conversation_id = ? AND tier = 'scene' AND status = 'approved'
         AND (rolled_up_into IS NULL OR rolled_up_into NOT IN (SELECT id FROM summaries WHERE tier = 'episode' AND status = 'approved'))
       ORDER BY created_at DESC`,
      conv.id);
    // 헬퍼로 개별 장면 채택(recentGuard/pathIds/rollup 제외/최대 2/예산 break)을 계산한다.
    const approvedEpisodeIds = new Set(
      many<{ id: string }>(db, `SELECT id FROM summaries WHERE conversation_id = ? AND tier = 'episode' AND status = 'approved'`, conv.id).map((r) => r.id),
    );
    const sceneAlloc = allocateSummaryBudget({
      sumBudget: sceneBudget,
      stateEst: 0,
      episodeContentTokens: 0,
      wholeContentTokens: 0,
      recentGuardIds: [...recentGuardIds],
      pathIds: [...pathIds],
      approvedEpisodeIds: [...approvedEpisodeIds],
      scenes: scenes.map((sc) => {
        const tok = estimateTokens(`- ${sc.content}`, cal);
        return { id: sc.id, tokens: tok, coversUntil: sc.covers_until_message_id, rolledUpInto: sc.rolled_up_into };
      }),
    });
    const byId = new Map(scenes.map((sc) => [sc.id, sc]));
    for (const used of sceneAlloc.scenesUsed) {
      const sc = byId.get(used.id);
      if (!sc) continue;
      sceneParts.push(sc.content);
      sceneEst += used.tokens;
    }
  }
  const sceneTierText = sceneParts.length ? `### 최근 장면\n${sceneParts.map((c) => `- ${c}`).join('\n')}` : null;
  const summaries: NonNullable<BudgetReport['diagnostics']>['summaries'] = [];
  summaries.push({ tier: 'state', used: !!stateText, tokens: stateEst, note: stateText ? undefined : (stateRow ? '예산 부족' : '승인된 상태 없음') });
  summaries.push({ tier: 'whole', used: !!summaryText, tokens: wholeEstOnly, note: summaryText ? undefined : (summaryRow ? '예산 부족' : '승인된 요약 없음') });
  summaries.push({ tier: 'scene', used: sceneParts.length > 0, tokens: sceneEst, note: sceneParts.length ? undefined : '해당 장면 없음/제외' });
  summaries.push({ tier: 'episode', used: !!episodeText, tokens: episodeEst, note: episodeText ? undefined : (episodeRow ? '예산 부족/최근창' : '승인된 에피소드 없음') });
  const sumEst = wholeEstOnly + stateEst + sceneEst + episodeEst;
  sections.push({
    name: '고정 기억+요약',
    est_tokens: memEst + sumEst,
    budget: budgets.memory,
    note: [droppedMemItems.length ? `기억 ${droppedMemItems.length}건 예산 초과로 제외` : '', stateText ? 'state 포함' : (stateRow ? 'state 예산 부족' : '승인된 상태 없음'), summaryRow ? '' : '승인된 요약 없음', episodeText ? 'episode 포함' : '', sceneParts.length ? `장면 ${sceneParts.length}` : ''].filter(Boolean).join('; ') || undefined,
    // 기억과 4계층 요약이 한 예산(budgets.memory)을 나눠 쓰는 단일 섹션 — 'summary' 는 아직 별도로 나오지 않는다.
    kind: 'memory',
  });
  used += memEst + sumEst;

  // 3b) inject-macro-1to1: per-turn instruction (non-OOC only). Count into used
  // before recentBudget so pressure shrinks recent — never silent-truncate the instruction.
  const injectText = (!isOoc && opts?.inject?.instruction) ? opts.inject.instruction : null;
  let injectEst = 0;
  if (injectText) {
    injectEst = estimateTokens(injectText, cal);
    sections.push({ name: '주입 지침', est_tokens: injectEst, budget: injectEst, kind: 'system' });
    used += injectEst;
  }

  // The choices contract is appended to the system message below. Reserve it
  // before packing recent turns when a profile instruction is active.
  const choicesText = isOoc ? null : substitute(STORY_CHOICES_INSTRUCTION, charName, userName);
  if (instructionSection && choicesText) {
    const choicesEst = estimateTokens(choicesText, cal);
    sections.push({ name: '선택지 출력 계약', est_tokens: choicesEst, budget: choicesEst, kind: 'system' });
    used += choicesEst;
  }

  // 3c) 지침 초과 판정: 지침을 넣고 나면 현재 턴조차 실제 한도에 못 들어가면 보고한다(잘라 넣지 않는다).
  // 생성 경로는 이 보고로 모델 호출 전에 거부한다. 지침이 없는 턴은 판정하지 않는다(기존 동작 불변).
  // 한도는 `available`(REPLY_MARGIN 까지 뺀 패킹 예산)이 아니라 context − max_tokens 다. 최근 대화
  // 패킹은 available 을 몇 토큰 차이로 채우고, 제목·구분자·메시지당 여유분이 그 위에 얹히므로
  // available 로 판정하면 긴 대화의 평범한 턴이 거부된다(P0, 300메시지 40건 중 38건).
  const hardLimit = contextTokens - profile.max_tokens;
  let instructionOverflow: InstructionOverflow | undefined;
  if (instructionSection) {
    const currentTurn = last?.role === 'user' && last.content.trim()
      ? last.content
      : substitute(last ? '(장면을 이어서 {{char}}의 차례로 진행한다.)' : '첫 장면을 {{char}}의 인사로 시작한다.', charName, userName);
    const required = used + estimateMessageTokens(currentTurn, cal);
    if (required > hardLimit) {
      instructionOverflow = { profile: profile.name, instruction_tokens: instructionSection.est_tokens, required, available: hardLimit };
      instructionSection.note = `${instructionSection.note} · 컨텍스트 초과 — 생성 거부`;
    }
  }

  // 4) 최근 대화: 남은 예산 전부. OOC 쌍은 제외(현재 입력 제외)
  const recentBudget = Math.max(0, available - used);
  const skip = new Set<number>();
  history.forEach((m, i) => {
    // empty-turn: 내용 없는 user 행은 모델 입력에서 뺀다. inject-only 단축어는
    // routes/chat.ts 의 POST messages/branch 에서 content='' 인 user 행을 complete 로
    // 남기는데, 그 행이 그대로 턴이 되면 모델은 "사용자가 아무 말도 하지 않았다"를
    // 입력으로 받는다(라이브에서 "무반응/무시"로 서사에 반영된 적이 있다). 지침은
    // system 블록의 inject 로 이미 전달되므로 이 행에는 옮길 내용이 없다.
    // 마지막 인덱스(현재 턴)도 예외로 두지 않는다 — 오염이 생기는 자리가 바로
    // 현재 턴이다. 비워진 끝자리는 아래 "마지막이 user 가 아니면" 폴백이 기존
    // 문구로 메운다. 새 문구를 만들지 않는다.
    if (m.role === 'user' && !m.content.trim()) skip.add(i);
    if (i === history.length - 1) return;
    if (isOocMessage(m)) {
      skip.add(i);
      if (history[i + 1]?.role === 'assistant' && i + 1 !== history.length - 1) skip.add(i + 1);
    }
    if ((m.status === 'streaming' || m.status === 'error') && !m.content.trim()) skip.add(i);
  });
  const recent: MessageRow[] = [];
  let recentEst = 0;
  let dropped = 0;
  // 승인 요약이 덮은 구간은 최근 창 후보에서 제외한다. dropped_messages 는
  // 컴팩션·보호선 적용 뒤에 토큰 예산에 못 들어간 메시지만 센다.
  const compactEnd = effectiveCompactionEndIndex(
    resolveWatermarkIndex(
      history,
      many<SummaryRow>(db, `SELECT * FROM summaries WHERE conversation_id = ?`, conv.id),
      conv.id,
    ),
    history.length,
  );
  for (let i = history.length - 1; i >= 0; i--) {
    if (skip.has(i)) continue;
    if (compactEnd != null && i <= compactEnd) continue;
    const m = history[i];
    // leak-choices-ui: never feed raw ui/header/thought blocks into recent turns (echo fuel).
    if (isEchoFuelMessage(m)) continue;
    const t = estimateMessageTokens(m.content, cal);
    if (recent.length > 0 && recentEst + t > recentBudget) {
      dropped++;
      continue;
    }
    recent.unshift(m);
    recentEst += t;
  }
  sections.push({ name: '최근 대화', est_tokens: recentEst, budget: recentBudget, note: dropped ? `오래된 메시지 ${dropped}건 제외` : undefined, kind: 'recent' });
  used += recentEst;

  // 5) 시스템 메시지 합성
  const partyCtx = partyContextFromHistory(history);
  const systemParts = [rules, profileInstructionText, charText, personaText, noteIncluded ? noteText : null, sceneText, partyCtx, storyText, renderMemories(memItems), stateText, renderSummary(summaryText), episodeText, sceneTierText, loreText].filter((x): x is string => !!x);
  if (isOoc) systemParts.push(OOC_INSTRUCTION);
  else {
    // Order: choices first, then inject (both coexist when inject present).
    systemParts.push(choicesText!);
    if (injectText) systemParts.push(injectText);
  }
  const systemText = systemParts.join('\n\n');

  let turns: ChatMessage[] = recent.map((m) => ({ role: m.role, content: m.content }));
  if (turns.length === 0) turns.push({ role: 'user', content: substitute('첫 장면을 {{char}}의 인사로 시작한다.', charName, userName) });
  else if (turns[turns.length - 1].role !== 'user') turns.push({ role: 'user', content: substitute('(장면을 이어서 {{char}}의 차례로 진행한다.)', charName, userName) });
  turns = mergeConsecutive(turns);

  let messages: ChatMessage[];
  if (profile.system_mode === 'merge') {
    if (turns[0].role !== 'user') turns.unshift({ role: 'user', content: '(장면을 시작한다.)' });
    turns[0] = { role: 'user', content: `${systemText}\n\n---\n\n${turns[0].content}` };
    messages = turns;
  } else {
    messages = [{ role: 'system', content: systemText }, ...turns];
  }

  // Joined system blocks and merge-mode wrappers also consume tokens. The
  // inspector still receives the prompt; generation rejects this report.
  if (instructionSection) {
    const finalRequired = messages.reduce((sum, message) => sum + estimateMessageTokens(message.content, cal), 0);
    if (finalRequired > hardLimit && (!instructionOverflow || finalRequired > instructionOverflow.required)) {
      instructionOverflow = { profile: profile.name, instruction_tokens: instructionSection.est_tokens, required: finalRequired, available: hardLimit };
      if (!instructionSection.note?.includes('컨텍스트 초과')) instructionSection.note = `${instructionSection.note} · 컨텍스트 초과 — 생성 거부`;
    }
  }

  const stop = uniq([`\n${userName}:`, `\n${userName} :`, ...parseJson<string[]>(profile.stop_json, [])]).slice(0, 4);

  const budget: BudgetReport = {
    context_tokens: contextTokens,
    reply_reserve: profile.max_tokens + REPLY_MARGIN,
    available,
    calibration: cal,
    sections,
    est_total: used,
    dropped_messages: dropped,
    included_messages: recent.length,
    active_lore: activeLore.map((e) => e.title),
    dropped_lore: droppedLore,
    included_memories: memItems,
    dropped_memories: droppedMemItems,
    summary_used: !!summaryText,
    summary_preview: summaryText ? summaryText.slice(0, 160) : null,
    recent_from_id: recent[0]?.id ?? null,
    recent_to_id: recent[recent.length - 1]?.id ?? null,
  };
  if (opts?.diagnostics) {
    budget.diagnostics = { lore: loreDiag, memories: memDiag, summaries };
  }
  if (instructionOverflow) budget.instruction_overflow = instructionOverflow;

  return { messages, budget, profile, model: profile.model || defaultModel, stop, charName, userName, isOoc };
}

/** 후보(created_at DESC로 정렬된) 중 현재 활성 경로에 실제로 있는 첫 건. 다른 가지에서 만든 요약을 걸러낸다. */
function pickOnPath(rows: SummaryRow[], pathIds: Set<string>): SummaryRow | null {
  return rows.find((r) => !r.covers_until_message_id || pathIds.has(r.covers_until_message_id)) ?? null;
}

/**
 * Episode pick: same-conversation rows keep branch path guard;
 * other-conversation relation rows are eligible without local pathIds
 * (covers_* belong to the source room).
 */
function pickEpisodeCandidate(
  rows: SummaryRow[],
  pathIds: Set<string>,
  convId: string,
): SummaryRow | null {
  return (
    rows.find((r) => {
      if (r.conversation_id !== convId) return true;
      return !r.covers_until_message_id || pathIds.has(r.covers_until_message_id);
    }) ?? null
  );
}

function mergeConsecutive(turns: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const t of turns) {
    const prev = out[out.length - 1];
    if (prev && prev.role === t.role) prev.content = `${prev.content}\n\n${t.content}`;
    else out.push({ ...t });
  }
  return out;
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim()))];
}
