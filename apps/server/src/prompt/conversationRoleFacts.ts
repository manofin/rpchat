import type { DB } from '../db/index.js';
import { loadRoleEvents } from '../db/roleFacts.js';
import { parseMessageMeta } from '../db/messageMeta.js';
import { getPath } from '../db/tree.js';
import type { ConversationRow } from '../types.js';
import { loadStoryRoster } from './dialogContext.js';
import { reduceRoleFacts, roleFactsForAudience } from './roleFacts.js';

export function conversationRoleState(db: DB, conv: ConversationRow) {
  const path = getPath(db, conv).filter(row => row.status === 'complete');
  const ids = new Set(path.map(row => row.id));
  const roster = loadStoryRoster(db, conv);
  const actorIds = new Set([conv.character_id, ...roster.map(row => row.id)]);
  return reduceRoleFacts(loadRoleEvents(db, conv.id), {
    conversationId: conv.id,
    pathIds: ids,
    visibleIds: ids,
    actorIds,
    speakerByMessage: new Map(path.flatMap(row => {
      const speaker = parseMessageMeta(row.meta_json).speaker_character_id;
      return row.role === 'assistant' && typeof speaker === 'string' ? [[row.id, speaker] as const] : [];
    })),
  });
}

/** Saved INFO is user-visible state, so only explicit accepted decisions appear. */
export function confirmedRolesForInfo(db: DB, conv: ConversationRow): string[] {
  const state = roleFactsForAudience(conversationRoleState(db, conv), 'user');
  return state.facts.filter(fact => fact.status === 'accepted').map(fact => fact.description);
}
