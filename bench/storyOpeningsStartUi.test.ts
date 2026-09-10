/** npx tsx bench/storyOpeningsStartUi.test.ts
 * ADR-F8f Slice 3 (story-multi-opening-slice3-start-ui): start-sheet opening picker.
 * Source inventory + helper. Helper/bench PASS is not a product PASS.
 * No live HTTP / systemd / DB / commit / deploy / restart.
 */
import assert from 'node:assert/strict';
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
function t(name: string, fn: () => void) {
  fn();
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

t('types expose optional openingId on StoryStartRequest', () => {
  assert.ok(typesSrc.includes('export type StoryStartRequest') || typesSrc.includes('export interface StoryStartRequest'));
  assert.match(typesSrc, /StoryStartRequest[\s\S]*openingId\?:\s*string/);
});

t('F5: extras 0 / default pick omits openingId key; extra id is sent', () => {
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

t('openingId does not change participantIds ORDER_CONTRACT', () => {
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

t('StoryPage shows opening picker only when openings_extra length >= 1', () => {
  assert.ok(pageSrc.includes('openings_extra'));
  assert.ok(pageSrc.includes('openingPick'));
  assert.match(pageSrc, /\(story\.openings_extra\s*\?\?\s*\[\]\)\.length/);
  assert.ok(pageSrc.includes('시작 설정'));
  assert.ok(pageSrc.includes('>기본<') || pageSrc.includes('>기본</option>'));
  assert.ok(pageSrc.includes('e.label') || pageSrc.includes('.label}'));
  const sheet = pageSrc.slice(pageSrc.indexOf('<BottomSheet'), pageSrc.indexOf('</BottomSheet>'));
  assert.ok(sheet.includes('openingPick'));
  assert.ok(sheet.includes('rosterIds'));
  assert.equal(sheet.includes('present_ids'), false, 'opening picker is not the first-scene roster');
});

t('startChat passes openingId through buildStoryStartRequest; default stays omit', () => {
  const startChat = pageSrc.slice(pageSrc.indexOf('async function startChat'), pageSrc.indexOf('if (loading || !story)'));
  assert.ok(startChat.includes('buildStoryStartRequest'));
  assert.ok(startChat.includes('openingId'));
  assert.ok(startChat.includes('openingPick'));
  assert.ok(pageSrc.includes('setOpeningPick'));
});

t('1:1 CharacterPage stays free of openingId / story start helper', () => {
  assert.equal(charPageSrc.includes('openingId'), false);
  assert.equal(charPageSrc.includes('buildStoryStartRequest'), false);
  assert.equal(charPageSrc.includes('openings_extra'), false);
});

t('generate-path and pipeline files stay untouched', () => {
  const changed = execSync(
    'git diff --name-only HEAD -- apps/server/src/prompt/storyOpening.ts apps/server/src/prompt/applySceneDelta.ts apps/server/src/prompt/composeBeat.ts apps/server/src/routes/chat.ts apps/server/src/prompt/resolveFocus.ts apps/server/src/prompt/builder.ts apps/server/src/prompt/templates.ts apps/server/src/config.ts apps/server/src/routes/conversations.ts apps/server/src/routes/stories.ts',
    { cwd: path.resolve('.'), encoding: 'utf8' },
  ).trim();
  assert.equal(changed, '', `Slice 3 must not touch: ${changed}`);
  assert.equal(/from ['"][^'"]*applySceneDelta/.test(pageSrc), false);
  assert.equal(/from ['"][^'"]*storyOpening/.test(pageSrc), false);
  assert.equal(startReqSrc.includes('applySceneDelta'), false);
});

console.log(`passed ${passed}`);
}

void main();
