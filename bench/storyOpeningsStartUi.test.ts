/** npx tsx bench/storyOpeningsStartUi.test.ts
 * ADR-F8f Slice 3 (story-multi-opening-slice3-start-ui): start-sheet opening picker.
 * Production opening-picker callbacks + helper; UI playtest is separate.
 * No live HTTP / systemd / DB / commit / deploy / restart.
 */
import assert from 'node:assert/strict';
import { loadedStoryStart, storyFixture, nodes, one, button, tick } from './helpers/storyUiHarness.ts';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
try {
  require2('../apps/web/src/pages/StoryPage.tsx');
} catch (e) {
  console.error('RED: StoryPage missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

let passed = 0;
async function t(name: string, fn: () => unknown) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const ROOT = path.resolve('apps/web/src');
const pageSrc = fs.readFileSync(path.join(ROOT, 'pages/StoryPage.tsx'), 'utf8');
const typesSrc = fs.readFileSync(path.join(ROOT, 'types.ts'), 'utf8');
const startReqSrc = fs.readFileSync(path.join(ROOT, 'lib/storyStartRequest.ts'), 'utf8');
const charPageSrc = fs.readFileSync(path.join(ROOT, 'pages/CharacterPage.tsx'), 'utf8');

const HAYEON = 'hayeon';
const NARI = 'nari';
const SERA = 'sera';
const STORY = 'story-parallel';

async function main() {
const { buildStoryStartRequest } = await import('../apps/web/src/lib/storyStartRequest.ts');

await t('types expose optional openingId on StoryStartRequest', () => {
  assert.ok(typesSrc.includes('export type StoryStartRequest') || typesSrc.includes('export interface StoryStartRequest'));
  assert.match(typesSrc, /StoryStartRequest[\s\S]*openingId\?:\s*string/);
});

await t('F5: extras 0 / default pick omits openingId key; extra id is sent', () => {
  const omitted = buildStoryStartRequest({
    characterId: HAYEON,
    storyId: STORY,
    selectedIds: [HAYEON, NARI],
  });
  assert.equal('openingId' in omitted, false);
  const empty = buildStoryStartRequest({
    characterId: HAYEON,
    storyId: STORY,
    selectedIds: [HAYEON],
    openingId: '',
  });
  assert.equal('openingId' in empty, false);
  const extra = buildStoryStartRequest({
    characterId: HAYEON,
    storyId: STORY,
    selectedIds: [HAYEON],
    openingId: 'lib',
  });
  assert.equal(extra.openingId, 'lib');
  assert.equal(JSON.stringify(extra).includes('"openingId":"lib"'), true);
});

await t('openingId does not change participantIds ORDER_CONTRACT', () => {
  const body = buildStoryStartRequest({
    characterId: HAYEON,
    storyId: STORY,
    selectedIds: [SERA, HAYEON, NARI],
    openingId: 'lib',
  });
  assert.deepEqual(body.participantIds, [SERA, HAYEON, NARI]);
  assert.equal(body.characterId, HAYEON);
  assert.equal(body.mode, 'story');
  assert.equal(body.openingId, 'lib');
});

await t('StoryPage shows opening picker only when openings_extra length >= 1', async () => {
  const empty = await loadedStoryStart({ story: storyFixture({ openings_extra: [] }) });
  assert.equal(nodes(empty.render()).filter((node) => node.type === 'select').length, 0);
  const extras = await loadedStoryStart();
  const picker = one(extras.render(), (node) => node.type === 'select');
  assert.equal(picker.props.value, '');
  assert.deepEqual(nodes(picker).filter((node) => node.type === 'option').map((node) => [node.props.value, node.props.children]), [['', '기본'], ['rain', '비 오는 밤']]);
  assert.equal(nodes(extras.render()).filter((node) => node.type === 'input' && node.props.type === 'checkbox').length, 0, 'opening picker is not the first-scene roster');
});

await t('startChat passes openingId through buildStoryStartRequest; default stays omit', async () => {
  for (const opening of ['', 'rain']) {
    const bodies: any[] = [];
    const h = await loadedStoryStart({ post: async (_url, body) => { bodies.push(body); return { id: 'room' }; } });
    one(h.render(), (node) => node.type === 'select').props.onChange({ target: { value: opening } });
    one(h.render(), button('시작')).props.onClick(); await tick();
    assert.deepEqual(bodies[0].participantIds, ['b', 'a']);
    if (opening) assert.equal(bodies[0].openingId, opening); else assert.equal('openingId' in bodies[0], false);
  }
});

await t('1:1 CharacterPage stays free of openingId / story start helper', () => {
  assert.equal(charPageSrc.includes('openingId'), false);
  assert.equal(charPageSrc.includes('buildStoryStartRequest'), false);
  assert.equal(charPageSrc.includes('openings_extra'), false);
});

await t('generate-path and pipeline files stay untouched', () => {
  const changed = execSync(
    'git diff --name-only HEAD -- apps/server/src/prompt/storyOpening.ts apps/server/src/prompt/applySceneDelta.ts apps/server/src/prompt/composeBeat.ts apps/server/src/prompt/resolveFocus.ts apps/server/src/prompt/builder.ts apps/server/src/prompt/templates.ts apps/server/src/config.ts apps/server/src/routes/stories.ts',
    { cwd: path.resolve('.'), encoding: 'utf8' },
  ).trim();
  assert.equal(changed, '', `Slice 3 must not touch: ${changed}`);
  const chatDiff = execSync('git diff HEAD -- apps/server/src/routes/chat.ts', { cwd: path.resolve('.'), encoding: 'utf8' });
  for (const line of chatDiff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) assert.ok(line.includes('ended_at') || line.includes('already ended') || line.includes('fireEndingEvalJob') || line.includes('endingJudge') || line.includes('Slice 3'), `chat.ts guard-only (+F8h slice-3 eval hook): ${line}`);
  }
  assert.equal(/from ['"][^'"]*applySceneDelta/.test(pageSrc), false);
  assert.equal(/from ['"][^'"]*storyOpening/.test(pageSrc), false);
  assert.equal(startReqSrc.includes('applySceneDelta'), false);
});

console.log(`passed ${passed}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
