/**
 * npx tsx bench/approveStoryExtras.test.ts
 * story-peer-cast-extra-policy — ADR-F8e Fork C1 isolated.
 * Isolated: no systemd, no live DB, no model, no migration, no live generate.
 * Does not import chat.ts. Does not edit approveExtras.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EXTRA_SCORE_ENABLED, approveExtras } from '../apps/server/src/prompt/approveExtras.ts';
import type { CastMember } from '../apps/server/src/prompt/cast.ts';
import type { PartyCatalog } from '../apps/server/src/prompt/applySceneDelta.ts';
import type { Scene } from '../apps/server/src/types.ts';

const require2 = createRequire(import.meta.url);
let approveStoryExtras: typeof import('../apps/server/src/prompt/approveStoryExtras.js')['approveStoryExtras'];
try {
  approveStoryExtras = require2('../apps/server/src/prompt/approveStoryExtras.ts').approveStoryExtras;
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

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

const FROST = 'f89ace9b-8684-4d97-96dc-e00c4b25a819';
const KAI = '255f96a2-d78e-433d-9169-fb6da6e0963f';

const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [],
  duties: [],
  place: '의무실',
  role: 'secondary',
  ...o,
});

const ROSETTA = member({ id: 'rosetta', name: '로제타' });
const GIYAM = member({ id: 'giyam', name: '기얌' });
const MIRA = member({ id: 'mira', name: '미라' });
const NARA = member({ id: 'nara', name: '나라' });

const bothPresent: Scene = {
  location: '의무실',
  present_ids: ['rosetta', 'giyam'],
};

const EMPTY_CAT = { flags: {} } as PartyCatalog;

const run = (o: Partial<Parameters<typeof approveStoryExtras>[0]> = {}) =>
  approveStoryExtras({
    cast: [ROSETTA, GIYAM],
    scene: bothPresent,
    focus_id: 'rosetta',
    ...o,
  });

const ids = (r: ReturnType<typeof approveStoryExtras>) => r.approved.map((a) => a.character_id);
const why = (r: ReturnType<typeof approveStoryExtras>, id: string) =>
  r.rejected.find((x) => x.id === id)?.reason;

t('1 two present, focus one, other is extra', () => {
  const r = run();
  assert.deepEqual(ids(r), ['giyam']);
  assert.equal(r.k_opened, 1);
  assert.equal(why(r, 'rosetta'), 'is_focus');
});

t('2 previous extra is self_repeat', () => {
  const r = run({ previous_extra_ids: ['giyam'] });
  assert.deepEqual(ids(r), []);
  assert.equal(r.k_opened, 0);
  assert.equal(why(r, 'giyam'), 'self_repeat');
});

t('3 solo participant extra 0', () => {
  const r = run({
    cast: [ROSETTA],
    scene: { location: '의무실', present_ids: ['rosetta'] },
    focus_id: 'rosetta',
  });
  assert.deepEqual(ids(r), []);
  assert.equal(r.k_opened, 0);
});

t('4a background extra 0', () => {
  const bg = member({ id: 'giyam', name: '기얌', role: 'background' });
  const r = run({ cast: [ROSETTA, bg] });
  assert.deepEqual(ids(r), []);
  assert.equal(why(r, 'giyam'), 'background');
});

t('4b locked extra 0', () => {
  const locked = member({ id: 'giyam', name: '기얌', locked: true });
  const r = run({ cast: [ROSETTA, locked] });
  assert.deepEqual(ids(r), []);
  assert.equal(why(r, 'giyam'), 'locked');
});

t('5 focus null extra 0', () => {
  const r = run({ focus_id: null });
  assert.deepEqual(ids(r), []);
  assert.equal(r.k_opened, 0);
  assert.equal(why(r, 'rosetta'), 'no_focus');
  assert.equal(why(r, 'giyam'), 'no_focus');
});

t('6 more than two candidates cap at 2', () => {
  const r = run({
    cast: [ROSETTA, GIYAM, MIRA, NARA],
    scene: { location: '의무실', present_ids: ['rosetta', 'giyam', 'mira', 'nara'] },
    focus_id: 'rosetta',
  });
  assert.deepEqual(ids(r), ['giyam', 'mira']);
  assert.equal(r.k_opened, 2);
  assert.equal(why(r, 'nara'), 'cap');
});

t('7 call itself is story-room; legacy approveExtras unchanged; canonical cap', () => {
  const r = run();
  assert.deepEqual(ids(r), ['giyam']);
  assert.equal(r.k_opened, 1);

  const impl = read('apps/server/src/prompt/approveStoryExtras.ts');
  assert.equal(impl.includes('story?:'), false);
  assert.equal(impl.includes('not_story'), false);
  assert.equal(impl.includes('STORY_EXTRA_K'), false);
  assert.equal(impl.includes('MAX_EXTRAS'), true);
  assert.match(impl, /from '\.\/assignSpeakers\.js'/);

  assert.equal(EXTRA_SCORE_ENABLED, false);
  const legacy = approveExtras({
    cast: [ROSETTA, GIYAM],
    scene: bothPresent,
    focus_id: 'rosetta',
    catalog: EMPTY_CAT,
    applied_events: [],
  });
  assert.deepEqual(legacy.approved, []);
  assert.equal(legacy.k_opened, 0);
  assert.equal(legacy.score_ran, false);
});

t('8 frost/kai ids are not fixtures; generate path not imported', () => {
  const fixtureIds = [ROSETTA.id, GIYAM.id, MIRA.id, NARA.id];
  assert.equal(fixtureIds.includes(FROST), false);
  assert.equal(fixtureIds.includes(KAI), false);
  const impl = read('apps/server/src/prompt/approveStoryExtras.ts');
  assert.equal(impl.includes(FROST), false);
  assert.equal(impl.includes(KAI), false);
  assert.equal(impl.includes('approveExtras'), false);
  assert.equal(impl.includes('chat.ts'), false);
  assert.equal(impl.includes('templates.ts'), false);
  const chat = read('apps/server/src/routes/chat.ts');
  assert.equal(chat.includes('approveStoryExtras'), false);
  const templates = read('apps/server/src/prompt/templates.ts');
  assert.equal(templates.includes('approveStoryExtras'), false);
  const extras = read('apps/server/src/prompt/approveExtras.ts');
  assert.equal(extras.includes('approveStoryExtras'), false);
});

console.log(`passed ${passed}`);
