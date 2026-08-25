/** npx tsx bench/userContextBudget.test.ts
 * user_note budget helper TDD. Fixed-block split: persona first, note gets leftover.
 *
 * // PASS here is not live wiring.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// RED: module does not exist yet. createRequire resolves the TS source via tsx register.
const require2 = createRequire(import.meta.url);
let allocateUserContextBudget: (typeof import('../apps/server/src/prompt/userContextBudget'))['allocateUserContextBudget'];
try {
  allocateUserContextBudget = require2('../apps/server/src/prompt/userContextBudget.ts').allocateUserContextBudget;
} catch (e) {
  console.error('RED: helper module missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

t('profile only', () => {
  const r = allocateUserContextBudget({ totalBudget: 100, profileTokens: 40, noteTokens: 0, profileCap: null, noteCap: null });
  assert.deepEqual(r, { profileIncluded: true, profileTokensUsed: 40, noteIncluded: false, noteTokensUsed: 0 });
});

t('note only', () => {
  const r = allocateUserContextBudget({ totalBudget: 100, profileTokens: 0, noteTokens: 50, profileCap: null, noteCap: null });
  assert.deepEqual(r, { profileIncluded: false, profileTokensUsed: 0, noteIncluded: true, noteTokensUsed: 50 });
});

t('both fit', () => {
  const r = allocateUserContextBudget({ totalBudget: 100, profileTokens: 40, noteTokens: 30, profileCap: null, noteCap: null });
  assert.deepEqual(r, { profileIncluded: true, profileTokensUsed: 40, noteIncluded: true, noteTokensUsed: 30 });
});

t('both over cap → persona wins, note truncated to leftover', () => {
  const r = allocateUserContextBudget({ totalBudget: 100, profileTokens: 80, noteTokens: 60, profileCap: null, noteCap: null });
  assert.deepEqual(r, { profileIncluded: true, profileTokensUsed: 80, noteIncluded: true, noteTokensUsed: 20 });
});

t('totalBudget 0 → nothing included', () => {
  const r = allocateUserContextBudget({ totalBudget: 0, profileTokens: 10, noteTokens: 10, profileCap: null, noteCap: null });
  assert.deepEqual(r, { profileIncluded: false, profileTokensUsed: 0, noteIncluded: false, noteTokensUsed: 0 });
});

t('empty strings contribute zero tokens and are excluded', () => {
  const r = allocateUserContextBudget({ totalBudget: 100, profileTokens: 0, noteTokens: 0, profileCap: null, noteCap: null });
  assert.deepEqual(r, { profileIncluded: false, profileTokensUsed: 0, noteIncluded: false, noteTokensUsed: 0 });
});

t('profileCap truncates profile before note is considered', () => {
  const r = allocateUserContextBudget({ totalBudget: 100, profileTokens: 90, noteTokens: 20, profileCap: 50, noteCap: null });
  assert.equal(r.profileIncluded, true);
  assert.equal(r.profileTokensUsed, 50);
});

t('note gets leftover after capped profile', () => {
  const r = allocateUserContextBudget({ totalBudget: 100, profileTokens: 90, noteTokens: 20, profileCap: 50, noteCap: null });
  assert.deepEqual({ p: r.profileTokensUsed, n: [r.noteIncluded, r.noteTokensUsed] }, { p: 50, n: [true, 20] });
});

t('note truncated to leftover when it overflows', () => {
  const r = allocateUserContextBudget({ totalBudget: 100, profileTokens: 70, noteTokens: 60, profileCap: null, noteCap: null });
  assert.deepEqual(r, { profileIncluded: true, profileTokensUsed: 70, noteIncluded: true, noteTokensUsed: 30 });
});

t('noteCap caps the note independently of leftover', () => {
  const r = allocateUserContextBudget({ totalBudget: 200, profileTokens: 50, noteTokens: 100, profileCap: null, noteCap: 40 });
  assert.deepEqual(r, { profileIncluded: true, profileTokensUsed: 50, noteIncluded: true, noteTokensUsed: 40 });
});

t('CJK+ASCII mix counts as tokens given (caller estimates)', () => {
  const r = allocateUserContextBudget({ totalBudget: 10, profileTokens: 4, noteTokens: 6, profileCap: null, noteCap: null });
  assert.deepEqual(r, { profileIncluded: true, profileTokensUsed: 4, noteIncluded: true, noteTokensUsed: 6 });
});

console.log(`passed ${passed}`);
