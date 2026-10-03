import { z } from 'zod';
import { audienceSchema, type Audience } from './observation.js';

const id = z.string().min(1).max(100);
const status = z.enum(['proposed', 'accepted', 'rejected']);
const base = {
  id, proposal_id: id, conversation_id: id, anchor_message_id: id,
  expected_version: z.number().int().min(0), recorded_by: id,
};
const registration = z.object({ ...base, action: z.literal('register'), proposal: z.object({
  kind: z.enum(['proposal', 'role']), subject_id: id, description: z.string().min(1).max(1000),
  proposed_by: id, source_message_ids: z.array(id).min(1).max(12), audience: audienceSchema,
}).strict() }).strict();
const decision = z.object({ ...base, action: z.enum(['accept', 'reject', 'withdraw_acceptance']), decision_by: id }).strict();
const assertion = z.object({ ...base, action: z.literal('record_claim'), speaker_id: id,
  source_message_id: id, claimed_status: status }).strict();
export const roleEventSchema = z.union([registration, decision, assertion]);
export type RoleEvent = z.infer<typeof roleEventSchema>;
export type RoleStatus = z.infer<typeof status>;
export type RoleFact = {
  id: string; kind: 'proposal' | 'role'; subject_id: string; description: string; proposed_by: string;
  status: RoleStatus; version: number; decision_by: string | null; last_decision: 'accept' | 'reject' | 'withdraw_acceptance' | null;
  audience: Audience; evidence_ids: string[];
};
export type RoleConflict = {
  proposal_id: string; speaker_id: string; source_message_id: string;
  claimed_status: RoleStatus; actual_status_at_claim: RoleStatus;
};
export type RoleFactsContext = {
  conversationId: string; pathIds: ReadonlySet<string>; visibleIds: ReadonlySet<string>;
  actorIds: ReadonlySet<string>; speakerByMessage: ReadonlyMap<string, string>;
};

/** Only authenticated, human-confirmed server records belong here, never model JSON.
 * Stage 1 takes a supplied fixture/provider; this module does not persist or infer events. */
export function reduceRoleFacts(raw: readonly unknown[], ctx: RoleFactsContext) {
  if (raw.length > 256) throw new Error('Too many role events');
  const facts = new Map<string, RoleFact>();
  const conflicts: RoleConflict[] = [];
  const seen = new Map<string, string>();
  const offBranch = new Set<string>();
  const entity = (value: string) => value === 'user' || ctx.actorIds.has(value);
  for (const input of raw) {
    const event = roleEventSchema.parse(input);
    if (event.conversation_id !== ctx.conversationId) throw new Error('Foreign role event');
    const encoded = JSON.stringify(event);
    if (seen.has(event.id)) {
      if (seen.get(event.id) !== encoded) throw new Error('Role event id collision');
      continue;
    }
    seen.set(event.id, encoded);
    if (!ctx.pathIds.has(event.anchor_message_id)) {
      if (event.action === 'register') offBranch.add(event.proposal_id);
      continue;
    }
    if (event.action === 'register') {
      const p = event.proposal;
      if (!p.source_message_ids.every(id => ctx.pathIds.has(id))) { offBranch.add(event.proposal_id); continue; }
      if (facts.has(event.proposal_id) || event.expected_version !== 0) throw new Error('Role registration version mismatch');
      if (!entity(p.subject_id) || !entity(p.proposed_by)) throw new Error('Unknown role actor');
      if (p.audience.visibility === 'private' && [...p.audience.recipient_ids, ...p.audience.observer_ids].some(id => !entity(id) && id !== 'gm')) throw new Error('Unknown role audience');
      facts.set(event.proposal_id, { id: event.proposal_id, kind: p.kind, subject_id: p.subject_id,
        description: p.description, proposed_by: p.proposed_by, status: 'proposed', version: 1,
        decision_by: null, last_decision: null, audience: p.audience,
        evidence_ids: [...new Set([event.anchor_message_id, ...p.source_message_ids])] });
      continue;
    }
    const fact = facts.get(event.proposal_id);
    if (!fact && offBranch.has(event.proposal_id)) continue;
    if (!fact || fact.version !== event.expected_version) throw new Error('Role event version mismatch');
    if (event.action === 'record_claim') {
      if (!ctx.pathIds.has(event.source_message_id)) throw new Error('Role claim off branch');
      if (!ctx.actorIds.has(event.speaker_id) || ctx.speakerByMessage.get(event.source_message_id) !== event.speaker_id) throw new Error('Role claim speaker mismatch');
      if (event.claimed_status !== fact.status) conflicts.push({ proposal_id: fact.id, speaker_id: event.speaker_id,
        source_message_id: event.source_message_id, claimed_status: event.claimed_status, actual_status_at_claim: fact.status });
      fact.evidence_ids.push(event.source_message_id);
    } else {
      if (!entity(event.decision_by) || event.decision_by !== fact.subject_id) throw new Error('Role decision requires subject');
      if (event.action === 'withdraw_acceptance' && fact.status !== 'accepted') throw new Error('Cannot withdraw unaccepted role');
      fact.status = event.action === 'accept' ? 'accepted' : 'rejected';
      fact.decision_by = event.decision_by;
      fact.last_decision = event.action;
    }
    fact.version++;
    fact.evidence_ids.push(event.anchor_message_id);
  }
  const visible = [...facts.values()].filter(f => f.evidence_ids.every(id => ctx.visibleIds.has(id)));
  const ids = new Set(visible.map(f => f.id));
  return { facts: visible.map(f => ({ ...f, evidence_ids: [...new Set(f.evidence_ids)] })),
    conflicts: conflicts.filter(c => ids.has(c.proposal_id)) };
}

export function roleFactsForAudience(state: ReturnType<typeof reduceRoleFacts>, actor: string) {
  const facts = state.facts.filter(f => f.audience.visibility === 'public' || f.audience.recipient_ids.includes(actor));
  const ids = new Set(facts.map(f => f.id));
  return { facts, conflicts: state.conflicts.filter(c => ids.has(c.proposal_id)) };
}
