/** node --import tsx bench/fixtures/pathMemory/generate.ts [--write]
 * Deterministic fixture authoring only. No product projector/reducer, DB or model.
 * Default verifies reproducibility without modifying files. --write freezes files.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../../..');
const write = process.argv.includes('--write');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const privateTo = (recipients: string[], observers: string[] = []) => ({ visibility: 'private', recipient_ids: recipients, observer_ids: observers });
// These declared columns author BOTH inputs and membership tables. They do not
// inspect/project node audiences. A separate bench audits their consistency.
const assignmentRules = [
  { slot: 0, state: 'active', audience: { visibility: 'public' }, allowed: ['gm', 'synthetic-01', 'synthetic-02', 'synthetic-03', 'synthetic-17', 'user'], explicitUser: false },
  { slot: 1, state: 'active', audience: privateTo(['gm']), allowed: ['gm'], explicitUser: false },
  { slot: 2, state: 'active', audience: privateTo(['synthetic-01']), allowed: ['synthetic-01'], explicitUser: false },
  { slot: 3, state: 'active', audience: privateTo(['synthetic-02']), allowed: ['synthetic-02'], explicitUser: false },
  { slot: 4, state: 'active', audience: privateTo(['synthetic-03']), allowed: ['synthetic-03'], explicitUser: false },
  { slot: 5, state: 'active', audience: privateTo(['user']), allowed: ['user'], explicitUser: true },
  { slot: 6, state: 'active', audience: privateTo([], ['synthetic-17']), allowed: [], explicitUser: false },
  { slot: 7, state: 'closed', audience: { visibility: 'public' }, allowed: [], explicitUser: false },
  { slot: 8, state: 'active', audience: privateTo(['synthetic-01'], ['synthetic-17']), allowed: ['synthetic-01'], explicitUser: false },
];
const recipients = [
  { id: 'gm', pass: 'N' }, { id: 'synthetic-01', pass: 'F' },
  { id: 'synthetic-02', pass: 'E' }, { id: 'synthetic-03', pass: 'E' },
  { id: 'synthetic-17', pass: 'observer-no-request' },
  { id: 'user', pass: 'explicit-player-knowledge-no-model-request' },
];
const outputs = new Map<string, string>();
for (const size of [0, 17, 256, 257, 1024]) {
  const expected = recipients.map(r => ({ ...r, node_ids: [] as string[] }));
  const nodes = Array.from({ length: size }, (_, index) => {
    const rule = assignmentRules[index % assignmentRules.length];
    const id = `n${String(index + 1).padStart(4, '0')}`;
    for (const recipient of expected) if (rule.allowed.includes(recipient.id)) recipient.node_ids.push(id);
    return { node_id: id, ordinal: index + 1, rule_slot: rule.slot, kind: 'knowledge', state: rule.state,
      label: `N${size}_LABEL_${id} 여러 어절 합성 물건`, body: `N${size}_BODY_${id} 승인 여부를 시험하는 합성 기억이다.`,
      audience: rule.audience, explicit_user_recipient: rule.explicitUser };
  });
  outputs.set(`nodes-N${size}.json`, json({ version: 1, count: size, nodes }));
  outputs.set(`expected/recipients-N${size}.json`, json({ version: 1, source: 'generate.ts assignmentRules.allowed column; no projector', recipients: expected }));
}
for (const count of [256, 257]) outputs.set(`events-${count}.json`, json({
  version: 1, purpose: 'event-count/order input only; no replay expectation', node_count: 17,
  events: Array.from({ length: count }, (_, i) => ({ event_id: `e${String(i + 1).padStart(4, '0')}`, sequence: i + 1,
    node_id: `n${String(i % 17 + 1).padStart(4, '0')}`, action: 'propose', proposal_id: `p${i + 1}` })),
}));
const names = ['cast17.json', 'nodes-canary.json', 'expected/recipients-canary.json', 'expected/branch-PENDING.json', 'generate.ts', ...outputs.keys()].sort();
const manifest = {
  version: 1, base: '7cbb1d0959998022135c6d792f6d846ea3785060',
  freeze_scope: 'listed files; MANIFEST cannot hash itself; compare its hash in the execution receipt',
  estimator: { function: 'estimateTokensRaw', path: 'apps/server/src/prompt/tokens.ts', calibration: 1,
    sha256: sha(fs.readFileSync(path.join(root, 'apps/server/src/prompt/tokens.ts'))), kind: 'heuristic estimate, not a model tokenizer' },
  context_tokens: 16384, context_source: 'user-authorized assumption; live process settings not re-read',
  output_reservation: { N: 300, F: 500, E: 220 }, output_reservation_source: 'routes/chat.ts constants at frozen BASE; normal response length',
  message_overhead_tokens: 5, budget_scope: 'pure N/F/E prompt strings with synthetic narration and focus output; no model call, history fit or HTTP request capture',
  assignmentRules,
  files: Object.fromEntries(names.map(name => [name, sha(outputs.has(name) ? Buffer.from(outputs.get(name)!) : fs.readFileSync(path.join(dir, name)))])),
};
outputs.set('MANIFEST.json', json(manifest));
for (const [name, content] of outputs) {
  if (write) fs.writeFileSync(path.join(dir, name), content);
  else assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), content, `non-deterministic fixture: ${name}`);
}
console.log(`${write ? 'froze' : 'verified'} ${outputs.size} deterministic files`);
