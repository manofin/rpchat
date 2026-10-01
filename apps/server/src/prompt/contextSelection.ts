import { type DB, many, one, parseJson } from '../db/index.js';
import type { BudgetReport, ConversationRow, LoreEntryRow, MemoryRow, MessageRow, SummaryRow } from '../types.js';
import { getPath } from '../db/tree.js';
import { estimateTokens, truncateToTokens } from './tokens.js';
import { loreEntryMatch } from './loreMatch.js';
import { MIN_EPISODE_TOKENS, SCENE_RECENT_GUARD, allocateSummaryBudget } from './summaryBudget.js';
import { renderEpisode, renderLore, renderMemories, renderState, renderSummary } from './templates.js';
const LORE_SCAN_MESSAGES = 6;
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


export interface SelectedContext {
  sections: BudgetReport['sections']; used: number; memoryParts: string[]; loreText: string | null; parts: (string | null)[];
  activeLore: Array<{ title: string; content: string }>; droppedLore: string[]; memItems: string[]; droppedMemItems: string[];
  summaryText: string | null; diagnostics: NonNullable<BudgetReport['diagnostics']>;
  /** Complete summary bodies that survived final rendered-budget selection. */
  compactionSummaries: SummaryRow[];
}

export function selectContext(db: DB, conv: ConversationRow, history: MessageRow[], budgets: { lore: number; memory: number }, cal: number, opts?: { pathIds?: Set<string>; branchScoped?: boolean; strictBudget?: boolean }): SelectedContext {
  const pathIds = opts?.pathIds ?? new Set(history.map((m) => m.id));
  const sections: BudgetReport['sections'] = [];
  const sourcePaths = new Map<string, Set<string>>([[conv.id, pathIds]]);
  const sourcePath = (id: string) => {
    let ids = sourcePaths.get(id);
    if (!ids) {
      const source = one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', id);
      ids = new Set(source ? getPath(db, source).map((m) => m.id) : []);
      sourcePaths.set(id, ids);
    }
    return ids;
  };
  const onBranch = (rows: SummaryRow[]) => opts?.branchScoped
    ? rows.filter((r) => {
      const ids = sourcePath(r.conversation_id);
      return (!r.covers_from_message_id || ids.has(r.covers_from_message_id)) && (!r.covers_until_message_id || ids.has(r.covers_until_message_id));
    }) : rows;
  // Dialog limits eligible candidates, so newer sibling rows cannot starve an active summary.
  const localSummaryCandidates = (tier: 'whole' | 'state') => {
    const query = tier === 'whole'
      ? `SELECT * FROM summaries WHERE conversation_id = ? AND tier = 'whole' AND status = 'approved' ORDER BY created_at DESC LIMIT 5`
      : `SELECT * FROM summaries WHERE conversation_id = ? AND tier = 'state' AND status = 'approved' ORDER BY created_at DESC LIMIT 5`;
    return onBranch(many<SummaryRow>(db, opts?.branchScoped ? query.replace(' LIMIT 5', '') : query, conv.id)).slice(0, 5);
  };
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
    if (opts?.branchScoped) {
      const evidence = parseJson<unknown>(m.evidence_message_ids_json, []);
      if (!Array.isArray(evidence) || evidence.some((id) => typeof id !== 'string')) continue;
      if (evidence.some((id) => {
        const source = one<{ conversation_id: string }>(db, 'SELECT conversation_id FROM messages WHERE id = ?', id);
        return !source || !sourcePath(source.conversation_id).has(id);
      })) continue;
    }
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
    localSummaryCandidates('whole'),
    pathIds,
  );
  const stateRow = pickOnPath(
    localSummaryCandidates('state'),
    pathIds,
  );
  const sumBudget = Math.max(0, budgets.memory - memEst);
  const stateCap = Math.min(200, sumBudget);
  const stateRendered = renderState(stateRow?.content ?? null);
  const stateCore = stateRendered && (!opts?.strictBudget || stateCap > 0) ? truncateToTokens(stateRendered, stateCap, cal) : null;
  const stateUnknownConstraint = '※ 현재 상태에 행방불명·미해결·미상으로 기재된 사실은 임의로 원인이나 주체를 지어내지 않고 알 수 없는 상태로 유지한다.';
  const stateText = stateCore ? `${stateCore}\n\n${stateUnknownConstraint}` : null;
  const stateEst = stateText ? estimateTokens(stateText, cal) : 0;
  // recentGuard 를 episode/scene 공용으로 먼저 정의 (상수는 summaryBudget.ts에서)
  const recentGuardIds = new Set(history.slice(-SCENE_RECENT_GUARD).map((m) => m.id));
  // episode: 최신 approved 1건, 예약(상태 후 잔여의 35%), recentGuard 적용
  const episodeRow = pickEpisodeCandidate(
    onBranch(opts?.branchScoped
      ? many<SummaryRow>(db, `${episodeRelationInjectParts(conv.persona_id).unionSql} ORDER BY created_at DESC`, ...episodeRelationInjectBinds(conv))
      : loadApprovedEpisodeCandidates(db, conv)).slice(0, 5),
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
  const wholeCap = Math.max(0, sumBudget - stateEst - episodeEst);
  const summaryText = summaryRow && (!opts?.strictBudget || wholeCap > 0) ? truncateToTokens(summaryRow.content, wholeCap, cal) : null;
  const wholeEstOnly = summaryText ? estimateTokens(summaryText, cal) : 0;
  let sceneBudget = Math.max(0, sumBudget - stateEst - episodeEst - wholeEstOnly);
  const sceneParts: string[] = [];
  const sceneRows: SummaryRow[] = [];
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
      scenes: onBranch(scenes).map((sc) => {
        const tok = estimateTokens(`- ${sc.content}`, cal);
        return { id: sc.id, tokens: tok, coversUntil: sc.covers_until_message_id, rolledUpInto: sc.rolled_up_into };
      }),
    });
    const byId = new Map(scenes.map((sc) => [sc.id, sc]));
    for (const used of sceneAlloc.scenesUsed) {
      const sc = byId.get(used.id);
      if (!sc) continue;
      sceneParts.push(sc.content);
      sceneRows.push(sc);
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

  const memoryParts = [renderMemories(memItems), stateText, renderSummary(summaryText), episodeText, sceneTierText].filter((x): x is string => !!x);
  if (opts?.strictBudget) {
    const memoryCost = estimateTokens(memoryParts.join('\n\n'), cal);
    const loreCost = estimateTokens(loreText ?? '', cal);
    if (memoryCost > budgets.memory || loreCost > budgets.lore) {
      return selectContext(db, conv, history, {
        memory: Math.max(0, budgets.memory - Math.max(0, memoryCost - budgets.memory)),
        lore: Math.max(0, budgets.lore - Math.max(0, loreCost - budgets.lore)),
      }, cal, opts);
    }
    sections[0].est_tokens = loreCost;
    sections[1].est_tokens = memoryCost;
  }
  return { sections, used: sections.reduce((sum, s) => sum + s.est_tokens, 0),
    memoryParts, loreText,
    parts: [...memoryParts, loreText],
    activeLore, droppedLore, memItems, droppedMemItems, summaryText,
    compactionSummaries: [
      ...(stateRow && stateText && stateCore === stateRendered ? [stateRow] : []),
      ...(summaryRow && summaryText && summaryText === summaryRow.content ? [summaryRow] : []),
      ...(episodeRow && episodeText && episodeText === renderEpisode(episodeRow.content) ? [episodeRow] : []),
      ...sceneRows,
    ],
    diagnostics: { lore: loreDiag, memories: memDiag, summaries },
  };
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
