/** npm run test:benches -- pathMemoryNodeReplay — pure node replay, hand-written expected values, no DB or model. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NodeReplayError, replayNodeStates, type DerivedNode, type ReplayLedgerEvent } from '../apps/server/src/pathMemory/nodeReplay.ts';
import type { MessageTree } from '../apps/server/src/pathMemory/tree.ts';

const tree: MessageTree = {
  order: 'oldest-to-newest',
  rows: [
    { id: 'u1', parent: null, role: 'user', status: 'complete', internal: false },
    { id: 'h1', parent: 'u1', role: 'assistant', status: 'complete', internal: false },
    { id: 'x1', parent: 'h1', role: 'memory-anchor', status: 'complete', internal: true },
    { id: 'u2', parent: 'x1', role: 'user', status: 'complete', internal: false },
    { id: 'h2', parent: 'u2', role: 'assistant', status: 'complete', internal: false },
    { id: 'x2', parent: 'h2', role: 'memory-anchor', status: 'complete', internal: true },
    { id: 'u3', parent: 'x1', role: 'user', status: 'complete', internal: false },
    { id: 'h3', parent: 'u3', role: 'assistant', status: 'complete', internal: false },
    { id: 'x3', parent: 'h3', role: 'memory-anchor', status: 'complete', internal: true },
  ],
};

const CREATE_JSON = '{"audience":{"visibility":"public"},"category_segments":["promise","user"],"kind":"promise","label":"약속 A","node_id":"n1","subject_id":"user","target_ids":["c1"]}';
const EDIT_B_JSON = '{"body":"내용","label":"약속 B","node_id":"n1"}';
const EDIT_LABEL_B_JSON = '{"label":"B","node_id":"n1"}';
const EDIT_LABEL_C_JSON = '{"label":"C","node_id":"n1"}';
const MOVE_JSON = '{"category_segments":["promise","c1"],"node_id":"n1"}';
const CLOSE_JSON = '{"node_id":"n1"}';
const UNSORTED_JSON = '{"node_id":"n1","audience":{"visibility":"public"},"category_segments":["promise","user"],"kind":"promise","label":"약속 A","subject_id":"user","target_ids":["c1"]}';

const N1: DerivedNode = {
  node_id: 'n1',
  revision: 1,
  kind: 'promise',
  subject_id: 'user',
  target_ids: ['c1'],
  category_segments: ['promise', 'user'],
  label: '약속 A',
  state: 'active',
  audience: { visibility: 'public' },
};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function pair(spec: {
  acceptId: string;
  sequence: number;
  change: 'create' | 'edit' | 'move' | 'close';
  anchor: string;
  expected: number;
  payload: string;
  sources: readonly string[];
  schemaVersion?: number;
  hashText?: string;
  proposeExpected?: number;
}): ReplayLedgerEvent[] {
  const payloadHash = sha256(spec.hashText ?? spec.payload);
  const version = spec.schemaVersion ?? 1;
  const shared = {
    node_id: 'n1',
    proposal_id: `prop-${spec.acceptId}`,
    change: spec.change,
    payload_hash: payloadHash,
    schema_version: version,
    payload_json: spec.payload,
    source_message_ids: spec.sources,
    anchor_message_id: spec.anchor,
  };
  return [
    { ...shared, sequence: spec.sequence, id: `p-${spec.acceptId}`, action: 'propose', expected_revision: spec.proposeExpected ?? spec.expected },
    { ...shared, sequence: spec.sequence + 1, id: spec.acceptId, action: 'accept', expected_revision: spec.expected },
  ];
}

function createAt(anchor: string, sources: readonly string[], sequence = 1, acceptId = 'a-create'): ReplayLedgerEvent[] {
  return pair({ acceptId, sequence, change: 'create', anchor, expected: 0, payload: CREATE_JSON, sources });
}

function replay(events: readonly ReplayLedgerEvent[], head: string | null, allowCategory: (segments: readonly string[]) => boolean = () => true) {
  return replayNodeStates(events, tree, head, allowCategory);
}

function expectError(events: readonly ReplayLedgerEvent[], head: string | null, code: string, eventId: string, allowCategory: (segments: readonly string[]) => boolean = () => true): void {
  assert.throws(() => replay(events, head, allowCategory), (error: unknown) => {
    assert.ok(error instanceof NodeReplayError);
    assert.equal(error.code, code);
    assert.equal(error.event_id, eventId);
    return true;
  });
}

let passed = 0;
function t(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok ${++passed} ${name}`);
  } catch (error) {
    console.error(`not ok ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

const base = createAt('x1', ['h1']);

t('create-on-path', () => {
  const map = replay(base, 'x2');
  assert.deepStrictEqual([...map.keys()], ['n1']);
  assert.deepStrictEqual(map.get('n1'), N1);
  assert.equal(Object.hasOwn(map.get('n1')!, 'body'), false);
});

t('edit-label-body', () => {
  const node = replay([...base, ...pair({ acceptId: 'a-edit', sequence: 3, change: 'edit', anchor: 'x2', expected: 1, payload: EDIT_B_JSON, sources: ['h2'] })], 'x2').get('n1');
  assert.deepStrictEqual(node, { ...N1, revision: 2, label: '약속 B', body: '내용' });
});

t('move-category', () => {
  const node = replay([...base, ...pair({ acceptId: 'a-move', sequence: 3, change: 'move', anchor: 'x2', expected: 1, payload: MOVE_JSON, sources: ['h2'] })], 'x2').get('n1');
  assert.deepStrictEqual(node, { ...N1, revision: 2, category_segments: ['promise', 'c1'] });
});

t('close-node', () => {
  const node = replay([...base, ...pair({ acceptId: 'a-close', sequence: 3, change: 'close', anchor: 'x2', expected: 1, payload: CLOSE_JSON, sources: ['h2'] })], 'x2').get('n1');
  assert.deepStrictEqual(node, { ...N1, revision: 2, state: 'closed' });
});

t('branch-filter', () => {
  const events = [
    ...base,
    ...pair({ acceptId: 'a-edit-b', sequence: 3, change: 'edit', anchor: 'x2', expected: 1, payload: EDIT_LABEL_B_JSON, sources: ['h2'] }),
    ...pair({ acceptId: 'a-edit-c', sequence: 5, change: 'edit', anchor: 'x3', expected: 1, payload: EDIT_LABEL_C_JSON, sources: ['h3'] }),
  ];
  assert.deepStrictEqual(replay(events, 'x2').get('n1'), { ...N1, revision: 2, label: 'B' });
  assert.deepStrictEqual(replay(events, 'x3').get('n1'), { ...N1, revision: 2, label: 'C' });
  assert.equal(replay(events, 'h1').size, 0);
});

t('sequence-order', () => {
  assert.deepStrictEqual(replay([...base].reverse(), 'x2').get('n1'), N1);
  expectError([
    { ...base[0]!, sequence: 4, id: 'seq-first' },
    { ...base[1]!, sequence: 4, id: 'seq-later' },
  ], 'x2', 'pm-sequence-order', 'seq-later');
});

t('unknown-schema-version', () => {
  expectError(pair({ acceptId: 'a-schema', sequence: 1, change: 'create', anchor: 'x1', expected: 0, payload: CREATE_JSON, sources: ['h1'], schemaVersion: 2 }), 'x2', 'pm-unknown-schema-version', 'a-schema');
});

t('corrupt-payload', () => {
  expectError(pair({ acceptId: 'a-bad-json', sequence: 1, change: 'create', anchor: 'x1', expected: 0, payload: '{', sources: ['h1'] }), 'x2', 'pm-corrupt-payload', 'a-bad-json');
  expectError(pair({ acceptId: 'a-unsorted', sequence: 1, change: 'create', anchor: 'x1', expected: 0, payload: UNSORTED_JSON, sources: ['h1'] }), 'x2', 'pm-corrupt-payload', 'a-unsorted');
});

t('payload-hash-mismatch', () => {
  expectError(pair({ acceptId: 'a-hash', sequence: 1, change: 'create', anchor: 'x1', expected: 0, payload: CREATE_JSON, sources: ['h1'], hashText: 'not-the-payload' }), 'x2', 'pm-payload-hash-mismatch', 'a-hash');
});

t('proposal-mismatch', () => {
  expectError(pair({ acceptId: 'a-mismatch', sequence: 1, change: 'create', anchor: 'x1', expected: 0, payload: CREATE_JSON, sources: ['h1'], proposeExpected: 1 }), 'x2', 'pm-proposal-mismatch', 'a-mismatch');
});

t('orphan-accept', () => {
  expectError([pair({ acceptId: 'a-orphan', sequence: 1, change: 'create', anchor: 'x1', expected: 0, payload: CREATE_JSON, sources: ['h1'] })[1]!], 'x2', 'pm-orphan-accept', 'a-orphan');
  const first = pair({ acceptId: 'a-two', sequence: 1, change: 'create', anchor: 'x1', expected: 0, payload: CREATE_JSON, sources: ['h1'] });
  expectError([
    first[0]!,
    { ...first[0]!, sequence: 2, id: 'p-a-two-again' },
    { ...first[1]!, sequence: 3 },
  ], 'x2', 'pm-orphan-accept', 'a-two');
});

t('accept-after-reject', () => {
  const [propose, accept] = pair({ acceptId: 'a-reject', sequence: 1, change: 'create', anchor: 'x1', expected: 0, payload: CREATE_JSON, sources: ['h1'] });
  expectError([
    propose!,
    { ...propose!, sequence: 2, id: 'r-a-reject', action: 'reject' },
    { ...accept!, sequence: 3 },
  ], 'x2', 'pm-accept-after-reject', 'a-reject');
});

t('revision-conflict', () => {
  expectError([
    ...base,
    ...pair({ acceptId: 'a-revision', sequence: 3, change: 'edit', anchor: 'x2', expected: 2, payload: EDIT_LABEL_B_JSON, sources: ['h2'] }),
  ], 'x2', 'pm-revision-conflict', 'a-revision');
});

t('edit-closed-node', () => {
  expectError([
    ...base,
    ...pair({ acceptId: 'a-close', sequence: 3, change: 'close', anchor: 'x2', expected: 1, payload: CLOSE_JSON, sources: ['h2'] }),
    ...pair({ acceptId: 'a-closed', sequence: 5, change: 'edit', anchor: 'x2', expected: 2, payload: EDIT_LABEL_B_JSON, sources: ['h2'] }),
  ], 'x2', 'pm-edit-closed-node', 'a-closed');
});

t('source-not-ancestor', () => {
  expectError(createAt('x1', ['h2'], 1, 'a-ancestor'), 'x2', 'pm-source-not-ancestor', 'a-ancestor');
});

t('source-missing', () => {
  expectError(createAt('x1', ['nope'], 1, 'a-missing'), 'x2', 'pm-source-missing', 'a-missing');
  expectError(createAt('x1', [], 1, 'a-empty-source'), 'x2', 'pm-source-missing', 'a-empty-source');
});

t('duplicate-node-id', () => {
  expectError([
    ...createAt('x2', ['h2'], 1, 'a-dup'),
    ...createAt('x3', ['h3'], 3, 'a-dup-other'),
  ], 'x2', 'pm-duplicate-node-id', 'a-dup');
});

t('category-not-allowed', () => {
  expectError(base, 'x2', 'pm-category-not-allowed', 'a-create', (segments) => !segments.includes('user'));
});

if (passed !== 18) {
  console.error(`expected 18 passed, got ${passed}`);
  process.exitCode = 1;
}
