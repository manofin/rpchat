/**
 * npx tsx bench/beatRenderWeb.test.ts
 * f9-swap-passes (S4) — the client renders §6 blocks, and only §6 blocks.
 * The load-bearing case is the negative one: a message with no `block_kind` must
 * keep the ordinary bubble, or every message written before the beat engine gets
 * reinterpreted as beat chrome on first load.
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const view = () => src('apps/web/src/components/view.tsx');
const chatPage = () => src('apps/web/src/pages/ChatPage.tsx');
const useChat = () => src('apps/web/src/pages/useChat.ts');
const webTypes = () => src('apps/web/src/types.ts');
const serverTypes = () => src('apps/server/src/types.ts');
const chat = () => src('apps/server/src/routes/chat.ts');

// ── 1. block_kind is optional on both sides ─────────────────────────────────
t('block_kind / beat_seq / image_url are optional in server and web MessageMeta', () => {
  for (const [name, s] of [['server', serverTypes()], ['web', webTypes()]] as const) {
    assert.match(s, /block_kind\?: 'header' \| 'narration' \| 'line' \| 'thought' \| 'ui'/, name);
    assert.match(s, /beat_seq\?: number/, name);
    assert.match(s, /image_url\?: string/, name);
  }
});

t('a message with no block_kind falls through to the existing bubble', () => {
  const s = code('apps/web/src/pages/ChatPage.tsx');
  const guard = /const kind = m\.meta\.block_kind;[\s\S]{0,120}if \(!isUser && kind && kind !== 'line'\)/;
  assert.match(s, guard, 'the beat branch must be gated on block_kind being present');
  // the ordinary path is still there, below the guard
  const at = s.search(guard);
  assert.ok(s.slice(at).includes('renderContent(m.content)'), 'bubble rendering survives');
  assert.ok(s.slice(at).includes('className={`msg '), 'the msg wrapper survives');
});

t("a 'line' block keeps the bubble — it is speech, not chrome", () => {
  const s = code('apps/web/src/pages/ChatPage.tsx');
  assert.ok(s.includes("kind !== 'line'"), "'line' must be excluded from the chrome branch");
});

// ── 2. each block kind has a renderer ───────────────────────────────────────
t('view.tsx exports a renderer for every non-line block kind', () => {
  const s = view();
  for (const fn of ['BeatHeader', 'BeatNarration', 'BeatThought', 'BeatUiPanel', 'parseBeatUi']) {
    assert.ok(s.includes(`export function ${fn}`), fn);
  }
  const page = chatPage();
  for (const fn of ['BeatHeader', 'BeatNarration', 'BeatThought', 'BeatUiPanel', 'parseBeatUi']) {
    assert.ok(page.includes(fn), `${fn} must be wired into ChatPage`);
  }
});

t('the speaker header is used for line blocks only', () => {
  const s = code('apps/web/src/pages/ChatPage.tsx');
  assert.ok(s.includes('<SpeakerHeader'));
  const at = s.indexOf('<SpeakerHeader');
  const branchAt = s.indexOf("kind !== 'line'");
  assert.ok(branchAt < at, 'SpeakerHeader lives below the chrome branch, i.e. on the bubble path');
});

t('a damaged ui payload renders nothing rather than throwing', () => {
  const s = view();
  assert.match(s, /export function parseBeatUi[\s\S]{0,400}catch \{\s*return null;/);
  const page = code('apps/web/src/pages/ChatPage.tsx');
  assert.ok(page.includes('ui ? <BeatUiPanel ui={ui} /> : null'), 'a null parse must render nothing');
});

// ── 3. the image is a server path, never model output ───────────────────────
t('the portrait comes from meta.image_url, which the server computed', () => {
  const page = code('apps/web/src/pages/ChatPage.tsx');
  assert.ok(page.includes('m.meta.image_url'), 'the client reads the server-chosen path');
  // the client never builds a path of its own
  assert.equal(/\/media\/assets\//.test(page), false, 'the client must not construct asset paths');
  assert.equal(/silu\.uk|https?:\/\//.test(page), false);
});

t('no asset path means no img tag — Avatar falls back to the initial', () => {
  const s = view();
  assert.match(s, /export function Avatar[\s\S]{0,300}if \(avatar\) return[\s\S]{0,120}<img/);
  assert.match(s, /export function Avatar[\s\S]{0,500}aria-hidden>\{initial\}/);
});

// ── 4. SSE contract ─────────────────────────────────────────────────────────
t('every beat block except the streamed one rides the append-only aux channel', () => {
  const s = code('apps/server/src/routes/chat.ts');
  const beatAt = s.indexOf('async function generateBeat');
  const beat = s.slice(beatAt);
  assert.ok(beat.includes("type: 'aux'"));
  assert.ok(beat.includes("type: 'start'"));
  assert.ok(beat.includes("type: 'done'"));
  assert.ok(beat.includes("type: 'token'"));
});

t('aux is id-deduped and append-only, so it is safe before start', () => {
  const s = useChat();
  assert.match(s, /case 'aux': \{\s*\n\s*if \(s\.messages\.some\(\(m\) => m\.id === e\.message\.id\)\) return s;/);
});

t('exactly one start/done pair per beat, whether or not there is a focus', () => {
  const s = code('apps/server/src/routes/chat.ts');
  const beat = s.slice(s.indexOf('async function generateBeat'));
  // start fires once for the focus row, or once for the closing row when there is none
  assert.ok(beat.includes('if (!started)'), 'the no-focus beat must still emit start');
  assert.ok(beat.includes('const closing = focusRow ?? uiRow'), 'and done must have a row to close on');
});

t('the user message is emitted before the first block, not after it', () => {
  const s = code('apps/server/src/routes/chat.ts');
  const beat = s.slice(s.indexOf('async function generateBeat'));
  const userAt = beat.indexOf('if (userMessage) sse.send');
  const headerAt = beat.indexOf("addBlock('header'");
  assert.ok(userAt > 0 && headerAt > 0 && userAt < headerAt,
    'otherwise the header would be appended above the user turn');
});

// ── 5. persistence shape ────────────────────────────────────────────────────
t('every block row is persisted with its kind and its position', () => {
  const s = code('apps/server/src/routes/chat.ts');
  const beat = s.slice(s.indexOf('async function generateBeat'));
  assert.ok(beat.includes('block_kind: kind'));
  assert.ok(beat.includes('beat_seq: emitted.length'));
  assert.ok(beat.includes("insertMessage(db, conv.id, head, 'assistant'"), 'rows chain under one another');
});

// Regression, seen live 2026-09-02: the focus row is created outside addBlock, so
// it was not counted. Every later block's beat_seq came out one short and the
// final updateMessage reset the line's own seq to 0.
t('the focus row occupies a beat position, and keeps it through the final update', () => {
  const s = code('apps/server/src/routes/chat.ts');
  const beat = s.slice(s.indexOf('async function generateBeat'));
  assert.ok(beat.includes('focusSeq = emitted.length'), 'the focus row takes the next position');
  assert.ok(beat.includes('emitted.push(focusRow)'), 'and is counted so later blocks follow it');
  assert.ok(beat.includes('beat_seq: focusSeq'), 'the final update must not reset it');
  assert.equal(/beat_seq: 0\b/.test(beat), false, 'no block may hardcode position 0');
});

t('the focus row is the only streaming row; the rest are complete on insert', () => {
  const s = code('apps/server/src/routes/chat.ts');
  const beat = s.slice(s.indexOf('async function generateBeat'));
  assert.ok(beat.includes("'assistant', content, 'complete'"), 'blocks are written complete');
  assert.ok(beat.includes("'assistant', '', 'streaming'"), 'the focus row starts empty and streams');
});

// ── 6. the 1:1 path is untouched ────────────────────────────────────────────
t('the 1:1 client path is unchanged: no block_kind is ever written there', () => {
  const s = code('apps/server/src/routes/chat.ts');
  const oneToOne = s.slice(0, s.indexOf('async function generateBeat'));
  assert.equal(oneToOne.includes('block_kind'), false, 'the 1:1 path must not stamp beat metadata');
  assert.ok(oneToOne.includes('extractChoices('), 'and it keeps its own contract');
});

t('beat styles are additive; no existing class was redefined', () => {
  const css = src('apps/web/src/app.css');
  for (const cls of ['.beat-header', '.beat-narration', '.beat-thought', '.beat-ui', '.beat-chip']) {
    assert.ok(css.includes(cls), cls);
  }
  // `.bubble` and `.msg` keep exactly one definition each
  assert.equal((css.match(/^\.bubble \{/gm) ?? []).length, 1);
  assert.equal((css.match(/^\.msg \{/gm) ?? []).length, 1);
});

console.log(`\n${passed} passed`);
