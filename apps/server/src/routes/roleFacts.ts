import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { authState } from '../auth.js';
import { appendRoleEvent, loadRoleEvents } from '../db/roleFacts.js';
import { one, uid } from '../db/index.js';
import { getPath } from '../db/tree.js';
import { audienceSchema } from '../prompt/observation.js';
import { conversationRoleState } from '../prompt/conversationRoleFacts.js';
import { reduceRoleFacts } from '../prompt/roleFacts.js';
import { loadStoryRoster } from '../prompt/dialogContext.js';
import { parseMessageMeta } from '../db/messageMeta.js';
import type { ConversationRow } from '../types.js';

const id = z.string().min(1).max(100);
const registerBody = z.object({
  anchorMessageId: id,
  kind: z.enum(['proposal', 'role']),
  subjectId: id,
  description: z.string().trim().min(1).max(1000),
  proposedBy: id,
  sourceMessageIds: z.array(id).min(1).max(12),
  audience: audienceSchema.default({ visibility: 'public' }),
}).strict();
const decisionBody = z.object({
  anchorMessageId: id,
  action: z.enum(['accept', 'reject', 'withdraw_acceptance']),
}).strict();
const claimBody = z.object({
  anchorMessageId: id,
  speakerId: id,
  sourceMessageId: id,
  claimedStatus: z.enum(['proposed', 'accepted', 'rejected']),
}).strict();

function load(db: Ctx['db'], id: string) {
  return one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', id);
}

function reducerContext(db: Ctx['db'], conv: ConversationRow) {
  const path = getPath(db, conv).filter(row => row.status === 'complete');
  const ids = new Set(path.map(row => row.id));
  const roster = loadStoryRoster(db, conv);
  return {
    conversationId: conv.id,
    pathIds: ids,
    visibleIds: ids,
    actorIds: new Set([conv.character_id, ...roster.map(row => row.id)]),
    speakerByMessage: new Map(path.flatMap(row => {
      const speaker = parseMessageMeta(row.meta_json).speaker_character_id;
      return row.role === 'assistant' && typeof speaker === 'string' ? [[row.id, speaker] as const] : [];
    })),
  };
}

function recorder(req: FastifyRequest, db: Ctx['db']): string | null {
  const state = authState(req, db);
  return state.authenticated ? `human:${state.login || state.mode}` : null;
}

function output(db: Ctx['db'], conv: ConversationRow) {
  const state = conversationRoleState(db, conv);
  return {
    facts: state.facts,
    conflicts: state.conflicts,
    confirmed: state.facts.filter(fact => fact.status === 'accepted').map(fact => ({ id: fact.id, description: fact.description })),
  };
}

export function roleFactRoutes(ctx: Ctx) {
  const { db } = ctx;
  return async function plugin(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>('/api/conversations/:id/role-facts', async (req, reply) => {
      const conv = load(db, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      return output(db, conv);
    });

    app.post<{ Params: { id: string } }>('/api/conversations/:id/role-facts', async (req, reply) => {
      const conv = load(db, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const parsed = registerBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const recordedBy = recorder(req, db);
      if (!recordedBy) return reply.code(401).send({ error: 'unauthorized' });
      const proposalId = uid();
      const d = parsed.data;
      const event = {
        proposal_id: proposalId, conversation_id: conv.id, anchor_message_id: d.anchorMessageId,
        expected_version: 0, action: 'register' as const,
        proposal: { kind: d.kind, subject_id: d.subjectId, description: d.description,
          proposed_by: d.proposedBy, source_message_ids: d.sourceMessageIds, audience: d.audience },
      };
      try {
        reduceRoleFacts([...loadRoleEvents(db, conv.id), { ...event, id: 'validation', recorded_by: recordedBy }], reducerContext(db, conv));
        const stored = appendRoleEvent(db, event, recordedBy);
        return reply.code(201).send({ eventId: stored.id, proposalId, ...output(db, conv) });
      } catch (error) {
        return reply.code(409).send({ error: (error as Error).message });
      }
    });

    app.post<{ Params: { id: string; proposalId: string } }>('/api/conversations/:id/role-facts/:proposalId/decision', async (req, reply) => {
      const conv = load(db, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const parsed = decisionBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const recordedBy = recorder(req, db);
      if (!recordedBy) return reply.code(401).send({ error: 'unauthorized' });
      const before = conversationRoleState(db, conv);
      const fact = before.facts.find(row => row.id === req.params.proposalId);
      if (!fact) return reply.code(404).send({ error: 'role fact not found on active branch' });
      const event = { proposal_id: fact.id, conversation_id: conv.id, anchor_message_id: parsed.data.anchorMessageId,
        expected_version: fact.version, action: parsed.data.action, decision_by: fact.subject_id };
      try {
        reduceRoleFacts([...loadRoleEvents(db, conv.id), { ...event, id: 'validation', recorded_by: recordedBy }], reducerContext(db, conv));
        const stored = appendRoleEvent(db, event, recordedBy);
        return { eventId: stored.id, ...output(db, conv) };
      } catch (error) {
        return reply.code(409).send({ error: (error as Error).message });
      }
    });

    app.post<{ Params: { id: string; proposalId: string } }>('/api/conversations/:id/role-facts/:proposalId/claim', async (req, reply) => {
      const conv = load(db, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const parsed = claimBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const recordedBy = recorder(req, db);
      if (!recordedBy) return reply.code(401).send({ error: 'unauthorized' });
      const before = conversationRoleState(db, conv);
      const fact = before.facts.find(row => row.id === req.params.proposalId);
      if (!fact) return reply.code(404).send({ error: 'role fact not found on active branch' });
      const d = parsed.data;
      const event = { proposal_id: fact.id, conversation_id: conv.id, anchor_message_id: d.anchorMessageId,
        expected_version: fact.version, action: 'record_claim' as const, speaker_id: d.speakerId,
        source_message_id: d.sourceMessageId, claimed_status: d.claimedStatus };
      try {
        reduceRoleFacts([...loadRoleEvents(db, conv.id), { ...event, id: 'validation', recorded_by: recordedBy }], reducerContext(db, conv));
        const stored = appendRoleEvent(db, event, recordedBy);
        return { eventId: stored.id, ...output(db, conv) };
      } catch (error) {
        return reply.code(409).send({ error: (error as Error).message });
      }
    });
  };
}
