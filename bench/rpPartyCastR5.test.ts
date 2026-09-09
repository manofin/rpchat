/**
 * npx tsx bench/rpPartyCastR5.test.ts
 * R5 — Multi-speaker party UX. Display only + ui.focus_id stamp.
 * Isolated: no live DB, no generate, no 1:1 prompt rewrite.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCK_CHIP, renderUi } from '../apps/server/src/prompt/renderBeat.ts';
import { renderScene } from '../apps/server/src/prompt/templates.ts';
import type { Scene } from '../apps/server/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
const css = src('apps/web/src/app.css').replace(/\/\*[\s\S]*?\*\//g, '');

t('renderUi stamps focus_id; locked rows keep the lock chip', () => {
  const scene: Scene = { present_ids: ['yuki', 'chen'], roster: { yuki: { emotion: '🙂' } } };
  const ui = renderUi({
    scene,
    cast: [
      { id: 'yuki', name: '유키' },
      { id: 'chen', name: '첸', locked: true },
    ],
    focus_id: 'yuki',
  });
  assert.equal(ui.focus_id, 'yuki');
  assert.equal(ui.roster.find((r) => r.id === 'yuki')!.locked, false);
  assert.equal(ui.roster.find((r) => r.id === 'chen')!.locked, true);
  assert.equal(ui.roster.find((r) => r.id === 'chen')!.chip, LOCK_CHIP);
  assert.equal(LOCK_CHIP, '🔒');
});

t('BeatUiPanel names lock and focus in the same language as the chip', () => {
  const view = src('apps/web/src/components/view.tsx');
  assert.match(view, /잠금/);
  assert.match(view, /포커스/);
  assert.match(view, /beat-chip-tag/);
  assert.match(view, /is-focus/);
  assert.match(view, /focused \? ' is-focus'/);
});

t('ChatPage wires last_beat.focus_id and keeps a sticky cast strip outside the scroller', () => {
  const page = src('apps/web/src/pages/ChatPage.tsx');
  assert.match(page, /focusId: conv\.scene\.last_beat\?\.focus_id/);
  assert.match(page, /className="cast-status"/);
  assert.match(page, /block_kind === 'ui'/);
  assert.match(page, /SpeakerHeader/);
  assert.match(page, /focused=\{lineFocus\}/);
  const scrollAt = page.indexOf('className="chat-scroll"');
  const castAt = page.indexOf('className="cast-status"');
  assert.ok(castAt >= 0 && scrollAt > castAt, 'cast strip must sit above the scroller so it survives scroll');
});

t('CSS: lock is dashed not faded; focus is ink, not a per-speaker role color', () => {
  assert.match(css, /\.beat-chip\.locked\s*\{[^}]*border-style:\s*dashed/);
  assert.doesNotMatch(css, /\.beat-chip\.locked\s*\{[^}]*opacity:\s*0\.5/);
  assert.match(css, /\.beat-chip\.is-focus\s*\{[^}]*border-color:\s*var\(--kami-ink\)/);
  assert.match(css, /\.cast-status\s*\{/);
  assert.match(css, /\.speaker-header\s*\{[^}]*display:\s*flex/);
  const info = /\.beat-info\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
  const panel = /\.beat-panel\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.ok(info.includes('border-left'));
  assert.ok(panel.includes('border-left'));
  assert.ok(!/--role-/.test(info));
  assert.ok(!/--role-/.test(panel));
});

t('1:1 bubbles and renderScene stay off this slice', () => {
  const gold = '### 현재 장면 (정본. 없는 항목을 창작하지 말 것)\n장소: 항구\n시간: 밤';
  assert.equal(renderScene({ place: '항구', time: '밤' }), gold);
  const page = src('apps/web/src/pages/ChatPage.tsx');
  assert.match(page, /kind && kind !== 'line'/);
  assert.doesNotMatch(src('apps/web/src/pages/useChat.ts'), /last_beat|cast-status/);
  assert.doesNotMatch(src('apps/server/src/prompt/builder.ts'), /focus_id/);
  assert.doesNotMatch(src('apps/server/src/prompt/templates.ts'), /LOCK_CHIP|cast-status/);
});

console.log(`\n${passed} passed`);
