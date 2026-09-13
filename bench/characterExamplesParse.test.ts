/**
 * npx tsx bench/characterExamplesParse.test.ts
 * C5 example_dialogue pair editor: strict parse/serialize, raw fallback,
 * row-state save gate, C6 set() autosave, C12 pair-chip refs.
 * Isolated: no systemd, no live DB write, no model, no migration, no generate.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require2 = createRequire(import.meta.url);

let pairsMod: typeof import('../apps/web/src/lib/characterExamplePairs.ts');
try {
  pairsMod = require2('../apps/web/src/lib/characterExamplePairs.ts');
} catch (e) {
  console.error('RED: characterExamplePairs missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const {
  parseExampleDialogue,
  serializeExamplePairs,
  initialExampleEditorState,
  isUtteranceEmpty,
  isExamplePairIncomplete,
  hasIncompleteExamplePairs,
} = pairsMod;

let insertMod: typeof import('../apps/web/src/lib/characterTokenInsert.ts');
try {
  insertMod = require2('../apps/web/src/lib/characterTokenInsert.ts');
} catch (e) {
  console.error('RED: characterTokenInsert missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}
const { insertCharacterToken, applyTokenCaretRestore } = insertMod;

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
import { FIELD_LIMITS, overLimitFields } from '../apps/web/src/lib/characterFieldLimits.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const editorPath = path.join(root, 'apps/web/src/components/CharacterEditor.tsx');
const editor = fs.readFileSync(editorPath, 'utf8');
const pairsSrc = fs.readFileSync(path.join(root, 'apps/web/src/lib/characterExamplePairs.ts'), 'utf8');
const storeSrc = fs.readFileSync(path.join(root, 'apps/web/src/lib/characterDraftStore.ts'), 'utf8');
const limitsSrc = fs.readFileSync(path.join(root, 'apps/web/src/lib/characterFieldLimits.ts'), 'utf8');

const SEORI = '{{user}}: 여기서 일한 지 오래됐어요?\n{{char}}: *페이지를 넘기던 손이 잠시 멈췄다.* 햇수로 세는 건 그만뒀습니다. …기억해야 할 게 너무 많아서요. 그보다, 손이 차 보입니다. 차라도 한 잔.\n{{user}}: 무서운 이야기 같은 것도 알아요?\n{{char}}: 이 건물이 곧 무서운 이야기입니다. *희미하게 웃었다.* 하지만 대개는 무서운 게 아니라 슬픈 겁니다. 사람들은 그 둘을 자주 헷갈리죠.';
const KAI = '{{user}}: 네 계획은 뭔데?\n{{char}}: 계획? *코웃음.* 살아서 아침을 보는 거. 그 이상은 상황 봐가면서. 겁먹었냐?\n{{user}}: 무섭지 않아?\n{{char}}: 안 무서우면 바보지. *밧줄을 고쳐 쥐며.* 근데 무서운 거랑 멈추는 건 달라. 가자.';
const SEORI_SHA = '37a487d8f2dd16cec7b72a942b1135e5d03de055a4ccd3399999a9d51d02100d';
const KAI_SHA = '9cd8043d80e4a151f5856c0e823dee9c1298f428c7ff9615d7ced2f5eccf704d';

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
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
  example_dialogue: '',
  taboos: '금기',
  tags: ['party:role=secondary'],
};

function memKv(): Kv {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
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

function sliceFn(src: string, startTok: string, endTok: string): string {
  const start = src.indexOf(startTok);
  assert.ok(start >= 0, `missing ${startTok}`);
  const end = src.indexOf(endTok, start + startTok.length);
  assert.ok(end > start, `missing ${endTok} after ${startTok}`);
  return src.slice(start, end);
}

type BindCtx = {
  d: CharacterDraft;
  exampleMode: 'structured' | 'raw';
  exampleRows: Array<{ id: string; user: string; char: string }>;
  character: { id: string } | null;
  dirtyRef: { current: boolean };
  suppressRef: { current: boolean };
  dRef: { current: CharacterDraft };
  timerRef: { current: ReturnType<typeof setTimeout> | null };
  pendingDraft: CharacterDraft | null;
  savingLog: boolean[];
  requests: Array<{ method: string; url: string; body: unknown }>;
  onSavedCalls: unknown[];
  removeDraftCalls: number;
  insertCalls: number;
  pairFieldRefs: { current: Map<string, FakeNode | null> };
  fieldRefs: { current: Record<string, FakeNode | null> };
  kv: Kv;
};

function emptyBindCtx(partial: Partial<BindCtx> = {}): BindCtx {
  const d = { ...SAMPLE, ...(partial.d ?? {}) };
  const base: BindCtx = {
    d,
    exampleMode: 'structured',
    exampleRows: [{ id: 'r1', user: '', char: '' }],
    character: { id: 'c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5' },
    dirtyRef: { current: false },
    suppressRef: { current: false },
    dRef: { current: d },
    timerRef: { current: null },
    pendingDraft: null,
    savingLog: [],
    requests: [],
    onSavedCalls: [],
    removeDraftCalls: 0,
    insertCalls: 0,
    pairFieldRefs: { current: new Map() },
    fieldRefs: { current: {} },
    kv: memKv(),
  };
  const merged: BindCtx = { ...base, ...partial, d };
  merged.dRef = partial.dRef ?? { current: merged.d };
  return merged;
}

function bindEditor(editorSrc: string, ctx: BindCtx) {
  const setSrc = sliceFn(editorSrc, 'const set =', 'async function save()');
  const saveSrc = sliceFn(editorSrc, 'async function save()', 'function restoreDraft()');
  const discardSrc = sliceFn(editorSrc, 'function discardDraft()', 'function addTag()');
  const helpersSrc = sliceFn(editorSrc, 'function commitExampleRows', 'const setupIncomplete');
  assert.ok(setSrc.includes('const set ='));
  assert.ok(saveSrc.includes('async function save()'));
  const wrapped = `
    export function bind(ctx: any) {
      const dirtyRef = ctx.dirtyRef;
      const suppressRef = ctx.suppressRef;
      const dRef = ctx.dRef;
      const timerRef = ctx.timerRef;
      const character = ctx.character;
      const d = ctx.d;
      const exampleMode = ctx.exampleMode;
      const exampleRows = ctx.exampleRows;
      const exampleRowsRef = { current: exampleRows };
      const pairFieldRefs = ctx.pairFieldRefs;
      const fieldRefs = ctx.fieldRefs;
      const FIELD_LIMITS = ctx.FIELD_LIMITS;
      const insertCharacterToken = function() {
        ctx.insertCalls++;
        return ctx.insertCharacterToken.apply(null, arguments);
      };
      const applyTokenCaretRestore = ctx.applyTokenCaretRestore;
      const serializeExamplePairs = ctx.serializeExamplePairs;
      const hasIncompleteExamplePairs = ctx.hasIncompleteExamplePairs;
      const overLimitFields = ctx.overLimitFields;
      const pairRefKey = ctx.pairRefKey;
      const createExampleRow = ctx.createExampleRow;
      const flushCharacterDraft = ctx.flushCharacterDraft;
      const CHARACTER_DRAFT_DEBOUNCE_MS = ctx.CHARACTER_DRAFT_DEBOUNCE_MS;
      function removeCharacterDraft() { ctx.removeDraftCalls++; ctx.removeCharacterDraft.apply(null, arguments); }
      function setPendingDraft(v: any) { ctx.pendingDraft = v; }
      function setSaving(v: boolean) { ctx.savingLog.push(v); }
      function setExampleRows(next: any[]) {
        exampleRows.splice(0, exampleRows.length, ...next);
        exampleRowsRef.current = exampleRows;
      }
      function setD(fn: any) {
        const next = fn(d);
        for (const k of Object.keys(next)) (d as any)[k] = next[k];
        dRef.current = d;
      }
      function clearTimer() {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      }
      const ui = {
        toast() { ctx.lastToast = arguments; },
      };
      async function put(url: string, body: unknown) {
        ctx.requests.push({ method: 'PUT', url, body });
        return { id: 'saved-put', ...((body && typeof body === 'object') ? body : {}) };
      }
      async function post(url: string, body: unknown) {
        ctx.requests.push({ method: 'POST', url, body });
        return { id: 'saved-post', ...((body && typeof body === 'object') ? body : {}) };
      }
      function onSaved(saved: unknown) { ctx.onSavedCalls.push(saved); }
      ${setSrc}
      ${saveSrc}
      ${discardSrc}
      ${helpersSrc}
      return { set, save, discardDraft, commitExampleRows, insertPairToken, addExamplePair, removeExamplePair };
    }
  `;
  const { transformSync } = require2('esbuild');
  const js = transformSync(wrapped, { loader: 'ts', format: 'cjs' }).code;
  const exported: { bind?: (ctx: unknown) => Record<string, unknown> } = {};
  const moduleObj = { exports: exported };
  new Function('exports', 'module', 'require', js)(exported, moduleObj, require2);
  const bind = exported.bind ?? (moduleObj.exports as { bind: typeof exported.bind }).bind;
  assert.equal(typeof bind, 'function');
  const bindCtx = ctx as BindCtx & Record<string, unknown>;
  bindCtx.flushCharacterDraft = flushCharacterDraft;
  bindCtx.removeCharacterDraft = removeCharacterDraft;
  bindCtx.CHARACTER_DRAFT_DEBOUNCE_MS = CHARACTER_DRAFT_DEBOUNCE_MS;
  bindCtx.FIELD_LIMITS = FIELD_LIMITS;
  bindCtx.insertCharacterToken = insertCharacterToken;
  bindCtx.applyTokenCaretRestore = applyTokenCaretRestore;
  bindCtx.serializeExamplePairs = serializeExamplePairs;
  bindCtx.hasIncompleteExamplePairs = hasIncompleteExamplePairs;
  bindCtx.overLimitFields = overLimitFields;
  bindCtx.pairRefKey = (rowId: string, side: string) => `${rowId}:${side}`;
  let seq = 1000;
  bindCtx.createExampleRow = (user = '', char = '') => ({ id: `new-${++seq}`, user, char });
  return bind!(bindCtx) as {
    set: (k: string, v: unknown) => void;
    save: () => Promise<void>;
    discardDraft: () => void;
    commitExampleRows: (next: Array<{ id: string; user: string; char: string }>) => void;
    insertPairToken: (rowId: string, side: 'user' | 'char', token: string) => void;
    addExamplePair: () => void;
    removeExamplePair: (rowId: string) => void;
  };
}

function withLocalStorage<T>(kv: Kv, fn: () => T): T {
  const g = globalThis as { localStorage?: unknown };
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: kv });
  try {
    return fn();
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    else delete g.localStorage;
  }
}

async function main() {
  t('C5-1 standard single pair parse-serialize is byte-identical', () => {
    const raw = '{{user}}: hi\n{{char}}: hello';
    const parsed = parseExampleDialogue(raw);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(serializeExamplePairs(parsed.pairs), raw);
    assert.deepEqual(parsed.pairs, [{ user: 'hi', char: 'hello' }]);
  });

  t('C5-2 multiple standard pairs round-trip on single newlines', () => {
    const raw = '{{user}}: a\n{{char}}: b\n{{user}}: c\n{{char}}: d';
    const parsed = parseExampleDialogue(raw);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const out = serializeExamplePairs(parsed.pairs);
    assert.equal(out, raw);
    assert.equal(out.includes('\n\n'), false);
    assert.equal(out.endsWith('\n'), false);
  });

  t('C5-3 seori and kai confirmed originals round-trip byte-identical', () => {
    assert.equal(sha256(SEORI), SEORI_SHA);
    assert.equal(sha256(KAI), KAI_SHA);
    for (const raw of [SEORI, KAI]) {
      const parsed = parseExampleDialogue(raw);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      assert.equal(serializeExamplePairs(parsed.pairs), raw);
    }
  });

  t('C5-4 untagged prose is parse failure', () => {
    const raw = '가젯은 태그가 없다';
    assert.equal(parseExampleDialogue(raw).ok, false);
  });

  t('C5-5 leading space / space-before-colon tag variants fail parse', () => {
    assert.equal(parseExampleDialogue(' {{user}}: hi\n{{char}}: lo').ok, false);
    assert.equal(parseExampleDialogue('{{user}} : hi\n{{char}}: lo').ok, false);
    assert.equal(parseExampleDialogue('{{USER}}: hi\n{{char}}: lo').ok, false);
    assert.equal(parseExampleDialogue('{{user}}:hi\n{{char}}: lo').ok, false);
  });

  t('C5-6 odd utterance count is parse failure', () => {
    assert.equal(parseExampleDialogue('{{user}}: hi').ok, false);
    assert.equal(parseExampleDialogue('{{user}}: a\n{{char}}: b\n{{user}}: c').ok, false);
  });

  t('C5-7 input starting with {{char}} is parse failure', () => {
    assert.equal(parseExampleDialogue('{{char}}: hi\n{{user}}: lo').ok, false);
    assert.equal(parseExampleDialogue('{{char}}: only').ok, false);
  });

  t('C5-8 single-word input is parse failure', () => {
    assert.equal(parseExampleDialogue('hello').ok, false);
  });

  t('C5-9 parse-failure source string is not mutated even one byte', () => {
    const raw = '  not a pair\nwith\\quotes\\and trailing\n';
    const copy = raw;
    const before = Buffer.from(raw, 'utf8');
    const parsed = parseExampleDialogue(raw);
    assert.equal(parsed.ok, false);
    assert.equal(raw, copy);
    assert.equal(Buffer.from(raw, 'utf8').equals(before), true);
  });

  t('C5-10 empty string opens structured empty init', () => {
    const init = initialExampleEditorState('');
    assert.equal(init.mode, 'structured');
    if (init.mode !== 'structured') return;
    assert.deepEqual(init.pairs, [{ user: '', char: '' }]);
    assert.equal(serializeExamplePairs(init.pairs), '');
    assert.ok(editor.includes("initialExampleEditorState(raw)"));
    assert.ok(editor.includes("applyExampleSource(EMPTY.example_dialogue)"));
  });

  t('C5-11 empty init alone does not call set() or autosave', () => {
    const applySrc = sliceFn(editor, 'function applyExampleSource', 'function clearTimer');
    assert.equal(applySrc.includes("set('"), false);
    assert.equal(applySrc.includes('setD('), false);
    assert.equal(applySrc.includes('flushCharacterDraft'), false);
    const effectSrc = sliceFn(editor, 'useEffect(() => {', 'const set =');
    assert.equal(effectSrc.includes("set('example_dialogue'"), false);
    assert.equal(effectSrc.includes('flushCharacterDraft(id'), true);
    assert.ok(effectSrc.includes('applyExampleSource'));
  });

  t('C5-12 nonempty parse failure displays as raw fallback', () => {
    const raw = '첸 리안 로제타 원문';
    const init = initialExampleEditorState(raw);
    assert.equal(init.mode, 'raw');
    if (init.mode !== 'raw') return;
    assert.equal(init.raw, raw);
  });

  t('C5-13 initial mode judgment does not call set()', () => {
    const applySrc = sliceFn(editor, 'function applyExampleSource', 'function clearTimer');
    assert.equal(/set\('example_dialogue'/.test(applySrc), false);
    assert.ok(editor.includes('exampleMode === \'raw\''));
  });

  await (async () => {
    const ctx = emptyBindCtx({
      exampleMode: 'raw',
      exampleRows: [{ id: 'r1', user: 'only-user', char: '' }],
      d: { ...SAMPLE, example_dialogue: '가젯 평문 원문' },
    });
    ctx.dRef.current = ctx.d;
    const { save } = bindEditor(editor, ctx);
    await save();
    assert.equal(ctx.requests.length, 1, 'C5-14 raw fallback save must not be blocked');
    assert.equal(ctx.onSavedCalls.length, 1);
  })();
  passed++;
  console.log(`ok ${passed} C5-14 raw fallback save is not blocked by pair completeness`);

  t('C5-15 user-only row is incomplete', () => {
    assert.equal(isExamplePairIncomplete({ user: 'hi', char: '' }), true);
    assert.equal(hasIncompleteExamplePairs([{ user: 'hi', char: '' }]), true);
  });

  t('C5-16 char-only row is incomplete', () => {
    assert.equal(isExamplePairIncomplete({ user: '', char: 'lo' }), true);
    assert.equal(hasIncompleteExamplePairs([{ user: '', char: 'lo' }]), true);
  });

  t('C5-17 whitespace-only side counts as empty utterance', () => {
    assert.equal(isUtteranceEmpty('   '), true);
    assert.equal(isExamplePairIncomplete({ user: 'hi', char: ' \n\t ' }), true);
    assert.equal(isExamplePairIncomplete({ user: '  ', char: '  ' }), false);
  });

  await (async () => {
    const ctx = emptyBindCtx({
      exampleMode: 'structured',
      exampleRows: [{ id: 'r1', user: 'only', char: '' }],
      d: { ...SAMPLE, example_dialogue: '{{user}}: only\n{{char}}: ' },
    });
    ctx.dRef.current = ctx.d;
    writeCharacterDraft(ctx.character!.id, ctx.d, ctx.kv);
    await withLocalStorage(ctx.kv, async () => {
      const { save } = bindEditor(editor, ctx);
      await save();
    });
    assert.equal(ctx.requests.length, 0, 'C5-18 no server request');
    assert.equal(ctx.onSavedCalls.length, 0, 'C5-19 onSaved not called');
    assert.equal(ctx.removeDraftCalls, 0, 'C5-20 draft not removed');
    assert.deepEqual(ctx.savingLog, [], 'C5-21 saving never set true');
    assert.equal(ctx.d.example_dialogue, '{{user}}: only\n{{char}}: ');
    assert.equal(ctx.exampleRows[0].user, 'only');
  })();
  passed++;
  console.log(`ok ${passed} C5-18..21 incomplete row blocks request/onSaved/draft-delete and preserves saving+input`);

  t('C5-22 both-empty rows are omitted from serialize', () => {
    assert.equal(serializeExamplePairs([{ user: '', char: '' }]), '');
    assert.equal(serializeExamplePairs([{ user: '  ', char: '\n' }, { user: 'a', char: 'b' }]), '{{user}}: a\n{{char}}: b');
  });

  await (async () => {
    const ctx = emptyBindCtx({
      exampleMode: 'structured',
      exampleRows: [{ id: 'r1', user: '', char: '' }],
      d: { ...SAMPLE, example_dialogue: '' },
    });
    ctx.dRef.current = ctx.d;
    const { save } = bindEditor(editor, ctx);
    await save();
    assert.equal(ctx.requests.length, 1, 'C5-23 empty-only rows must not block save');
    assert.equal((ctx.requests[0].body as CharacterDraft).example_dialogue, '');
  })();
  passed++;
  console.log(`ok ${passed} C5-23 both-empty rows do not block save`);

  await (async () => {
    const rows = [{ id: 'r1', user: 'only', char: '' }];
    const ctx = emptyBindCtx({ exampleMode: 'structured', exampleRows: rows, d: { ...SAMPLE, name: '테스트' } });
    ctx.dRef.current = ctx.d;
    const bound = bindEditor(editor, ctx);
    await bound.save();
    assert.equal(ctx.requests.length, 0);
    rows[0].char = 'reply';
    await bound.save();
    assert.equal(ctx.requests.length, 1, 'C5-24 completing empty side uses existing save path');
  })();
  passed++;
  console.log(`ok ${passed} C5-24 completing the empty side runs existing save path`);

  await (async () => {
    const rows = [
      { id: 'keep', user: 'a', char: 'b' },
      { id: 'drop', user: 'only', char: '' },
    ];
    const ctx = emptyBindCtx({ exampleMode: 'structured', exampleRows: rows, d: { ...SAMPLE } });
    ctx.dRef.current = ctx.d;
    const bound = bindEditor(editor, ctx);
    await bound.save();
    assert.equal(ctx.requests.length, 0);
    bound.removeExamplePair('drop');
    await bound.save();
    assert.equal(ctx.requests.length, 1, 'C5-25 deleting incomplete row uses existing save path');
  })();
  passed++;
  console.log(`ok ${passed} C5-25 deleting incomplete row runs existing save path`);

  t('C5-26 leading/trailing spaces on complete utterances are kept', () => {
    const raw = '{{user}}:  hi \n{{char}}: lo ';
    const parsed = parseExampleDialogue(raw);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.pairs[0].user, ' hi ');
    assert.equal(parsed.pairs[0].char, 'lo ');
    assert.equal(serializeExamplePairs(parsed.pairs), raw);
  });

  t('C5-27 empty speaker lines are not created in the final save string', () => {
    assert.equal(serializeExamplePairs([{ user: '', char: '' }]), '');
    assert.equal(serializeExamplePairs([{ user: 'a', char: 'b' }]).includes('{{user}}: \n'), false);
    const saveSrc = sliceFn(editor, 'async function save()', 'function restoreDraft()');
    assert.ok(saveSrc.includes('hasIncompleteExamplePairs(exampleRows)'));
    assert.equal(saveSrc.includes('parseExampleDialogue'), false);
  });

  await (async () => {
    const ctx = emptyBindCtx({
      exampleMode: 'structured',
      exampleRows: [{ id: 'r1', user: '', char: '' }],
    });
    ctx.dRef.current = ctx.d;
    const kv = ctx.kv;
    await withLocalStorage(kv, async () => {
      const bound = bindEditor(editor, ctx);
      bound.commitExampleRows([{ id: 'r1', user: 'hello', char: 'there' }]);
      assert.equal(ctx.d.example_dialogue, '{{user}}: hello\n{{char}}: there');
      if (ctx.timerRef.current) {
        clearTimeout(ctx.timerRef.current);
        ctx.timerRef.current = null;
      }
      flushCharacterDraft(ctx.character!.id, ctx.dRef.current, {
        dirty: ctx.dirtyRef.current,
        suppress: ctx.suppressRef.current,
      }, kv);
      assert.equal(readCharacterDraft(ctx.character!.id, kv)?.example_dialogue, '{{user}}: hello\n{{char}}: there');
    });
  })();
  passed++;
  console.log(`ok ${passed} C5-28 pair edits go through set('example_dialogue', serialized)`);

  t('C5-29 pair mutations do not call setD directly', () => {
    const helpers = sliceFn(editor, 'function commitExampleRows', 'const setupIncomplete');
    assert.equal(/setD\s*\(/.test(helpers), false);
    assert.ok(helpers.includes("set('example_dialogue', serializeExamplePairs"));
    const onChanges = [...editor.matchAll(/commitExampleRows\(exampleRowsRef\.current\.map/g)];
    assert.equal(onChanges.length, 2);
  });

  await (async () => {
    const id = 'c5disc01-c5c5-4c5c-8c5c-c5c5c5c5c5c5';
    const kv = memKv();
    await withLocalStorage(kv, async () => {
      writeCharacterDraft(id, SAMPLE, kv);
      const ctx = emptyBindCtx({
        character: { id },
        kv,
        exampleRows: [{ id: 'r1', user: '', char: '' }],
      });
      ctx.dRef.current = ctx.d;
      const bound = bindEditor(editor, ctx);
      bound.discardDraft();
      assert.equal(ctx.pendingDraft, null);
      flushCharacterDraft(id, ctx.dRef.current, {
        dirty: ctx.dirtyRef.current,
        suppress: ctx.suppressRef.current,
      }, kv);
      assert.equal(readCharacterDraft(id, kv), null);
      bound.commitExampleRows([{ id: 'r1', user: 'x', char: 'y' }]);
      assert.equal(ctx.dirtyRef.current, true);
      assert.equal(ctx.suppressRef.current, false);
      if (ctx.timerRef.current) {
        clearTimeout(ctx.timerRef.current);
        ctx.timerRef.current = null;
      }
      flushCharacterDraft(id, ctx.dRef.current, {
        dirty: ctx.dirtyRef.current,
        suppress: ctx.suppressRef.current,
      }, kv);
      assert.equal(readCharacterDraft(id, kv)?.example_dialogue, '{{user}}: x\n{{char}}: y');
    });
  })();
  passed++;
  console.log(`ok ${passed} C5-30 discard then pair edit reactivates C6 autosave`);

  t('C5-31 deleting a pair does not change other pairs order or content', () => {
    const rows = [
      { id: 'a', user: 'u1', char: 'c1' },
      { id: 'b', user: 'u2', char: 'c2' },
      { id: 'c', user: 'u3', char: 'c3' },
    ];
    const next = rows.filter((r) => r.id !== 'b');
    assert.deepEqual(next, [
      { id: 'a', user: 'u1', char: 'c1' },
      { id: 'c', user: 'u3', char: 'c3' },
    ]);
    const removeSrc = sliceFn(editor, 'function removeExamplePair', 'const setupIncomplete');
    assert.ok(removeSrc.includes('exampleRowsRef.current.filter((r) => r.id !== rowId)'));
    assert.equal(removeSrc.includes('sort('), false);
  });

  t('C5-32 stable row identity does not depend only on array index', () => {
    assert.ok(editor.includes('key={row.id}'));
    assert.equal(editor.includes('key={i}'), false);
    assert.equal(editor.includes('key={index}'), false);
    assert.ok(editor.includes('function allocExampleRowId'));
    assert.ok(editor.includes('exrow-'));
    assert.equal(pairsSrc.includes('id:'), false);
    assert.equal(serializeExamplePairs([{ user: 'a', char: 'b' }]).includes('exrow'), false);
  });

  await (async () => {
    const userA = fakeNode({ selectionStart: 1, selectionEnd: 1 });
    const charA = fakeNode({ selectionStart: 0, selectionEnd: 0 });
    const userB = fakeNode({ selectionStart: 2, selectionEnd: 2 });
    const charB = fakeNode({ selectionStart: 3, selectionEnd: 3 });
    const ctx = emptyBindCtx({
      exampleRows: [
        { id: 'rowA', user: 'ab', char: 'cd' },
        { id: 'rowB', user: 'ef', char: 'gh' },
      ],
    });
    ctx.dRef.current = ctx.d;
    ctx.pairFieldRefs.current.set('rowA:user', userA);
    ctx.pairFieldRefs.current.set('rowA:char', charA);
    ctx.pairFieldRefs.current.set('rowB:user', userB);
    ctx.pairFieldRefs.current.set('rowB:char', charB);
    let raf: FrameRequestCallback | null = null;
    const prevRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      raf = cb;
      return 1;
    }) as typeof requestAnimationFrame;
    try {
      const bound = bindEditor(editor, ctx);
      bound.insertPairToken('rowA', 'user', '{{char}}');
      assert.equal(ctx.insertCalls, 1);
      assert.equal(ctx.exampleRows[0].user, 'a{{char}}b');
      assert.equal(ctx.exampleRows[1].user, 'ef');
      assert.equal(ctx.exampleRows[1].char, 'gh');
      raf!(0);
      assert.equal(userA.focused, true);
      assert.deepEqual(userA.range, [1 + '{{char}}'.length, 1 + '{{char}}'.length]);
      assert.equal(userB.focused, false);
      assert.equal(charA.focused, false);
      assert.equal(charB.focused, false);
    } finally {
      globalThis.requestAnimationFrame = prevRaf;
    }
  })();
  passed++;
  console.log(`ok ${passed} C5-33..34 structured utterance refs are isolated; other-row selection unused`);

  await (async () => {
    const stale = fakeNode({ selectionStart: 0, selectionEnd: 0 });
    const other = fakeNode({ selectionStart: 0, selectionEnd: 0 });
    const ctx = emptyBindCtx({
      exampleRows: [{ id: 'gone', user: 'z', char: 'q' }],
    });
    ctx.dRef.current = ctx.d;
    ctx.pairFieldRefs.current.set('gone:user', stale);
    ctx.pairFieldRefs.current.set('alive:user', other);
    let raf: FrameRequestCallback | null = null;
    const prevRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      raf = cb;
      return 1;
    }) as typeof requestAnimationFrame;
    try {
      const bound = bindEditor(editor, ctx);
      bound.insertPairToken('gone', 'user', '{{user}}');
      ctx.pairFieldRefs.current.set('gone:user', null);
      stale.isConnected = false;
      raf!(0);
      assert.equal(stale.focused, false);
      assert.equal(stale.range, null);
      assert.equal(other.focused, false);
      bound.insertPairToken('missing', 'user', '{{user}}');
      assert.equal(other.focused, false);
    } finally {
      globalThis.requestAnimationFrame = prevRaf;
    }
  })();
  passed++;
  console.log(`ok ${passed} C5-35 stale/unmounted node does not receive caret`);

  t('C5-36 structured chips reuse insertCharacterToken', () => {
    const insertSrc = sliceFn(editor, 'function insertPairToken', 'function addExamplePair');
    assert.ok(insertSrc.includes('insertCharacterToken('));
    assert.equal(insertSrc.includes('src.slice(0, start)'), false);
    assert.ok(editor.includes('function PairUtteranceChips'));
    assert.equal(editor.includes('function PairUtteranceChips') && editor.includes('function TokenChips'), true);
  });

  t('C5-37 raw fallback keeps existing TokenChips wiring', () => {
    assert.ok(editor.includes('<TokenChips field="example_dialogue"'));
    const rawBranch = sliceFn(editor, "exampleMode === 'raw'", 'FieldCount value={d.example_dialogue}');
    assert.ok(rawBranch.includes('<TokenChips field="example_dialogue"'));
    assert.ok(rawBranch.includes("set('example_dialogue', e.target.value)"));
  });

  t('C5-38 TokenChips field= count stays 8', () => {
    assert.equal((editor.match(/<TokenChips field="/g) ?? []).length, 8);
  });

  t('C5-39 CharacterEditor.tsx has 0 as unknown', () => {
    assert.equal(editor.includes('as unknown'), false);
  });

  t('C5-40 request body still uses d', () => {
    const saveFn = sliceFn(editor, 'async function save()', 'function restoreDraft()');
    assert.ok(editor.includes("await put<Character>(`/api/characters/${character.id}`, d)"));
    assert.ok(editor.includes("await post<Character>('/api/characters', d)"));
    assert.ok(saveFn.includes(', d)'));
    assert.equal(saveFn.includes('example_pairs'), false);
  });

  t('C5-41 existing maxLength contract is unchanged', () => {
    assert.equal(FIELD_LIMITS.example_dialogue, 20000);
    assert.match(limitsSrc, /example_dialogue:\s*20000/);
    assert.ok(editor.includes('maxLength={FIELD_LIMITS.example_dialogue}'));
    assert.ok(editor.includes('maxLength={FIELD_LIMITS.first_message}'));
  });

  t('C5-42 C6 draft schema is unchanged', () => {
    const head = execSync('git show HEAD:apps/web/src/lib/characterDraftStore.ts', {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(storeSrc, head);
    assert.equal(storeSrc.includes('exampleMode'), false);
    assert.equal(storeSrc.includes('exampleRows'), false);
  });

  t('C5-43 serializer keeps internal newlines in an utterance', () => {
    const pairs = [{ user: 'line1\nline2', char: 'ok' }];
    const out = serializeExamplePairs(pairs);
    assert.equal(out, '{{user}}: line1\nline2\n{{char}}: ok');
    assert.equal(out.includes('\n'), true);
  });

  t('C5-44 multiline serialize is strict parse failure and raw fallback preserves bytes', () => {
    const out = serializeExamplePairs([{ user: 'line1\nline2', char: 'ok' }]);
    assert.equal(parseExampleDialogue(out).ok, false);
    const init = initialExampleEditorState(out);
    assert.equal(init.mode, 'raw');
    if (init.mode !== 'raw') return;
    assert.equal(init.raw, out);
    assert.equal(Buffer.from(init.raw).equals(Buffer.from(out)), true);
  });

  await (async () => {
    const rows = [{ id: 'r1', user: 'line1\nline2', char: 'ok' }];
    assert.equal(hasIncompleteExamplePairs(rows), false);
    const ctx = emptyBindCtx({ exampleMode: 'structured', exampleRows: rows, d: { ...SAMPLE } });
    ctx.dRef.current = ctx.d;
    const { save } = bindEditor(editor, ctx);
    await save();
    assert.equal(ctx.requests.length, 1, 'C5-45 multiline complete pair must not block save');
  })();
  passed++;
  console.log(`ok ${passed} C5-45 internal newlines alone do not block save`);

  t('C5-46 internal newlines are not deleted, space-substituted, or backslash-n escaped', () => {
    const out = serializeExamplePairs([{ user: 'a\nb', char: 'c\nd' }]);
    assert.equal(out, '{{user}}: a\nb\n{{char}}: c\nd');
    assert.equal(out.includes('\\n'), false);
    assert.equal(out.includes('a b'), false);
    assert.equal(out.includes('c d'), false);
    assert.equal(pairsSrc.includes('replace('), false);
    assert.equal(pairsSrc.includes('\\\\n'), false);
  });

  const saveSrc = sliceFn(editor, 'async function save()', 'function restoreDraft()');
  t('C5-gate completeness is row state only; early return before setSaving(true)', () => {
    const incAt = saveSrc.indexOf('hasIncompleteExamplePairs(exampleRows)');
    const savingAt = saveSrc.indexOf('setSaving(true)');
    assert.ok(incAt >= 0 && savingAt > incAt);
    assert.ok(saveSrc.includes("exampleMode === 'structured' && hasIncompleteExamplePairs(exampleRows)"));
    assert.equal(saveSrc.includes('parseExampleDialogue'), false);
    const overAt = saveSrc.indexOf('overLimitFields');
    assert.ok(overAt > incAt);
    assert.ok(saveSrc.includes('그래도 저장 시도'));
  });

  console.log(`passed ${passed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
