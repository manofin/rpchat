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
t('branch expectations stay pending D2; T11 and reachability are present', () => {
  const f = read('expected/branch-PENDING.json');
  assert.equal(f.D2, null);
  assert.equal(f.transition_document_sha256, '57dfe772ad3258b09552b348c90734f5920f11ae4aa3ebb1cef90b6ffe2e42ce');
  assert.deepEqual(f.cases.map((c: any) => c.id), ['T00','T01','T02','T03','T04a','T04b','T05a','T05b','T06a','T06b','T07','T08','T09a','T09b','T10','T11']);
  for (const c of f.cases) {
    assert.equal(c.expected, null); assert.equal(c.pending, 'D2(anchor A/C) 결정 후 채움');
    assert.ok(c.input.operation && c.input.initial_tree.length > 0);
    assert.ok(['new-navigation-assumption','new-receipt-return','current-navigation-with-new-memory-semantics','new-memory-semantics'].includes(c.reachability));
  }
  assert.equal(f.cases.find((c: any) => c.id === 'T11').input.precondition, 'leaf-L-before-acceptance');
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
