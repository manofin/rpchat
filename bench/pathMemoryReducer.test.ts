/**
 * npm run test:benches -- pathMemoryReducer --output-dir <new-evidence-dir>
 * Isolated offline inputs only; no DB, network, model, production wiring or writes.
 * Row arrays declare oldest-to-newest sibling order, not topological order.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function t(name: string, fn: () => void) {
  try { fn(); console.log(`ok ${++passed} ${name}`); }
  catch (error) {
    // Collect witnesses within this runner invocation; any failure makes its exit nonzero.
    // The execution lock stops further work after a baseline mismatch is reported.
    console.error(`not ok ${name}`); console.error(error); process.exitCode = 1;
  }
}
async function main() {
t('pure tree implementation exists independently of product wiring', () => {
  assert.ok(fs.existsSync(path.join(root, 'apps/server/src/pathMemory/tree.ts')), 'missing pure tree implementation');
});
const { structuralPath, displayPath, descendForSelect, returnToReceipt, siblingsOf, projectForDisplay } = await import('../apps/server/src/pathMemory/tree.ts');
const row = (id: string, parent: string | null, role = 'assistant', internal = false, status = 'complete') => ({ id, parent, role, internal, status });
const snapshot = (rows: any[]) => ({ order: 'oldest-to-newest' as const, rows });
const { checkApproval, checkDelete } = await import('../apps/server/src/pathMemory/gate.ts');
const { replayEvents, activeEffects, effectsAtHead } = await import('../apps/server/src/pathMemory/reducer.ts');
const { projectNodes } = await import('../apps/server/src/pathMemory/projector.ts');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(root, 'bench/fixtures/pathMemory', name), 'utf8'));
const branch = read('expected/branch-A.json');

// Transition-table vocabulary, independent of expected outcomes. The fixture omits
// full event payloads, so the harness supplies the documented anchor/effect names.
const priorEffects: Record<string, string> = { X: 'e1', XL: 'e2', X1: 'e1', X2: 'e2' };
function simulate(i: any) {
  let rows = structuredClone(i.initial_tree), head = i.initial_head;
  let events: any[] = rows.filter((r: any) => r.internal).map((r: any, index: number) => {
    assert.ok(priorEffects[r.id], `unknown fixture anchor ${r.id}`);
    return { event_id: `prior-${r.id}`, sequence: index + 1, action: 'accept', effect: { effect_id: priorEffects[r.id], anchor_message_id: r.id } };
  });
  let rejected: any = null, receipt: any;
  const tree = () => snapshot(rows);
  const append = (id: string, parent: string | null, role: string, internal = false) => {
    rows.push(row(id, parent, role, internal));
    head = id;
  };
  const regenerate = (target: string, newId: string) => {
    const source = rows.find((r: any) => r.id === target); assert.ok(source);
    append(newId, source.parent, source.role);
    head = descendForSelect(tree(), newId);
  };
  const approve = () => {
    const proposal = i.operation === 'accept-at-leaf-LA-then-regenerate-H'
      ? { anchor_id: 'XL', effect_id: 'eL', node_id: 'n3', proposal_id: 'q', idempotency_key: 'kq' }
      : i.approval_head === 'LA'
        ? { anchor_id: 'XL', effect_id: 'e2', node_id: 'n2', proposal_id: 'p2', idempotency_key: 'k2' }
        : { anchor_id: 'X', effect_id: 'e1', node_id: 'n1', proposal_id: 'p1', idempotency_key: 'k1' };
    const request = {
      idempotencyKey: i.idempotency_key ?? proposal.idempotency_key,
      payloadHash: i.payload_hash ?? `payload-${proposal.proposal_id}`,
      expectedHead: i.expected_head, expectedStateToken: i.expected_state_token,
      proposalOnActivePath: (i.proposal_branch ?? i.recorded_approval_head) === (i.active_branch ?? i.recorded_approval_head),
    };
    const state = { tree: tree(), head, stateToken: i.state_token,
      activeBranch: i.active_branch ?? head,
      approvedAnchorIds: events.map(e => e.effect.anchor_message_id),
      receipts: i.previous_receipt ? [{ payloadHash: i.stored_payload_hash ?? `payload-${i.previous_receipt.proposal_id}`, receipt: i.previous_receipt }] : [],
    };
    const before = JSON.stringify({ request, state });
    const result = checkApproval(request, state);
    assert.equal(JSON.stringify({ request, state }), before, 'approval gate mutated inputs');
    if ('code' in result) { rejected = result; return; }
    if (result.receipt) { assert.strictEqual(result.receipt, i.previous_receipt); receipt = result.receipt; return; }
    receipt = proposal;
    append(receipt.anchor_id, head, 'memory-anchor', true);
    events.push({ event_id: `accepted-${receipt.effect_id}`, sequence: events.length + 1, action: 'accept', effect: { effect_id: receipt.effect_id, anchor_message_id: receipt.anchor_id } });
  };
  switch (i.operation) {
    case 'propose':
      events.push({ event_id: 'proposal', sequence: events.length + 1, action: 'propose' }); break;
    case 'accept': case 'retry-accept-same-key': case 'retry-accept-different-payload': approve(); break;
    case 'select': head = descendForSelect(tree(), i.target); break;
    case 'explicit-return': head = returnToReceipt(tree(), i.target_receipt_anchor); break;
    case 'explicit-return-and-send': head = returnToReceipt(tree(), 'X'); append('U', head, 'user'); break;
    case 'stay-at-H-and-send': head = 'H'; append('U0', head, 'user'); break;
    case 'generation-failure-retain-input': break;
    case 'regenerate-H': regenerate('H', 'H2'); break;
    case 'regenerate-response-to-U': regenerate('V', 'V2'); break;
    case 'accept-at-leaf-LA-then-regenerate-H': approve(); if (!rejected) regenerate('H', 'H2'); break;
    case 'delete-fallback': case 'delete-protected-ancestor': case 'delete-unprotected-sibling': {
      const protectedIds = i.protected_ids ?? events.filter(e => e.action === 'accept').flatMap(e => [e.effect.anchor_message_id, 'H']);
      const decision = checkDelete(tree(), i.delete_root, protectedIds);
      if ('code' in decision) { rejected = decision; break; }
      const deleted = new Set(rows.filter((r: any) => structuralPath(tree(), r.id).some(a => a.id === i.delete_root)).map((r: any) => r.id));
      const parent = rows.find((r: any) => r.id === i.delete_root).parent;
      rows = rows.filter((r: any) => !deleted.has(r.id));
      if (deleted.has(head)) {
        const siblings = rows.filter((r: any) => !r.internal && r.parent === parent);
        head = siblings.length ? descendForSelect(tree(), siblings[siblings.length - 1].id) : parent;
      }
      break;
    }
    case 'delete-conversation': events = []; rows = []; head = null; break;
    case 'inspect-siblings': break;
    default: throw new Error(`unsupported fixture operation: ${i.operation}`);
  }
  return { final_tree: rows, final_head: head,
    active_effect_ids: activeEffects(tree(), events, head).map(e => e.effect_id), rejected,
    display_projection: projectForDisplay(tree(), head),
    siblings: Object.fromEntries(rows.filter((r: any) => !r.internal).map((r: any) => [r.id, siblingsOf(tree(), r.id)])),
    receipt, preserved_ids: rows.map((r: any) => r.id),
    preserved_effect_ids: replayEvents(events).acceptedEffects.map(e => e.effect_id),
  };
}
const byId = (rows: any[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
function compareCase(c: any) {
  const before = JSON.stringify(c.input), actual = simulate(c.input), e = c.expected;
  assert.equal(JSON.stringify(c.input), before, `${c.id}: input mutation`);
  for (const field of ['final_head', 'active_effect_ids', 'rejected', 'display_projection']) {
    assert.deepEqual(actual[field as keyof typeof actual], e[field], `${c.id}: ${field}`);
  }
  assert.deepEqual([...actual.preserved_ids].sort(), [...e.preserved_ids].sort(), `${c.id}: preserved_ids`);
  // Row order defines navigation input. Authored output tables are sets of rows,
  // and some place a child before its parent; do not use output order as input.
  assert.deepEqual(byId(actual.final_tree), byId(e.final_tree), `${c.id}: final_tree rows`);
  if (e.siblings) for (const [id, expected] of Object.entries(e.siblings)) assert.deepEqual(actual.siblings[id], expected, `${c.id}: siblings ${id}`);
  if (e.receipt) assert.deepEqual(actual.receipt, e.receipt, `${c.id}: receipt`);
  if (e.preserved_effect_ids) assert.deepEqual(actual.preserved_effect_ids, e.preserved_effect_ids, `${c.id}: preserved effects`);
  if (e.after_send) {
    const sent = [...actual.final_tree, row('U', actual.final_head, 'user')];
    assert.deepEqual(byId(sent), byId(e.after_send.final_tree), `${c.id}: after_send tree`);
    assert.equal('U', e.after_send.final_head);
    assert.deepEqual(projectForDisplay(snapshot(sent), 'U'), e.after_send.display_projection, `${c.id}: after_send projection`);
  }
  assert.equal(JSON.stringify(simulate(c.input)), JSON.stringify(actual), `${c.id}: deterministic bytes`);
}
for (const c of branch.cases) t(`${c.id} operation matches authored branch oracle`, () => {
  compareCase(c);
  for (const v of c.variants ?? []) compareCase(v);
  for (const variant of c.input.mismatch_variants ?? []) compareCase({ ...c, input: { ...c.input, ...variant } });
});
t('all 29 branch cases including K8 are present', () => assert.equal(branch.cases.length, 29));
t('T07 and T23 return T01 receipt and preserve their own heads', () => {
  const original = simulate(branch.cases.find((c: any) => c.id === 'T01').input).receipt;
  for (const id of ['T07', 'T23']) {
    const c = branch.cases.find((c: any) => c.id === id), result = simulate(c.input);
    assert.deepEqual(result.receipt, original); assert.equal(result.final_head, c.input.initial_head);
  }
});
t('K1/K2/K3 explicit order, internal boundary and displayed parents', () => {
  const tree = snapshot([row('P', null), row('H', 'P'), row('old', 'H', 'user'), row('X', 'H', 'memory-anchor', true), row('U', 'X', 'user'), row('new', 'H', 'user')]);
  assert.deepEqual(structuralPath(tree, 'U').map(r => r.id), ['P', 'H', 'X', 'U']);
  assert.deepEqual(displayPath(tree, 'U').map(r => r.id), ['P', 'H', 'U']);
  assert.equal(descendForSelect(tree, 'H'), 'new');
  assert.equal(returnToReceipt(tree, 'X'), 'U');
  assert.deepEqual(siblingsOf(tree, 'U'), ['U']);
  assert.deepEqual(siblingsOf(tree, 'old'), ['old', 'new']);
  assert.deepEqual(projectForDisplay(tree, 'U'), { head: 'U', messages: [{ id: 'P', parent: null }, { id: 'H', parent: 'P' }, { id: 'U', parent: 'H' }] });
});
t('approval gate implementation exists', () => {
  assert.ok(fs.existsSync(path.join(root, 'apps/server/src/pathMemory/gate.ts')), 'missing pure approval gate');
});
t('K8 idempotency then freshness then branch then K7; D1 independent', () => {
  const tree = snapshot([row('H', null), row('U', 'H', 'user'), row('X', 'H', 'memory-anchor', true)]);
  const receipt = { anchor_id: 'X', effect_id: 'e', node_id: 'n', proposal_id: 'p', idempotency_key: 'key' };
  const request = { idempotencyKey: 'key', payloadHash: 'payload', expectedHead: 'H', expectedStateToken: 'old', proposalOnActivePath: false };
  const state = { tree, head: 'U', stateToken: 'now', activeBranch: 'U', approvedAnchorIds: ['X'], receipts: [] };
  assert.deepEqual(checkApproval(request, state), { code: 'stale-approval-state', reconfirm: true });
  const fresh = { ...request, expectedHead: 'U', expectedStateToken: 'now' };
  assert.deepEqual(checkApproval(fresh, state), { code: 'proposal-branch-mismatch', reconfirm: true });
  assert.deepEqual(checkApproval({ ...fresh, proposalOnActivePath: true }, state), { code: 'approval-not-at-turn-boundary', reconfirm: false });
  const stored = { ...state, receipts: [{ payloadHash: 'payload', receipt }] };
  const retry = checkApproval(request, stored);
  assert.ok('ok' in retry && retry.ok); assert.strictEqual(retry.receipt, receipt);
  assert.deepEqual(checkApproval({ ...request, payloadHash: 'different' }, stored), { code: 'idempotency-payload-conflict', reconfirm: false });
  assert.deepEqual(checkDelete(tree, 'H', ['X']), { code: 'protected-memory-ancestor', reconfirm: false });
  assert.deepEqual(checkDelete(tree, 'U', ['X']), { ok: true });
});
t('replay implementation exists', () => {
  assert.ok(fs.existsSync(path.join(root, 'apps/server/src/pathMemory/reducer.ts')), 'missing pure effect replay');
});
t('unbounded accepted replay sorts sequence and resumes across pages', () => {
  const tree = snapshot([row('H', null), row('X', 'H', 'memory-anchor', true)]);
  const events = Array.from({ length: 300 }, (_, i) => ({ event_id: `evt${i}`, sequence: i + 1, action: 'accept' as const, effect: { effect_id: `effect${i}`, anchor_message_id: 'X' } }));
  const before = JSON.stringify(events);
  const whole = replayEvents([...events].reverse());
  let state = replayEvents([]);
  for (let i = 0; i < events.length; i += 17) state = replayEvents(events.slice(i, i + 17), state);
  assert.equal(JSON.stringify(state), JSON.stringify(whole));
  assert.equal(activeEffects(tree, events, 'X').length, 300);
  assert.deepEqual(effectsAtHead(tree, state, 'H'), []);
  assert.equal(JSON.stringify(events), before);
  assert.throws(() => replayEvents([events[0]], state), /sequence/);
});
t('recipient projector implementation exists', () => {
  assert.ok(fs.existsSync(path.join(root, 'apps/server/src/pathMemory/projector.ts')), 'missing pure recipient projector');
});
t('canary recipient tables and forbidden markers match actual packets', () => {
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(root, 'bench/fixtures/pathMemory', name), 'utf8'));
  for (const name of ['canary', 'N0', 'N17', 'N256', 'N257', 'N1024']) {
    const nodes = read(`nodes-${name}.json`).nodes;
    for (const recipient of read(`expected/recipients-${name}.json`).recipients) {
      const packet = projectNodes(nodes, recipient.id), bytes = JSON.stringify(packet);
      assert.deepEqual(packet.map(n => n.node_id), recipient.node_ids, `${name}:${recipient.id} authorized node IDs`);
      assert.equal(JSON.stringify(projectNodes(nodes, recipient.id)), bytes);
      if (name === 'canary') for (const node of nodes) if (!recipient.node_ids.includes(node.node_id)) {
        for (const text of [node.label, node.body]) assert.equal(bytes.includes(text.split(' ')[0]), false, `canary:${recipient.id} forbidden ${node.node_id}`);
      }
    }
  }
});
t('fence: pathMemory production importers are exactly the approved set', () => {
  const src = path.join(root, 'apps/server/src'), memory = path.join(src, 'pathMemory');
  const importers = new Set<string>();
  const visitDir = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (file === memory) continue;
      if (entry.isDirectory()) { visitDir(file); continue; }
      if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const inspect = (node: ts.Node): void => {
        let spec: ts.Expression | undefined;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier;
        else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) spec = node.arguments[0];
        else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) spec = node.moduleReference.expression;
        if (spec && ts.isStringLiteralLike(spec)) {
          const resolved = path.resolve(path.dirname(file), spec.text);
          if (resolved === memory || resolved.startsWith(memory + path.sep) || /(^|\/)pathMemory(\/|$)/.test(spec.text)) importers.add(path.relative(root, file));
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }
  };
  visitDir(src);
  assert.deepEqual([...importers].sort(), ['apps/server/src/routes/conversations.ts'], 'fence: external production pathMemory imports');
});
t('invalid audiences reject without echoing private input; denied nodes are unread', () => {
  for (const invalid of read('nodes-canary.json').invalid_audience_cases) {
    assert.throws(() => projectNodes([{ ...invalid, node_id: 'SECRET', label: 'SECRET', state: 'active' }], 'user'), /^Error: invalid memory audience$/);
  }
  const denied: any = { state: 'active', audience: { visibility: 'private', recipient_ids: ['owner'], observer_ids: ['user'] } };
  for (const key of ['node_id', 'label', 'body']) Object.defineProperty(denied, key, { get() { throw new Error('denied metadata read'); } });
  assert.deepEqual(projectNodes([denied], 'user'), []);
});
t('fixture 257 proposes replay without acceptance; mixed pages preserve all accepted effects', () => {
  const input = read('events-257.json').events;
  const full = replayEvents(input);
  let paged = replayEvents([]);
  for (let start = 0; start < input.length; start += 19) paged = replayEvents(input.slice(start, start + 19), paged);
  assert.deepEqual(paged, full); assert.equal(full.lastSequence, 257); assert.deepEqual(full.acceptedEffects, []);
  const tree = snapshot([row('H', null), row('X', 'H', 'memory-anchor', true), row('S', 'H', 'memory-anchor', true)]);
  const mixed: any[] = Array.from({ length: 1024 }, (_, i) => ({ event_id: `m${i}`, sequence: i + 1,
    ...(i % 3 === 0 ? { action: 'propose' } : i % 3 === 1 ? { action: 'reject' } : { action: 'accept', effect: { effect_id: `e${i}`, anchor_message_id: i % 2 ? 'S' : 'X' } }) }));
  for (const size of [1, 17, 256, 257, 1024]) {
    let state = replayEvents([]);
    for (let start = 0; start < mixed.length; start += size) state = replayEvents([...mixed.slice(start, start + size)].reverse(), state);
    assert.equal(JSON.stringify(state), JSON.stringify(replayEvents([...mixed].reverse())));
    assert.deepEqual(effectsAtHead(tree, state, 'X'), activeEffects(tree, mixed, 'X'));
  }
  assert.deepEqual(activeEffects(tree, mixed, 'X').map(e => e.effect_id), mixed.filter(e => e.action === 'accept' && e.effect.anchor_message_id === 'X').map(e => e.effect.effect_id));
});
t('K7 approved internal anchor only; interrupted assistant rejected', () => {
  const rows = [row('H', null), row('X', 'H', 'memory-anchor', true), row('I', 'H', 'assistant', false, 'interrupted')];
  const request = { idempotencyKey: 'k', payloadHash: 'p', expectedHead: 'X', expectedStateToken: 's', proposalOnActivePath: true };
  const state = { tree: snapshot(rows), head: 'X', stateToken: 's', activeBranch: 'b', approvedAnchorIds: ['X'], receipts: [] };
  assert.deepEqual(checkApproval(request, state), { ok: true });
  assert.deepEqual(checkApproval(request, { ...state, approvedAnchorIds: [] }), { code: 'approval-not-at-turn-boundary', reconfirm: false });
  assert.deepEqual(checkApproval({ ...request, expectedHead: 'I' }, { ...state, head: 'I' }), { code: 'approval-not-at-turn-boundary', reconfirm: false });
  for (const id of ['H', 'X']) assert.deepEqual(checkDelete(snapshot(rows), id, ['X']), { code: 'protected-memory-ancestor', reconfirm: false });
});
console.log(`pathMemoryReducer: ${branch.cases.length} branch cases; ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
