/** npx tsx bench/storyDetail.test.ts
 * F8 story-detail — reader navigation + editor CRUD behavior and boundary inventory.
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 * No live HTTP / systemd / DB / inject / commit / deploy / restart.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { storyHarness, storyFixture, character, nodes, one, named, button, tick } from './helpers/storyUiHarness.ts';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
try {
  require2('../apps/web/src/pages/StoryPage.tsx');
} catch (e) {
  console.error('RED: StoryPage missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}
try {
  require2('../apps/web/src/components/StoryEditor.tsx');
} catch (e) {
  console.error('RED: StoryEditor missing —', (e as Error).message.split('\n')[0]);
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
const editorSrc = fs.readFileSync(path.join(ROOT, 'components/StoryEditor.tsx'), 'utf8');
const homeSrc = fs.readFileSync(path.join(ROOT, 'pages/HomePage.tsx'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
const typesSrc = fs.readFileSync(path.join(ROOT, 'types.ts'), 'utf8');
const builderSrc = fs.readFileSync(path.resolve('apps/server/src/prompt/builder.ts'), 'utf8');
const charSrc = fs.readFileSync(path.resolve('apps/server/src/routes/characters.ts'), 'utf8');

async function main() {

await t('DET-01 App routes /story/:id to StoryPage', () => {
  assert.ok(appSrc.includes("match(path, '/story/:id')"));
  assert.ok(appSrc.includes('StoryPage'));
  assert.ok(appSrc.includes("from './pages/StoryPage'"));
});

await t('DET-02 detail loads story, opens editor, and archives only after confirmation', async () => {
  const calls: string[] = [], routes: string[] = [];
  const story = storyFixture();
  const h = storyHarness('StoryDetailPage', { id: story.id }, { api: {
    get: async (url: string) => { calls.push(url); return url === '/api/characters' ? [] : story; },
    del: async (url: string) => { calls.push(`DELETE ${url}`); },
  }, router: { navigate: (url: string) => routes.push(url) } });
  h.render(); h.runEffects(); await tick();
  assert.ok(calls.includes(`/api/stories/${story.id}`));
  one(h.render(), button('스토리 수정')).props.onClick();
  assert.equal(one(h.render(), named('StoryEditor')).props.open, true);
  one(h.render(), button('스토리 보관')).props.onClick(); await tick();
  assert.ok(calls.includes(`DELETE /api/stories/${story.id}`));
  assert.deepEqual(routes, ['/?tab=story']);
});

await t('DET-03 cast mapping writes live in the editor; reader detail only navigates cast profiles', async () => {
  const story = storyFixture(), routes: string[] = [], writes: unknown[] = [];
  const reader = storyHarness('StoryDetailView', { story }, { router: { navigate: (url: string) => routes.push(url) } });
  const cast = nodes(reader.render()).find((node) => node.props.className === 'story-cast-card')!;
  cast.props.onClick(); assert.deepEqual(routes, ['/character/b']);
  assert.equal(nodes(reader.render()).filter((node) => node.type === 'select' || node.type === 'input').length, 0);
  const editor = storyHarness('StoryEditor', { open: true, story, hosted: story.characters, initialTab: 'opening', onClose() {}, onSaved() {} }, { api: {
    get: async (url: string) => url === '/api/characters' ? [character('a'), character('b'), character('c')] : [],
    post: async (url: string, body: unknown) => { writes.push({ url, body }); },
    del: async (url: string) => { writes.push({ url }); },
  } }, {}, 'components/StoryEditor.tsx');
  editor.render(); editor.runEffects(); await tick();
  editor.state.addPickId = 'c'; one(editor.render(), button('추가')).props.onClick(); await tick();
  assert.deepEqual(writes[0], { url: `/api/stories/${story.id}/characters`, body: { characterId: 'c', role: 'main' } });
  const remove = nodes(editor.render()).find((node) => node.type === 'button' && node.props['aria-label'] === '빼기')!;
  remove.props.onClick(); await tick(); assert.deepEqual(writes[1], { url: `/api/stories/${story.id}/characters/b` });
});

await t('DET-04 StoryEditor create/edit fields; no nested .sheet tabs; cover upload (A2)', () => {
  assert.ok(editorSrc.includes("post('/api/stories'") || editorSrc.includes('post<') && editorSrc.includes('/api/stories'));
  assert.ok(editorSrc.includes('put<') && editorSrc.includes('/api/stories/'));
  assert.ok(editorSrc.includes('name'));
  assert.ok(editorSrc.includes('tagline'));
  assert.ok(editorSrc.includes('setting'));
  assert.ok(editorSrc.includes('minor_cast'));
  assert.equal(editorSrc.includes('className="sheet tabs"'), false);
  assert.equal(editorSrc.includes("className='sheet tabs'"), false);
  // story-editor-tabs A2 (0015): the ADR-F8 §5 "no cover" clause was conditional
  // on there being no cover UI (see storySchema.test.ts). This is that UI.
  assert.ok(editorSrc.includes('/api/stories/${story.id}/cover'));
});

await t('DET-05 HomePage story tab creates and opens detail', () => {
  assert.ok(homeSrc.includes('StoryEditor'));
  assert.ok(homeSrc.includes("navigate(`/story/${"));
  assert.ok(homeSrc.includes('첫 스토리를 만드세요'));
  assert.ok(homeSrc.includes("aria-label=\"새 스토리\"") || homeSrc.includes('aria-label="새 스토리"'));
  assert.equal(homeSrc.includes('className="tabs"'), false);
});

await t('DET-06 types include StoryCharacter; no worlds', () => {
  assert.ok(typesSrc.includes('export interface StoryCharacter'));
  assert.ok(typesSrc.includes('character_id'));
  assert.equal(pageSrc.includes('worlds'), false);
  assert.equal(pageSrc.includes('world_id'), false);
  assert.equal(editorSrc.includes('worlds'), false);
  assert.equal(editorSrc.includes('world_id'), false);
  assert.equal(homeSrc.includes('worlds'), false);
});

await t('DET-07 UI has no inject; characters list unfiltered', () => {
  assert.equal(/\bFROM\s+stories\b/i.test(builderSrc), false);
  assert.equal(builderSrc.includes('story_characters'), false);
  assert.equal(pageSrc.includes('buildPrompt'), false);
  assert.equal(pageSrc.includes('PROMPT_VERSION'), false);
  // C4 가 합법적으로 역방향 조회를 추가함 — 검사 범위를 목록 핸들러로 좁힘.
  const startTok = "app.get('/api/characters', async () => {";
  const endTok = "app.post('/api/characters'";
  const start = charSrc.indexOf(startTok);
  const end = charSrc.indexOf(endTok);
  assert.ok(start >= 0, 'GET /api/characters list handler start missing');
  assert.ok(end > start, 'GET /api/characters list handler end missing');
  assert.equal(charSrc.slice(start, end).includes('story_characters'), false);
  assert.equal(pageSrc.includes('conversations.story_id'), false);
  assert.equal(editorSrc.includes('/api/conversations'), false);
});

console.log(`passed ${passed}`);

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
