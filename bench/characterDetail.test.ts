/** Character details and the explicitly opened conversation chooser. No server or live data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import postcss from 'postcss';
import React, { type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CharacterPage, CharacterDetailView, ConversationChooser, ConversationRow, NewConversationSheet } from '../apps/web/src/pages/CharacterPage.tsx';
import { BottomSheet, Spinner } from '../apps/web/src/components/ui.tsx';
import { CharacterEditor } from '../apps/web/src/components/CharacterEditor.tsx';
import { DiscCover, relTime, softHue } from '../apps/web/src/components/view.tsx';
import { loadCharacterStories } from '../apps/web/src/lib/characterDetails.ts';
import { characterHeroEmpty, resolveConversationCount, resolveLastChatAt } from '../apps/web/src/lib/characterChatStats.ts';
import { conversationTitleLabel } from '../apps/web/src/lib/conversationTitleLabel.ts';
import { stripDescSectionHeaders } from '../apps/web/src/lib/stripDescSectionHeaders.ts';
import { publicTags } from '../apps/web/src/lib/publicTags.ts';
import type { Character, Conversation, Story } from '../apps/web/src/types.ts';

const character: Character = {
  id: 'char/fixture', name: '하린', tagline: '기록을 찾는 여행자', avatar: null,
  description: 'LOOK & FEEL\n별을 읽는 기록자입니다.', personality: '침착하고 호기심이 많다.',
  speech_style: '나직한 존댓말', scenario: '오래된 역에서 지도를 펼쳤다.', first_message: '함께 찾아볼까요?',
  play_guide: '기록의 단서를 물어보세요.', example_dialogue: '', taboos: '', tags: ['탐험'],
  archived: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};
function story(id: string, setting = `세계-${id}`): Story {
  return { id, name: `스토리-${id}`, tagline: `소개-${id}`, cover: `/uploads/${id}.webp`, setting, archived: false } as Story;
}
const conversation = {
  id: 'conversation-fixture', title: '  ', character_name: character.name, story_name_snapshot: '별의 역',
  preview: '다음 역을 찾아가자.', favorite: true, created_at: '2026-01-01T00:00:00Z', last_message_at: '2026-02-01T00:00:00Z',
} as Conversation;
const tests: Array<{ name: string; run: () => unknown }> = [];
const test = (name: string, run: () => unknown) => tests.push({ name, run });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Execute production component bodies with controlled hook state. Effects and JSX callbacks
// are the actual source, so request boundaries, cleanup guards and payloads are not duplicated.
const filename = new URL('../apps/web/src/pages/CharacterPage.tsx', import.meta.url);
const source = ts.createSourceFile(filename.pathname, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const baseDependencies = {
  React, CharacterDetailView, ConversationChooser, ConversationRow, NewConversationSheet, CharacterEditor,
  BottomSheet, Spinner, DiscCover, relTime, softHue, characterHeroEmpty, resolveConversationCount,
  resolveLastChatAt, conversationTitleLabel, stripDescSectionHeaders, publicTags,
  useUi: () => ({ toast: () => {}, confirm: async () => true }),
  navigate: () => {}, back: () => {},
  get: async () => { throw new Error('unexpected GET'); },
  post: async () => { throw new Error('unexpected POST'); },
  patch: async () => { throw new Error('unexpected PATCH'); },
  del: async () => { throw new Error('unexpected DELETE'); },
  loadCharacterStories: async () => { throw new Error('unexpected story load'); },
};
function harness(name: string, props: Record<string, unknown>, dependencies: Record<string, unknown> = {}, initial: Record<string, unknown> = {}) {
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `production ${name} exists`);
  const stateNames: string[] = [];
  const refNames: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression.getText(source);
      if (callee === 'useState' && ts.isArrayBindingPattern(node.name)) stateNames.push(node.name.elements[0].getText(source));
      if (callee === 'useRef') refNames.push(node.name.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(declaration);
  const state = { ...initial };
  const refs: Record<string, { current: any }> = {};
  const writes: string[] = [];
  let effects: Array<() => void | (() => void)> = [];
  let stateIndex = 0;
  let refIndex = 0;
  const scope = {
    ...baseDependencies, ...dependencies,
    useState(value: unknown) {
      const key = stateNames[stateIndex++];
      assert.ok(key, 'all production useState calls named');
      if (!(key in state)) state[key] = typeof value === 'function' ? value() : value;
      return [state[key], (next: unknown) => {
        writes.push(key);
        state[key] = typeof next === 'function' ? next(state[key]) : next;
      }];
    },
    useRef(value: unknown) {
      const key = refNames[refIndex++];
      return refs[key] ??= { current: value };
    },
    useEffect(effect: () => void | (() => void)) { effects.push(effect); },
  };
  const compiled = ts.transpileModule(`return (${declaration.getText(source).replace(/^export\s+/, '')});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
  }).outputText;
  const component = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
  return {
    state, refs, writes,
    render(nextProps = props): ReactElement { stateIndex = 0; refIndex = 0; effects = []; return component(nextProps); },
    runEffects() { const cleanups = effects.map((effect) => effect()); return () => cleanups.forEach((cleanup) => cleanup?.()); },
  };
}
function nodes(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!React.isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function one(tree: ReactNode, predicate: (node: ReactElement<any>) => boolean) {
  const found = nodes(tree).filter(predicate);
  assert.equal(found.length, 1, 'exactly one requested rendered element');
  return found[0];
}
const classIs = (name: string) => (node: ReactElement<any>) => node.props.className?.split(' ').includes(name);
const textIs = (value: string) => (node: ReactElement<any>) => node.type === 'button' && node.props.children === value;

// Read-only relationship expansion is independent of chat creation.
test('linked stories are deduplicated, encoded, filtered and preserve successful results on partial failure', async () => {
  const requests: string[] = [];
  const a = story('story/a');
  const result = await loadCharacterStories(character.id, (async (url: string) => {
    requests.push(url);
    if (url.startsWith('/api/characters/')) return [
      { id: a.id, archived: false }, { id: a.id, archived: false }, { id: 'hidden', archived: true },
      { id: 'recently-archived', archived: false }, { id: 'broken', archived: false },
    ];
    if (url === '/api/stories/story%2Fa') return a;
    if (url === '/api/stories/recently-archived') return { ...story('recently-archived'), archived: true };
    throw new Error('story unavailable');
  }) as any);
  assert.deepEqual(result, { stories: [a], failed: true });
  assert.deepEqual(requests, ['/api/characters/char%2Ffixture/stories', '/api/stories/story%2Fa', '/api/stories/recently-archived', '/api/stories/broken']);
});
test('empty relationships are distinct from a failed lookup and cause no extra requests', async () => {
  const requests: string[] = [];
  assert.deepEqual(await loadCharacterStories('empty', (async (url: string) => { requests.push(url); return []; }) as any), { stories: [], failed: false });
  assert.deepEqual(requests, ['/api/characters/empty/stories']);
  await assert.rejects(loadCharacterStories('bad', (async () => { throw new Error('relationship lookup failed'); }) as any), /relationship lookup failed/);
});

test('detail renders supplied authoring fields and per-story worlds without a conversation list', () => {
  const stories = [story('first', 'WORLD & SETTING\n첫 번째 세계'), story('second', '두 번째 세계')];
  const html = renderToStaticMarkup(React.createElement(CharacterDetailView, { character, stories, storiesLoading: false, storiesError: false, onRetryStories() {} }));
  for (const value of ['캐릭터 소개', '별을 읽는 기록자입니다.', character.personality, character.speech_style, character.scenario, character.play_guide, character.first_message, '등장 스토리', '세계관', '첫 번째 세계', '두 번째 세계', '스토리-first', '스토리-second']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /LOOK &amp; FEEL|WORLD &amp; SETTING|이전 대화|마지막 대화|새 대화|conversation-fixture/);
  assert.match(html, /\/uploads\/first.webp/);
  assert.match(html, /<details[^>]*open=""/);
});
test('empty detail does not invent worlds, scenarios or first messages; story failure has actionable retry', () => {
  const empty = { ...character, description: '', personality: '', speech_style: '', scenario: '', play_guide: '', first_message: '' };
  const props = { character: empty, stories: [], storiesLoading: false, storiesError: false, onRetryStories() {} };
  const html = renderToStaticMarkup(React.createElement(CharacterDetailView, props));
  assert.match(html, /아직 등록된 소개가 없습니다/);
  assert.match(html, /아직 연결된 스토리가 없습니다/);
  assert.doesNotMatch(html, /세계관|시작 상황|플레이 안내|첫 만남/);
  let retries = 0;
  const view = CharacterDetailView({ ...props, storiesError: true, onRetryStories: () => { retries++; } });
  const retry = one(view, textIs('스토리 다시 불러오기'));
  retry.props.onClick();
  assert.equal(retries, 1);
  const failure = renderToStaticMarkup(view);
  assert.match(failure, /스토리를 불러오지 못했습니다/);
  assert.doesNotMatch(failure, /아직 연결된 스토리가 없습니다/);
});
test('appearing-story card opens that story without starting a character conversation', () => {
  const routes: string[] = [];
  const h = harness('CharacterDetailView', { character, stories: [story('story-a')], storiesLoading: false, storiesError: false, onRetryStories() {} }, { navigate: (route: string) => routes.push(route) });
  one(h.render(), classIs('char-story-card')).props.onClick();
  assert.deepEqual(routes, ['/story/story-a']);
});

test('character entry fetches only detail and stories; Start opens chooser, new form and back are mutually exclusive', async () => {
  const requests: string[] = [];
  const h = harness('CharacterDetailPage', { id: character.id }, {
    get: async (url: string) => { requests.push(url); return character; },
    loadCharacterStories: async (id: string) => { requests.push(`stories:${id}`); return { stories: [], failed: false }; },
  });
  h.render(); h.runEffects(); await tick();
  let tree = h.render();
  assert.deepEqual(requests, ['/api/characters/char%2Ffixture', 'stories:char/fixture']);
  assert.equal(nodes(tree).filter((node) => node.type === ConversationChooser || node.type === NewConversationSheet).length, 0);
  one(tree, textIs('대화 시작')).props.onClick();
  tree = h.render();
  const chooser = one(tree, (node) => node.type === ConversationChooser);
  assert.equal(nodes(tree).filter((node) => node.type === NewConversationSheet).length, 0);
  chooser.props.onNew();
  tree = h.render();
  const newSheet = one(tree, (node) => node.type === NewConversationSheet);
  assert.equal(nodes(tree).filter((node) => node.type === ConversationChooser).length, 0);
  newSheet.props.onBack();
  one(h.render(), (node) => node.type === ConversationChooser).props.onClose();
  assert.equal(nodes(h.render()).filter((node) => node.type === ConversationChooser || node.type === NewConversationSheet).length, 0);
  assert.deepEqual(requests, ['/api/characters/char%2Ffixture', 'stories:char/fixture'], 'opening the form itself cannot create a conversation');
  assert.equal(CharacterPage({ id: 'a' }).key, 'a');
  assert.equal(CharacterPage({ id: 'b' }).key, 'b', 'a character switch resets the detail/form subtree');
});
test('conversation sheet offsets cannot affect the character editor on the same detail page', () => {
  function expandConversationSheet(node: ReactNode): ReactNode {
    if (Array.isArray(node)) return node.map(expandConversationSheet);
    if (!React.isValidElement<any>(node)) return node;
    if (node.type === ConversationChooser || node.type === NewConversationSheet) {
      return harness(node.type.name, node.props).render();
    }
    return React.cloneElement(node, { children: expandConversationSheet(node.props.children) });
  }
  for (const starter of ['choose', 'new']) {
    const page = harness('CharacterDetailPage', { id: character.id }, {}, {
      char: character, loading: false, editorOpen: true, starter,
    });
    const tree = expandConversationSheet(page.render());
    const wrapper = one(tree, classIs('char-conversation-sheet'));
    one(wrapper, (node) => node.type === BottomSheet);
    assert.equal(nodes(wrapper).filter((node) => node.type === CharacterEditor).length, 0);
    assert.equal(one(tree, (node) => node.type === CharacterEditor).props.open, true,
      'the editor remains rendered outside the conversation-only offset wrapper');
  }
  const css = postcss.parse(fs.readFileSync(new URL('../apps/web/src/app.css', import.meta.url), 'utf8'));
  let offsetRules = 0;
  css.walkRules((rule) => {
    if (!rule.selectors.some((selector) => selector.includes('.sheet'))) return;
    const offset = rule.nodes.some((node) => node.type === 'decl' &&
      (node.prop === 'bottom' || node.prop === 'max-height') && node.value.includes('--bottom-nav-offset'));
    if (!offset) return;
    if (rule.selectors.includes('.char-conversation-sheet .sheet')) offsetRules++;
    for (const selector of rule.selectors) assert.ok(['.char-conversation-sheet .sheet', '.story-conversation-sheet .sheet'].includes(selector),
      'bottom-navigation offsets must target dedicated conversation wrappers, never editors or full detail subtrees');
  });
  assert.ok(offsetRules > 0, 'conversation sheets retain the bottom-navigation offset');
});
test('character and linked-story responses cannot mutate an unmounted detail; failures allow retry', async () => {
  const detail = deferred<Character>(); const worlds = deferred<{ stories: Story[]; failed: boolean }>();
  const h = harness('CharacterDetailPage', { id: character.id }, { get: () => detail.promise, loadCharacterStories: () => worlds.promise });
  h.render(); const cleanup = h.runEffects(); cleanup();
  const writes = h.writes.length;
  detail.resolve(character); worlds.reject(new Error('late failure')); await tick();
  assert.equal(h.writes.length, writes);
  assert.equal(h.state.char, null);
  let fail = true;
  const retry = harness('CharacterDetailPage', { id: character.id }, {
    get: async () => { if (fail) throw new Error('offline'); return character; },
    loadCharacterStories: async () => ({ stories: [], failed: false }),
  });
  retry.render(); retry.runEffects(); await tick();
  assert.equal(retry.state.error, true);
  one(retry.render(), textIs('다시 시도')).props.onClick();
  assert.equal(retry.state.revision, 1);
  fail = false; retry.render(); retry.runEffects(); await tick();
  assert.equal(retry.state.char, character); assert.equal(retry.state.error, false);
});
test('chooser loads conversations only when mounted, retries failed reads, and ignores late reads', async () => {
  const requests: string[] = [];
  let fail = true;
  const h = harness('ConversationChooser', { character, onClose() {}, onNew() {} }, {
    get: async (url: string) => { requests.push(url); if (fail) throw new Error('offline'); return [conversation]; },
  });
  let tree = h.render(); assert.deepEqual(requests, []);
  h.runEffects(); await tick(); assert.equal(h.state.error, true);
  one(h.render(), textIs('다시 시도')).props.onClick(); assert.equal(h.state.revision, 1);
  fail = false; h.render(); h.runEffects(); await tick(); tree = h.render();
  assert.deepEqual(requests, Array(2).fill('/api/conversations?characterId=char%2Ffixture&limit=200'));
  assert.equal(one(tree, (node) => node.type === ConversationRow).props.conv, conversation);
  assert.equal(h.state.error, false);
  const late = deferred<Conversation[]>();
  const stale = harness('ConversationChooser', { character, onClose() {}, onNew() {} }, { get: () => late.promise });
  stale.render(); const cleanup = stale.runEffects(); cleanup(); const writes = stale.writes.length;
  late.resolve([conversation]); await tick(); assert.equal(stale.writes.length, writes); assert.deepEqual(stale.state.convs, []);
});

test('new conversation waits for personas, chooses the default, and can retry persona lookup failure', async () => {
  let fail = true;
  const h = harness('NewConversationSheet', { character, onClose() {}, onBack() {} }, {
    get: async (url: string) => { assert.equal(url, '/api/personas'); if (fail) throw new Error('offline'); return [{ id: 'first', name: '첫째' }, { id: 'default', name: '기본', is_default: true }]; },
  });
  assert.equal(one(h.render(), textIs('시작')).props.disabled, true);
  h.runEffects(); await tick(); assert.equal(h.state.error, true);
  one(h.render(), textIs('다시 시도')).props.onClick(); assert.equal(h.state.retry, 1);
  fail = false; h.render(); h.runEffects(); await tick();
  assert.equal(h.state.personaId, 'default'); assert.equal(one(h.render(), textIs('시작')).props.disabled, false);
  const late = deferred<unknown>();
  const stale = harness('NewConversationSheet', { character, onClose() {}, onBack() {} }, { get: () => late.promise });
  stale.render(); const cleanup = stale.runEffects(); cleanup(); const writes = stale.writes.length;
  late.resolve([{ id: 'obsolete', is_default: true }]); await tick(); assert.equal(stale.writes.length, writes);
});
test('new conversation preserves character-only create payload and latches duplicate clicks before rerender', async () => {
  const request = deferred<Conversation>();
  const requests: unknown[] = []; const actions: string[] = [];
  const h = harness('NewConversationSheet', { character, onClose: () => actions.push('close'), onBack() {} }, {
    post: (url: string, body: unknown) => { requests.push({ url, body }); return request.promise; },
    navigate: (route: string) => actions.push(route),
  }, { loading: false, personaId: 'persona-a', title: '  새 제목  ', scene: { place: '도서관', goal: '기록 찾기' } });
  const create = one(h.render(), textIs('시작')).props.onClick;
  const first = create(); await create();
  assert.deepEqual(requests, [{ url: '/api/conversations', body: { characterId: character.id, personaId: 'persona-a', mode: 'story', title: '새 제목', scene: { place: '도서관', goal: '기록 찾기' } } }]);
  assert.equal(h.refs.pending.current, true);
  one(h.render(), (node) => node.type === BottomSheet).props.onClose(); assert.deepEqual(actions, [], 'dismiss blocked while saving');
  request.resolve(conversation); await first;
  assert.deepEqual(actions, ['close', '/chat/conversation-fixture']); assert.equal(h.refs.pending.current, false);
});
test('failed creation reports an error, keeps the form, releases its latch and permits retry', async () => {
  let calls = 0; const actions: string[] = [];
  const h = harness('NewConversationSheet', { character, onClose: () => actions.push('close'), onBack() {} }, {
    post: async (_url: string, body: any) => { calls++; assert.equal(body.title, undefined); assert.equal(body.personaId, null); if (calls === 1) throw new Error('create rejected'); return conversation; },
    useUi: () => ({ toast: (message: string) => actions.push(message) }), navigate: (route: string) => actions.push(route),
  }, { loading: false, title: '   ' });
  await one(h.render(), textIs('시작')).props.onClick();
  assert.deepEqual(actions, ['create rejected']); assert.equal(h.state.busy, false); assert.equal(h.refs.pending.current, false);
  await one(h.render(), textIs('시작')).props.onClick(); assert.equal(calls, 2);
  assert.deepEqual(actions, ['create rejected', 'close', '/chat/conversation-fixture']);
});
test('persona loading and lookup errors prevent creation even if the submit callback is invoked', async () => {
  for (const state of [{ loading: true, error: false }, { loading: false, error: true }]) {
    let posts = 0;
    const h = harness('NewConversationSheet', { character, onClose() {}, onBack() {} }, {
      post: async () => { posts++; return conversation; },
    }, state);
    const submit = one(h.render(), textIs('시작'));
    assert.equal(submit.props.disabled, true);
    await submit.props.onClick();
    assert.equal(posts, 0); assert.equal(h.refs.pending.current, false);
  }
});
test('late creation success or failure cannot navigate, toast, or mutate the form after unmount', async () => {
  for (const outcome of ['resolve', 'reject'] as const) {
    const request = deferred<Conversation>(); const actions: string[] = [];
    const h = harness('NewConversationSheet', { character, onClose: () => actions.push('close'), onBack() {} }, {
      get: async () => [], post: () => request.promise,
      navigate: (route: string) => actions.push(route), useUi: () => ({ toast: (message: string) => actions.push(message) }),
    });
    h.render(); const cleanup = h.runEffects(); await tick();
    const saving = one(h.render(), textIs('시작')).props.onClick();
    assert.equal(h.refs.pending.current, true);
    cleanup(); const writes = h.writes.length;
    if (outcome === 'resolve') request.resolve(conversation);
    else request.reject(new Error('obsolete creation failure'));
    await saving;
    assert.deepEqual(actions, [], outcome); assert.equal(h.writes.length, writes, outcome);
    assert.equal(h.refs.pending.current, false);
  }
});
test('conversation rows preserve title fallback, preview, navigation, favorite and cancellable deletion', async () => {
  const writes: unknown[] = []; const routes: string[] = []; let confirmed = false; let refreshed = 0;
  const h = harness('ConversationRow', { conv: conversation, onChanged: () => { refreshed++; } }, {
    navigate: (route: string) => routes.push(route), patch: async (url: string, body: unknown) => writes.push({ url, body }),
    del: async (url: string) => writes.push({ url, deleted: true }), useUi: () => ({ confirm: async () => confirmed, toast() {} }),
  });
  let tree = h.render();
  const html = renderToStaticMarkup(tree); assert.match(html, /하린 · 별의 역/); assert.match(html, /다음 역을 찾아가자/);
  one(tree, classIs('char-conversation-open')).props.onClick(); assert.deepEqual(routes, ['/chat/conversation-fixture']);
  one(tree, (node) => node.props['aria-label'] === '즐겨찾기').props.onClick(); await tick();
  assert.deepEqual(writes, [{ url: '/api/conversations/conversation-fixture', body: { favorite: false } }]);
  tree = h.render(); one(tree, (node) => node.props['aria-label'] === '삭제').props.onClick(); await tick(); assert.equal(writes.length, 1); assert.equal(h.refs.pending.current, false);
  confirmed = true; one(h.render(), (node) => node.props['aria-label'] === '삭제').props.onClick(); await tick();
  assert.deepEqual(writes[1], { url: '/api/conversations/conversation-fixture', deleted: true }); assert.equal(refreshed, 2);
});

async function main() {
  for (const [index, { name, run }] of tests.entries()) { await run(); console.log(`ok ${index + 1} ${name}`); }
  console.log(`passed ${tests.length}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
