/**
 * npx tsx bench/characterAvatarFlow.test.ts
 * C2 new-character avatar staging: memory-only until save, then create → upload → onSaved.
 * Isolated: no systemd, no live DB write, no model, no migration, no generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { CharacterDraft, Kv } from '../apps/web/src/lib/characterDraftStore.ts';
import { FIELD_LIMITS, overLimitFields } from '../apps/web/src/lib/characterFieldLimits.ts';

const require2 = createRequire(import.meta.url);

let staging: typeof import('../apps/web/src/lib/characterAvatarStaging.ts');
try {
  staging = require2('../apps/web/src/lib/characterAvatarStaging.ts');
} catch (e) {
  console.error('RED: characterAvatarStaging missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const {
  STAGED_AVATAR_MAX_BYTES,
  STAGED_AVATAR_ALLOWED_TYPES,
  isAvatarFileInputVisible,
  validateStagedAvatarFile,
} = staging;

let draftMod: typeof import('../apps/web/src/lib/characterDraftStore.ts');
try {
  draftMod = require2('../apps/web/src/lib/characterDraftStore.ts');
} catch (e) {
  console.error('RED: characterDraftStore missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}
const {
  CHARACTER_DRAFT_DEBOUNCE_MS,
  CHARACTER_DRAFT_NEW_KEY,
  flushCharacterDraft,
  removeCharacterDraft,
  writeCharacterDraft,
  readCharacterDraft,
} = draftMod;

let pairsMod: typeof import('../apps/web/src/lib/characterExamplePairs.ts');
try {
  pairsMod = require2('../apps/web/src/lib/characterExamplePairs.ts');
} catch (e) {
  console.error('RED: characterExamplePairs missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}
const { serializeExamplePairs, hasIncompleteExamplePairs } = pairsMod;

let insertMod: typeof import('../apps/web/src/lib/characterTokenInsert.ts');
try {
  insertMod = require2('../apps/web/src/lib/characterTokenInsert.ts');
} catch (e) {
  console.error('RED: characterTokenInsert missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}
const { insertCharacterToken, applyTokenCaretRestore } = insertMod;

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
const helperSrc = fs.readFileSync(path.join(root, 'apps/web/src/lib/characterAvatarStaging.ts'), 'utf8');
const storeSrc = fs.readFileSync(path.join(root, 'apps/web/src/lib/characterDraftStore.ts'), 'utf8');

const FROST = 'f89ace9b-8684-4d97-96dc-e00c4b25a819';
const CREATED_ID = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const EXISTING_ID = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';

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

function sliceFn(src: string, startTok: string, endTok: string): string {
  const start = src.indexOf(startTok);
  assert.ok(start >= 0, `missing ${startTok}`);
  const end = src.indexOf(endTok, start + startTok.length);
  assert.ok(end > start, `missing ${endTok} after ${startTok}`);
  return src.slice(start, end);
}

function fakeFile(size: number, type: string, name = 'shot.png'): { name: string; size: number; type: string } {
  return { name, size, type };
}

type RequestRec = { method: string; url: string; body: unknown; contentType?: string };

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
  uploadingLog: boolean[];
  requests: RequestRec[];
  onSavedCalls: unknown[];
  removeDraftCalls: number;
  toasts: Array<{ msg: unknown; kind: unknown }>;
  stagedAvatar: unknown;
  stagedPreview: string | null;
  stagedFileRef: { current: unknown };
  stagedPreviewRef: { current: string | null };
  URL: {
    createObjectURL: (blob: unknown) => string;
    revokeObjectURL: (url: string) => void;
  };
  created: string[];
  revoked: string[];
  kv: Kv;
  postImpl?: (url: string, body: unknown) => Promise<unknown>;
  postBinaryImpl?: (url: string, body: unknown, contentType: string) => Promise<unknown>;
};

function emptyBindCtx(partial: Partial<BindCtx> = {}): BindCtx {
  const d = { ...SAMPLE, ...(partial.d ?? {}) };
  const created: string[] = [];
  const revoked: string[] = [];
  let seq = 0;
  const URL = {
    createObjectURL(_blob: unknown) {
      const u = `blob:c2-preview-${++seq}`;
      created.push(u);
      return u;
    },
    revokeObjectURL(url: string) {
      revoked.push(url);
    },
  };
  const base: BindCtx = {
    d,
    exampleMode: 'structured',
    exampleRows: [{ id: 'r1', user: '', char: '' }],
    character: null,
    dirtyRef: { current: false },
    suppressRef: { current: false },
    dRef: { current: d },
    timerRef: { current: null },
    pendingDraft: null,
    savingLog: [],
    uploadingLog: [],
    requests: [],
    onSavedCalls: [],
    removeDraftCalls: 0,
    toasts: [],
    stagedAvatar: null,
    stagedPreview: null,
    stagedFileRef: { current: null },
    stagedPreviewRef: { current: null },
    URL,
    created,
    revoked,
    kv: memKv(),
  };
  const merged: BindCtx = { ...base, ...partial, d, URL: partial.URL ?? URL, created: partial.created ?? created, revoked: partial.revoked ?? revoked };
  merged.dRef = partial.dRef ?? { current: merged.d };
  merged.stagedFileRef = partial.stagedFileRef ?? merged.stagedFileRef;
  merged.stagedPreviewRef = partial.stagedPreviewRef ?? merged.stagedPreviewRef;
  return merged;
}

function bindEditor(editorSrc: string, ctx: BindCtx) {
  const setSrc = sliceFn(editorSrc, 'const set =', 'async function save()');
  const saveSrc = sliceFn(editorSrc, 'async function save()', 'function restoreDraft()');
  assert.ok(setSrc.includes('async function onAvatarFileChosen'));
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
      const pairFieldRefs = { current: new Map() };
      const fieldRefs = { current: {} };
      const FIELD_LIMITS = ctx.FIELD_LIMITS;
      const insertCharacterToken = ctx.insertCharacterToken;
      const applyTokenCaretRestore = ctx.applyTokenCaretRestore;
      const serializeExamplePairs = ctx.serializeExamplePairs;
      const hasIncompleteExamplePairs = ctx.hasIncompleteExamplePairs;
      const overLimitFields = ctx.overLimitFields;
      const pairRefKey = (rowId: string, side: string) => rowId + ':' + side;
      const createExampleRow = ctx.createExampleRow;
      const flushCharacterDraft = ctx.flushCharacterDraft;
      const CHARACTER_DRAFT_DEBOUNCE_MS = ctx.CHARACTER_DRAFT_DEBOUNCE_MS;
      const stagedFileRef = ctx.stagedFileRef;
      const stagedPreviewRef = ctx.stagedPreviewRef;
      const URL = ctx.URL;
      const AVATAR_MAX_BYTES = ctx.AVATAR_MAX_BYTES;
      const validateStagedAvatarFile = ctx.validateStagedAvatarFile;
      function removeCharacterDraft() { ctx.removeDraftCalls++; ctx.removeCharacterDraft.apply(null, arguments); }
      function setPendingDraft(v: any) { ctx.pendingDraft = v; }
      function setSaving(v: boolean) { ctx.savingLog.push(v); }
      function setUploading(v: boolean) { ctx.uploadingLog.push(v); }
      function setStagedAvatar(v: any) { ctx.stagedAvatar = v; }
      function setStagedAvatarPreview(v: any) { ctx.stagedPreview = v; }
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
        toast(msg: unknown, kind?: unknown) { ctx.toasts.push({ msg, kind }); },
      };
      async function put(url: string, body: unknown) {
        ctx.requests.push({ method: 'PUT', url, body });
        return { id: 'saved-put', ...((body && typeof body === 'object') ? body : {}) };
      }
      async function post(url: string, body: unknown) {
        ctx.requests.push({ method: 'POST', url, body });
        if (ctx.postImpl) return ctx.postImpl(url, body);
        return { id: '${CREATED_ID}', ...((body && typeof body === 'object') ? body : {}) };
      }
      async function postBinary(url: string, body: unknown, contentType: string) {
        ctx.requests.push({ method: 'POST', url, body, contentType });
        if (ctx.postBinaryImpl) return ctx.postBinaryImpl(url, body, contentType);
        return { id: url.includes('/avatar') ? (ctx.character?.id ?? '${CREATED_ID}') : '${CREATED_ID}', avatar: '/media/avatars/staged.webp' };
      }
      function onSaved(saved: unknown) { ctx.onSavedCalls.push(saved); }
      ${setSrc}
      ${saveSrc}
      return { set, save, onAvatarFileChosen, clearStagedAvatar, revokeCurrentPreview };
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
  bindCtx.AVATAR_MAX_BYTES = STAGED_AVATAR_MAX_BYTES;
  bindCtx.validateStagedAvatarFile = validateStagedAvatarFile;
  let seq = 1000;
  bindCtx.createExampleRow = (user = '', char = '') => ({ id: `new-${++seq}`, user, char });
  return bind!(bindCtx) as {
    set: (k: string, v: unknown) => void;
    save: () => Promise<void>;
    onAvatarFileChosen: (file: unknown) => Promise<void>;
    clearStagedAvatar: () => void;
    revokeCurrentPreview: () => void;
  };
}

function runUnmountCleanup(editorSrc: string, ctx: BindCtx) {
  const startTok = 'useEffect(() => {\n    return () => {\n      const prev = stagedPreviewRef.current;';
  const start = editorSrc.indexOf(startTok);
  assert.ok(start >= 0, 'unmount revoke effect missing');
  const end = editorSrc.indexOf('}, []);', start);
  assert.ok(end > start, 'unmount effect end missing');
  const effect = editorSrc.slice(start, end);
  assert.ok(effect.includes('URL.revokeObjectURL'));
  assert.ok(effect.includes('stagedFileRef.current = null'));
  const innerStart = effect.indexOf('const prev = stagedPreviewRef.current;');
  const innerEnd = effect.indexOf('/* revoke must not throw the editor */', innerStart);
  assert.ok(innerEnd > innerStart, 'unmount revoke catch marker missing');
  const inner = `${effect.slice(innerStart, innerEnd)}/* revoke must not throw the editor */
      }
`;
  const wrapped = `
    export function cleanup(stagedPreviewRef: any, stagedFileRef: any, URL: any) {
      ${inner}
    }
  `;
  const { transformSync } = require2('esbuild');
  const js = transformSync(wrapped, { loader: 'ts', format: 'cjs' }).code;
  const exported: { cleanup?: (a: unknown, b: unknown, c: unknown) => void } = {};
  const moduleObj = { exports: exported };
  new Function('exports', 'module', 'require', js)(exported, moduleObj, require2);
  const cleanup = exported.cleanup ?? (moduleObj.exports as { cleanup: typeof exported.cleanup }).cleanup;
  assert.equal(typeof cleanup, 'function');
  cleanup!(ctx.stagedPreviewRef, ctx.stagedFileRef, ctx.URL);
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

async function main() {
  t('C2-1 new (unsaved) state shows avatar file input', () => {
    assert.equal(isAvatarFileInputVisible(null, FROST), true);
    assert.equal(isAvatarFileInputVisible(undefined, FROST), true);
    const setup = tabSection('setup', 'intro');
    assert.ok(setup.includes('아바타 파일'));
    assert.ok(setup.includes('isAvatarFileInputVisible(character?.id, FROST_CHARACTER_ID)'));
    assert.equal(setup.includes('character && character.id !== FROST_CHARACTER_ID'), false);
  });

  await (async () => {
    const ctx = emptyBindCtx();
    const { onAvatarFileChosen } = bindEditor(editor, ctx);
    const picked = fakeFile(12, 'image/png');
    await onAvatarFileChosen(picked);
    assert.equal(ctx.requests.length, 0, 'C2-2 file pick must not hit the server');
    assert.equal(ctx.stagedFileRef.current, picked);
    assert.equal((ctx.stagedFileRef.current as { type: string }).type, 'image/png');
    assert.equal(ctx.onSavedCalls.length, 0);
  })();
  passed++;
  console.log(`ok ${passed} C2-2 file pick alone issues 0 server requests`);

  t('C2-3 files over 8MB are rejected and not staged', () => {
    assert.equal(validateStagedAvatarFile({ size: STAGED_AVATAR_MAX_BYTES + 1, type: 'image/png' }), 'too-large');
    assert.equal(validateStagedAvatarFile({ size: STAGED_AVATAR_MAX_BYTES, type: 'image/png' }), null);
  });

  t('C2-4 nonempty disallowed file.type is rejected and not staged', () => {
    assert.equal(validateStagedAvatarFile({ size: 10, type: 'image/gif' }), 'bad-type');
    assert.equal(validateStagedAvatarFile({ size: 10, type: 'application/octet-stream' }), 'bad-type');
    assert.deepEqual([...STAGED_AVATAR_ALLOWED_TYPES], ['image/jpeg', 'image/png', 'image/webp']);
  });

  t('C2-5 empty file.type is staged, not client-rejected', () => {
    assert.equal(validateStagedAvatarFile({ size: 10, type: '' }), null);
  });

  await (async () => {
    const ctx = emptyBindCtx();
    const { onAvatarFileChosen } = bindEditor(editor, ctx);
    const first = fakeFile(10, 'image/png', 'a.png');
    const second = fakeFile(20, 'image/jpeg', 'b.jpg');
    await onAvatarFileChosen(first);
    assert.equal((ctx.stagedFileRef.current as { name: string }).name, 'a.png');
    const firstUrl = ctx.stagedPreviewRef.current;
    await onAvatarFileChosen(second);
    assert.equal((ctx.stagedFileRef.current as { name: string }).name, 'b.jpg');
    assert.equal((ctx.stagedFileRef.current as { size: number }).size, 20);
    assert.notEqual(ctx.stagedPreviewRef.current, firstUrl);
    assert.equal(ctx.requests.length, 0);
  })();
  passed++;
  console.log(`ok ${passed} C2-6 reselect replaces the previously staged file`);

  await (async () => {
    const ctx = emptyBindCtx();
    const { onAvatarFileChosen, clearStagedAvatar } = bindEditor(editor, ctx);
    await onAvatarFileChosen(fakeFile(10, 'image/png'));
    assert.ok(ctx.stagedFileRef.current);
    clearStagedAvatar();
    assert.equal(ctx.stagedFileRef.current, null);
    assert.equal(ctx.stagedPreviewRef.current, null);
    assert.equal(ctx.requests.length, 0);
    const ctx2 = emptyBindCtx();
    const bound = bindEditor(editor, ctx2);
    await bound.onAvatarFileChosen(fakeFile(10, 'image/webp'));
    assert.ok(ctx2.stagedPreviewRef.current);
    runUnmountCleanup(editor, ctx2);
    assert.equal(ctx2.stagedFileRef.current, null);
    assert.equal(ctx2.stagedPreviewRef.current, null);
    assert.equal(ctx2.requests.length, 0);
  })();
  passed++;
  console.log(`ok ${passed} C2-7 cancel/unmount discards staged file with 0 server writes`);

  await (async () => {
    const ctx = emptyBindCtx();
    const { onAvatarFileChosen, set } = bindEditor(editor, ctx);
    await onAvatarFileChosen(fakeFile(10, 'image/png', 'keep-out-of-draft.png'));
    assert.equal(ctx.kv.getItem(CHARACTER_DRAFT_NEW_KEY), null);
    flushCharacterDraft(null, ctx.d, { dirty: true, suppress: false }, ctx.kv);
    const raw = ctx.kv.getItem(CHARACTER_DRAFT_NEW_KEY);
    assert.ok(raw);
    assert.equal(raw!.includes('keep-out-of-draft.png'), false);
    assert.equal(raw!.includes('blob:'), false);
    const parsed = JSON.parse(raw!);
    assert.equal(parsed.avatar, null);
    assert.equal('stagedAvatar' in parsed, false);
    const onAvatarSrc = sliceFn(editor, 'async function onAvatarFileChosen', 'async function save()');
    assert.equal(onAvatarSrc.includes('writeCharacterDraft'), false);
    assert.equal(onAvatarSrc.includes('flushCharacterDraft'), false);
    assert.equal(storeSrc.includes('stagedAvatar'), false);
    assert.equal(helperSrc.includes('writeCharacterDraft'), false);
    void set;
  })();
  passed++;
  console.log(`ok ${passed} C2-8 staged file is not written into the C6 draft`);

  await (async () => {
    const ctx = emptyBindCtx({ d: { ...SAMPLE, name: '신규' } });
    ctx.dRef.current = ctx.d;
    const { onAvatarFileChosen, save } = bindEditor(editor, ctx);
    const file = fakeFile(10, 'image/png');
    await onAvatarFileChosen(file);
    await save();
    assert.ok(ctx.requests.length >= 1);
    assert.equal(ctx.requests[0].method, 'POST');
    assert.equal(ctx.requests[0].url, '/api/characters');
    assert.ok(ctx.requests[1], 'C2-10 upload must run after create');
    assert.equal(ctx.requests[1].url, `/api/characters/${CREATED_ID}/avatar`);
    assert.equal(ctx.requests[1].body, file);
    assert.equal(ctx.onSavedCalls.length, 1);
    assert.equal(ctx.requests[0].url.includes('/avatar'), false);
    const urls = ctx.requests.map((r) => r.url);
    assert.deepEqual(urls, ['/api/characters', `/api/characters/${CREATED_ID}/avatar`]);
    assert.equal(ctx.onSavedCalls.length, 1);
  })();
  passed++;
  console.log(`ok ${passed} C2-9..11 create then upload then onSaved, upload uses saved.id`);

  await (async () => {
    const ctx = emptyBindCtx({ d: { ...SAMPLE, name: '신규' } });
    ctx.dRef.current = ctx.d;
    ctx.postImpl = async () => {
      throw new Error('create-failed');
    };
    const { onAvatarFileChosen, save } = bindEditor(editor, ctx);
    await onAvatarFileChosen(fakeFile(10, 'image/png'));
    await save();
    assert.equal(ctx.requests.length, 1);
    assert.equal(ctx.requests[0].url, '/api/characters');
    assert.equal(ctx.requests.some((r) => r.url.includes('/avatar')), false);
    assert.equal(ctx.onSavedCalls.length, 0);
    assert.equal(String(ctx.toasts[ctx.toasts.length - 1]?.msg), 'create-failed');
  })();
  passed++;
  console.log(`ok ${passed} C2-12 create failure does not call avatar upload`);

  await (async () => {
    const ctx = emptyBindCtx({ d: { ...SAMPLE, name: '신규' } });
    ctx.dRef.current = ctx.d;
    ctx.postBinaryImpl = async () => {
      throw new Error('upload-failed');
    };
    const { onAvatarFileChosen, save } = bindEditor(editor, ctx);
    await onAvatarFileChosen(fakeFile(10, 'image/png'));
    await save();
    const creates = ctx.requests.filter((r) => r.url === '/api/characters');
    const uploads = ctx.requests.filter((r) => r.url.includes('/avatar'));
    assert.equal(creates.length, 1);
    assert.equal(uploads.length, 1);
    assert.equal(ctx.onSavedCalls.length, 1);
    const warn = ctx.toasts.find((x) => x.kind === 'warn');
    assert.ok(warn, 'C2-14 warn toast missing');
    assert.equal(String(warn!.msg).includes('이미지 업로드'), true);
    assert.equal(creates.length, 1, 'C2-15 must not re-POST /api/characters');
  })();
  passed++;
  console.log(`ok ${passed} C2-13..15 upload failure still onSaved + warn toast, no re-create`);

  await (async () => {
    const ctx = emptyBindCtx({ d: { ...SAMPLE, name: '신규' } });
    ctx.dRef.current = ctx.d;
    const { save } = bindEditor(editor, ctx);
    await save();
    assert.equal(ctx.requests.length, 1);
    assert.equal(ctx.requests[0].url, '/api/characters');
    assert.equal(ctx.requests.some((r) => r.url.includes('/avatar')), false);
    assert.equal(ctx.onSavedCalls.length, 1);
  })();
  passed++;
  console.log(`ok ${passed} C2-16 no staged file means no avatar upload`);

  await (async () => {
    const ctx = emptyBindCtx({
      character: { id: EXISTING_ID },
      d: { ...SAMPLE, name: '기존' },
    });
    ctx.dRef.current = ctx.d;
    const file = fakeFile(10, 'image/png');
    const { onAvatarFileChosen } = bindEditor(editor, ctx);
    await onAvatarFileChosen(file);
    assert.equal(ctx.requests.length, 1);
    assert.equal(ctx.requests[0].url, `/api/characters/${EXISTING_ID}/avatar`);
    assert.equal(ctx.requests[0].body, file);
    assert.equal(ctx.stagedFileRef.current, null);
    assert.equal(ctx.d.avatar, '/media/avatars/staged.webp');
    assert.ok(ctx.toasts.some((x) => String(x.msg) === '아바타 업로드됨'));
  })();
  passed++;
  console.log(`ok ${passed} C2-17 existing character still uploads immediately`);

  t('C2-18 FROST_CHARACTER_ID hides the file input', () => {
    assert.equal(isAvatarFileInputVisible(FROST, FROST), false);
    const setup = tabSection('setup', 'intro');
    assert.ok(setup.includes('FROST_CHARACTER_ID'));
    assert.ok(editor.includes(`const FROST_CHARACTER_ID = '${FROST}'`));
  });

  await (async () => {
    const ctx = emptyBindCtx();
    const { onAvatarFileChosen, clearStagedAvatar, save } = bindEditor(editor, ctx);
    await onAvatarFileChosen(fakeFile(10, 'image/png', 'one.png'));
    const url1 = ctx.stagedPreviewRef.current;
    assert.ok(url1);
    assert.deepEqual(ctx.created, [url1]);
    await onAvatarFileChosen(fakeFile(11, 'image/jpeg', 'two.jpg'));
    const url2 = ctx.stagedPreviewRef.current;
    assert.ok(url2);
    assert.notEqual(url2, url1);
    assert.deepEqual(ctx.revoked, [url1]);
    clearStagedAvatar();
    assert.deepEqual(ctx.revoked, [url1, url2]);
    assert.equal(ctx.stagedPreviewRef.current, null);

    const ctxU = emptyBindCtx();
    const bU = bindEditor(editor, ctxU);
    await bU.onAvatarFileChosen(fakeFile(10, 'image/webp'));
    const uUrl = ctxU.stagedPreviewRef.current;
    runUnmountCleanup(editor, ctxU);
    assert.deepEqual(ctxU.revoked, [uUrl]);

    const ctxS = emptyBindCtx({ d: { ...SAMPLE, name: '신규' } });
    ctxS.dRef.current = ctxS.d;
    const bS = bindEditor(editor, ctxS);
    await bS.onAvatarFileChosen(fakeFile(10, 'image/png'));
    const sUrl = ctxS.stagedPreviewRef.current;
    await bS.save();
    assert.ok(ctxS.revoked.includes(sUrl!));
    assert.equal(ctxS.stagedPreviewRef.current, null);
  })();
  passed++;
  console.log(`ok ${passed} C2-19 createObjectURL is revoked on reselect, discard, unmount, and save`);

  await (async () => {
    const ctx = emptyBindCtx();
    ctx.URL.revokeObjectURL = (url: string) => {
      ctx.revoked.push(url);
    };
    const { onAvatarFileChosen, clearStagedAvatar, revokeCurrentPreview } = bindEditor(editor, ctx);
    await onAvatarFileChosen(fakeFile(10, 'image/png'));
    const url = ctx.stagedPreviewRef.current;
    assert.ok(url);
    clearStagedAvatar();
    clearStagedAvatar();
    revokeCurrentPreview();
    runUnmountCleanup(editor, ctx);
    assert.equal(ctx.revoked.filter((u) => u === url).length, 1);

    const boom: BindCtx = emptyBindCtx();
    boom.URL.revokeObjectURL = () => {
      throw new Error('revoke-boom');
    };
    const b2 = bindEditor(editor, boom);
    await b2.onAvatarFileChosen(fakeFile(10, 'image/png'));
    assert.doesNotThrow(() => b2.clearStagedAvatar());
    assert.doesNotThrow(() => runUnmountCleanup(editor, boom));
  })();
  passed++;
  console.log(`ok ${passed} C2-20 same preview URL is not revoked twice; revoke throw is swallowed`);

  await (async () => {
    const ctx = emptyBindCtx({ d: { ...SAMPLE, name: '신규', avatar: null } });
    ctx.dRef.current = ctx.d;
    const { onAvatarFileChosen, save } = bindEditor(editor, ctx);
    await onAvatarFileChosen(fakeFile(10, 'image/png'));
    assert.ok(ctx.stagedPreviewRef.current);
    assert.equal(ctx.d.avatar, null);
    assert.equal(String(ctx.d.avatar ?? '').startsWith('blob:'), false);
    await save();
    const createBody = ctx.requests[0].body as CharacterDraft;
    assert.equal(createBody.avatar, null);
    assert.equal(String(createBody.avatar ?? '').includes('blob:'), false);
    assert.equal(createBody, ctx.d);
  })();
  passed++;
  console.log(`ok ${passed} C2-21 preview URL is not written to d.avatar or the save payload`);

  t('C2-22 save request body remains d', () => {
    assert.ok(editor.includes("await put<Character>(`/api/characters/${character.id}`, d)"));
    assert.ok(editor.includes("await post<Character>('/api/characters', d)"));
    const saveFn = sliceFn(editor, 'async function save()', 'function restoreDraft()');
    assert.ok(saveFn.includes(', d)'));
  });

  t('C2-23 CharacterEditor.tsx has no as unknown', () => {
    assert.equal(editor.includes('as unknown'), false);
  });

  await (async () => {
    const ctx = emptyBindCtx({ d: { ...SAMPLE, name: '신규' } });
    ctx.dRef.current = ctx.d;
    writeCharacterDraft(null, ctx.d, ctx.kv);
    assert.ok(readCharacterDraft(null, ctx.kv));
    const g = globalThis as { localStorage?: unknown };
    const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: ctx.kv });
    try {
      const { save } = bindEditor(editor, ctx);
      await save();
    } finally {
      if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
      else delete g.localStorage;
    }
    assert.ok(ctx.removeDraftCalls >= 1);
    assert.equal(readCharacterDraft(null, ctx.kv), null);
    const saveFn = sliceFn(editor, 'async function save()', 'function restoreDraft()');
    const suppressAt = saveFn.indexOf('suppressRef.current = true');
    const removeAt = saveFn.indexOf('removeCharacterDraft');
    const onSavedAt = saveFn.indexOf('onSaved(saved)');
    assert.ok(suppressAt >= 0 && removeAt > suppressAt && onSavedAt > removeAt);
  })();
  passed++;
  console.log(`ok ${passed} C2-24 successful save still deletes the C6 .new draft`);

  t('C2 extra: rejected pick does not replace a prior staged file', () => {
    assert.equal(validateStagedAvatarFile({ size: STAGED_AVATAR_MAX_BYTES + 1, type: '' }), 'too-large');
  });

  await (async () => {
    const ctx = emptyBindCtx();
    const { onAvatarFileChosen } = bindEditor(editor, ctx);
    const keep = fakeFile(10, 'image/png', 'keep.png');
    await onAvatarFileChosen(keep);
    await onAvatarFileChosen(fakeFile(STAGED_AVATAR_MAX_BYTES + 1, 'image/png', 'huge.png'));
    assert.equal((ctx.stagedFileRef.current as { name: string }).name, 'keep.png');
    await onAvatarFileChosen(fakeFile(10, 'image/gif', 'no.gif'));
    assert.equal((ctx.stagedFileRef.current as { name: string }).name, 'keep.png');
    assert.equal(ctx.requests.length, 0);
    await onAvatarFileChosen(fakeFile(10, '', 'empty-type.bin'));
    assert.equal((ctx.stagedFileRef.current as { name: string }).name, 'empty-type.bin');
    assert.equal(ctx.requests.length, 0);
  })();
  passed++;
  console.log(`ok ${passed} C2 extra: size/type reject keeps prior stage; empty type stages`);

  t('C2 extra: TokenChips stay out of the avatar URL/file slices', () => {
    const setup = tabSection('setup', 'intro');
    const avatarUrl = setup.slice(setup.indexOf('아바타 URL'), setup.indexOf('아바타 파일'));
    assert.equal(avatarUrl.includes('TokenChips'), false);
    const avatarFile = setup.slice(setup.indexOf('아바타 파일'));
    assert.equal(avatarFile.includes('TokenChips'), false);
    assert.equal((editor.match(/<TokenChips field="/g) ?? []).length, 8);
  });

  console.log(`passed ${passed}`);
}

void main();
