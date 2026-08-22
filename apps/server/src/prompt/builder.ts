import { type DB, many, one, parseJson, getSetting } from '../db/index.js';
import type {
  BudgetReport, CharacterRow, ChatMessage, ConversationRow, LoreEntryRow, MemoryRow, MessageRow, ModelProfile, PersonaRow, Scene, SummaryRow,
} from '../types.js';
import { estimateTokens, estimateMessageTokens, getCalibration, truncateToTokens } from './tokens.js';
import { loreEntryActive } from './loreMatch.js';
import {
  OOC_INSTRUCTION, STORY_CHOICES_INSTRUCTION, renderCharacter, renderLore, renderMemories, renderPersona, renderRules, renderScene, renderSummary, substitute,
} from './templates.js';

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
const REPLY_MARGIN = 64;
const LORE_SCAN_MESSAGES = 6;

export function isOocMessage(m: MessageRow): boolean {
  return m.role === 'user' && /^\s*[\(\[]\s*ooc\s*[\)\]]/i.test(m.content);
}

export function loadProfile(db: DB, name: string): ModelProfile {
  return (
    one<ModelProfile>(db, 'SELECT * FROM model_profiles WHERE name = ?', name) ??
    one<ModelProfile>(db, 'SELECT * FROM model_profiles WHERE name = ?', 'rp-balanced') ??
    ({ name: 'fallback', model: null, temperature: 0.8, top_p: 0.95, max_tokens: 400, stop_json: '[]', system_mode: 'system', notes: null } as ModelProfile)
  );
}

export function resolvePersona(db: DB, conv: ConversationRow): PersonaRow | null {
  if (conv.persona_id) {
    const p = one<PersonaRow>(db, 'SELECT * FROM personas WHERE id = ?', conv.persona_id);
    if (p) return p;
  }
  return one<PersonaRow>(db, 'SELECT * FROM personas WHERE is_default = 1 ORDER BY created_at LIMIT 1') ?? null;
}

/**
 * 프롬프트 조립 (계획서 4.1 순서):
 * 시스템 규칙 → 캐릭터 카드 → 페르소나 → 장면 → 고정 기억 → 활성 로어 → 요약 → 최근 N개 → 현재 입력
 * history: 현재 활성 분기의 메시지(시간순). 마지막 원소가 현재 사용자 입력이어야 한다(인사 재생성 시 빈 배열).
 */
export function buildPrompt(db: DB, conv: ConversationRow, history: MessageRow[], contextTokens: number, defaultModel: string, profileName?: string): BuiltPrompt {
  const character = one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', conv.character_id);
  if (!character) throw new Error('캐릭터를 찾을 수 없음');
  const persona = resolvePersona(db, conv);
  const profile = loadProfile(db, profileName ?? conv.profile_name);
  const cal = getCalibration(db);
  const contentPolicy = getSetting(db, 'content_policy', '');
  const charName = character.name;
  const userName = persona?.name || '나';
  const mode = conv.mode === 'story' ? 'story' : 'chat';
  const last = history[history.length - 1];
  const isOoc = !!last && isOocMessage(last);

  const available = Math.max(512, contextTokens - profile.max_tokens - REPLY_MARGIN);
  const budgets = {
    fixed: Math.floor(available * SHARE.fixed),
    lore: Math.floor(available * SHARE.lore),
    memory: Math.floor(available * SHARE.memory),
  };
  const sections: BudgetReport['sections'] = [];
  let used = 0;

  // 1) 고정 블록: 규칙 + 캐릭터 + 페르소나 + 장면
  const rules = renderRules(mode, contentPolicy, charName, userName);
  const personaText = renderPersona(persona, charName, userName);
  const sceneText = renderScene(parseJson<Scene>(conv.scene_json, {}));
  let charText = renderCharacter(character, charName, userName, true);
  let fixedEst = estimateTokens([rules, charText, personaText, sceneText ?? ''].join('\n\n'), cal);
  let fixedNote: string | undefined;
  if (fixedEst > budgets.fixed) {
    const withoutEx = renderCharacter(character, charName, userName, false);
    const base = estimateTokens([rules, withoutEx, personaText, sceneText ?? ''].join('\n\n'), cal);
    const room = budgets.fixed - base;
    if (room > 80) {
      charText = renderCharacter(character, charName, userName, true, truncateToTokens(character.example_dialogue, room - 20, cal));
      fixedNote = '예시 대화를 예산에 맞게 잘라 넣음';
    } else {
      charText = withoutEx;
      fixedNote = base > budgets.fixed ? '예시 대화 제외 후에도 고정 블록이 예산 초과 (카드 본문 축약 권장)' : '예시 대화 제외';
    }
    fixedEst = estimateTokens([rules, charText, personaText, sceneText ?? ''].join('\n\n'), cal);
  }
  sections.push({ name: '시스템 규칙+카드+페르소나+장면', est_tokens: fixedEst, budget: budgets.fixed, note: fixedNote });
  used += fixedEst;

  // 2) 활성 로어: 최근 발화 키워드 매칭 (결정론적)
  const scanText = history.slice(-LORE_SCAN_MESSAGES).map((m) => m.content).join('\n').toLowerCase();
  const entries = many<LoreEntryRow>(
    db,
    `SELECT e.* FROM lore_entries e JOIN lorebooks b ON b.id = e.lorebook_id
     WHERE e.enabled = 1 AND (b.character_id = ? OR b.character_id IS NULL)
     ORDER BY e.always_on DESC, e.priority DESC`,
    conv.character_id,
  );
  const activeLore: Array<{ title: string; content: string }> = [];
  const droppedLore: string[] = [];
  let loreEst = 0;
  for (const e of entries) {
    const hit = loreEntryActive({
      always_on: e.always_on,
      keywords: parseJson<string[]>(e.keywords_json, []),
      secondary_keys: parseJson<string[]>(e.secondary_keys_json, []),
      selective: e.selective,
      scanText,
    });
    if (!hit) continue;
    const content = truncateToTokens(e.content, e.token_cap, cal);
    const t = estimateTokens(`- [${e.title}] ${content}`, cal);
    if (loreEst + t > budgets.lore) {
      droppedLore.push(e.title);
      continue;
    }
    activeLore.push({ title: e.title, content });
    loreEst += t;
  }
  const loreText = renderLore(activeLore);
  sections.push({ name: '활성 로어', est_tokens: loreEst, budget: budgets.lore, note: droppedLore.length ? `예산 초과로 제외: ${droppedLore.join(', ')}` : undefined });
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
  let memEst = 0;
  const memCap = Math.floor(budgets.memory * 0.5);
  let droppedMem = 0;
  for (const m of pinned) {
    const t = estimateTokens(`- ${m.content}`, cal);
    if (memEst + t > memCap) {
      droppedMem++;
      continue;
    }
    memItems.push(m.content);
    memEst += t;
  }
  const summaryRow = one<SummaryRow>(
    db,
    `SELECT * FROM summaries WHERE conversation_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 1`,
    conv.id,
  );
  const summaryText = summaryRow ? truncateToTokens(summaryRow.content, budgets.memory - memEst, cal) : null;
  const sumEst = summaryText ? estimateTokens(summaryText, cal) : 0;
  sections.push({
    name: '고정 기억+요약',
    est_tokens: memEst + sumEst,
    budget: budgets.memory,
    note: [droppedMem ? `기억 ${droppedMem}건 예산 초과로 제외` : '', summaryRow ? '' : '승인된 요약 없음'].filter(Boolean).join('; ') || undefined,
  });
  used += memEst + sumEst;

  // 4) 최근 대화: 남은 예산 전부. OOC 쌍은 제외(현재 입력 제외)
  const recentBudget = Math.max(0, available - used);
  const skip = new Set<number>();
  history.forEach((m, i) => {
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
  for (let i = history.length - 1; i >= 0; i--) {
    if (skip.has(i)) continue;
    const m = history[i];
    const t = estimateMessageTokens(m.content, cal);
    if (recent.length > 0 && recentEst + t > recentBudget) {
      dropped++;
      continue;
    }
    recent.unshift(m);
    recentEst += t;
  }
  sections.push({ name: '최근 대화', est_tokens: recentEst, budget: recentBudget, note: dropped ? `오래된 메시지 ${dropped}건 제외` : undefined });
  used += recentEst;

  // 5) 시스템 메시지 합성
  const systemParts = [rules, charText, personaText, sceneText, renderMemories(memItems), loreText, renderSummary(summaryText)].filter((x): x is string => !!x);
  if (isOoc) systemParts.push(OOC_INSTRUCTION);
  else if (mode === 'story') systemParts.push(substitute(STORY_CHOICES_INSTRUCTION, charName, userName));
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
  };

  return { messages, budget, profile, model: profile.model || defaultModel, stop, charName, userName, isOoc };
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
