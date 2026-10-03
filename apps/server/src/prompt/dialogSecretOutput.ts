import type { DB } from '../db/index.js';
import type { ConversationRow, MessageRow, Scene } from '../types.js';
import { buildActorContext, type ActorContext } from './dialogActorContext.js';
import { loadStoryRoster } from './dialogContext.js';
import { promptPathIds } from './promptHistory.js';
import type { ScriptItem } from './renderDialog.js';
import { parseScript, type SpeakerSlot } from './dialogScript.js';
import { extractChoices } from './templates.js';
import { sanitizeGeneratedContent } from '../contracts/chatEventAdapter.js';

type SecretRule = { memoryId: string; text: string; allowed: Set<string> };

export function secretRulesFromPacket(packet: ActorContext): SecretRule[] {
  const rules = new Map<string, SecretRule>();
  const add = (fact: ActorContext['narrator_facts'][number], actorId?: string) => {
    if (!fact.text.trim()) return;
    let rule = rules.get(fact.memory_id);
    if (!rule) { rule = { memoryId: fact.memory_id, text: fact.text, allowed: new Set() }; rules.set(fact.memory_id, rule); }
    if (actorId) rule.allowed.add(actorId);
  };
  for (const fact of packet.narrator_facts) add(fact);
  for (const actor of packet.actors) for (const fact of actor.facts) add(fact, actor.id);
  return [...rules.values()];
}

export function dialogSecretRules(db: DB, conv: ConversationRow, history: MessageRow[], scene: Scene): SecretRule[] {
  if (scene.dialog_context === undefined) return [];
  // Output checks cannot lose an approved restriction because its input was budget-truncated.
  const assigned = buildActorContext(db, conv, promptPathIds(history), scene.dialog_context,
    loadStoryRoster(db, conv).map(({ id, name }) => ({ id, name })), Number.MAX_SAFE_INTEGER, 1);
  return secretRulesFromPacket(assigned.packet);
}

/** Exact registered memory text only: no claim about paraphrases or narrator knowledge. */
export function secretOutputViolations(items: ScriptItem[], rules: SecretRule[]) {
  return items.flatMap(item => item.kind !== 'line' ? [] : rules
    .filter(rule => !rule.allowed.has(item.character_id) && item.text.includes(rule.text))
    .map(rule => ({ actorId: item.character_id, memoryId: rule.memoryId })));
}

export function scriptSecretViolations(text: string, speakers: SpeakerSlot[], rules: SecretRule[]) {
  const content = sanitizeGeneratedContent(extractChoices(text).content);
  // Check every proposed speaker line, including lines dropped by the display cap.
  return content.split(/\r?\n/).flatMap(line => secretOutputViolations(parseScript(line, speakers).items, rules));
}
