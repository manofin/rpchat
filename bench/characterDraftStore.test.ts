/**
 * npx tsx bench/characterDraftStore.test.ts
 * C6 character-authoring draft autosave — helper + source inventory.
 * Isolated: no systemd, no live DB, no model, no migration, no generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require2 = createRequire(import.meta.url);
let mod: typeof import('../apps/web/src/lib/characterDraftStore.ts');
try {
  mod = require2('../apps/web/src/lib/characterDraftStore.ts');
} catch (e) {
  console.error('RED: characterDraftStore missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const {
  CHARACTER_DRAFT_DEBOUNCE_MS,
  CHARACTER_DRAFT_NEW_KEY,
  characterDraftStorageKey,
  flushCharacterDraft,
  parseCharacterDraft,
  readCharacterDraft,
  removeCharacterDraft,
  writeCharacterDraft,
} = mod;

import type { CharacterDraft, Kv } from '../apps/web/src/lib/characterDraftStore.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function memKv(init: Record<string, string> = {}): Kv & { map: Map<string, string> } {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

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

const dir = path.dirname(fileURLToPath(import.meta.url));
const editor = fs.readFileSync(
  path.join(dir, '..', 'apps/web/src/components/CharacterEditor.tsx'),
  'utf8',
);
const storeSrc = fs.readFileSync(
  path.join(dir, '..', 'apps/web/src/lib/characterDraftStore.ts'),
  'utf8',
);

t('1 new key is rpchat.characterDraft.new', () => {
  const kv = memKv();
  writeCharacterDraft(null, SAMPLE, kv);
  assert.equal(characterDraftStorageKey(null), 'rpchat.characterDraft.new');
  assert.equal(characterDraftStorageKey(undefined), 'rpchat.characterDraft.new');
  assert.equal(characterDraftStorageKey(''), 'rpchat.characterDraft.new');
  assert.equal(CHARACTER_DRAFT_NEW_KEY, 'rpchat.characterDraft.new');
  assert.equal(kv.map.has('rpchat.characterDraft.new'), true);
  assert.deepEqual(readCharacterDraft(null, kv), SAMPLE);
});

t('2 existing character keys are isolated per characterId', () => {
  const a = '11111111-1111-1111-1111-111111111111';
  const b = '22222222-2222-2222-2222-222222222222';
  assert.equal(characterDraftStorageKey(a), `rpchat.characterDraft.${a}`);
  assert.equal(characterDraftStorageKey(b), `rpchat.characterDraft.${b}`);
  assert.notEqual(characterDraftStorageKey(a), characterDraftStorageKey(b));
  assert.notEqual(characterDraftStorageKey(a), CHARACTER_DRAFT_NEW_KEY);
  const weird = 'id/with spaces';
  assert.equal(characterDraftStorageKey(weird), 'rpchat.characterDraft.' + encodeURIComponent(weird));
  assert.notEqual(characterDraftStorageKey(weird), `rpchat.characterDraft.${weird}`);
});

t('3 draft for another characterId is not returned', () => {
  const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const kv = memKv();
  writeCharacterDraft(a, SAMPLE, kv);
  writeCharacterDraft(null, OTHER, kv);
  assert.deepEqual(readCharacterDraft(b, kv), null);
  assert.deepEqual(readCharacterDraft(a, kv), SAMPLE);
  assert.deepEqual(readCharacterDraft(null, kv), OTHER);
  assert.equal(kv.map.has(characterDraftStorageKey(b)), false);
});

t('4 valid draft round-trips write then read', () => {
  const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const kv = memKv();
  writeCharacterDraft(id, SAMPLE, kv);
  assert.deepEqual(readCharacterDraft(id, kv), SAMPLE);
  assert.equal(parseCharacterDraft(JSON.stringify(SAMPLE))?.name, '테스트');
});

t('5 removeItem discards only that draft', () => {
  const a = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const b = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const kv = memKv();
  writeCharacterDraft(a, SAMPLE, kv);
  writeCharacterDraft(b, OTHER, kv);
  writeCharacterDraft(null, SAMPLE, kv);
  removeCharacterDraft(a, kv);
  assert.equal(readCharacterDraft(a, kv), null);
  assert.deepEqual(readCharacterDraft(b, kv), OTHER);
  assert.deepEqual(readCharacterDraft(null, kv), SAMPLE);
  assert.equal(kv.map.has(characterDraftStorageKey(a)), false);
  assert.equal(kv.map.has(characterDraftStorageKey(b)), true);
});

t('6 save-success cleanup removes that draft', () => {
  const id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const kv = memKv();
  writeCharacterDraft(id, SAMPLE, kv);
  assert.ok(readCharacterDraft(id, kv));
  removeCharacterDraft(id, kv);
  assert.equal(readCharacterDraft(id, kv), null);
  assert.match(editor, /suppressRef\.current = true/);
  assert.match(editor, /removeCharacterDraft\(character\?\.id \?\? null\)/);
  assert.ok(editor.includes("await put<Character>(`/api/characters/${character.id}`, d)"));
  const saveFn = editor.slice(editor.indexOf('async function save()'), editor.indexOf('function restoreDraft()'));
  const suppressAt = saveFn.indexOf('suppressRef.current = true');
  const removeAt = saveFn.indexOf('removeCharacterDraft');
  const onSavedAt = saveFn.indexOf('onSaved(saved)');
  assert.ok(suppressAt >= 0 && removeAt > suppressAt && onSavedAt > removeAt);
  assert.equal(saveFn.includes('catch'), true);
  const tryBlock = saveFn.slice(saveFn.indexOf('try {'), saveFn.indexOf('} catch'));
  assert.ok(tryBlock.includes('removeCharacterDraft'));
});

t('7 corrupt JSON does not throw and is not restorable', () => {
  const kv = memKv({ [CHARACTER_DRAFT_NEW_KEY]: '{not-json' });
  assert.equal(parseCharacterDraft('{not-json'), null);
  assert.equal(parseCharacterDraft('null'), null);
  assert.equal(parseCharacterDraft('[]'), null);
  assert.equal(parseCharacterDraft('5'), null);
  assert.equal(parseCharacterDraft('"hi"'), null);
  assert.equal(readCharacterDraft(null, kv), null);
  kv.setItem(CHARACTER_DRAFT_NEW_KEY, 'null');
  assert.equal(readCharacterDraft(null, kv), null);
});

t('8 partial object or wrong schema is not a restorable draft', () => {
  assert.equal(parseCharacterDraft(JSON.stringify({ name: 'x' })), null);
  assert.equal(parseCharacterDraft(JSON.stringify({ ...SAMPLE, tags: 'nope' })), null);
  assert.equal(parseCharacterDraft(JSON.stringify({ ...SAMPLE, avatar: 1 })), null);
  assert.equal(parseCharacterDraft(JSON.stringify({ ...SAMPLE, name: 1 })), null);
  assert.equal(parseCharacterDraft(JSON.stringify({ ...SAMPLE, tags: [1] })), null);
  const kv = memKv({ [CHARACTER_DRAFT_NEW_KEY]: JSON.stringify({ name: 'x' }) });
  assert.equal(readCharacterDraft(null, kv), null);
});

t('9 getItem throw does not propagate', () => {
  const boom: Kv = {
    getItem() { throw new Error('blocked-get'); },
    setItem() {},
    removeItem() {},
  };
  assert.equal(readCharacterDraft(null, boom), null);
  assert.equal(readCharacterDraft('id-1', boom), null);
});

t('10 setItem throw does not propagate', () => {
  const boom: Kv = {
    getItem() { return null; },
    setItem() { throw new Error('blocked-set'); },
    removeItem() {},
  };
  writeCharacterDraft(null, SAMPLE, boom);
  writeCharacterDraft('id-1', SAMPLE, boom);
});

t('11 removeItem throw does not propagate', () => {
  const boom: Kv = {
    getItem() { return JSON.stringify(SAMPLE); },
    setItem() {},
    removeItem() { throw new Error('blocked-remove'); },
  };
  removeCharacterDraft(null, boom);
  removeCharacterDraft('id-1', boom);
});

t('12 no storage argument and no localStorage does not throw', () => {
  const g = globalThis as { localStorage?: unknown };
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    if (desc) delete g.localStorage;
    assert.equal(typeof localStorage, 'undefined');
    assert.equal(readCharacterDraft(null), null);
    writeCharacterDraft(null, SAMPLE);
    removeCharacterDraft(null);
    flushCharacterDraft(null, SAMPLE, { dirty: true, suppress: false });
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
  }
});

t('13 CharacterEditor has no as unknown', () => {
  assert.equal(editor.includes('as unknown'), false);
  assert.equal(CHARACTER_DRAFT_DEBOUNCE_MS, 300);
  assert.ok(editor.includes('CHARACTER_DRAFT_DEBOUNCE_MS'));
});

t('14 save request body is still d', () => {
  assert.ok(editor.includes("await put<Character>(`/api/characters/${character.id}`, d)"));
  assert.ok(editor.includes("await post<Character>('/api/characters', d)"));
});

t('15 initial render does not overwrite an existing draft', () => {
  const kv = memKv();
  writeCharacterDraft(null, SAMPLE, kv);
  const before = kv.getItem(CHARACTER_DRAFT_NEW_KEY);
  assert.ok(before);
  assert.deepEqual(readCharacterDraft(null, kv), SAMPLE);
  assert.equal(kv.getItem(CHARACTER_DRAFT_NEW_KEY), before);
  flushCharacterDraft(null, OTHER, { dirty: false, suppress: false }, kv);
  assert.equal(kv.getItem(CHARACTER_DRAFT_NEW_KEY), before);
  assert.deepEqual(readCharacterDraft(null, kv), SAMPLE);
  const openEffect = editor.slice(editor.indexOf('if (!open) return;'), editor.indexOf('const set ='));
  assert.ok(openEffect.includes('dirtyRef.current = false'));
  assert.ok(openEffect.includes('readCharacterDraft(id)'));
  assert.equal(openEffect.includes('writeCharacterDraft'), false);
  assert.ok(editor.includes('dirtyRef.current = true'));
  const setFn = editor.slice(editor.indexOf('const set ='), editor.indexOf('async function save()'));
  assert.ok(setFn.includes('dirtyRef.current = true'));
});

t('16 cleanup after successful save or discard does not resurrect the draft', () => {
  const id = '99999999-9999-9999-9999-999999999999';
  const kv = memKv();
  writeCharacterDraft(id, SAMPLE, kv);
  removeCharacterDraft(id, kv);
  flushCharacterDraft(id, SAMPLE, { dirty: true, suppress: true }, kv);
  assert.equal(readCharacterDraft(id, kv), null);
  writeCharacterDraft(null, SAMPLE, kv);
  removeCharacterDraft(null, kv);
  flushCharacterDraft(null, SAMPLE, { dirty: true, suppress: true }, kv);
  assert.equal(readCharacterDraft(null, kv), null);
  assert.ok(storeSrc.includes('if (!flags.dirty || flags.suppress) return'));
  const discardFn = editor.slice(editor.indexOf('function discardDraft()'), editor.indexOf('function addTag()'));
  assert.ok(discardFn.includes('suppressRef.current = true'));
  assert.ok(discardFn.includes('dirtyRef.current = false'));
  assert.ok(discardFn.includes('removeCharacterDraft'));
  const saveFn = editor.slice(editor.indexOf('async function save()'), editor.indexOf('function restoreDraft()'));
  const suppressAt = saveFn.indexOf('suppressRef.current = true');
  const onSavedAt = saveFn.indexOf('onSaved(saved)');
  assert.ok(suppressAt >= 0 && suppressAt < onSavedAt);
});

function bindEditorAutosave(editorSrc: string, ctx: {
  dirtyRef: { current: boolean };
  suppressRef: { current: boolean };
  dRef: { current: CharacterDraft };
  timerRef: { current: ReturnType<typeof setTimeout> | null };
  character: { id: string } | null;
  setD: (fn: (p: CharacterDraft) => CharacterDraft) => void;
  clearTimer: () => void;
  pendingDraft: CharacterDraft | null;
}) {
  const setSrc = editorSrc.slice(editorSrc.indexOf('const set ='), editorSrc.indexOf('async function save()'));
  const discardSrc = editorSrc.slice(
    editorSrc.indexOf('function discardDraft()'),
    editorSrc.indexOf('function addTag()'),
  );
  assert.ok(setSrc.includes('const set ='), 'set() missing');
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
      function setPendingDraft(v: any) { ctx.pendingDraft = v; }
      ${setSrc}
      ${discardSrc}
      return { set, discardDraft };
    }
  `;
  const { transformSync } = require2('esbuild');
  const js = transformSync(wrapped, { loader: 'ts', format: 'cjs' }).code;
  const exported: { bind?: (ctx: unknown) => { set: (k: string, v: unknown) => void; discardDraft: () => void } } = {};
  const moduleObj = { exports: exported };
  new Function('exports', 'module', 'require', js)(exported, moduleObj, require2);
  const bind = exported.bind ?? (moduleObj.exports as { bind: typeof exported.bind }).bind;
  assert.equal(typeof bind, 'function');
  const bindCtx = ctx as typeof ctx & {
    flushCharacterDraft: typeof flushCharacterDraft;
    removeCharacterDraft: typeof removeCharacterDraft;
    CHARACTER_DRAFT_DEBOUNCE_MS: number;
  };
  bindCtx.flushCharacterDraft = flushCharacterDraft;
  bindCtx.removeCharacterDraft = removeCharacterDraft;
  bindCtx.CHARACTER_DRAFT_DEBOUNCE_MS = CHARACTER_DRAFT_DEBOUNCE_MS;
  return bind!(bindCtx);
}

t('17 discard then later user edit writes a new draft', () => {
  const id = '17171717-1717-1717-1717-171717171717';
  const kv = memKv();
  const g = globalThis as { localStorage?: unknown };
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: kv });
  try {
    writeCharacterDraft(id, OTHER);
    assert.deepEqual(readCharacterDraft(id), OTHER);

    const dirtyRef = { current: false };
    const suppressRef = { current: false };
    const dRef = { current: SAMPLE };
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
    };
    const { set, discardDraft } = bindEditorAutosave(editor, ctx);

    discardDraft();
    assert.equal(ctx.pendingDraft, null);
    assert.equal(readCharacterDraft(id), null);
    flushCharacterDraft(id, dRef.current, { dirty: dirtyRef.current, suppress: suppressRef.current });
    assert.equal(readCharacterDraft(id), null, 'discard without new edits must not resurrect');

    set('name', '편집후');
    clearTimer();
    const edited: CharacterDraft = { ...SAMPLE, name: '편집후' };
    assert.deepEqual(dRef.current, edited);
    flushCharacterDraft(id, dRef.current, { dirty: dirtyRef.current, suppress: suppressRef.current });
    assert.deepEqual(readCharacterDraft(id), edited);
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    else delete g.localStorage;
  }
});

console.log(`passed ${passed}`);

