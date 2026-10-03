import { z } from 'zod';
import { type DB, many, one } from '../db/index.js';
import { getPath } from '../db/tree.js';
import type { ConversationRow, MemoryRow } from '../types.js';
import { memoryEvidenceAllowed } from './contextSelection.js';
import { estimateTokens } from './tokens.js';

const id = z.string().min(1).max(100);
const entrySchema = z.object({
  memory_id: id,
  anchor_message_id: id,
  kind: z.enum(['fact', 'relationship', 'injury', 'promise', 'goal']),
  known_by: z.union([z.literal('public'), z.array(id).max(12)]),
  subject_id: id.optional(),
  target_id: id.optional(),
  status: z.enum(['active', 'resolved']),
}).strict().superRefine((e, ctx) => {
  if (e.kind !== 'fact' && !e.subject_id) ctx.addIssue({ code: 'custom', message: 'subject_id required' });
  if ((e.kind === 'relationship' || e.kind === 'promise') && !e.target_id) ctx.addIssue({ code: 'custom', message: 'target_id required' });
  if (Array.isArray(e.known_by) && new Set(e.known_by).size !== e.known_by.length) ctx.addIssue({ code: 'custom', message: 'duplicate known_by' });
});
export const dialogContextSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(64) }).strict()
  .superRefine((s, ctx) => { if (new Set(s.entries.map(e => e.memory_id)).size !== s.entries.length) ctx.addIssue({ code: 'custom', message: 'duplicate memory_id' }); });
export type DialogKnowledgeSpec = z.infer<typeof dialogContextSchema>;
export function invalidAssignmentAnchor(db: DB, conversationId: string, pathIds: Set<string>, spec: DialogKnowledgeSpec): boolean {
  return spec.entries.some(e => !one(db, 'SELECT id FROM messages WHERE id = ? AND conversation_id = ?', e.anchor_message_id, conversationId)
    || !pathIds.has(e.anchor_message_id));
}
type Fact = { memory_id: string; kind: DialogKnowledgeSpec['entries'][number]['kind']; text: string; subject_id?: string; target_id?: string };
export type ActorContext = {
  version: 1;
  legacy_policy: 'narrator_reference_unspecified';
  boundary: 'public_script_with_scoped_supplements';
  public_facts: Fact[];
  narrator_facts: Fact[];
  actors: Array<{ id: string; name: string; public_memory_ids: string[]; facts: Fact[] }>;
  excluded: Array<{ memory_id: string; reason: string }>;
};

function promptFacts(packet: ActorContext, facts: Fact[]) {
  const name = (id?: string) => id === 'user' ? '사용자' : packet.actors.find(actor => actor.id === id)?.name;
  return facts.map(fact => ({
    ...fact,
    ...(fact.subject_id ? { subject: name(fact.subject_id) ?? fact.subject_id } : {}),
    ...(fact.target_id ? { target: name(fact.target_id) ?? fact.target_id } : {}),
  }));
}

export function renderPublicActorContext(packet: ActorContext): string {
  return packet.public_facts.length
    ? `### 승인된 공개 지식\n${JSON.stringify({ public_facts: promptFacts(packet, packet.public_facts) })}`
    : '';
}

export function renderActorPrivateContext(packet: ActorContext, actorId: string): string {
  const actor = packet.actors.find((row) => row.id === actorId);
  if (!actor?.facts.length) return '';
  return [
    `너는 오직 ${actor.name} 한 인물의 다음 대사만 작성한다.`,
    `### 승인된 공개 사실\n${JSON.stringify(promptFacts(packet, packet.public_facts))}`,
    `### ${actor.name}에게만 배정된 사실\n${JSON.stringify(promptFacts(packet, actor.facts))}`,
    '## 규칙',
    '- 다른 인물의 대사·행동·생각·감정이나 서술을 작성하지 않는다.',
    `- 대사가 필요하면 \`${actor.name} | 대사\` 형식만 사용하고, 필요 없으면 정확히 \`NO_LINE\`만 출력한다.`,
    '- 위 공개 사실과 이 인물에게 배정된 비공개 사실만 근거로 삼는다.',
  ].join('\n');
}

export function renderNarratorPrivateContext(packet: ActorContext): string {
  if (!packet.narrator_facts.length) return '';
  return [
    '너는 인물의 목소리를 맡지 않는 장면 서술자다.',
    `### 승인된 공개 사실\n${JSON.stringify(promptFacts(packet, packet.public_facts))}`,
    `### 서술자에게만 배정된 사실\n${JSON.stringify(promptFacts(packet, packet.narrator_facts))}`,
    '## 규칙',
    '- 대사·이름표를 쓰지 않는다. 필요한 서술이 없으면 정확히 `NO_NARRATION`만 출력한다.',
  ].join('\n');
}
export const ACTOR_CONTEXT_RULES = [
  '## 인물별 지식 경계',
  '- 전체 대본을 쓰는 서술자와 각 인물의 지식은 다르다. 명시적 공개 기억은 모든 인물이 아는 사실이다.',
  '- 각 인물은 명시적 공개 기억과 자기 목록에 배정된 기억을 안다. 자기 목록에 없는 다른 인물의 기억이나 서술자 참고를 자기 지식으로 대사에 사용하지 않는다.',
  '- 범위 미지정 기존 기억·요약·기록·카드·로어·입력은 서술자 참고다. 존재하거나 함께 있었다는 이유로 모든 인물이 안다고 추정하지 않는다.',
  '- 관계와 약속은 subject_id → target_id 방향이다. 역방향 관계를 추정하지 않는다. active 부상·약속·미해결 목표는 유지하며 임의로 회복·이행·해결하지 않는다.',
  '- 목록에 없는 과거 기억·관계·상태를 안다고 확정하지 않는다. 현재 사용자 입력의 대답은 기존 화자 규칙을 따르며, 지식 전달이나 상태 변경을 새로 확정하지 않는다.',
].join('\n');

/** Explicit user-owned references only: prose, presence and speakers never infer knowledge. */
export function buildActorContext(db: DB, conv: ConversationRow, pathIds: Set<string>, raw: unknown,
  actors: Array<{ id: string; name: string }>, cap: number, cal: number) {
  const parsed = dialogContextSchema.safeParse(raw);
  const reservedIds = new Set<string>();
  // Even malformed legacy JSON cannot fall back to publishing a referenced secret as generic memory.
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).entries)) {
    for (const e of (raw as any).entries) if (e && typeof e.memory_id === 'string') reservedIds.add(e.memory_id);
  }
  const packet: ActorContext = { version: 1, legacy_policy: 'narrator_reference_unspecified', boundary: 'public_script_with_scoped_supplements',
    public_facts: [], narrator_facts: [], actors: actors.map(a => ({ ...a, public_memory_ids: [], facts: [] })), excluded: [] };
  const render = () => packet.public_facts.length || packet.narrator_facts.length || packet.actors.some(a => a.facts.length)
    ? `### 승인된 지식 배정\n${JSON.stringify({ public_facts: packet.public_facts, narrator_facts: packet.narrator_facts, actors: packet.actors })}` : '';
  if (!parsed.success) {
    packet.excluded = [...reservedIds].map(memory_id => ({ memory_id, reason: 'invalid-contract' }));
    return { packet, text: '', tokens: 0, reservedIds };
  }
  const actorIds = new Set(actors.map(a => a.id));
  const entityIds = new Set([...actorIds, 'user']);
  const sourcePaths = new Map([[conv.id, pathIds]]);
  const sourcePath = (room: string) => {
    let ids = sourcePaths.get(room);
    if (!ids) { const c = one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', room); ids = new Set(c ? getPath(db, c).map(m => m.id) : []); sourcePaths.set(room, ids); }
    return ids;
  };
  const rows = reservedIds.size ? many<MemoryRow>(db, `SELECT * FROM memories WHERE id IN (${[...reservedIds].map(() => '?').join(',')})`, ...reservedIds) : [];
  const byId = new Map(rows.map(m => [m.id, m]));
  const entries = parsed.data.entries.map((e, order) => ({ e, order, m: byId.get(e.memory_id) }))
    .sort((a, b) => (b.m?.importance ?? 0) - (a.m?.importance ?? 0) || a.order - b.order);
  for (const { e, m } of entries) {
    let reason: string | null = null;
    if (e.status !== 'active') reason = 'resolved';
    else if (!one(db, 'SELECT id FROM messages WHERE id = ? AND conversation_id = ?', e.anchor_message_id, conv.id)) reason = 'invalid-anchor';
    else if (!pathIds.has(e.anchor_message_id)) reason = 'assignment-off-branch';
    else if (!m || m.status !== 'pinned') reason = 'not-approved';
    else if (!((m.scope === 'conversation' && m.conversation_id === conv.id) || (m.scope === 'character' && !!m.character_id && actorIds.has(m.character_id)))) reason = 'foreign-scope';
    else if (!memoryEvidenceAllowed(db, m, sourcePath)) reason = 'evidence-off-branch';
    else if ((Array.isArray(e.known_by) && e.known_by.some(v => !actorIds.has(v))) || (e.subject_id && !entityIds.has(e.subject_id)) || (e.target_id && !entityIds.has(e.target_id))) reason = 'unknown-actor';
    if (reason) { packet.excluded.push({ memory_id: e.memory_id, reason }); continue; }
    const fact: Fact = { memory_id: e.memory_id, kind: e.kind, text: m!.content, ...(e.subject_id ? { subject_id: e.subject_id } : {}), ...(e.target_id ? { target_id: e.target_id } : {}) };
    const holders = e.known_by === 'public' ? packet.actors : packet.actors.filter(a => e.known_by.includes(a.id));
    if (e.known_by === 'public') { packet.public_facts.push(fact); for (const a of holders) a.public_memory_ids.push(e.memory_id); }
    else if (!holders.length) packet.narrator_facts.push(fact);
    else for (const a of holders) a.facts.push(fact);
    if (estimateTokens(render(), cal) > cap) {
      if (e.known_by === 'public') { packet.public_facts.pop(); for (const a of holders) a.public_memory_ids.pop(); }
      else if (!holders.length) packet.narrator_facts.pop(); else for (const a of holders) a.facts.pop();
      packet.excluded.push({ memory_id: e.memory_id, reason: 'budget' });
    }
  }
  const text = render();
  return { packet, text, tokens: estimateTokens(text, cal), reservedIds };
}
