/** Runs shipped story JSX/effects/callbacks with deterministic hooks and stubbed I/O. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import React, { type ReactElement, type ReactNode } from 'react';
import ts from 'typescript';
import type { Character, Story, StoryInjectPreview } from '../../apps/web/src/types.ts';

export const character = (id: string, archived = false) => ({ id, name: `인물-${id}`, avatar: null, archived } as Character);
export const storyFixture = (patch: Partial<Story> = {}): Story => ({
  id: 'story/fixture', name: '별의 도서관', tagline: '책 속의 밤을 걷는 이야기', cover: '/uploads/story.webp',
  setting: 'WORLD & SETTING\n자정을 지나면 사라진 별이 책으로 돌아온다.', archived: false,
  minor_cast: [{ name: '문지기', note: '도서관을 지킨다.' }],
  characters: ['b', 'a'].map((id, sort_order) => ({ story_id: 'story/fixture', character_id: id, role: 'main', sort_order, name: `인물-${id}` })),
  opening: { scenario: '닫힌 서가 앞에 도착했다.', greeting: '책을 찾으러 오셨나요?', scene: {}, present_ids: [] },
  openings_extra: [{ id: 'rain', label: '비 오는 밤', opening_json: '{}' }],
  endings: [{ id: 'secret', title: '비밀 엔딩 제목', description: '숨길 스포일러', badge_label: '별' }],
  ...patch,
} as Story);
export const previewFixture = { settingExcerpt: '돌아온 별', settingTruncated: false, cast: [], estTokens: 20 } as unknown as StoryInjectPreview;
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
export function nodes(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!React.isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
export function one(tree: ReactNode, predicate: (node: ReactElement<any>) => boolean) {
  const found = nodes(tree).filter(predicate);
  assert.equal(found.length, 1, 'exactly one requested rendered element');
  return found[0];
}
export const named = (name: string) => (node: ReactElement<any>) => typeof node.type === 'function' && node.type.name === name;
export const classIs = (name: string) => (node: ReactElement<any>) => node.props.className?.split(' ').includes(name);
export function text(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return React.isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
}
export const button = (label: string) => (node: ReactElement<any>) => node.type === 'button' && text(node.props.children).trim() === label;

type Dependencies = { api?: Record<string, unknown>; router?: Record<string, unknown>; ui?: Record<string, unknown> };
export function storyHarness(name: string, props: Record<string, unknown>, dependencies: Dependencies = {}, initial: Record<string, unknown> = {}, file = 'pages/StoryPage.tsx') {
  const filename = new URL(`../../apps/web/src/${file}`, import.meta.url);
  const raw = fs.readFileSync(filename, 'utf8');
  const source = ts.createSourceFile(filename.pathname, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `production ${name} exists`);
  const stateNames: string[] = [], refNames: string[] = [];
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
  let stateIndex = 0, refIndex = 0, effectIndex = 0;
  const effects: Array<{ deps?: unknown[]; cleanup?: void | (() => void); pending?: () => void | (() => void) }> = [];
  const hookReact = {
    ...React,
    useState(value: unknown) {
      const key = stateNames[stateIndex++];
      assert.ok(key, 'all production state calls named');
      if (!(key in state)) state[key] = typeof value === 'function' ? value() : value;
      return [state[key], (next: unknown) => { writes.push(key); state[key] = typeof next === 'function' ? next(state[key]) : next; }];
    },
    useRef(value: unknown) {
      const key = refNames[refIndex++];
      assert.ok(key, 'all production refs named');
      return refs[key] ??= { current: value };
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const index = effectIndex++;
      const prior = effects[index];
      const changed = !prior || !deps || !prior.deps || deps.length !== prior.deps.length || deps.some((v, i) => !Object.is(v, prior.deps![i]));
      if (changed) effects[index] = { deps, cleanup: prior?.cleanup, pending: effect };
    },
  };
  const require = createRequire(filename);
  const module = { exports: {} as Record<string, any> };
  const unexpected = async () => { throw new Error('unexpected request'); };
  const scopedRequire = (id: string) => {
    if (id === 'react') return hookReact;
    const real = require(id);
    if (id === '../lib/api') return { ...real, get: unexpected, post: unexpected, put: unexpected, del: unexpected, patch: unexpected, ...dependencies.api };
    if (id === '../lib/router') return { ...real, navigate() {}, back() {}, ...dependencies.router };
    if (id === '../components/ui' || id === './ui') return { ...real, useUi: () => ({ toast() {}, confirm: async () => true, ...dependencies.ui }) };
    return real;
  };
  const compiled = ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require', 'module', 'exports', compiled)(scopedRequire, module, module.exports);
  assert.equal(typeof module.exports[name], 'function', `${name} is exported for behavioral verification`);
  return {
    state, refs, writes, exports: module.exports,
    render(nextProps = props): ReactElement { stateIndex = refIndex = effectIndex = 0; return module.exports[name](nextProps); },
    runEffects() {
      for (const entry of effects) {
        if (!entry.pending) continue;
        entry.cleanup?.(); entry.cleanup = entry.pending(); entry.pending = undefined;
      }
    },
    cleanup() { for (const entry of effects) { entry.cleanup?.(); entry.cleanup = undefined; entry.pending = undefined; } },
  };
}

export async function loadedStoryStart(options: {
  story?: Story; characters?: Character[]; get?: (url: string) => Promise<unknown>;
  post?: (url: string, body: any) => Promise<unknown>; navigate?: (url: string) => void;
  onClose?: () => void; onBack?: () => void; onEdit?: () => void; onArchived?: () => void;
  toast?: (message: string, kind?: string) => void;
} = {}) {
  const story = options.story ?? storyFixture();
  const requests: string[] = [];
  const h = storyHarness('NewStoryConversationSheet', {
    id: story.id, onClose: options.onClose ?? (() => {}), onBack: options.onBack ?? (() => {}),
    onEdit: options.onEdit ?? (() => {}), onArchived: options.onArchived ?? (() => {}),
  }, {
    api: {
      get: async (url: string) => {
        requests.push(url);
        if (options.get) return options.get(url);
        if (url.includes('/inject-preview?')) return previewFixture;
        if (url === '/api/characters') return options.characters ?? [character('a'), character('b')];
        return story;
      },
      post: options.post ?? (async () => { throw new Error('unexpected POST'); }),
    },
    router: { navigate: options.navigate ?? (() => {}) },
    ui: { toast: options.toast ?? (() => {}) },
  });
  for (let i = 0; i < 3; i++) { h.render(); h.runEffects(); await tick(); }
  return { ...h, requests };
}
