/** Reader-first story detail, deferred history and saved-cast start behavior. No live data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import postcss from 'postcss';
import { StoryPage, StoryDetailView, StartPreview } from '../apps/web/src/pages/StoryPage.tsx';
import { StoryCard } from '../apps/web/src/pages/HomePage.tsx';
import { activeStoryCast } from '../apps/web/src/lib/storyStartRequest.ts';
import { ApiError } from '../apps/web/src/lib/api.ts';
import type { Conversation } from '../apps/web/src/types.ts';
import { storyHarness, loadedStoryStart, storyFixture, previewFixture, character, nodes, one, named, button, classIs, text, tick, deferred } from './helpers/storyUiHarness.ts';

const story = storyFixture();
const characters = [character('a'), character('b'), character('outside')];
const tests: Array<{ name: string; run: () => unknown }> = [];
const test = (name: string, run: () => unknown) => tests.push({ name, run });
const conversation = (id: string) => ({ id, title: `대화-${id}`, character_name: '인물-b', story_id: story.id, preview: '책장을 넘겼다.', created_at: '2026-01-01T00:00:00Z' } as Conversation);

test('saved cast keeps server order, removes duplicates and excludes archived, missing and unrelated characters', () => {
  const fixture = storyFixture({ characters: [
    ...story.characters!, { ...story.characters![0] },
    { ...story.characters![0], character_id: 'archived' }, { ...story.characters![0], character_id: 'missing' },
  ] });
  const before = JSON.stringify(fixture);
  assert.deepEqual(activeStoryCast(fixture, [...characters, character('archived', true)]).map((c) => c.character_id), ['b', 'a']);
  assert.deepEqual(activeStoryCast(fixture, []), []);
  assert.equal(JSON.stringify(fixture), before);
});

test('story catalog card shows portrait cover, title and short tagline instead of world text and character metadata', () => {
  const html = renderToStaticMarkup(React.createElement(StoryCard, { story }));
  assert.ok(html.includes(story.name));
  assert.ok(html.includes(story.tagline));
  assert.ok(html.includes(story.cover!));
  assert.doesNotMatch(html, /자정을 지나면|참여 캐릭터|관리|대화하기|설정 보기/);
  const routes: string[] = [];
  const h = storyHarness('StoryCard', { story }, { router: { navigate: (route: string) => routes.push(route) } }, {}, 'pages/HomePage.tsx');
  one(h.render(), classIs('story-card')).props.onClick();
  assert.deepEqual(routes, [`/story/${story.id}`]);
  const empty = renderToStaticMarkup(React.createElement(StoryCard, { story: storyFixture({ tagline: '', cover: null }) }));
  assert.doesNotMatch(empty, /story-card-tagline/);
});

test('detail shows world, cast and starting scene while hiding editing controls, history and ending spoilers', () => {
  const html = renderToStaticMarkup(React.createElement(StoryDetailView, { story, characters }));
  for (const value of [story.name, story.tagline, '세계관 소개', '자정을 지나면', '등장 캐릭터', '인물-b', '문지기', '도서관을 지킨다.', '이야기의 시작', story.opening.scenario, '엔딩 1개 수록']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /<select|type="checkbox"|참여 캐릭터 추가|빼기|이전 대화|비밀 엔딩 제목|숨길 스포일러/);
  const routes: string[] = [];
  const h = storyHarness('StoryDetailView', { story, characters }, { router: { navigate: (route: string) => routes.push(route) } });
  nodes(h.render()).find(classIs('story-cast-card'))!.props.onClick();
  assert.deepEqual(routes, ['/character/b']);
  const empty = renderToStaticMarkup(React.createElement(StoryDetailView, { story: storyFixture({ setting: '', characters: [], minor_cast: [], opening: { scenario: '', greeting: '', scene: {}, present_ids: [] }, endings: [] }) }));
  assert.match(empty, /아직 등록된 세계관 소개가 없습니다/);
  assert.match(empty, /아직 등록된 등장 캐릭터가 없습니다/);
  assert.doesNotMatch(empty, /이야기의 시작|엔딩.*개 수록/);
});

test('entry defers conversation reads; chooser, fresh new sheet and editor transitions are mutually exclusive', async () => {
  const requests: string[] = [];
  const h = storyHarness('StoryDetailPage', { id: story.id }, { api: { get: async (url: string) => { requests.push(url); return url === '/api/characters' ? characters : story; } } });
  h.render(); h.runEffects(); await tick();
  let tree = h.render();
  assert.equal(requests.length, 2);
  assert.equal(requests.filter((url) => url.includes('conversations')).length, 0);
  assert.equal(nodes(tree).filter(named('StoryConversationChooser')).length, 0);
  assert.equal(one(tree, named('StoryEditor')).props.open, false);
  one(tree, button('대화 시작')).props.onClick();
  tree = h.render();
  one(tree, named('StoryConversationChooser')).props.onNew();
  tree = h.render();
  assert.equal(nodes(tree).filter(named('StoryConversationChooser')).length, 0);
  one(tree, named('NewStoryConversationSheet')).props.onBack();
  one(h.render(), named('StoryConversationChooser')).props.onNew();
  one(h.render(), named('NewStoryConversationSheet')).props.onEdit();
  tree = h.render();
  assert.equal(nodes(tree).filter(named('NewStoryConversationSheet')).length, 0);
  const editor = one(tree, named('StoryEditor'));
  assert.equal(editor.props.open, true); assert.equal(editor.props.initialTab, 'opening');
  editor.props.onClose();
  assert.equal(h.state.editor, null); assert.equal(h.state.retry, 1, 'closing editor refreshes immediate cast edits even without Save');
  assert.equal(StoryPage({ id: 'first' }).key, 'first');
  assert.equal(StoryPage({ id: 'second' }).key, 'second');
});

test('failed detail read offers retry; old detail and character reads cannot update an unmounted page', async () => {
  let fail = true;
  const h = storyHarness('StoryDetailPage', { id: story.id }, { api: { get: async (url: string) => { if (url === '/api/characters') return characters; if (fail) throw new Error('offline'); return story; } } });
  h.render(); h.runEffects(); await tick();
  assert.equal(h.state.error, true);
  one(h.render(), button('다시 시도')).props.onClick(); fail = false;
  h.render(); h.runEffects(); await tick();
  assert.equal(h.state.story, story); assert.equal(h.state.error, false);
  const pending = deferred<unknown>();
  const late = storyHarness('StoryDetailPage', { id: story.id }, { api: { get: () => pending.promise } });
  late.render(); late.runEffects(); late.cleanup();
  const count = late.writes.length; pending.resolve(story); await tick();
  assert.equal(late.writes.length, count);
});

test('history is filtered to this story, paginates beyond fifty, deduplicates overlapping pages and resets after row changes', async () => {
  const requests: string[] = [];
  const first = Array.from({ length: 50 }, (_, i) => conversation(`first-${i}`));
  const h = storyHarness('StoryConversationChooser', { story, onClose() {}, onNew() {} }, { api: { get: async (url: string) => { requests.push(url); return url.endsWith('offset=0') ? first : [first[49], conversation('older')]; } } });
  h.render(); assert.deepEqual(requests, []); h.runEffects(); await tick();
  assert.deepEqual(requests, ['/api/conversations?storyId=story%2Ffixture&limit=50&offset=0']);
  const more = one(h.render(), button('이전 대화 더 보기'));
  more.props.onClick(); more.props.onClick();
  assert.equal(h.state.offset, 50, 'same-frame double click cannot skip a history page');
  h.render(); h.runEffects(); await tick();
  assert.equal(h.state.conversations.length, 51);
  assert.equal(h.state.more, false);
  assert.match(requests[1], /offset=50$/);
  const rows = nodes(h.render()).filter(named('ConversationRow'));
  assert.equal(rows.length, 51); assert.equal(rows[50].props.conv.id, 'older');
  rows[0].props.onChanged(); h.render(); h.runEffects(); await tick();
  assert.equal(h.state.offset, 0); assert.equal(h.state.conversations.length, 50);
});

test('history errors and emptiness are distinct; archived stories still resume existing rooms and cannot create new ones', async () => {
  let fail = true;
  const h = storyHarness('StoryConversationChooser', { story: { ...story, archived: true }, onClose() {}, onNew() {} }, { api: { get: async () => { if (fail) throw new Error('offline'); return []; } } });
  h.render(); h.runEffects(); await tick();
  assert.equal(h.state.error, true); assert.doesNotMatch(text(h.render()), /아직 대화가 없습니다/);
  one(h.render(), button('다시 시도')).props.onClick(); fail = false;
  h.render(); h.runEffects(); await tick();
  assert.match(text(h.render()), /아직 대화가 없습니다/);
  assert.equal(one(h.render(), button('＋ 새 대화')).props.disabled, true);
  const request = deferred<Conversation[]>();
  const late = storyHarness('StoryConversationChooser', { story, onClose() {}, onNew() {} }, { api: { get: () => request.promise } });
  late.render(); late.runEffects(); late.cleanup(); const count = late.writes.length;
  request.resolve([conversation('late')]); await tick(); assert.equal(late.writes.length, count);
});

test('new start reloads saved cast, previews the first active member and sends full ordered peers without a character picker', async () => {
  const posts: unknown[] = [], routes: string[] = [];
  const h = await loadedStoryStart({ post: async (url, body) => { posts.push({ url, body }); return { id: 'new-room' }; }, navigate: (route) => routes.push(route) });
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests.includes('/api/characters'));
  assert.ok(h.requests.some((url) => url.endsWith('/inject-preview?characterId=b')));
  const tree = h.render();
  assert.equal(nodes(tree).filter((node) => node.type === 'select').length, 1, 'only opening selection stays in the start sheet');
  assert.equal(nodes(tree).filter((node) => node.type === 'input' && node.props.type === 'checkbox').length, 0);
  assert.match(text(tree), /인물-b · 인물-a/);
  one(tree, button('시작')).props.onClick(); await tick();
  assert.deepEqual(posts, [{ url: '/api/conversations', body: { characterId: 'b', storyId: story.id, mode: 'story', participantIds: ['b', 'a'] } }]);
  assert.deepEqual(routes, ['/chat/new-room']);
});

test('default opening is omitted; selecting an extra sends its id without changing the saved cast', async () => {
  const bodies: any[] = [];
  const h = await loadedStoryStart({ post: async (_url, body) => { bodies.push(body); return { id: 'extra-room' }; } });
  one(h.render(), (node) => node.type === 'select').props.onChange({ target: { value: 'rain' } });
  one(h.render(), button('시작')).props.onClick(); await tick();
  assert.equal(bodies[0].openingId, 'rain'); assert.deepEqual(bodies[0].participantIds, ['b', 'a']);
  const plain = await loadedStoryStart({ story: storyFixture({ openings_extra: [] }) });
  assert.equal(nodes(plain.render()).filter((node) => node.type === 'select').length, 0);
});

test('failed POST preserves opening and roster for retry, double click posts once, and unmounted responses cannot navigate', async () => {
  const post = deferred<unknown>(); const bodies: any[] = [], routes: string[] = [], messages: string[] = [];
  let calls = 0;
  const h = await loadedStoryStart({ post: async (_url, body) => { calls++; bodies.push(body); return calls === 1 ? post.promise : { id: 'retry-room' }; }, navigate: (route) => routes.push(route), toast: (message) => messages.push(message) });
  one(h.render(), (node) => node.type === 'select').props.onChange({ target: { value: 'rain' } });
  const start = one(h.render(), button('시작')); start.props.onClick(); start.props.onClick();
  assert.equal(calls, 1); assert.equal(h.state.starting, true);
  post.reject(new Error('offline')); await tick();
  assert.deepEqual(routes, []); assert.deepEqual(messages, ['offline']); assert.equal(h.state.openingPick, 'rain');
  one(h.render(), button('시작')).props.onClick(); await tick();
  assert.equal(calls, 2); assert.deepEqual(bodies[1], bodies[0]); assert.deepEqual(routes, ['/chat/retry-room']);
  for (const failure of [false, true]) {
    const response = deferred<unknown>(); let navigation = 0, closure = 0, toasts = 0;
    const late = await loadedStoryStart({ post: () => response.promise, navigate: () => navigation++, onClose: () => closure++, toast: () => toasts++ });
    one(late.render(), button('시작')).props.onClick(); late.cleanup(); const writes = late.writes.length;
    if (failure) response.reject(new Error('late failure')); else response.resolve({ id: 'late-room' });
    await tick(); assert.equal(navigation + closure + toasts, 0); assert.equal(late.writes.length, writes);
  }
});

test('preview gate blocks loading, missing, failure and archived cases; retry recovers and 409 keeps creation closed', async () => {
  for (const [error, kind] of [[new Error('offline'), 'error'], [new ApiError(404, 'missing'), 'missing'], [new ApiError(409, 'archived'), 'archived']] as const) {
    let fail = true, posted = 0, archived = 0;
    const h = await loadedStoryStart({ get: async (url) => {
      if (url === '/api/characters') return characters;
      if (url.includes('/inject-preview?')) { if (fail) throw error; return previewFixture; }
      return story;
    }, post: async () => { posted++; return { id: 'blocked' }; }, onArchived: () => archived++ });
    assert.equal(h.state.previewKind, kind);
    const start = one(h.render(), button('시작')); assert.equal(start.props.disabled, true); start.props.onClick(); await tick(); assert.equal(posted, 0);
    if (kind === 'archived') { assert.equal(archived, 1); continue; }
    one(h.render(), named('StartPreview')).props.onRetry(); fail = false;
    for (let i = 0; i < 3; i++) { h.render(); h.runEffects(); await tick(); }
    assert.equal(h.state.previewKind, 'ok'); assert.equal(one(h.render(), button('시작')).props.disabled, false);
  }
  let archived = 0;
  const post409 = await loadedStoryStart({ post: async () => { throw new ApiError(409, 'archived'); }, onArchived: () => archived++ });
  one(post409.render(), button('시작')).props.onClick(); await tick();
  assert.equal(post409.state.previewKind, 'archived'); assert.equal(archived, 1); assert.equal(one(post409.render(), button('시작')).props.disabled, true);
});

test('empty, over-limit and archived cast never POST and direct readers to participation settings', async () => {
  const many = Array.from({ length: 13 }, (_, i) => character(`c-${i}`));
  const variants = [
    { story: storyFixture({ characters: [] }), characters: [] },
    { story: storyFixture({ characters: many.map((c, sort_order) => ({ story_id: story.id, character_id: c.id, name: c.name, sort_order, role: 'main' })) }), characters: many },
  ];
  for (const variant of variants) {
    let edits = 0;
    const h = await loadedStoryStart({ ...variant, onEdit: () => edits++ });
    assert.equal(nodes(h.render()).filter(button('시작')).length, 0);
    assert.equal(h.requests.some((url) => url.includes('inject-preview')), false);
    one(h.render(), button('참여 캐릭터 설정')).props.onClick(); assert.equal(edits, 1);
  }
  const archived = await loadedStoryStart({ story: storyFixture({ archived: true }) });
  assert.equal(archived.state.previewKind, 'archived'); assert.equal(one(archived.render(), button('시작')).props.disabled, true);
});

test('fresh roster load failure blocks start and retries; late preview cannot overwrite a newer preview or an unmounted form', async () => {
  let fail = true;
  const h = await loadedStoryStart({ get: async (url) => {
    if (url === '/api/characters') { if (fail) throw new Error('characters unavailable'); return characters; }
    if (url.includes('/inject-preview?')) return previewFixture;
    return story;
  } });
  assert.equal(h.state.error, true); assert.equal(nodes(h.render()).filter(button('시작')).length, 0);
  one(h.render(), button('다시 시도')).props.onClick(); fail = false;
  for (let i = 0; i < 3; i++) { h.render(); h.runEffects(); await tick(); }
  assert.equal(h.state.previewKind, 'ok');
  const old = deferred<unknown>(), recent = deferred<unknown>(); let previewCalls = 0;
  const late = await loadedStoryStart({ get: async (url) => {
    if (url === '/api/characters') return characters;
    if (url.includes('/inject-preview?')) return ++previewCalls === 1 ? old.promise : recent.promise;
    return story;
  } });
  assert.equal(late.state.previewKind, 'loading');
  late.state.previewRetry++; late.render(); late.runEffects();
  recent.resolve({ ...previewFixture, settingExcerpt: '새 응답' }); await tick();
  old.resolve({ ...previewFixture, settingExcerpt: '오래된 응답' }); await tick();
  assert.equal(late.state.preview.settingExcerpt, '새 응답');
  late.state.previewRetry++; late.render(); late.runEffects(); late.cleanup(); const writes = late.writes.length;
  await tick(); assert.equal(late.writes.length, writes);
});

test('preview renders user-facing truncation, cast, budget and freeze notices and exposes retry without technical fields', () => {
  const html = renderToStaticMarkup(React.createElement(StartPreview, { kind: 'ok', preview: { settingExcerpt: '확인할 세계', settingTruncated: true, estTokens: 321, cast: [{ name: '포함', included: true }, { name: '제외', included: false }] }, onRetry() {} }));
  for (const value of ['확인할 세계', '일부 잘림', '1명 포함', '1명 제외', '321', '동결됩니다', '반영되지 않습니다']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /storyRoom|fixedEst|budgets|willFreeze/);
  const empty = renderToStaticMarkup(React.createElement(StartPreview, { kind: 'ok', preview: { ...previewFixture, settingExcerpt: '' }, onRetry() {} }));
  assert.match(empty, /설정이 없습니다/); assert.match(empty, /설정 이름: 없음/);
  let retries = 0; one(StartPreview({ kind: 'error', preview: null, onRetry: () => retries++ }), button('다시 시도')).props.onClick(); assert.equal(retries, 1);
});

test('participation edits persist through the editor; cancelling and reopening prunes stale opening references before Save', async () => {
  const original = storyFixture({
    opening: { scenario: '보존할 장면', greeting: '보존할 인사', scene: { weather: '비', clock_minutes: 600 }, present_ids: ['b', 'a'] },
    openings_extra: [{ id: 'rain', label: '비 오는 밤', opening_json: JSON.stringify({ scenario: '다른 장면', greeting: '다른 인사', scene: { day_index: 3 }, present_ids: ['b', 'a'] }) }],
  });
  const reads: string[] = [], writes: Array<{ url: string; body?: any }> = [];
  const props = { open: true, story: original, hosted: original.characters!, initialTab: 'opening', onClose() {}, onSaved() {} };
  const h = storyHarness('StoryEditor', props, { api: {
    get: async (url: string) => { reads.push(url); return url === '/api/characters' ? characters : []; },
    del: async (url: string) => { writes.push({ url }); },
    put: async (url: string, body: any) => { writes.push({ url, body }); return original; },
  } }, {}, 'components/StoryEditor.tsx');
  h.render(); h.runEffects(); await tick();
  assert.equal(h.state.tab, 'opening');
  const remove = nodes(h.render()).filter((node) => node.type === 'button' && node.props['aria-label'] === '빼기');
  assert.equal(remove.length, 2); remove[0].props.onClick(); await tick();
  assert.deepEqual(h.state.roster.map((c: any) => c.character_id), ['a']);
  assert.deepEqual(h.state.opening.present_ids, ['a']); assert.deepEqual(h.state.extras[0].present_ids, ['a']);
  assert.equal(writes[0].url, `/api/stories/${story.id}/characters/b`);
  h.render({ ...props, open: false }); h.runEffects();
  h.render({ ...props, hosted: original.characters!.slice(1) }); h.runEffects(); await tick();
  assert.deepEqual(h.state.opening.present_ids, ['a']); assert.deepEqual(h.state.extras[0].present_ids, ['a']);
  const modal = one(h.render({ ...props, hosted: original.characters!.slice(1) }), named('Modal'));
  await one(modal.props.footer, button('저장')).props.onClick();
  const saved = writes.at(-1)!.body;
  assert.deepEqual(saved.opening, { ...original.opening, present_ids: ['a'] });
  assert.deepEqual(JSON.parse(saved.openings_extra[0].opening_json), { scenario: '다른 장면', greeting: '다른 인사', scene: { day_index: 3 }, present_ids: ['a'] });
  assert.deepEqual(original.opening.present_ids, ['b', 'a'], 'reading a draft does not mutate the authoring data');
  assert.ok(reads.includes('/api/characters'));
});

test('conversation sheet offsets remain scoped away from both story and character editors', () => {
  for (const starter of ['choose', 'new']) {
    const page = storyHarness('StoryDetailPage', { id: story.id }, {}, { story, characters, editor: 'opening', starter });
    const tree = page.render();
    const editor = one(tree, named('StoryEditor'));
    assert.equal(editor.props.open, true);
    const child = one(tree, named(starter === 'choose' ? 'StoryConversationChooser' : 'NewStoryConversationSheet'));
    const sheet = storyHarness(child.type.name, child.props).render();
    const wrapper = one(sheet, classIs('story-conversation-sheet'));
    one(wrapper, named('BottomSheet'));
    assert.equal(nodes(wrapper).filter(named('StoryEditor')).length, 0);
  }
  const css = postcss.parse(fs.readFileSync(new URL('../apps/web/src/app.css', import.meta.url), 'utf8'));
  const expected = new Set(['.char-conversation-sheet .sheet', '.story-conversation-sheet .sheet']);
  const seen = new Set<string>();
  css.walkRules((rule) => {
    if (!rule.selectors.some((selector) => selector.includes('.sheet'))) return;
    if (!rule.nodes.some((node) => node.type === 'decl' && ['bottom', 'max-height'].includes(node.prop) && node.value.includes('--bottom-nav-offset'))) return;
    for (const selector of rule.selectors) { assert.ok(expected.has(selector), `sheet offset must not reach an editor: ${selector}`); seen.add(selector); }
  });
  assert.deepEqual(seen, expected);
});

async function main() {
  let passed = 0;
  for (const { name, run } of tests) { await run(); console.log(`ok ${++passed} ${name}`); }
  console.log(`passed ${passed}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
