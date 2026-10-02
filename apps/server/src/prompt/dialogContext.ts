import { type DB, getSetting, many, one } from '../db/index.js';
import type { CharacterRow, ConversationRow, Scene } from '../types.js';
import { resolvePersona } from './builder.js';
import { storyCastForGenerate } from './composeBeat.js';
import type { DialogPlanInput } from './composeDialog.js';
import { parseParticipantSnapshot } from './resolveFocus.js';
import { catalogFromStory } from './sceneCatalog.js';
import { currentSceneVersion } from './sceneDeltaPrompt.js';
import type { PartyTagRow } from './tagsCatalog.js';
import type { PassCard } from './passes.js';

export function loadStoryRoster(db: DB, conv: ConversationRow): PartyTagRow[] {
  const snapshot = parseParticipantSnapshot(conv.story_participant_ids_snapshot);
  if (snapshot && snapshot.length) {
    const rows = many<PartyTagRow>(db,
      `SELECT id, name, tags_json FROM characters WHERE archived = 0 AND id IN (${snapshot.map(() => '?').join(',')})`, ...snapshot);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return snapshot.map((id) => byId.get(id)).filter((r): r is PartyTagRow => Boolean(r));
  }
  if (!conv.story_id) return [];
  return many<PartyTagRow>(db,
    `SELECT c.id, c.name, c.tags_json FROM story_characters sc JOIN characters c ON c.id = sc.character_id
      WHERE sc.story_id = ? ORDER BY sc.sort_order ASC, c.name ASC`, conv.story_id);
}

export function dialogPlanInput(db: DB, conv: ConversationRow, scene: Scene, userText: string, seed: string | null, patch?: unknown): DialogPlanInput | null {
  const roster = loadStoryRoster(db, conv);
  const cast = storyCastForGenerate(conv, roster);
  if (!cast?.length) return null;
  const cards: Record<string, PassCard> = {};
  for (const row of many<CharacterRow>(db, `SELECT * FROM characters WHERE id IN (${roster.map(() => '?').join(',')})`, ...roster.map((r) => r.id))) {
    cards[row.id] = { name: row.name, tagline: row.tagline, description: row.description, personality: row.personality, speech_style: row.speech_style, taboos: row.taboos };
  }
  const story = one<{ scene_catalog: string }>(db, 'SELECT scene_catalog FROM stories WHERE id = ?', conv.story_id);
  return {
    conversation_id: conv.id, scene, patch, catalog: catalogFromStory(story?.scene_catalog ?? '{}'),
    current_version: currentSceneVersion(scene), user_text: userText, user_name: resolvePersona(db, conv)?.name || '나',
    cast, cards, main_character_id: conv.character_id, message_id: seed,
    content_policy: getSetting(db, 'content_policy', ''), story_room: Boolean(conv.story_id),
    participant_ids: parseParticipantSnapshot(conv.story_participant_ids_snapshot), separate_user_input: true,
  };
}

export function supportsPartyObservation(db: DB, conv: ConversationRow): boolean {
  return Boolean(storyCastForGenerate(conv, loadStoryRoster(db, conv)));
}
