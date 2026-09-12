/**
 * npx tsx bench/characterTokenInsert.test.ts
 * C12 character-authoring {{char}}/{{user}} insert chips.
 * Isolated: no systemd, no live DB, no model, no migration, no generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require2 = createRequire(import.meta.url);
let insertMod: typeof import('../apps/web/src/lib/characterTokenInsert.ts');
try {
  insertMod = require2('../apps/web/src/lib/characterTokenInsert.ts');
} catch (e) {
  console.error('RED: characterTokenInsert missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const {
  INSERTABLE_TOKENS,
  TOKEN_CHIP_FIELDS,
  insertCharacterToken,
  applyTokenCaretRestore,
} = insertMod;

let substitute: (text: string, charName: string, userName: string) => string;
try {
  substitute = require2('../apps/server/src/prompt/templates.ts').substitute;
} catch (e) {
  console.error('RED: substitute missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

let draftMod: typeof import('../apps/web/src/lib/characterDraftStore.ts');
try {
  draftMod = require2('../apps/web/src/lib/characterDraftStore.ts');
} catch (e) {
  console.error('RED: characterDraftStore missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const {
  CHARACTER_DRAFT_DEBOUNCE_MS,
  flushCharacterDraft,
  readCharacterDraft,
  removeCharacterDraft,
  writeCharacterDraft,
} = draftMod;

import type { CharacterDraft, Kv } from '../apps/web/src/lib/characterDraftStore.ts';
import { FIELD_LIMITS } from '../apps/web/src/lib/characterFieldLimits.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const editorPath = path.join(dir, '..', 'apps/web/src/components/CharacterEditor.tsx');
const editor = fs.readFileSync(editorPath, 'utf8');
const limitsSrc = fs.readFileSync(
  path.join(dir, '..', 'apps/web/src/lib/characterFieldLimits.ts'),
  'utf8',
);

const SAMPLE: CharacterDraft = {
  name: '테스트',
  tagline: '한줄',
  avatar: null,
  description: '설명',
  personality: '성격',
  speech_style: '말투',
  scenario: '장면',
  first_message: '안녕',
  example_dialogue: '대화',
  taboos: '금기',
  tags: ['party:role=secondary'],
};

const OTHER: CharacterDraft = { ...SAMPLE, name: '다른' };

function memKv(init: Record<string, string> = {}): Kv & { map: Map<string, string> } {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

function tabSection(key: string, next: string | null): string {
  const startTok = `tab === '${key}'`;
  const start = editor.indexOf(startTok);
  assert.ok(start >= 0, `tab === '${key}' missing`);
  const endTok = next ? `tab === '${next}'` : '← 이전';
  const end = editor.indexOf(endTok, start + startTok.length);
  assert.ok(end > start, `end marker missing after ${key}`);
  return editor.slice(start, end);
}

function insertTokenSrc(): string {
  const start = editor.indexOf('function insertToken');
  assert.ok(start >= 0, 'function insertToken missing');
  const end = editor.indexOf('async function save()');
  assert.ok(end > start, 'insertToken must sit before save()');
  return editor.slice(start, end);
}

function tokenChipsSrc(): string {
  const start = editor.indexOf('function TokenChips');
  assert.ok(start >= 0, 'function TokenChips missing');
  const end = editor.indexOf('export function CharacterEditor');
  assert.ok(end > start, 'TokenChips must be module-level before CharacterEditor');
  return editor.slice(start, end);
}

type FakeNode = {
  selectionStart: number | null;
  selectionEnd: number | null;
  isConnected: boolean;
  focused: boolean;
  range: [number, number] | null;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
};

function fakeNode(init: Partial<FakeNode> = {}): FakeNode {
  const node: FakeNode = {
    selectionStart: init.selectionStart ?? 0,
    selectionEnd: init.selectionEnd ?? 0,
    isConnected: init.isConnected ?? true,
    focused: false,
    range: null,
    focus() { node.focused = true; },
    setSelectionRange(start: number, end: number) {
      node.range = [start, end];
      node.selectionStart = start;
      node.selectionEnd = end;
    },
  };
  return node;
}

function bindEditorTokenInsert(editorSrc: string, ctx: {
  dirtyRef: { current: boolean };
  suppressRef: { current: boolean };
  dRef: { current: CharacterDraft };
  timerRef: { current: ReturnType<typeof setTimeout> | null };
  character: { id: string } | null;
  setD: (fn: (p: CharacterDraft) => CharacterDraft) => void;
  clearTimer: () => void;
  pendingDraft: CharacterDraft | null;
  fieldRefs: { current: Record<string, FakeNode | null> };
}) {
  const setSrc = editorSrc.slice(editorSrc.indexOf('const set ='), editorSrc.indexOf('async function save()'));
  const discardSrc = editorSrc.slice(
    editorSrc.indexOf('function discardDraft()'),
    editorSrc.indexOf('function addTag()'),
  );
  assert.ok(setSrc.includes('const set ='), 'set() missing');
  assert.ok(setSrc.includes('function insertToken'), 'insertToken must live next to set(), before save()');
  assert.ok(discardSrc.includes('function discardDraft()'), 'discardDraft() missing');
  const wrapped = `
    export function bind(ctx: any) {
      const dirtyRef = ctx.dirtyRef;
      const suppressRef = ctx.suppressRef;
      const dRef = ctx.dRef;
      const timerRef = ctx.timerRef;
      const character = ctx.character;
      const setD = ctx.setD;
      const clearTimer = ctx.clearTimer;
      const flushCharacterDraft = ctx.flushCharacterDraft;
      const removeCharacterDraft = ctx.removeCharacterDraft;
      const CHARACTER_DRAFT_DEBOUNCE_MS = ctx.CHARACTER_DRAFT_DEBOUNCE_MS;
      const fieldRefs = ctx.fieldRefs;
      const FIELD_LIMITS = ctx.FIELD_LIMITS;
      const insertCharacterToken = ctx.insertCharacterToken;
      const applyTokenCaretRestore = ctx.applyTokenCaretRestore;
      function setPendingDraft(v: any) { ctx.pendingDraft = v; }
      ${setSrc}
      ${discardSrc}
      return { set, discardDraft, insertToken };
    }
  `;
  const { transformSync } = require2('esbuild');
  const js = transformSync(wrapped, { loader: 'ts', format: 'cjs' }).code;
  const exported: {
    bind?: (ctx: unknown) => {
      set: (k: string, v: unknown) => void;
      discardDraft: () => void;
      insertToken: (field: string, token: string) => void;
    };
  } = {};
  const moduleObj = { exports: exported };
  new Function('exports', 'module', 'require', js)(exported, moduleObj, require2);
  const bind = exported.bind ?? (moduleObj.exports as { bind: typeof exported.bind }).bind;
  assert.equal(typeof bind, 'function');
  const bindCtx = ctx as typeof ctx & {
    flushCharacterDraft: typeof flushCharacterDraft;
    removeCharacterDraft: typeof removeCharacterDraft;
    CHARACTER_DRAFT_DEBOUNCE_MS: number;
    FIELD_LIMITS: typeof FIELD_LIMITS;
    insertCharacterToken: typeof insertCharacterToken;
    applyTokenCaretRestore: typeof applyTokenCaretRestore;
  };
  bindCtx.flushCharacterDraft = flushCharacterDraft;
  bindCtx.removeCharacterDraft = removeCharacterDraft;
  bindCtx.CHARACTER_DRAFT_DEBOUNCE_MS = CHARACTER_DRAFT_DEBOUNCE_MS;
  bindCtx.FIELD_LIMITS = FIELD_LIMITS;
  bindCtx.insertCharacterToken = insertCharacterToken;
  bindCtx.applyTokenCaretRestore = applyTokenCaretRestore;
  return bind!(bindCtx);
}

t('1 insertable tokens are exactly {{char}} and {{user}}', () => {
  assert.deepEqual([...INSERTABLE_TOKENS], ['{{char}}', '{{user}}']);
  assert.equal(INSERTABLE_TOKENS.length, 2);
  assert.equal(INSERTABLE_TOKENS.includes('{{Char}}' as typeof INSERTABLE_TOKENS[number]), false);
});

t('2 both tokens are in the substitute() recognised set', () => {
  assert.equal(substitute('{{char}}', '캐릭', '유저'), '캐릭');
  assert.equal(substitute('{{user}}', '캐릭', '유저'), '유저');
  assert.equal(substitute('{{char}} {{user}}', '캐릭', '유저'), '캐릭 유저');
  for (const tok of INSERTABLE_TOKENS) {
    assert.match(tok, /^\{\{\s*char\s*\}\}$|^\{\{\s*user\s*\}\}$/);
    assert.notEqual(substitute(tok, 'C', 'U'), tok);
  }
});

t('3 insert at string start', () => {
  const r = insertCharacterToken('hello', '{{char}}', 0, 0);
  assert.equal(r.text, '{{char}}hello');
  assert.equal(r.caret, '{{char}}'.length);
});

t('4 insert at mid-string caret', () => {
  const r = insertCharacterToken('ab', '{{user}}', 1, 1);
  assert.equal(r.text, 'a{{user}}b');
  assert.equal(r.caret, 1 + '{{user}}'.length);
});

t('5 insert at string end', () => {
  const r = insertCharacterToken('ab', '{{char}}', 2, 2);
  assert.equal(r.text, 'ab{{char}}');
  assert.equal(r.caret, 'ab{{char}}'.length);
});

t('6 selection is replaced by the token', () => {
  const r = insertCharacterToken('hello', '{{user}}', 1, 4);
  assert.equal(r.text, 'h{{user}}o');
  assert.equal(r.caret, 1 + '{{user}}'.length);
});

t('7 missing selection inserts at end', () => {
  assert.equal(insertCharacterToken('ab', '{{char}}').text, 'ab{{char}}');
  assert.equal(insertCharacterToken('ab', '{{char}}', null, null).text, 'ab{{char}}');
  assert.equal(insertCharacterToken('ab', '{{user}}', undefined, undefined).text, 'ab{{user}}');
  assert.equal(insertCharacterToken('ab', '{{char}}', Number.NaN, 0).text, 'ab{{char}}');
});

t('8 insert into empty string', () => {
  const r = insertCharacterToken('', '{{char}}', 0, 0);
  assert.equal(r.text, '{{char}}');
  assert.equal(r.caret, '{{char}}'.length);
  assert.equal(insertCharacterToken('', '{{user}}').text, '{{user}}');
});

t('9 caret after insert sits just after the token', () => {
  const a = insertCharacterToken('xyz', '{{char}}', 1, 1);
  assert.equal(a.caret, 1 + '{{char}}'.length);
  assert.equal(a.text.slice(a.caret - '{{char}}'.length, a.caret), '{{char}}');
  const b = insertCharacterToken('xyz', '{{user}}', 0, 2);
  assert.equal(b.caret, '{{user}}'.length);
  assert.equal(b.text.slice(0, b.caret), '{{user}}');
});

t('10 out-of-range selection is clamped to string bounds', () => {
  const r = insertCharacterToken('hi', '{{char}}', -4, 99);
  assert.equal(r.text, '{{char}}');
  assert.equal(r.caret, '{{char}}'.length);
  const end = insertCharacterToken('hi', '{{user}}', 80, 80);
  assert.equal(end.text, 'hi{{user}}');
  assert.equal(end.caret, 'hi{{user}}'.length);
});

t('11 reversed selection range is handled safely', () => {
  const r = insertCharacterToken('hello', '{{char}}', 4, 1);
  assert.equal(r.text, 'h{{char}}o');
  assert.equal(r.caret, 1 + '{{char}}'.length);
});

t('12 chips are wired only to the eight target fields', () => {
  assert.deepEqual([...TOKEN_CHIP_FIELDS], [
    'tagline',
    'description',
    'personality',
    'speech_style',
    'scenario',
    'taboos',
    'first_message',
    'example_dialogue',
  ]);
  for (const field of TOKEN_CHIP_FIELDS) {
    assert.ok(
      editor.includes(`<TokenChips field="${field}"`),
      `TokenChips missing for ${field}`,
    );
  }
  assert.equal((editor.match(/<TokenChips field="/g) ?? []).length, 8);
});

t('13 name, avatar, and tag input have no chips', () => {
  const setup = tabSection('setup', 'intro');
  const nameBlock = setup.slice(setup.indexOf('이름 *'), setup.indexOf('한 줄 소개'));
  assert.equal(nameBlock.includes('TokenChips'), false);
  assert.equal(nameBlock.includes('{{char}}'), false);
  const avatarUrl = setup.slice(setup.indexOf('아바타 URL'), setup.indexOf('아바타 파일'));
  assert.equal(avatarUrl.includes('TokenChips'), false);
  const avatarFile = setup.slice(setup.indexOf('아바타 파일'));
  assert.equal(avatarFile.includes('TokenChips'), false);
  const detail = tabSection('detail', 'lore');
  const tagBlock = detail.slice(detail.indexOf('태그'));
  assert.equal(tagBlock.includes('TokenChips'), false);
  assert.equal(editor.includes('<TokenChips field="name"'), false);
  assert.equal(editor.includes('<TokenChips field="avatar"'), false);
  assert.equal(editor.includes('<TokenChips field="tags"'), false);
});

t('14 chip insert state update goes through existing set()', () => {
  const body = insertTokenSrc();
  assert.match(body, /set\(field, /);
  assert.ok(body.includes('insertCharacterToken'));
});

t('15 chip insert does not call setD directly', () => {
  const body = insertTokenSrc();
  assert.equal(/setD\s*\(/.test(body), false);
  assert.match(body, /set\(field, /);
});

t('16 chip insert via insertToken sets dirty=true and suppress=false (store read)', () => {
  const id = 'c12c12c1-2c12-4c12-8c12-c12c12c12c12';
  const kv = memKv();
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: kv });
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  }) as typeof requestAnimationFrame;
  try {
    const dirtyRef = { current: false };
    const suppressRef = { current: true };
    const dRef = { current: { ...SAMPLE } };
    const timerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
    function clearTimer() {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
    const ctx = {
      dirtyRef,
      suppressRef,
      dRef,
      timerRef,
      character: { id },
      setD: (fn: (p: CharacterDraft) => CharacterDraft) => { dRef.current = fn(dRef.current); },
      clearTimer,
      pendingDraft: null as CharacterDraft | null,
      fieldRefs: { current: { personality: fakeNode({ selectionStart: 2, selectionEnd: 2 }) } },
    };
    const { insertToken } = bindEditorTokenInsert(editor, ctx);
    insertToken('personality', '{{char}}');
    assert.equal(dirtyRef.current, true);
    assert.equal(suppressRef.current, false);
    assert.equal(dRef.current.personality, '성격'.slice(0, 2) + '{{char}}' + '성격'.slice(2));
    clearTimer();
    flushCharacterDraft(id, dRef.current, { dirty: dirtyRef.current, suppress: suppressRef.current });
    assert.deepEqual(readCharacterDraft(id), dRef.current);
    assert.equal(readCharacterDraft(id)?.personality.includes('{{char}}'), true);
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    globalThis.requestAnimationFrame = prevRaf;
  }
});

t('17 discard then chip insert reactivates autosave (store read)', () => {
  const id = 'd17d17d1-7d17-4d17-8d17-d17d17d17d17';
  const kv = memKv();
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: kv });
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  }) as typeof requestAnimationFrame;
  try {
    writeCharacterDraft(id, OTHER);
    assert.deepEqual(readCharacterDraft(id), OTHER);

    const dirtyRef = { current: false };
    const suppressRef = { current: false };
    const dRef = { current: { ...SAMPLE } };
    const timerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
    function clearTimer() {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
    const ctx = {
      dirtyRef,
      suppressRef,
      dRef,
      timerRef,
      character: { id },
      setD: (fn: (p: CharacterDraft) => CharacterDraft) => { dRef.current = fn(dRef.current); },
      clearTimer,
      pendingDraft: OTHER as CharacterDraft | null,
      fieldRefs: { current: {} as Record<string, FakeNode | null> },
    };
    const { insertToken, discardDraft } = bindEditorTokenInsert(editor, ctx);

    discardDraft();
    assert.equal(ctx.pendingDraft, null);
    assert.equal(readCharacterDraft(id), null);
    flushCharacterDraft(id, dRef.current, { dirty: dirtyRef.current, suppress: suppressRef.current });
    assert.equal(readCharacterDraft(id), null, 'discard without new edits must not resurrect');

    insertToken('tagline', '{{user}}');
    assert.equal(dirtyRef.current, true);
    assert.equal(suppressRef.current, false);
    clearTimer();
    flushCharacterDraft(id, dRef.current, { dirty: dirtyRef.current, suppress: suppressRef.current });
    assert.equal(readCharacterDraft(id)?.tagline, '한줄{{user}}');
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    globalThis.requestAnimationFrame = prevRaf;
  }
});

t('18 focus-steal preventDefault and post-render caret restore path', () => {
  const chips = tokenChipsSrc();
  assert.match(chips, /onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/);
  const body = insertTokenSrc();
  assert.ok(body.includes('requestAnimationFrame'));
  assert.ok(body.includes('applyTokenCaretRestore'));

  const node = fakeNode({ selectionStart: 1, selectionEnd: 1 });
  applyTokenCaretRestore(node, node, 1 + '{{char}}'.length);
  assert.equal(node.focused, true);
  assert.deepEqual(node.range, [1 + '{{char}}'.length, 1 + '{{char}}'.length]);

  const id = 'e18e18e1-8e18-4e18-8e18-e18e18e18e18';
  const kv = memKv();
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: kv });
  let rafCb: FrameRequestCallback | null = null;
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafCb = cb;
    return 1;
  }) as typeof requestAnimationFrame;
  try {
    const dirtyRef = { current: false };
    const suppressRef = { current: false };
    const dRef = { current: { ...SAMPLE } };
    const timerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
    function clearTimer() {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
    const live = fakeNode({ selectionStart: 0, selectionEnd: 0 });
    const ctx = {
      dirtyRef,
      suppressRef,
      dRef,
      timerRef,
      character: { id },
      setD: (fn: (p: CharacterDraft) => CharacterDraft) => { dRef.current = fn(dRef.current); },
      clearTimer,
      pendingDraft: null as CharacterDraft | null,
      fieldRefs: { current: { first_message: live } },
    };
    const { insertToken } = bindEditorTokenInsert(editor, ctx);
    insertToken('first_message', '{{char}}');
    assert.equal(typeof rafCb, 'function');
    rafCb!(0);
    assert.equal(live.focused, true);
    assert.deepEqual(live.range, ['{{char}}'.length, '{{char}}'.length]);
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    globalThis.requestAnimationFrame = prevRaf;
  }
});

t('19 stale or unmounted textarea does not receive caret restore', () => {
  const unmounted = fakeNode({ isConnected: false });
  applyTokenCaretRestore(unmounted, unmounted, 8);
  assert.equal(unmounted.focused, false);
  assert.equal(unmounted.range, null);

  const stale = fakeNode();
  const live = fakeNode();
  applyTokenCaretRestore(live, stale, 8);
  assert.equal(live.focused, false);
  assert.equal(stale.focused, false);

  applyTokenCaretRestore(null, stale, 8);
  assert.equal(stale.focused, false);

  const throwing = fakeNode();
  throwing.setSelectionRange = () => { throw new Error('caret-fail'); };
  applyTokenCaretRestore(throwing, throwing, 3);
  assert.equal(throwing.focused, true);

  const id = 'f19f19f1-9f19-4f19-8f19-f19f19f19f19';
  const kv = memKv();
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: kv });
  let rafCb: FrameRequestCallback | null = null;
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafCb = cb;
    return 1;
  }) as typeof requestAnimationFrame;
  try {
    const dirtyRef = { current: false };
    const suppressRef = { current: false };
    const dRef = { current: { ...SAMPLE } };
    const timerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
    function clearTimer() {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
    const oldNode = fakeNode({ selectionStart: 0, selectionEnd: 0 });
    const fieldRefs = { current: { scenario: oldNode as FakeNode | null } };
    const ctx = {
      dirtyRef,
      suppressRef,
      dRef,
      timerRef,
      character: { id },
      setD: (fn: (p: CharacterDraft) => CharacterDraft) => { dRef.current = fn(dRef.current); },
      clearTimer,
      pendingDraft: null as CharacterDraft | null,
      fieldRefs,
    };
    const { insertToken } = bindEditorTokenInsert(editor, ctx);
    insertToken('scenario', '{{user}}');
    const remount = fakeNode();
    fieldRefs.current.scenario = remount;
    oldNode.isConnected = false;
    rafCb!(0);
    assert.equal(oldNode.focused, false);
    assert.equal(oldNode.range, null);
    assert.equal(remount.focused, false);
    assert.equal(remount.range, null);
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    globalThis.requestAnimationFrame = prevRaf;
  }
});

t('20 CharacterEditor.tsx has no as unknown', () => {
  assert.equal(editor.includes('as unknown'), false);
});

t('21 save() request body is still d', () => {
  assert.ok(editor.includes("await put<Character>(`/api/characters/${character.id}`, d)"));
  assert.ok(editor.includes("await post<Character>('/api/characters', d)"));
  const saveFn = editor.slice(editor.indexOf('async function save()'), editor.indexOf('function restoreDraft()'));
  assert.ok(saveFn.includes(', d)'));
  assert.equal(saveFn.includes('insertCharacterToken'), false);
});

t('22 existing field maxLength values are unchanged', () => {
  assert.match(limitsSrc, /name:\s*80/);
  assert.match(limitsSrc, /tagline:\s*200/);
  assert.match(limitsSrc, /avatar:\s*300/);
  assert.match(limitsSrc, /description:\s*20000/);
  assert.match(limitsSrc, /personality:\s*10000/);
  assert.match(limitsSrc, /speech_style:\s*10000/);
  assert.match(limitsSrc, /scenario:\s*20000|scenario:\s*10000/);
  assert.equal(FIELD_LIMITS.scenario, 10000);
  assert.equal(FIELD_LIMITS.first_message, 10000);
  assert.equal(FIELD_LIMITS.example_dialogue, 20000);
  assert.equal(FIELD_LIMITS.taboos, 5000);
  for (const field of [
    'name',
    'tagline',
    'avatar',
    'description',
    'personality',
    'speech_style',
    'scenario',
    'first_message',
    'example_dialogue',
    'taboos',
  ] as const) {
    assert.ok(editor.includes(`maxLength={FIELD_LIMITS.${field}}`), `maxLength missing for ${field}`);
  }
});

console.log(`passed ${passed}`);
