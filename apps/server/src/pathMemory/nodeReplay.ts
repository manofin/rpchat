// 진단 코드 이름은 후보이며 API 계약이 아니다

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { structuralPath, type MessageTree } from './tree.js';
import { audienceSchema, type Audience } from '../prompt/observation.js';

export const NODE_KINDS = ['relationship', 'promise', 'possession_note', 'rule_note', 'knowledge'] as const;

export type NodeReplayCode =
  | 'pm-sequence-order'
  | 'pm-unknown-schema-version'
  | 'pm-corrupt-payload'
  | 'pm-payload-hash-mismatch'
  | 'pm-proposal-mismatch'
  | 'pm-orphan-accept'
  | 'pm-accept-after-reject'
  | 'pm-revision-conflict'
  | 'pm-edit-closed-node'
  | 'pm-duplicate-node-id'
  | 'pm-source-missing'
  | 'pm-source-not-ancestor'
  | 'pm-category-not-allowed';

export class NodeReplayError extends Error {
  readonly code: NodeReplayCode;
  readonly event_id: string;
  constructor(code: NodeReplayCode, event_id: string) {
    super(code);
    this.name = 'NodeReplayError';
    this.code = code;
    this.event_id = event_id;
  }
}

export type ReplayLedgerEvent = Readonly<{
  sequence: number;
  id: string;
  node_id: string;
  proposal_id: string;
  action: 'propose' | 'accept' | 'reject';
  change: 'create' | 'edit' | 'move' | 'close' | null;
  anchor_message_id: string | null;
  expected_revision: number;
  payload_hash: string;
  schema_version: number;
  payload_json: string;
  source_message_ids: readonly string[];
}>;

export type DerivedNode = Readonly<{
  node_id: string;
  revision: number;
  kind: (typeof NODE_KINDS)[number];
  subject_id: string;
  target_ids: readonly string[];
  category_segments: readonly string[];
  label: string;
  body?: string;
  state: 'active' | 'closed';
  audience: Audience;
}>;

const nodeId = z.string().min(1);
const segment = z.array(z.string().min(1));
const createPayload = z.object({
  node_id: nodeId,
  kind: z.enum(NODE_KINDS),
  subject_id: z.string().min(1),
  target_ids: segment,
  category_segments: segment.min(1),
  label: z.string().min(1),
  body: z.string().optional(),
  audience: audienceSchema,
}).strict();
const editPayload = z.object({
  node_id: nodeId,
  label: z.string().min(1).optional(),
  body: z.string().optional(),
  audience: audienceSchema.optional(),
}).strict().refine((value) => value.label !== undefined || value.body !== undefined || value.audience !== undefined);
const movePayload = z.object({
  node_id: nodeId,
  category_segments: segment.min(1),
}).strict();
const closePayload = z.object({ node_id: nodeId }).strict();

function fail(code: NodeReplayCode, eventId: string): never {
  throw new NodeReplayError(code, eventId);
}

function canonicalize(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('non-integer number');
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize((value as Record<string, unknown>)[key]);
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function assertSequenceOrder(events: readonly ReplayLedgerEvent[]): void {
  const seen = new Set<number>();
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || seen.has(event.sequence)) fail('pm-sequence-order', event.id);
    seen.add(event.sequence);
  }
}

function parsedPayload(event: ReplayLedgerEvent): unknown {
  if (event.change === null) fail('pm-corrupt-payload', event.id);
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.payload_json);
  } catch {
    fail('pm-corrupt-payload', event.id);
  }
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    fail('pm-corrupt-payload', event.id);
  }
  if (canonical !== event.payload_json) fail('pm-corrupt-payload', event.id);
  return parsed;
}

function assertPayload(event: ReplayLedgerEvent, parsed: unknown): void {
  const schema = event.change === 'create' ? createPayload
    : event.change === 'edit' ? editPayload
    : event.change === 'move' ? movePayload
    : closePayload;
  const result = schema.safeParse(parsed);
  if (!result.success || result.data.node_id !== event.node_id) fail('pm-corrupt-payload', event.id);
}

function assertProposal(event: ReplayLedgerEvent, events: readonly ReplayLedgerEvent[]): void {
  const proposes = events.filter((item) => item.action === 'propose' && item.proposal_id === event.proposal_id);
  if (proposes.length !== 1) fail('pm-orphan-accept', event.id);
  const propose = proposes[0]!;
  if (
    propose.node_id !== event.node_id ||
    propose.change !== event.change ||
    propose.schema_version !== event.schema_version ||
    propose.expected_revision !== event.expected_revision ||
    propose.payload_json !== event.payload_json ||
    propose.payload_hash !== event.payload_hash
  ) fail('pm-proposal-mismatch', event.id);
}

function assertNoEarlierReject(event: ReplayLedgerEvent, events: readonly ReplayLedgerEvent[]): void {
  if (events.some((item) => item.action === 'reject' && item.proposal_id === event.proposal_id && item.sequence < event.sequence)) {
    fail('pm-accept-after-reject', event.id);
  }
}

function assertSources(event: ReplayLedgerEvent, tree: MessageTree, anchor: string): void {
  const ids = new Set(tree.rows.map((row) => row.id));
  if (event.source_message_ids.length < 1 || event.source_message_ids.some((id) => !ids.has(id))) fail('pm-source-missing', event.id);
  const ancestors = new Set(structuralPath(tree, anchor).map((row) => row.id));
  if (event.source_message_ids.some((id) => id === anchor || !ancestors.has(id))) fail('pm-source-not-ancestor', event.id);
}

function requireOpen(nodes: Map<string, DerivedNode>, event: ReplayLedgerEvent): DerivedNode {
  const current = nodes.get(event.node_id);
  if (!current) fail('pm-revision-conflict', event.id);
  if (current.state === 'closed') fail('pm-edit-closed-node', event.id);
  if (event.expected_revision !== current.revision) fail('pm-revision-conflict', event.id);
  return current;
}

export function replayNodeStates(
  events: readonly ReplayLedgerEvent[],
  tree: MessageTree,
  head: string | null,
  allowCategory: (segments: readonly string[]) => boolean,
): ReadonlyMap<string, DerivedNode> {
  assertSequenceOrder(events);
  const pathIds = new Set(structuralPath(tree, head).map((row) => row.id));
  const nodes = new Map<string, DerivedNode>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.action !== 'accept') continue;
    if (event.anchor_message_id === null) fail('pm-corrupt-payload', event.id);
    const anchor = event.anchor_message_id;
    if (!pathIds.has(anchor)) continue;
    if (event.schema_version !== 1) fail('pm-unknown-schema-version', event.id);
    const parsed = parsedPayload(event);
    assertPayload(event, parsed);
    const digest = createHash('sha256').update(event.payload_json, 'utf8').digest('hex');
    if (digest !== event.payload_hash) fail('pm-payload-hash-mismatch', event.id);
    assertProposal(event, events);
    assertNoEarlierReject(event, events);
    assertSources(event, tree, anchor);
    if (event.change === null) fail('pm-corrupt-payload', event.id);
    if (event.change === 'create') {
      const payload = createPayload.parse(parsed);
      if (events.filter((item) => item.action === 'accept' && item.change === 'create' && item.node_id === event.node_id).length >= 2) {
        fail('pm-duplicate-node-id', event.id);
      }
      if (event.expected_revision !== 0) fail('pm-revision-conflict', event.id);
      if (!allowCategory(payload.category_segments)) fail('pm-category-not-allowed', event.id);
      const created: DerivedNode = {
        node_id: payload.node_id,
        revision: 1,
        kind: payload.kind,
        subject_id: payload.subject_id,
        target_ids: payload.target_ids,
        category_segments: payload.category_segments,
        label: payload.label,
        state: 'active',
        audience: payload.audience,
      };
      nodes.set(event.node_id, payload.body === undefined ? created : { ...created, body: payload.body });
    } else if (event.change === 'edit') {
      const current = requireOpen(nodes, event);
      const payload = editPayload.parse(parsed);
      nodes.set(event.node_id, {
        ...current,
        revision: current.revision + 1,
        ...(payload.label !== undefined ? { label: payload.label } : {}),
        ...(payload.body !== undefined ? { body: payload.body } : {}),
        ...(payload.audience !== undefined ? { audience: payload.audience } : {}),
      });
    } else if (event.change === 'move') {
      const current = requireOpen(nodes, event);
      const payload = movePayload.parse(parsed);
      if (!allowCategory(payload.category_segments)) fail('pm-category-not-allowed', event.id);
      nodes.set(event.node_id, { ...current, revision: current.revision + 1, category_segments: payload.category_segments });
    } else {
      const current = requireOpen(nodes, event);
      closePayload.parse(parsed);
      nodes.set(event.node_id, { ...current, revision: current.revision + 1, state: 'closed' });
    }
  }
  return nodes;
}
