/**
 * npx tsx bench/sceneStatusPanelCatalog.test.ts
 * Scene Status Panel catalog v0 — registry, uiState fixtures, placement, BeatUi freeze.
 * Isolated: no live DB, no generate, no apps/server writes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CATALOG_TYPES,
  parseSceneStatusSpec,
  resolveSceneAction,
  UI_STATES,
} from '../apps/web/src/lib/sceneStatusCatalog.ts';
import { buildSceneStatusSpec } from '../apps/web/src/lib/sceneStatusSpec.ts';
import { SCENE_STATUS_REGISTRY } from '../apps/web/src/components/sceneStatus/registry.ts';
import { SceneStatusRenderer } from '../apps/web/src/components/sceneStatus/SceneStatusRenderer.tsx';
import { SceneStatusPanel } from '../apps/web/src/components/sceneStatus/SceneStatusPanel.tsx';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
const fixtureDir = path.join(appRoot, 'apps/web/src/components/sceneStatus/fixtures');

t('registry has the six catalog types', () => {
  assert.deepEqual(Object.keys(SCENE_STATUS_REGISTRY).sort(), [...CATALOG_TYPES].sort());
});

t('uiState fixtures parse and render', () => {
  for (const state of UI_STATES) {
    const raw = fs.readFileSync(path.join(fixtureDir, `${state}.json`), 'utf8');
    const spec = parseSceneStatusSpec(JSON.parse(raw));
    assert.ok(spec, `${state} spec`);
    assert.equal(spec!.elements[spec!.root].props.uiState, state);
    const html = renderToStaticMarkup(createElement(SceneStatusRenderer, { spec: spec! }));
    assert.match(html, /data-catalog-type="SceneStatus"/);
    assert.match(html, new RegExp(`data-ui-state="${state}"`));
    if (state === 'empty' || state === 'loading') assert.match(html, /data-catalog-type="EmptyHint"/);
    if (state === 'error') assert.match(html, /data-catalog-type="AlertInline"/);
    if (state === 'disabled') assert.match(html, /disabled/);
  }
});

t('unknown type is skipped with a warning; extra props stripped; enum falls back', () => {
  const warnings: string[] = [];
  const spec = parseSceneStatusSpec({
    root: 'scene',
    elements: {
      scene: {
        type: 'SceneStatus',
        props: { title: '항구', progress: 'nope', uiState: 'wat', gold: true },
        children: ['ghost', 'loc'],
      },
      ghost: { type: 'NotACatalogType', props: {}, children: [] },
      loc: { type: 'LocationPill', props: { name: '부두', traversable: true, extra: 1 }, children: [] },
    },
  }, (m) => warnings.push(m));
  assert.ok(spec);
  assert.equal(spec!.elements.ghost, undefined);
  assert.ok(warnings.some((w) => w.includes('NotACatalogType')));
  assert.equal(spec!.elements.scene.props.progress, 'idle');
  assert.equal(spec!.elements.scene.props.uiState, 'default');
  assert.equal(spec!.elements.scene.props.gold, undefined);
  assert.deepEqual(spec!.elements.scene.children, ['loc']);
  assert.equal(spec!.elements.loc.props.extra, undefined);
  assert.equal(spec!.elements.loc.props.place, undefined);
  assert.equal(spec!.elements.loc.props.name, '부두');
  assert.equal(spec!.elements.loc.props.traversable, true);
});

t('SceneAction intents map to existing routes', () => {
  const id = 'conv-1';
  assert.deepEqual(resolveSceneAction('open_scene_info', id), { kind: 'navigate', href: '/chat/conv-1/settings' });
  assert.deepEqual(resolveSceneAction('open_scene_state', id), { kind: 'navigate', href: '/chat/conv-1/settings/state' });
  assert.deepEqual(resolveSceneAction('open_context', id), { kind: 'open_context' });
  assert.deepEqual(resolveSceneAction('retry', id), { kind: 'retry' });
  const chat = src('apps/web/src/pages/ChatPage.tsx');
  assert.match(chat, /resolveSceneAction/);
  const catalog = src('apps/web/src/lib/sceneStatusCatalog.ts');
  assert.match(catalog, /\/settings\/state/);
  const settings = src('apps/web/src/lib/conversationSettings.ts');
  assert.match(settings, /leaf\('state'\)/);
});

t('desktop rail and mobile fold placement in ChatPage + CSS', () => {
  const chat = src('apps/web/src/pages/ChatPage.tsx');
  assert.match(chat, /placement="desktop"/);
  assert.match(chat, /placement="mobile"/);
  assert.match(chat, /OverlayDrawer/);
  const css = src('apps/web/src/app.css');
  assert.match(css, /\.scene-status-panel/);
  assert.match(css, /border-left:\s*3px solid var\(--kami-ink\)/);
  assert.match(css, /max-height:\s*35vh/);
  assert.match(css, /\.scene-status\[data-progress=/);
  assert.match(css, /\.scene-status-summary[\s\S]*-webkit-line-clamp:\s*2/);
  assert.match(css, /\.scene-location-pill \{/);
  assert.match(css, /\.scene-action \{[\s\S]*min-height:\s*44px/);
  assert.match(css, /\.scene-action:focus-visible \{[\s\S]*--role-coral/);
  assert.doesNotMatch(css.replace(/\.beat-ui-panel[\s\S]*?}/, ''), /\.scene-status-panel[\s\S]*--role-gold/);
  const panelBlock = css.slice(css.indexOf('.scene-status-panel'));
  assert.ok(!panelBlock.includes('--role-gold'));
  assert.match(css, /\.chat-rail-right \{[\s\S]*flex-basis: 300px/);
  assert.match(css, /\.chat-rail-right \{[\s\S]*flex-basis: 280px/);
});

t('CastRow does not duplicate BeatUi roster when hasBeatRoster', () => {
  const spec = buildSceneStatusSpec({
    conversationId: 'c1',
    scene: { place: '항구', location: '부두' },
    characterName: '카이',
    hasBeatRoster: true,
    focusId: 'kai',
  });
  const cast = Object.values(spec.elements).find((el) => el.type === 'CastRow');
  assert.ok(cast);
  const members = cast!.props.members as Array<{ id: string; active?: boolean }>;
  assert.equal(members.length, 1);
  assert.equal(members[0].active, true);
});

t('BeatUi / PartyBlockView / ChoiceChips files are untouched vs BASE', () => {
  const { execSync } = require('node:child_process') as typeof import('node:child_process');
  const benchSrc = src('bench/sceneStatusPanelCatalog.test.ts');
  assert.match(benchSrc, /git diff origin\/master\.\.\.HEAD --/);
  assert.doesNotMatch(benchSrc, /git diff origin\/master --/);
  const out = execSync(
    'git diff origin/master...HEAD -- apps/web/src/components/view.tsx apps/server apps/web/src/pages/ChatPage.tsx',
    { cwd: appRoot, encoding: 'utf8' },
  );
  assert.doesNotMatch(out, /function ChoiceChips/);
  assert.doesNotMatch(out, /export function BeatUiPanel/);
  assert.doesNotMatch(out, /export function PartyBlockView/);
  const viewDiff = execSync('git diff origin/master...HEAD -- apps/web/src/components/view.tsx apps/server', {
    cwd: appRoot,
    encoding: 'utf8',
  });
  assert.equal(viewDiff, '');
  const chat = src('apps/web/src/pages/ChatPage.tsx');
  assert.match(chat, /function ChoiceChips/);
  assert.match(chat, /<BeatUiPanel /);
  assert.match(chat, /PartyBlockView/);
  const panelDir = src('apps/web/src/components/sceneStatus/SceneStatusPanel.tsx')
    + src('apps/web/src/components/sceneStatus/CastRow.tsx')
    + src('apps/web/src/lib/sceneStatusCatalog.ts');
  assert.doesNotMatch(panelDir, /BeatUiPanel|ChoiceChips|PartyBlockView/);
  const pkg = src('apps/web/package.json');
  assert.doesNotMatch(pkg, /shadcn|json-render/);
});

t('panel shell markup + no apps/server scene-status files', () => {
  const html = renderToStaticMarkup(createElement(SceneStatusPanel, {
    conversationId: 'c1',
    scene: { place: '항구 창고', location: '제3부두', goal: '밀수 화물을 확인한다' },
    characterName: '카이',
    hasBeatRoster: false,
    placement: 'desktop',
  }));
  assert.match(html, /data-test="scene-status-panel"/);
  assert.match(html, /class="scene-status-panel/);
  const serverHits = fs.readdirSync(path.join(appRoot, 'apps/server/src'), { recursive: true, encoding: 'utf8' })
    .filter((f) => String(f).includes('sceneStatus') || String(f).includes('scene-status'));
  assert.deepEqual(serverHits, []);
});

console.log(`passed ${passed}`);
