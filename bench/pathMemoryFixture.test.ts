/**
 * npm run test:benches -- pathMemoryFixture --output-dir /tmp/path-memory-fixture
 * Offline fixture audit and pure Pass N/F/E cost measurement only. No projector,
 * reducer, DB opening, model/network calls, live data, source mutation or migration.
 * Artifacts: <out>/pathMemoryFixture-artifacts/budget-baseline.json.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { audienceSchema } from '../apps/server/src/prompt/observation.ts';
import { estimateTokensRaw } from '../apps/server/src/prompt/tokens.ts';
import { planBeat, passFWith, planPassE, type BeatPlanInput } from '../apps/server/src/prompt/composeBeat.ts';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'bench/fixtures/pathMemory');
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const manifest = read('MANIFEST.json');
let passed = 0;
function t(name: string, fn: () => void) { fn(); console.log(`ok ${++passed} ${name}`); }
t('MANIFEST hashes every fixture and generator without gaps', () => {
  const listed = Object.keys(manifest.files).sort();
  const actual = fs.readdirSync(dir).filter(n => n !== 'MANIFEST.json' && n !== 'expected')
    .concat(fs.readdirSync(path.join(dir, 'expected')).map(n => `expected/${n}`)).sort();
  assert.deepEqual(listed, actual);
  for (const file of listed) assert.equal(hash(fs.readFileSync(path.join(dir, file))), manifest.files[file], `manifest hash mismatch: ${file}`);
  assert.equal(hash(fs.readFileSync(path.join(root, manifest.estimator.path))), manifest.estimator.sha256);
  assert.equal(manifest.estimator.function, 'estimateTokensRaw');
  assert.equal(manifest.estimator.calibration, 1);
  assert.equal(manifest.context_tokens, 16384);
  assert.deepEqual(manifest.output_reservation, { N: 300, F: 500, E: 220 });
});
const cast = read('cast17.json');
t('17 synthetic cards retain measured field lengths and stable IDs/order', () => {
  assert.equal(cast.cards.length, 17);
  assert.equal(new Set(cast.cards.map((c: any) => c.id)).size, 17);
  cast.cards.forEach((c: any, i: number) => {
    assert.equal(c.ordinal, i + 1); assert.equal(c.id, `synthetic-${String(i + 1).padStart(2, '0')}`);
    for (const [field, length] of Object.entries(c.measured_lengths)) {
      if (field === 'name') continue; // Deliberate name stress cases, documented in cast provenance.
      assert.equal([...c.fields[field]].length, length, `${c.id}.${field}`);
    }
    assert.ok(Array.isArray(JSON.parse(c.fields.tags_json)));
  });
  assert.ok([...cast.cards[0].fields.name].length > 12);
  assert.match(cast.cards[1].fields.name, /\S+ \S+/);
  assert.equal(cast.cards[2].fields.name, cast.cards[3].fields.name);
  assert.notEqual(cast.cards[2].id, cast.cards[3].id);
});
const sizes = [0, 17, 256, 257, 1024];
const inputs = [{ name: 'canary', data: read('nodes-canary.json') }, ...sizes.map(n => ({ name: `N${n}`, data: read(`nodes-N${n}.json`) }))];
for (const { name, data } of inputs) t(`${name} audiences are valid; user is never implicit`, () => {
  const ids = new Set<string>();
  for (const n of data.nodes) {
    assert.ok(!ids.has(n.node_id)); ids.add(n.node_id);
    const audience = audienceSchema.parse(n.audience);
    assert.ok(['active', 'closed'].includes(n.state));
    const explicit = audience.visibility === 'private' && audience.recipient_ids.includes('user');
    assert.equal(n.explicit_user_recipient, explicit, `${n.node_id}: user flag mismatch`);
    if (audience.visibility === 'private') for (const id of [...audience.recipient_ids, ...audience.observer_ids]) {
      assert.ok(['gm', 'user', ...cast.cards.map((c: any) => c.id)].includes(id), `unknown recipient: ${id}`);
    }
  }
});
t('missing and malformed audiences are rejected by the existing strict schema', () => {
  const cases = inputs[0].data.invalid_audience_cases;
  assert.ok(cases.some((c: any) => !('audience' in c)));
  for (const c of cases) assert.equal(audienceSchema.safeParse(c.audience).success, false, c.id);
});
t('canary cases cover every permission boundary with unique label/body markers', () => {
  const nodes = inputs[0].data.nodes;
  assert.ok(nodes.some((n: any) => n.audience.visibility === 'public'));
  for (const id of ['gm', 'user', 'synthetic-01']) assert.ok(nodes.some((n: any) => JSON.stringify(n.audience.recipient_ids) === JSON.stringify([id])));
  assert.ok(nodes.some((n: any) => n.audience.recipient_ids?.length === 0 && n.audience.observer_ids.includes('synthetic-17')));
  assert.ok(nodes.some((n: any) => n.state === 'closed'));
  const markers = nodes.flatMap((n: any) => [n.label.split(' ')[0], n.body.split(' ')[0]]);
  assert.equal(new Set(markers).size, nodes.length * 2);
});
// Audit the authored truth tables, not a production filtering implementation.
// No selected packet is produced or returned by this loop.
for (const { name, data } of inputs) t(`${name} authored recipient table obeys ADR body/index permissions`, () => {
  const expected = read(`expected/recipients-${name}.json`);
  assert.deepEqual(expected.recipients.map((r: any) => r.id), ['gm', 'synthetic-01', 'synthetic-02', 'synthetic-03', 'synthetic-17', 'user']);
  for (const r of expected.recipients) {
    const listed = new Set(r.node_ids);
    assert.equal(listed.size, r.node_ids.length, 'duplicate expected membership');
    for (const id of listed) assert.ok(data.nodes.some((n: any) => n.node_id === id), `unknown expected node: ${id}`);
    for (const n of data.nodes) {
      const a = n.audience;
      if (n.state === 'closed') assert.ok(!listed.has(n.node_id), `${r.id}: closed node ${n.node_id}`);
      else if (a.visibility === 'public') assert.ok(listed.has(n.node_id), `${r.id}: missing public ${n.node_id}`);
      else if (a.recipient_ids.includes(r.id)) assert.ok(listed.has(n.node_id), `${r.id}: missing recipient ${n.node_id}`);
      else assert.ok(!listed.has(n.node_id), `${r.id}: unauthorized membership ${n.node_id}`);
      if (a.visibility === 'private' && a.observer_ids.includes(r.id) && !a.recipient_ids.includes(r.id)) {
        assert.ok(!listed.has(n.node_id), `${r.id}: observer received body/index ${n.node_id}`);
      }
    }
  }
});
for (const n of sizes) t(`N${n} node count and order (not replay)`, () => {
  const fixture = read(`nodes-N${n}.json`);
  assert.equal(fixture.count, n); assert.equal(fixture.nodes.length, n);
  fixture.nodes.forEach((row: any, i: number) => { assert.equal(row.ordinal, i + 1); assert.equal(row.node_id, `n${String(i + 1).padStart(4, '0')}`); });
});
for (const count of [256, 257]) t(`${count} events counted independently of 17 nodes (not replay)`, () => {
  const f = read(`events-${count}.json`);
  assert.equal(f.node_count, 17); assert.equal(f.events.length, count);
  assert.equal(new Set(f.events.map((e: any) => e.node_id)).size, 17);
  f.events.forEach((e: any, i: number) => { assert.equal(e.sequence, i + 1); assert.equal(e.event_id, `e${String(i + 1).padStart(4, '0')}`); });
});
const branch = read('expected/branch-A.json');
t('branch A binds the adopted decisions and documents', () => {
  assert.equal(branch.D2, 'A'); assert.equal(branch.K2, 'b'); assert.equal(branch.K3, '(i)'); assert.equal(branch.K7, 'a'); assert.equal(branch.K8, 'a');
  assert.equal(branch.adr_sha256, '0db1e2c06871ebe1fd798f2b2375118fef5319542deeca456662034371ffd629');
  assert.equal(branch.transition_document_sha256, '96be33cead1f596cd67f2b41d1a6976e2c0cd95758748e49916a1a9c2aeae7a1');
  assert.equal(branch.authorship, 'handwritten from transition table column A + K2-b rules; not produced by a reducer/projector');
});
t('branch cases cover all 29 cases T00 through T23 without duplicate or pending expectations', () => {
  assert.deepEqual(branch.cases.map((c: any) => c.id), ['T00','T01','T02','T03','T04a','T04b','T05a','T05b','T06a','T06b','T07','T07b','T08','T09a','T09b','T10','T11','T12','T13','T14','T15','T16','T17','T18','T19','T20','T21','T22','T23']);
  assert.equal(branch.cases.length, 29);
  for (const c of branch.cases) {
    assert.ok(c.expected && c.basis.length > 0); assert.equal('pending' in c, false);
    assert.equal(c.expected.reachability, c.reachability);
  }
});
// Inspect authored tables for contradictions; do not execute commands or produce a state.
for (const c of branch.cases) t(`${c.id} authored branch table is self-consistent`, () => {
  const { input: i, expected: e } = c;
  for (const row of [...i.initial_tree, ...e.final_tree]) assert.ok(['complete','streaming','error','interrupted'].includes(row.status), `${c.id}: explicit status required`);
  if (['retry-accept-same-key','retry-accept-different-payload'].includes(i.operation)) {
    const head = i.initial_tree.find((row: any) => row.id === i.initial_head);
    assert.ok(head && ((head.role === 'assistant' && head.status === 'complete') || head.internal === true), `${c.id}: K5 c starting head must satisfy K7`);
  }
  const auditGates = (entry: any) => {
    const input = entry.input, expected = entry.expected;
    if (['accept','accept-at-leaf-LA-then-regenerate-H'].includes(input.operation) || entry.basis?.includes('K8')) {
      const head = input.initial_tree.find((r: any) => r.id === input.initial_head); assert.ok(head);
      const actual = {
        'K5 a': input.proposal_branch === input.active_branch,
        'K5 b': input.expected_head === input.initial_head && input.expected_state_token === input.state_token,
        'K5 c': !input.previous_receipt || input.idempotency_key !== input.previous_receipt.idempotency_key || input.payload_hash === input.stored_payload_hash,
        K7: (head.role === 'assistant' && head.status === 'complete') || head.internal === true,
      };
      const failed = Object.entries(actual).filter(([, pass]) => !pass).map(([key]) => key);
      const intended = Array.isArray(entry.intended_failure) ? entry.intended_failure : entry.intended_failure ? [entry.intended_failure] : [];
      assert.deepEqual(failed, intended, `${entry.id}: authored failure set must match inputs`);
      if (typeof entry.intended_failure === 'string') assert.equal(failed.length, 1, `${entry.id}: exactly one intended gate may fail`);
      assert.deepEqual(entry.gate_table, actual, `${entry.id}: gate table must match inputs`);
      const sameReceipt = input.previous_receipt && input.idempotency_key === input.previous_receipt.idempotency_key
        && input.payload_hash === input.stored_payload_hash;
      const first = (['K5 c', 'K5 b', 'K5 a', 'K7'] as const).find(key => !actual[key]);
      if (sameReceipt) {
        assert.equal(expected.rejected, null, `${entry.id}: K8 c returns receipt before stale check`);
        assert.deepEqual(expected.receipt, input.previous_receipt);
        assert.equal(expected.final_head, input.initial_head);
        assert.deepEqual(expected.final_tree, input.initial_tree);
      } else if (first) {
        const codes: Record<string, string> = { 'K5 c': 'idempotency-payload-conflict', 'K5 a': 'proposal-branch-mismatch', 'K5 b': 'stale-approval-state', K7: 'approval-not-at-turn-boundary' };
        assert.equal(expected.rejected?.code, codes[first], `${entry.id}: K8 first failed gate must reject`);
        assert.equal(expected.rejected.reconfirm, first === 'K5 a' || first === 'K5 b');
      } else assert.equal(expected.rejected, null);
      if (expected.rejected) {
        assert.deepEqual(expected.final_tree, input.initial_tree);
        assert.equal(expected.final_head, input.initial_head);
      }
    }
  };
  auditGates(c);
  for (const variant of c.variants ?? []) auditGates(variant);
  for (const variant of i.mismatch_variants ?? []) auditGates({ ...c, input: { ...i, ...variant } });
  if (e.rejected) {
    assert.deepEqual(Object.entries(c.gate_table).filter(([, pass]) => !pass).map(([key]) => key), Array.isArray(c.intended_failure) ? c.intended_failure : [c.intended_failure], `${c.id}: rejection table identifies authored failures`);
  }
  for (const id of i.recorded_approval_heads ?? (i.recorded_approval_head ? [i.recorded_approval_head] : [])) {
    const row = i.initial_tree.find((r: any) => r.id === id);
    assert.ok(row && ((row.role === 'assistant' && row.status === 'complete') || row.internal), `${c.id}: historical approval must satisfy K7`);
  }

  const ids = new Set(e.final_tree.map((r: any) => r.id));
  assert.equal(ids.size, e.final_tree.length);
  assert.ok(e.final_head === null ? ids.size === 0 : ids.has(e.final_head));
  for (const row of e.final_tree) assert.ok(row.parent === null || ids.has(row.parent));
  assert.deepEqual([...e.preserved_ids].sort(), [...ids].sort());
  const ancestors = (tree: any[], head: string | null) => {
    const seen = new Set<string>();
    while (head !== null) {
      assert.ok(!seen.has(head), `${c.id}: ancestry cycle`); seen.add(head);
      const row = tree.find((r: any) => r.id === head); assert.ok(row, `${c.id}: missing ancestor`); head = row.parent;
    }
    return seen;
  };
  const pathIds = ancestors(e.final_tree, e.final_head);
  const initialPath = ancestors(i.initial_tree, i.initial_head);
  const sharedApproval = i.initial_tree.some((r: any) => r.internal && initialPath.has(r.id) && pathIds.has(r.id));
  assert.equal(i.within_approved_branch, sharedApproval, `${c.id}: within_approved_branch must describe both endpoints`);
  if (e.siblings) for (const [id, siblings] of Object.entries(e.siblings)) {
    const row = e.final_tree.find((r: any) => r.id === id); assert.ok(row && !row.internal);
    const sameParentAndRole = e.final_tree.filter((r: any) => !r.internal && r.parent === row.parent && r.role === row.role).map((r: any) => r.id);
    assert.deepEqual(siblings, sameParentAndRole, `${c.id}: siblings must share actual parent and role`);
  }
  if (i.operation === 'retry-accept-different-payload' && i.payload_hash !== i.stored_payload_hash) {
    assert.deepEqual(e.rejected, { code: 'idempotency-payload-conflict', reconfirm: false });
  }

  const final = e.final_tree.find((r: any) => r.id === e.final_head);
  if (final?.internal) assert.ok(['accept','explicit-return'].includes(i.operation) || (i.operation === 'delete-fallback' && i.within_approved_branch), `${c.id}: forbidden internal final head`);
  if (i.operation === 'select' || (i.operation === 'delete-fallback' && !i.within_approved_branch)) {
    const entryPath = ancestors(i.initial_tree, i.target ?? i.initial_head);
    for (const row of e.final_tree.filter((r: any) => r.internal && pathIds.has(r.id))) assert.ok(entryPath.has(row.id), `${c.id}: general navigation entered internal child`);
  }
  if (e.rejected !== null) {
    assert.deepEqual(e.final_tree, i.initial_tree, `${c.id}: rejected request changed tree`);
    assert.equal(e.final_head, i.initial_head, `${c.id}: rejected request changed head`);
  }
  // Independent invalid-input predicates: removing a rejection cannot bypass this audit.
  if (!c.basis.includes('K8') && i.proposal_branch && i.proposal_branch !== i.active_branch) assert.equal(e.rejected?.code, 'proposal-branch-mismatch');
  if (i.operation === 'accept' && (('expected_head' in i && i.expected_head !== i.initial_head) || ('expected_state_token' in i && i.expected_state_token !== i.state_token))) {
    assert.equal(e.rejected?.code, 'stale-approval-state', `${c.id}: stale approval must reject`);
    assert.equal(e.rejected.reconfirm, true);
  }
  const projection = (state: any) => {
    const internalIds = new Set(state.final_tree.filter((r: any) => r.internal).map((r: any) => r.id));
    const walk = (value: any): void => {
      if (typeof value === 'string') assert.ok(!internalIds.has(value), `${c.id}: internal ID in display projection`);
      else if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) { assert.ok(!internalIds.has(key)); walk(v); }
    };
    walk(state.display_projection);
    const projected = state.display_projection.messages;
    assert.ok(state.display_projection.head === null || projected.some((r: any) => r.id === state.display_projection.head));
    for (const row of projected) assert.ok(row.parent === null || projected.some((r: any) => r.id === row.parent));
  };
  projection(e);
  if (e.after_send) projection(e.after_send);
});
t('T07 returns the T01 receipt without moving the current head', () => {
  const a = branch.cases.find((c: any) => c.id === 'T01');
  const retry = branch.cases.find((c: any) => c.id === 'T07');
  assert.deepEqual(retry.expected.receipt, a.expected.receipt);
  assert.equal(retry.expected.final_head, retry.input.initial_head);
  assert.deepEqual(retry.expected.final_tree, retry.input.initial_tree);
});
t('K2 explicit return and sibling tables preserve internal boundaries', () => {
  const c = (id: string) => branch.cases.find((x: any) => x.id === id);
  assert.equal(c('T12').expected.final_head, 'X1'); assert.deepEqual(c('T12').expected.active_effect_ids, ['e1']);
  assert.equal(c('T13').expected.final_head, 'H'); assert.deepEqual(c('T13').expected.active_effect_ids, []);
  assert.equal(c('T16').expected.final_head, 'LA');
  assert.deepEqual(c('T17').expected.siblings, { L: ['L','R'], R: ['L','R'], U: ['U'] });
});
t('T18 display head and streamed parent differ from validation state', () => {
  const e = branch.cases.find((c: any) => c.id === 'T18').expected;
  assert.equal(e.final_head, 'X'); assert.equal(e.display_projection.head, 'H');
  assert.equal(e.validation_state.actual_head, e.final_head);
  assert.equal(e.after_send.display_projection.messages.find((r: any) => r.id === 'U').parent, 'H');
  assert.equal(e.after_send.validation_state.actual_head, 'U');
  assert.notEqual(e.validation_state.token, e.after_send.validation_state.token);
});
function budgetBaseline(): string {
  const scenario = cast.scenario;
  const members = cast.cards.map((c: any, i: number) => ({ id: c.id, name: c.fields.name, aliases: [], duties: [], place: scenario.place, role: i === 0 ? 'main' : 'secondary' }));
  const input: BeatPlanInput = {
    conversation_id: 'synthetic-conversation', message_id: 'synthetic-message', main_character_id: scenario.roles.focus,
    story_room: true, participant_ids: members.map((m: any) => m.id),
    scene: { location: scenario.place, scene_version: 0, present_ids: members.map((m: any) => m.id), clock_minutes: 540 },
    catalog: catalogFromStory(JSON.stringify({ places: [{ id: scenario.place, default_focus: scenario.roles.focus }] })),
    current_version: 0, user_text: scenario.user_text, user_name: '플레이어', cast: members,
    cards: Object.fromEntries(cast.cards.map((c: any) => [c.id, c.fields])),
    observation_enabled: true, user_audience: { visibility: 'public' }, narration_audience: { visibility: 'public' }, focus_audience: { visibility: 'public' },
  };
  const plan = planBeat(input);
  assert.equal(plan.called_model, false);
  assert.equal(plan.focus.focus_id, scenario.roles.focus);
  const extras = planPassE(input, plan, scenario.narration, scenario.focus_text);
  assert.deepEqual(extras.map(e => e.character_id), scenario.roles.extras);
  const focus = passFWith(input, plan, scenario.narration); assert.ok(focus);
  const prompts = [{ recipient: 'gm', pass: 'N', prompt: plan.pass_n }, { recipient: plan.focus.focus_id, pass: 'F', prompt: focus }, ...extras.map(e => ({ recipient: e.character_id, pass: 'E', prompt: e.prompt }))];
  const rows = prompts.map(({ recipient, pass, prompt }) => {
    const content = estimateTokensRaw(prompt);
    const existing = content + manifest.message_overhead_tokens;
    const reserve = manifest.output_reservation[pass];
    const margin = manifest.context_tokens - reserve - existing;
    assert.ok(margin >= 0, `${pass} synthetic baseline exceeds context`);
    return { recipient, pass, prompt_sha256: hash(prompt), content_estimated_tokens: content,
      message_overhead_tokens: manifest.message_overhead_tokens, existing_request_estimated_tokens: existing,
      context_tokens: manifest.context_tokens, output_reserved_tokens: reserve, input_budget_tokens: manifest.context_tokens - reserve, remaining_estimated_tokens: margin };
  });
  return JSON.stringify({ version: 1, base: manifest.base, fixture_manifest_sha256: hash(fs.readFileSync(path.join(dir, 'MANIFEST.json'))),
    estimator: manifest.estimator, scope: manifest.budget_scope, cast_count: 17,
    caveat: 'Synthetic pure-prompt estimate only, not live request/tokenizer measurement or a product memory cap. No path-memory injection/projector, no new 1:1 byte gate.',
    requests: rows }, null, 2) + '\n';
}
t('pure N/F/E baseline has stable bytes and records remaining estimated budget', () => {
  const first = budgetBaseline(); assert.equal(budgetBaseline(), first);
  const artifact = process.env.RPCHAT_BENCH_ARTIFACT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'path-memory-budget-'));
  fs.writeFileSync(path.join(artifact, 'budget-baseline.json'), first);
});
console.log(`pathMemoryFixture: ${passed} checks passed`);
