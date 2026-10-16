/** npx tsx bench/adventurePromptCompatibility.test.ts */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { capture } from './helpers/adventurePromptCapture.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = JSON.parse(fs.readFileSync(path.join(root, 'bench/fixtures/adventure/no-adventure-prompts.json'), 'utf8')) as { calls: Array<{ label: string; sha256: string }> };
async function main() {
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-prompt-'));
await capture(out);
const calls = JSON.parse(fs.readFileSync(path.join(out, 'calls.json'), 'utf8')) as Array<{ label: string; messages: Array<{ role: string; content: string }> }>;

function sha(messages: Array<{ role: string; content: string }>): string {
  const body = JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content })));
  return createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
}

await t('no-adventure assembly labels and bytes match the BASE fixture', () => {
  assert.deepEqual(calls.map((c) => c.label), expected.calls.map((c) => c.label));
  calls.forEach((c, i) => assert.equal(sha(c.messages), expected.calls[i].sha256, c.label));
  for (const label of ['one-to-one', 'beat-N', 'beat-F', 'beat-E', 'dialog-public', 'dialog-actor']) {
    assert.equal(calls.filter((c) => c.label === label).length > 0, true, label);
  }
});
console.log(`ok ${passed} done`);
}
main().catch((err) => { console.error(err); process.exit(1); });
