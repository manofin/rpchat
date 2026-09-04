/**
 * npx tsx bench/hunterRenderWeb.test.ts
 * hunter-format — the client prints Huntt.txt-class blocks and does not parse them.
 *
 * Load-bearing negatives:
 *   - a message with no `block_kind` keeps the ordinary bubble
 *   - a beat/dialog `line` keeps SpeakerHeader + bubble (`kind !== 'line'` stays)
 *   - BeatHunterPanel prints the server text; it does not split a 🎯/🪪 row
 *
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
const page = () => src('apps/web/src/pages/ChatPage.tsx');
const css = () => src('apps/web/src/app.css');
const webTypes = () => src('apps/web/src/types.ts');

t('web MessageMeta includes panel and system, still optional', () => {
  assert.match(webTypes(), /block_kind\?: 'header' \| 'narration' \| 'line' \| 'thought' \| 'ui' \| 'info' \| 'panel' \| 'system'/);
});

t('scene.format is an optional per-conversation switch, never a global flag', () => {
  assert.match(webTypes(), /format\?: 'beat' \| 'dialog' \| 'hunter'/);
});

t('view.tsx exports a renderer for every hunter chrome kind', () => {
  for (const fn of ['BeatHunterPanel', 'BeatSystem', 'BeatHunterLine']) {
    assert.ok(view().includes(`export function ${fn}`), fn);
  }
});

t('BeatHunterPanel prints the server text and does not parse a panel row', () => {
  const s = code('apps/web/src/components/view.tsx');
  const at = s.indexOf('export function BeatHunterPanel');
  assert.ok(at >= 0);
  const body = s.slice(at, at + 280);
  assert.ok(body.includes('className="beat-panel"'));
  assert.ok(body.includes('{text}'));
  assert.equal(/🎯|🪪|INFO/.test(body), false, 'the client must not know panel labels');
  assert.equal(/split\(/.test(body), false, 'the client must not split panel rows');
});

t('BeatHunterLine is the transcript script row: 💬 name │ text', () => {
  const s = view();
  const at = s.indexOf('export function BeatHunterLine');
  assert.ok(at >= 0);
  const body = s.slice(at, at + 600);
  assert.ok(body.includes('💬'));
  assert.ok(body.includes('│'));
  assert.ok(body.includes('className="beat-line-hunter"'));
  assert.ok(body.includes('{name}'));
  assert.ok(body.includes('renderContent(text)'));
});

t('ChatPage wires panel / system / hunter line, gated on scene.format', () => {
  const s = page();
  assert.ok(s.includes('BeatHunterPanel'));
  assert.ok(s.includes('BeatSystem'));
  assert.ok(s.includes('BeatHunterLine'));
  assert.ok(s.includes('sceneFormat: conv.scene.format') || s.includes('sceneFormat={conv.scene.format}'));
  assert.match(code('apps/web/src/pages/ChatPage.tsx'), /kind === 'line' && props\.sceneFormat === 'hunter'/);
});

t('hunter narration keeps the stored 『』 text; the variant is display-only', () => {
  const s = code('apps/web/src/pages/ChatPage.tsx');
  assert.match(s, /BeatNarration text=\{m\.content\} variant=\{props\.sceneFormat === 'hunter' \? 'hunter' : undefined\}/);
  assert.ok(view().includes("variant?: 'hunter'"));
});

t('a message with no block_kind still falls through to the bubble', () => {
  const s = code('apps/web/src/pages/ChatPage.tsx');
  const guard = /const kind = m\.meta\.block_kind;[\s\S]{0,120}if \(!isUser && kind && kind !== 'line'\)/;
  assert.match(s, guard);
  const at = s.search(guard);
  assert.ok(s.slice(at).includes('renderContent(m.content)'));
  assert.ok(s.slice(at).includes('className={`msg '));
});

t("a non-hunter line keeps the bubble — hunter script is an extra branch, not a chrome rewrite", () => {
  const s = code('apps/web/src/pages/ChatPage.tsx');
  assert.ok(s.includes("kind !== 'line'"));
  const hunterAt = s.indexOf("kind === 'line' && props.sceneFormat === 'hunter'");
  const bubbleAt = s.indexOf('<SpeakerHeader');
  assert.ok(hunterAt > 0 && bubbleAt > hunterAt, 'the bubble path must remain below the hunter-line branch');
});

t('hunter styles are additive; .msg and .bubble stay unique', () => {
  const s = css();
  for (const cls of ['.beat-panel', '.beat-system', '.beat-line-hunter', '.beat-narration.hunter']) {
    assert.ok(s.includes(cls), cls);
  }
  assert.equal((s.match(/^\.bubble \{/gm) ?? []).length, 1);
  assert.equal((s.match(/^\.msg \{/gm) ?? []).length, 1);
});

t('the in-chat settings sheet does not call .trim on a nested hunter scene value', () => {
  const s = code('apps/web/src/pages/ChatPage.tsx');
  assert.match(s, /Object\.entries\(conv\.scene\)[\s\S]{0,80}typeof v === 'string'/);
});

console.log(`\n${passed} passed`);
