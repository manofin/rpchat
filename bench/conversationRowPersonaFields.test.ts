/** npx tsx bench/conversationRowPersonaFields.test.ts
 * Official ConversationRow must declare snapshot + applied_at (nullable).
 * Helper/bench PASS is not a product PASS.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const src = fs.readFileSync(
  path.resolve('apps/server/src/types.ts'),
  'utf8',
);
const start = src.indexOf('export interface ConversationRow {');
assert.ok(start >= 0, 'ConversationRow missing');
const end = src.indexOf('\n}', start);
assert.ok(end > start, 'ConversationRow unclosed');
const block = src.slice(start, end);

const required = [
  'persona_name_snapshot',
  'persona_address_snapshot',
  'persona_appearance_snapshot',
  'persona_personality_snapshot',
  'persona_relationship_snapshot',
  'persona_applied_at',
] as const;

for (const field of required) {
  t(`${field} is string | null`, () => {
    const re = new RegExp(`^\\s*${field}:\\s*string\\s*\\|\\s*null;\\s*$`, 'm');
    assert.match(block, re);
  });
}

console.log(`passed ${passed}`);
