/** npx tsx bench/storyAuthoringUi.test.ts
 * F8c story-authoring-ui — start sheet preview card + archived 409 copy.
 * Production JSX/effects/callbacks plus protected server-boundary inventory. UI playtest is separate.
 * No live HTTP / systemd / DB / commit / deploy / restart.
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StartPreview } from '../apps/web/src/pages/StoryPage.tsx';
import { ApiError } from '../apps/web/src/lib/api.ts';
import { loadedStoryStart, storyFixture, previewFixture, character, one, named, button, deferred, tick } from './helpers/storyUiHarness.ts';
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
const charPageSrc = fs.readFileSync(path.join(ROOT, 'pages/CharacterPage.tsx'), 'utf8');
const editorSrc = fs.readFileSync(path.join(ROOT, 'components/StoryEditor.tsx'), 'utf8');
const storiesSrc = fs.readFileSync(path.resolve('apps/server/src/routes/stories.ts'), 'utf8');
const convSrc = fs.readFileSync(path.resolve('apps/server/src/routes/conversations.ts'), 'utf8');
const builderSrc = fs.readFileSync(path.resolve('apps/server/src/prompt/builder.ts'), 'utf8');
const configSrc = fs.readFileSync(path.resolve('apps/server/src/config.ts'), 'utf8');

async function main() {

await t('AU-01 start sheet fetches inject-preview for the first active saved character', async () => {
  const h = await loadedStoryStart();
  assert.ok(h.requests.some((url) => url.endsWith('/inject-preview?characterId=b')));
  assert.ok(typesSrc.includes('export interface StoryInjectPreview'));
  for (const field of ['settingExcerpt', 'settingTruncated', 'estTokens']) assert.ok(typesSrc.includes(field));
});

await t('AU-02 preview card is confirmation UI, not a debugger', () => {
  for (const truncated of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(StartPreview, { kind: 'ok', preview: { settingExcerpt: '세계관 본문', settingTruncated: truncated, cast: [{ name: 'A', included: true }, { name: 'B', included: false }], estTokens: 321 }, onRetry() {} }));
    for (const value of ['대화에 적용될 스토리 설정', truncated ? '일부 잘림' : '전체 포함', '1명 포함', '1명 제외', '예상 사용량: 약', '321', '대화를 시작하면 현재 설정이 이 대화에 동결됩니다.', '이후 스토리를 수정해도 이미 시작한 대화에는 반영되지 않습니다.']) assert.ok(html.includes(value), value);
    assert.doesNotMatch(html, /storyRoom|fixedEst|budgets.fixed|BudgetReport|willFreeze|STORY_SETTING_SHARE/);
  }
});

await t('AU-03 stale preview cannot overwrite the current saved-cast preview', async () => {
  const old = deferred<unknown>(), current = deferred<unknown>(); let requests = 0;
  const h = await loadedStoryStart({ get: async (url) => {
    if (url === '/api/characters') return [character('a'), character('b')];
    if (url.includes('/inject-preview?')) return ++requests === 1 ? old.promise : current.promise;
    return storyFixture();
  } });
  assert.equal(h.state.previewKind, 'loading');
  h.state.previewRetry++; h.render(); h.runEffects();
  current.resolve({ ...previewFixture, settingExcerpt: 'current' }); await tick();
  old.resolve({ ...previewFixture, settingExcerpt: 'stale' }); await tick();
  assert.equal(h.state.preview.settingExcerpt, 'current');
});

await t('AU-04 start stays disabled until preview ok; failure has retry', async () => {
  for (const error of [new Error('offline'), new ApiError(404, 'missing')]) {
    let fail = true, posts = 0;
    const h = await loadedStoryStart({ get: async (url) => {
      if (url === '/api/characters') return [character('a'), character('b')];
      if (url.includes('/inject-preview?')) { if (fail) throw error; return previewFixture; }
      return storyFixture();
    }, post: async () => { posts++; return { id: 'room' }; } });
    const start = one(h.render(), button('시작')); assert.equal(start.props.disabled, true); start.props.onClick(); await tick(); assert.equal(posts, 0);
    const preview = one(h.render(), named('StartPreview'));
    const html = renderToStaticMarkup(React.createElement(StartPreview, preview.props));
    assert.match(html, /role="alert"/); assert.match(html, /다시 시도/);
    preview.props.onRetry(); fail = false;
    for (let i = 0; i < 3; i++) { h.render(); h.runEffects(); await tick(); }
    assert.equal(one(h.render(), button('시작')).props.disabled, false);
  }
});

await t('AU-05 preview 409 and conversation POST 409 share the archived copy and refresh the parent', async () => {
  for (const failedStep of ['preview', 'post']) {
    let refreshes = 0;
    const h = await loadedStoryStart({ get: async (url) => {
      if (url === '/api/characters') return [character('a'), character('b')];
      if (url.includes('/inject-preview?')) { if (failedStep === 'preview') throw new ApiError(409, 'archived'); return previewFixture; }
      return storyFixture();
    }, post: async () => { throw new ApiError(409, 'archived'); }, onArchived: () => refreshes++ });
    if (failedStep === 'post') { one(h.render(), button('시작')).props.onClick(); await tick(); }
    assert.equal(h.state.previewKind, 'archived'); assert.equal(refreshes, 1);
    const html = renderToStaticMarkup(React.createElement(StartPreview, one(h.render(), named('StartPreview')).props));
    assert.match(html, /보관된 스토리에서는 새 대화를 시작할 수 없습니다/);
    assert.match(html, /스토리를 다시 활성화한 뒤 시도해 주세요/);
    assert.equal(one(h.render(), button('시작')).props.disabled, true);
  }
  assert.equal(pageSrc.split('보관된 스토리에서는 새 대화를 시작할 수 없습니다.').length - 1, 1, 'one shared constant');
});

await t('AU-06 empty setting / empty cast do not assume rows exist', () => {
  const html = renderToStaticMarkup(React.createElement(StartPreview, { kind: 'ok', preview: { ...previewFixture, settingExcerpt: '' }, onRetry() {} }));
  assert.match(html, /설정이 없습니다/); assert.match(html, /설정 이름: 없음/);
});

await t('AU-07 character-tab start, editor, and server contracts stay untouched', () => {
  assert.equal(charPageSrc.includes('storyId'), false);
  assert.equal(charPageSrc.includes('inject-preview'), false);
  assert.equal(editorSrc.includes('inject-preview'), false);
  assert.equal(editorSrc.includes('/api/conversations'), false);
  assert.ok(storiesSrc.includes('/inject-preview'));
  assert.ok(convSrc.includes("error: 'archived'") || convSrc.includes('error: "archived"'));
  assert.ok(builderSrc.includes('computeStoryInjection'));
  assert.ok(configSrc.includes("PROMPT_VERSION = '2026.08.22-r1+story+compact+roster+opening'"));
  assert.equal(pageSrc.includes('default_character_id'), false);
  assert.equal(pageSrc.includes('worlds'), false);
  assert.equal(pageSrc.includes('lore'), false);
});

await t('AU-08 one saved active character starts without manual character selection', async () => {
  const story = storyFixture(); story.characters = story.characters!.slice(1);
  const h = await loadedStoryStart({ story });
  assert.ok(h.requests.some((url) => url.endsWith('/inject-preview?characterId=a')));
  assert.equal(one(h.render(), button('시작')).props.disabled, false);
});

console.log(`passed ${passed}`);

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
