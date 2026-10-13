// Errors are fixture logical-code drafts, not adoption of an API contract.
import { structuralPath, type MessageTree } from './tree.js';

export type ApprovalReceipt = Readonly<{
  anchor_id: string;
  effect_id: string;
  node_id: string;
  proposal_id: string;
  idempotency_key: string;
}>;
export type ApprovalRequest = Readonly<{
  idempotencyKey: string;
  payloadHash: string;
  expectedHead: string | null;
  expectedStateToken: string;
  proposalOnActivePath: boolean;
}>;
export type ApprovalState = Readonly<{
  tree: MessageTree;
  head: string | null;
  stateToken: string;
  activeBranch: string;
  approvedAnchorIds: readonly string[];
  receipts: readonly Readonly<{ payloadHash: string; receipt: ApprovalReceipt }>[];
}>;
export type Rejection = Readonly<{
  code: 'idempotency-payload-conflict' | 'stale-approval-state' | 'proposal-branch-mismatch'
    | 'approval-not-at-turn-boundary' | 'protected-memory-ancestor';
  reconfirm: boolean;
}>;
export type ApprovalDecision = Readonly<{ ok: true; receipt?: ApprovalReceipt }> | Rejection;

/** Format, authentication and proposal existence must already be validated by the caller. */
export function checkApproval(request: ApprovalRequest, state: ApprovalState): ApprovalDecision {
  const prior = state.receipts.find(item => item.receipt.idempotency_key === request.idempotencyKey);
  if (prior) {
    return prior.payloadHash === request.payloadHash
      ? { ok: true, receipt: prior.receipt }
      : { code: 'idempotency-payload-conflict', reconfirm: false };
  }
  if (request.expectedHead !== state.head || request.expectedStateToken !== state.stateToken) {
    return { code: 'stale-approval-state', reconfirm: true };
  }
  if (!request.proposalOnActivePath) {
    return { code: 'proposal-branch-mismatch', reconfirm: true };
  }
  const head = state.tree.rows.find(row => row.id === state.head);
  const boundary = head && ((head.role === 'assistant' && head.status === 'complete' && !head.internal)
    || (head.internal && head.role === 'memory-anchor' && state.approvedAnchorIds.includes(head.id)));
  if (!boundary) return { code: 'approval-not-at-turn-boundary', reconfirm: false };
  return { ok: true };
}

/** protectedIds are approved anchors and source IDs, including closed-node history. */
export function checkDelete(tree: MessageTree, rootId: string, protectedIds: readonly string[]): Readonly<{ ok: true }> | Rejection {
  for (const id of protectedIds) {
    if (structuralPath(tree, id).some(row => row.id === rootId)) {
      return { code: 'protected-memory-ancestor', reconfirm: false };
    }
  }
  return { ok: true };
}
