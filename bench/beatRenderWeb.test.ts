/**
 * npx tsx bench/beatRenderWeb.test.ts
 * Beat rendering through the shared server event contract, including legacy rows.
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { adaptChatEvents, type EventMessage } from '../apps/server/src/contracts/chatEventAdapter.ts';
import { EventRenderer } from '../apps/web/src/components/EventRenderer.tsx';
import { initialChatState, reduceChatEvent } from '../apps/web/src/lib/chatStreamState.ts';
import type { Message } from '../apps/web/src/types.ts';

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
const webTypes = () => src('apps/web/src/types.ts');
const serverTypes = () => src('apps/server/src/types.ts');
const chat = () => src('apps/server/src/routes/chat.ts');
const render = (content: string, meta: EventMessage['meta'] = {}) => renderToStaticMarkup(createElement(EventRenderer, {
  events: adaptChatEvents({ id: 'fixture', role: 'assistant', content, meta }),
}));

// ── 1. block_kind is optional on both sides ─────────────────────────────────
t('block_kind / beat_seq / image_url are optional in server and web MessageMeta', () => {
  for (const [name, s] of [['server', serverTypes()], ['web', webTypes()]] as const) {
    assert.match(s, /block_kind\?: 'header' \| 'narration' \| 'line' \| 'thought' \| 'ui'/, name);
    assert.match(s, /beat_seq\?: number/, name);
    assert.match(s, /image_url\?: string/, name);
  }
});

t('a message with no block_kind uses canonical events without becoming beat chrome', () => {
  const s = code('apps/web/src/pages/ChatPage.tsx');
  assert.match(render('평범한 서술'), /class="beat-narration">평범한 서술/);
  assert.doesNotMatch(render('평범한 서술'), /beat-header|beat-ui-panel/);
  assert.match(s, /isUser \? renderContent\(m.content\) : <MessageEvents/);
});

t("a 'line' block keeps the bubble — it is speech, not chrome", () => {
  const html = render('대사입니다.', { block_kind: 'line', speaker_name: '나리', speaker_character_id: 'nari' });
  assert.match(html, /class="bubble beat-dialogue-bubble"/);
  assert.match(html, /\[나리\]/);
  assert.doesNotMatch(html, /beat-header|beat-ui-panel/);
});

// ── 2. each block kind has a renderer ───────────────────────────────────────
t('EventRenderer draws headers, info, narration and server-decoded panels', () => {
  for (const [kind, className] of [['header', 'beat-header'], ['info', 'beat-info'], ['narration', 'beat-narration']] as const) {
    assert.match(render('표시 내용', { block_kind: kind }), new RegExp(`class="${className}"`));
  }
  assert.match(render('{"location_badge":"교실"}', { block_kind: 'ui' }), /beat-ui-panel/);
  const page = chatPage();
  assert.match(page, /MessageEvents/);
  assert.match(page, /eventUiData/, 'roster reads structured event payloads');
  assert.match(page, /BeatUiPanel/, 'roster path still uses BeatUiPanel');
});

t('historical thought rows produce no event or DOM', () => {
  assert.equal(view().includes('BeatThought'), false, 'no thought renderer may come back silently');
  assert.equal(render('private historical thought', { block_kind: 'thought' }), '');
  assert.match(webTypes(), /block_kind\?: 'header' \| 'narration' \| 'line' \| 'thought' \| 'ui'/);
});

t('the speaker header reads a dialogue event with an explicit actor name', () => {
  const s = code('apps/web/src/pages/ChatPage.tsx');
  assert.ok(s.includes('<SpeakerHeader'));
  assert.match(s, /events.find\(\(event\) => event.type === 'dialogue'\)/);
  assert.match(s, /firstDialogue\?\.actorName \?/);
});

t('BeatUiPanel prints gear, inventory and traits from the user_sheet', () => {
  const s = view();
  assert.ok(s.includes('sheet.gear'), 'gear');
  assert.ok(s.includes('sheet.inventory'), 'inventory');
  assert.ok(s.includes('sheet.traits'), 'traits');
  assert.ok(s.includes('장비'), 'gear label');
  assert.ok(s.includes('보유'), 'inventory label');
  assert.ok(s.includes('특수'), 'traits label');
});

t('a damaged ui payload renders nothing rather than throwing', () => {
  assert.equal(render('{not valid json', { block_kind: 'ui' }), '');
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
  const message: Message = {
    id: 'aux', conversation_id: 'conversation', parent_id: null, role: 'assistant', content: '표시 내용', status: 'complete',
    meta: {}, eventVersion: 1, events: [{ type: 'narration', id: 'aux:0', text: '표시 내용' }],
    bookmarked: false, created_at: '2026-01-01T00:00:00Z', siblings: { index: 0, count: 1, ids: ['aux'] },
  };
  const event = { type: 'aux' as const, message };
  const first = reduceChatEvent(initialChatState, event, 'conversation');
  const replay = reduceChatEvent(first, event, 'conversation');
  assert.deepEqual(replay.messages, [message]);
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
  // Historical thought rows have no visible surface.
  for (const cls of ['.beat-header', '.beat-narration', '.beat-ui', '.beat-chip']) {
    assert.ok(css.includes(cls), cls);
  }
  // `.bubble` and `.msg` keep exactly one definition each
  assert.equal((css.match(/^\.bubble \{/gm) ?? []).length, 1);
  assert.equal((css.match(/^\.msg \{/gm) ?? []).length, 1);
});

console.log(`\n${passed} passed`);
