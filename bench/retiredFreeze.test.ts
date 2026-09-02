/**
 * npx tsx bench/retiredFreeze.test.ts
 *
 * `bench/retired/` holds frozen copies of product modules that a CLOSED
 * measurement was run against. Their whole value is that they cannot drift: the
 * moment one of them is imported by product code, or starts importing a live
 * module whose behaviour can change, the recorded result stops meaning what it
 * says.
 *
 * This is the cheap guard for that. It is a grep, deliberately.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const retiredDir = path.join(dir, 'retired');

function walk(root: string, ext: RegExp): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (ext.test(e.name)) out.push(p);
  }
  return out;
}

const FROZEN = ['retiredRouter.ts', 'retiredAuxGate.ts'];

t('the frozen modules exist under bench/retired, not beside product code', () => {
  for (const f of FROZEN) {
    assert.ok(fs.existsSync(path.join(retiredDir, 'triggerSupply', f)), f);
    assert.equal(fs.existsSync(path.join(appRoot, 'apps/server/src/prompt', f)), false, `${f} must not be in apps/**`);
  }
  // and the modules they replaced really are gone from product
  for (const f of ['pickSpeaker.ts', 'auxGate.ts', 'auxSpeakerPrompt.ts', 'composePartyTurn.ts']) {
    assert.equal(fs.existsSync(path.join(appRoot, 'apps/server/src/prompt', f)), false, f);
  }
});

t('each frozen module carries the PROD_IMPORT_FORBIDDEN marker', () => {
  for (const f of FROZEN) {
    const s = fs.readFileSync(path.join(retiredDir, 'triggerSupply', f), 'utf8');
    assert.ok(s.includes('PROD_IMPORT_FORBIDDEN'), f);
  }
});

t('no product file imports anything under bench/', () => {
  for (const p of walk(path.join(appRoot, 'apps'), /\.(ts|tsx)$/)) {
    if (p.includes(`${path.sep}dist`) || p.includes('node_modules')) continue;
    const s = fs.readFileSync(p, 'utf8');
    assert.equal(/from ['"][^'"]*bench\//.test(s), false, `${p} imports from bench/`);
    assert.equal(/retiredRouter|retiredAuxGate/.test(s), false, `${p} references a frozen module`);
  }
});

t('the frozen modules import no live runtime value — only types', () => {
  for (const f of FROZEN) {
    const s = fs.readFileSync(path.join(retiredDir, 'triggerSupply', f), 'utf8');
    for (const line of s.match(/^import .*$/gm) ?? []) {
      if (!line.includes('apps/server/src')) continue;
      assert.ok(line.startsWith('import type'),
        `${f}: "${line.trim()}" is a runtime import — a later change to it would rewrite a closed result`);
    }
  }
});

t('the frozen router keeps the retired scoring, and product does not', () => {
  const frozen = fs.readFileSync(path.join(retiredDir, 'triggerSupply', 'retiredRouter.ts'), 'utf8');
  assert.ok(frozen.includes('const WIN = 95;'), 'the measured behaviour must still be here');
  assert.ok(frozen.includes('llm_reached'));

  const promptDir = path.join(appRoot, 'apps/server/src/prompt');
  for (const f of fs.readdirSync(promptDir)) {
    const s = fs.readFileSync(path.join(promptDir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/const WIN = 95|llm_reached|decided_stage/.test(s), false, `${f} must not revive scoring`);
  }
});

t('the frozen gate keeps secondary_triggers, and product does not', () => {
  const frozen = fs.readFileSync(path.join(retiredDir, 'triggerSupply', 'retiredAuxGate.ts'), 'utf8');
  assert.ok(frozen.includes('secondary_triggers'), 'the measured field must still be here');

  const promptDir = path.join(appRoot, 'apps/server/src/prompt');
  for (const f of fs.readdirSync(promptDir)) {
    const s = fs.readFileSync(path.join(promptDir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/secondary_triggers|parseSecondaryTriggers|trigger_exists/.test(s), false, `${f}`);
  }
});

t('the retired suite reads as retired: its runners live under bench/retired only', () => {
  assert.equal(fs.existsSync(path.join(dir, 'triggerSupply')), false,
    'the old bench/triggerSupply path must not come back — it reads as a live regression suite');
  for (const f of ['run.ts', 'run-aprime.ts', 'run-candidate.ts', 'filter.ts']) {
    assert.ok(fs.existsSync(path.join(retiredDir, 'triggerSupply', f)), f);
  }
  // the recorded results moved with them
  assert.ok(fs.existsSync(path.join(retiredDir, 'triggerSupply', 'results')));
});

console.log(`\n${passed} passed`);
