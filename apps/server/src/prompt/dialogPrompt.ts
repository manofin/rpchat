import { type DB, many } from '../db/index.js';
import { parseMessageMeta } from '../db/messageMeta.js';
import type { BudgetReport, ChatMessage, ConversationRow, MessageRow, SummaryRow } from '../types.js';
import { computeStoryInjection, isOocMessage, loadProfile, mergeConsecutive, resolvePersona } from './builder.js';
import { selectContext } from './contextSelection.js';
import { effectiveCompactionEndIndex, resolveWatermarkIndex } from './compaction.js';
import { attachInjectToIcPass, type InjectContext } from './injectContext.js';
import { profileInstructionText } from './promptPolicy.js';
import { resolveStory } from './resolveStory.js';
import { extractChoices, renderPersona, renderProfileInstruction } from './templates.js';
import { sanitizeGeneratedContent } from '../contracts/chatEventAdapter.js';
import { estimateMessageTokens, estimateTokens, getCalibration, truncateToTokens } from './tokens.js';

export const DIALOG_MAX_TOKENS = 900;
const REPLY_MARGIN = 64;
const SHARE = { fixed: 0.25, lore: 0.15, memory: 0.15 };

function fitText(text: string, cap: number, cal: number): string {
  if (cap <= 0) return '';
  let fitted = text;
  let target = cap;
  while (estimateTokens(fitted, cal) > cap && target > 0) fitted = truncateToTokens(text, --target, cal);
  return estimateTokens(fitted, cal) <= cap ? fitted : '';
}

/** Roles remain adapter roles; INFO/UI, thoughts and choice drafts never become conversation text. */
export function dialogHistory(db: DB, history: MessageRow[]): MessageRow[] {
  const names = new Map(many<{ id: string; name: string }>(db, 'SELECT id, name FROM characters').map((r) => [r.id, r.name]));
  const out: MessageRow[] = [];
  let skipAssistant = false;
  for (const m of history) {
    if (m.role === 'user') {
      skipAssistant = isOocMessage(m);
      if (!skipAssistant && m.content.trim()) out.push(m);
      continue;
    }
    if (skipAssistant) continue;
    const meta = parseMessageMeta(m.meta_json);
    if (meta.block_kind && !['line', 'narration'].includes(meta.block_kind)) continue;
    const content = extractChoices(sanitizeGeneratedContent(m.content)).content.trim();
    if (!content) continue;
    const name = meta.speaker_name || (meta.speaker_character_id ? names.get(meta.speaker_character_id) : undefined);
    out.push({ ...m, content: name ? `${name} | ${content}` : content });
  }
  return out;
}

/** Pass S owns its output contract; only selection policy is shared with 1:1. */
export function buildDialogPrompt(db: DB, conv: ConversationRow, history: MessageRow[], passS: string, userText: string,
  contextTokens: number, model: string, inject: InjectContext = { instruction: null }) {
  const profile = loadProfile(db, conv.profile_name);
  const cal = getCalibration(db);
  const persona = resolvePersona(db, conv);
  const userName = persona?.name || '나';
  const instruction = profileInstructionText(profile);
  const profileBlock = instruction ? renderProfileInstruction(instruction, '## 서술 지침', '', userName) : null;
  // Attach uses the existing party hook; final role/message overhead is counted below.
  const mandatory = attachInjectToIcPass(passS, inject.instruction, {
    promptTokenBudget: Number.MAX_SAFE_INTEGER, calibration: cal, profileInstruction: profileBlock,
  }).prompt;
  const current: ChatMessage = { role: 'user', content: userText.trim() ? userText : '(장면을 이어서 진행한다.)' };
  const available = Math.max(0, contextTokens - DIALOG_MAX_TOKENS - REPLY_MARGIN);
  const mandatoryEst = estimateMessageTokens(mandatory, cal) + estimateMessageTokens(current.content, cal);
  const room = Math.max(0, available - mandatoryEst - 16);
  const fixedCap = Math.floor(room * SHARE.fixed);
  const loreCap = Math.floor(room * SHARE.lore);
  const memoryCap = Math.floor(room * SHARE.memory);
  const sections: BudgetReport['sections'] = [{ name: '대본 규칙+화자+현재 장면+현재 입력', kind: 'system', est_tokens: mandatoryEst, budget: available }];
  const personaRaw = renderPersona(persona, '', userName) ?? '';
  const personaText = fitText(personaRaw, fixedCap, cal);
  const noteRaw = conv.user_note?.trim() ? `### 유저노트\n${conv.user_note.trim()}` : '';
  const noteText = estimateTokens([personaText, noteRaw].filter(Boolean).join('\n\n'), cal) <= fixedCap ? noteRaw : '';
  const staticPrefix = [personaText, noteText].filter(Boolean).join('\n\n');
  const storyRoom = Math.max(0, fixedCap - estimateTokens(staticPrefix, cal) - 4);
  const resolvedStory = resolveStory(conv);
  let storyCap = storyRoom;
  let story = computeStoryInjection(resolvedStory, storyCap, 0, cal, '', userName);
  while (story && story.estTokens > storyRoom && storyCap > 0) {
    storyCap = Math.max(0, storyCap - (story.estTokens - storyRoom));
    story = computeStoryInjection(resolvedStory, storyCap, 0, cal, '', userName);
  }
  const storyText = story && story.estTokens <= storyRoom ? story.text : '';
  const staticText = [staticPrefix, storyText].filter(Boolean).join('\n\n');
  sections.push({ name: '페르소나+유저노트+스토리 설정', kind: 'story', est_tokens: estimateTokens(staticText, cal), budget: fixedCap,
    note: [personaText !== personaRaw ? '페르소나 절단' : '', noteRaw && !noteText ? '유저노트 제외' : '', story?.note ?? ''].filter(Boolean).join('; ') || undefined });
  const currentRow = history.at(-1)?.role === 'user' ? history.at(-1)! : null;
  const filtered = dialogHistory(db, currentRow ? history.slice(0, -1) : history);
  // Current input also participates in lore matching, including OOC (party IC policy unchanged).
  const scanHistory = currentRow ? [...filtered, { ...currentRow, content: userText }] : filtered;
  const selected = selectContext(db, conv, scanHistory, { lore: loreCap, memory: memoryCap }, cal,
    { pathIds: new Set(history.map((m) => m.id)), branchScoped: true, strictBudget: true });
  sections.push(...selected.sections.map((s) => ({ ...s, budget: s.kind === 'lore' ? loreCap : memoryCap })));
  const system = [mandatory, staticText, ...selected.parts].filter(Boolean).join('\n\n');
  const compactEnd = effectiveCompactionEndIndex(resolveWatermarkIndex(history,
    many<SummaryRow>(db, 'SELECT * FROM summaries WHERE conversation_id = ?', conv.id), conv.id), history.length);
  const compactIds = new Set(compactEnd == null ? [] : history.slice(0, compactEnd + 1).map((m) => m.id));
  const candidates = filtered.filter((m) => !compactIds.has(m.id));
  const recentBudget = Math.max(0, available - estimateMessageTokens(system, cal) - estimateMessageTokens(current.content, cal));
  const recent: MessageRow[] = [];
  let recentEst = 0;
  let dropped = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const row = candidates[i];
    const cost = estimateMessageTokens(row.content, cal);
    if (recentEst + cost > recentBudget) { dropped++; continue; }
    recent.unshift(row);
    recentEst += cost;
  }
  const assemble = (): ChatMessage[] => {
    const turns = mergeConsecutive([...recent.map(({ role, content }) => ({ role, content })), current]);
    if (turns[0].role === 'assistant') turns.unshift({ role: 'user', content: '(이전 장면)' });
    return [{ role: 'system', content: system }, ...turns];
  };
  let messages = assemble();
  const cost = () => messages.reduce((sum, m) => sum + estimateMessageTokens(m.content, cal), 0);
  while (cost() > available && recent.length) {
    recent.shift();
    dropped++;
    messages = assemble();
  }
  recentEst = recent.reduce((sum, m) => sum + estimateMessageTokens(m.content, cal), 0);
  sections.push({ name: '최근 대화', kind: 'recent', est_tokens: recentEst, budget: recentBudget, note: dropped ? `메시지 ${dropped}건 예산 초과로 제외` : undefined });
  const estTotal = cost();
  const budget: BudgetReport = {
    context_tokens: contextTokens, reply_reserve: DIALOG_MAX_TOKENS + REPLY_MARGIN, available, calibration: cal,
    sections, est_total: estTotal, included_messages: recent.length + (currentRow ? 1 : 0), dropped_messages: dropped,
    active_lore: selected.activeLore.map((r) => r.title), dropped_lore: selected.droppedLore,
    included_memories: selected.memItems, dropped_memories: selected.droppedMemItems, summary_used: !!selected.summaryText,
    summary_preview: selected.summaryText?.slice(0, 160) ?? null, recent_from_id: recent[0]?.id ?? currentRow?.id ?? null,
    recent_to_id: currentRow?.id ?? recent.at(-1)?.id ?? null, diagnostics: selected.diagnostics,
  };
  if (estTotal > available) budget.instruction_overflow = {
    profile: profile.name, instruction_tokens: profileBlock ? estimateTokens(profileBlock, cal) : 0, required: estTotal, available,
  };
  return { messages, budget, profile, model, stop: [], isOoc: false as const };
}
