/** npx tsx bench/storyInjectUi.test.ts
 * F8b story-inject-ui — reader CTA, saved-cast create and archive behavior.
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 * No live HTTP / systemd / DB / commit / deploy / restart.
 */
import assert from 'node:assert/strict';
import { loadedStoryStart, storyHarness, storyFixture, nodes, one, named, button, tick } from './helpers/storyUiHarness.ts';
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
const homeSrc = fs.readFileSync(path.join(ROOT, 'pages/HomePage.tsx'), 'utf8');
const editorSrc = fs.readFileSync(path.join(ROOT, 'components/StoryEditor.tsx'), 'utf8');
const storiesSrc = fs.readFileSync(path.resolve('apps/server/src/routes/stories.ts'), 'utf8');
const convSrc = fs.readFileSync(path.resolve('apps/server/src/routes/conversations.ts'), 'utf8');
const charPageSrc = fs.readFileSync(path.join(ROOT, 'pages/CharacterPage.tsx'), 'utf8');

async function main() {

await t('UI-01 StoryPage Start opens history selection before creation', () => {
  const story = storyFixture();
  const h = storyHarness('StoryDetailPage', { id: story.id }, {}, { story });
  assert.equal(nodes(h.render()).filter(named('StoryConversationChooser')).length, 0);
  one(h.render(), button('대화 시작')).props.onClick();
  one(h.render(), named('StoryConversationChooser'));
  assert.equal(nodes(h.render()).filter(named('NewStoryConversationSheet')).length, 0);
});

await t('UI-02 explicit new start POSTs storyId and ordered saved cast before opening chat', async () => {
  const writes: unknown[] = [], routes: string[] = [];
  const h = await loadedStoryStart({ post: async (url, body) => { writes.push({ url, body }); return { id: 'room' }; }, navigate: (url) => routes.push(url) });
  one(h.render(), button('시작')).props.onClick(); await tick();
  assert.deepEqual(writes, [{ url: '/api/conversations', body: { storyId: storyFixture().id, characterId: 'b', mode: 'story', participantIds: ['b', 'a'] } }]);
  assert.deepEqual(routes, ['/chat/room']);
});

await t('UI-03 an empty saved cast cannot start and directs the user to story settings', async () => {
  let edits = 0;
  const h = await loadedStoryStart({ story: storyFixture({ characters: [] }), onEdit: () => edits++ });
  assert.equal(nodes(h.render()).filter(button('시작')).length, 0);
  one(h.render(), button('참여 캐릭터 설정')).props.onClick(); assert.equal(edits, 1);
});

await t('UI-04 archived stories resume existing conversations but cannot create new ones', async () => {
  assert.ok(storiesSrc.includes('WHERE s.archived = 0'), 'list API hides archived');
  assert.ok(homeSrc.includes('/api/stories'), 'home story tab uses list API');
  const story = storyFixture({ archived: true });
  const chooser = storyHarness('StoryConversationChooser', { story, onClose() {}, onNew() {} });
  assert.equal(one(chooser.render(), button('＋ 새 대화')).props.disabled, true);
  const start = await loadedStoryStart({ story });
  assert.equal(start.state.previewKind, 'archived');
  assert.equal(one(start.render(), button('시작')).props.disabled, true);
});

await t('UI-05 no reapply control on StoryPage', () => {
  assert.equal(pageSrc.includes('재적용'), false);
  assert.equal(pageSrc.includes('story-reapply'), false);
  assert.equal(pageSrc.includes('story_applied_at'), false);
  assert.equal(editorSrc.includes('재적용'), false);
  assert.equal(editorSrc.includes('/api/conversations'), false);
});

await t('UI-06 worlds unused; character tab start stays story-less', () => {
  assert.equal(pageSrc.includes('worlds'), false);
  assert.equal(pageSrc.includes('world_id'), false);
  assert.equal(homeSrc.includes('worlds'), false);
  assert.equal(charPageSrc.includes('storyId'), false);
});

await t('UI-07 createSchema still accepts optional storyId (schema slice)', () => {
  assert.match(convSrc, /const createSchema = z\.object\(\{[\s\S]*?storyId:/);
});

console.log(`passed ${passed}`);

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
