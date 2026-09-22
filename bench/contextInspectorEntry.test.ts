/** npx tsx bench/contextInspectorEntry.test.ts
 * P5-R1 minimal — labeled, stable Context Inspector entry in the chat header.
 * Source inventory only. Helper/bench PASS is not a product PASS.
 * No live HTTP / systemd / DB / commit / deploy / restart.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { resolveSceneAction } from '../apps/web/src/lib/sceneStatusCatalog.ts';

const require2 = createRequire(import.meta.url);
try {
  require2('../apps/web/src/pages/ChatPage.tsx');
} catch (e) {
  console.error('RED: ChatPage missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const ROOT = path.resolve('apps/web/src');
const chatSrc = fs.readFileSync(path.join(ROOT, 'pages/ChatPage.tsx'), 'utf8');
const drawerSrc = fs.readFileSync(path.join(ROOT, 'pages/ChatDrawer.tsx'), 'utf8');

t('CI-01 header entry is labeled and test-addressable, not a bare glyph', () => {
  assert.ok(chatSrc.includes('data-test="context-inspector"'), 'stable hook missing');
  assert.match(chatSrc, /data-test="context-inspector"[\s\S]{0,400}컨텍스트/, 'visible 컨텍스트 label missing on the entry');
  assert.ok(chatSrc.includes('aria-label="컨텍스트 인스펙터 열기"'), 'screen-reader label missing');
  assert.equal(chatSrc.includes('aria-label="컨텍스트/기억"'), false, 'old unlabeled glyph entry must be replaced, not duplicated');
});

t('CI-02 it opens the existing drawer on the budget tab', () => {
  assert.ok(chatSrc.includes("setDrawerTab('budget')"), 'must target the budget tab explicitly');
  assert.match(
    chatSrc,
    /data-test="context-inspector"[\s\S]{0,400}setDrawerTab\('budget'\)[\s\S]{0,80}setDrawer\(true\)/,
    'the entry itself must set the tab then open',
  );
  assert.ok(chatSrc.includes('initialTab={drawerTab}'), 'tab still travels through the existing prop');
});


t('CI-03b mobile tools hub links to the same inspector drawer', () => {
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'pages/ConversationTools.tsx'), 'utf8');
  assert.ok(chatSrc.includes('onOpenContextInspector'), 'ChatPage passes mobile CI opener into tools');
  assert.ok(toolsSrc.includes('data-test="tools-context-inspector"'), 'tools hub exposes a stable CI entry');
  assert.ok(toolsSrc.includes('onOpenContextInspector'), 'tools hub accepts the opener prop');
});

t('CI-03 no second inspector surface was added', () => {
  assert.equal((chatSrc.match(/<ChatDrawer/g) ?? []).length, 1, 'exactly one drawer');
  assert.equal((chatSrc.match(/BottomSheet/g) ?? []).length, 11, 'no new BottomSheet in ChatPage beyond the A11 ending sheet');
  assert.equal((chatSrc.match(/prompt-preview/g) ?? []).length, 0, 'ChatPage itself does not fetch prompt-preview; BudgetTab still does');
  assert.equal(chatSrc.includes('inject-preview'), false, 'story pre-start preview is a different surface');
});

function verifyOpeners(text: string) {
  const source = ts.createSourceFile('ChatPage.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const elements: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  const variables: ts.VariableDeclaration[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node);
    if (ts.isVariableDeclaration(node)) variables.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  function attribute(element: typeof elements[number], name: string) {
    return element.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(source) === name)?.initializer;
  }
  function callback(tag: string, prop: string, marker?: string, label?: string) {
    const matches = elements.filter((e) => e.tagName.getText(source) === tag &&
      (!marker || attribute(e, 'data-test')?.getText(source) === JSON.stringify(marker)) &&
      (!label || (ts.isJsxElement(e.parent) && e.parent.children.filter(ts.isJsxText).map((n) => n.text).join('').trim() === label)));
    assert.equal(matches.length, 1, `one ${tag} ${marker ?? ''}`);
    const init = attribute(matches[0], prop);
    assert.ok(init && ts.isJsxExpression(init) && init.expression, `${tag}.${prop} handler`);
    return init.expression.getText(source);
  }
  const calls: unknown[][] = [];
  const deps = {
    desktop: false, id: 'fixture-room', resolveSceneAction,
    setDrawerTab: (tab: unknown) => calls.push(['tab', tab]),
    setDrawer: (open: boolean) => calls.push(['drawer', open]),
    setToolsOpen: (open: boolean) => calls.push(['tools', open]),
    setSettings: (open: boolean) => calls.push(['settings', open]),
    navigate: (href: string) => calls.push(['navigate', href]),
    chat: { reload: () => calls.push(['reload']) },
  };
  function compile(expression: string, overrides = {}) {
    const args = { ...deps, ...overrides };
    const code = ts.transpileModule(`const handler = ${expression};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    return new Function(...Object.keys(args), `${code}\nreturn handler;`)(...Object.values(args));
  }
  compile(callback('button', 'onClick', 'context-inspector'))();
  assert.deepEqual(calls.splice(0), [['tab', 'budget'], ['drawer', true]]);
  const mobile = callback('ConversationTools', 'onOpenContextInspector');
  compile(mobile)();
  assert.deepEqual(calls.splice(0), [['tab', 'budget'], ['drawer', true], ['tools', false]]);
  assert.equal(compile(mobile, { desktop: true }), undefined, 'desktop uses the header entry');
  compile(callback('ConversationSettings', 'onOpenMemory'))();
  assert.deepEqual(calls.splice(0), [['settings', false], ['tab', undefined], ['drawer', true]]);
  compile(callback('button', 'onClick', undefined, '요약하기'))();
  assert.deepEqual(calls.splice(0), [['tab', 'summary'], ['drawer', true]]);
  const scene = variables.filter((v) => v.name.getText(source) === 'onSceneIntent');
  assert.equal(scene.length, 1);
  assert.ok(scene[0].initializer);
  const dispatch = compile(scene[0].initializer.getText(source));
  dispatch('open_context');
  assert.deepEqual(calls.splice(0), [['tab', 'budget'], ['drawer', true]]);
  dispatch('open_scene_state');
  dispatch('retry');
  assert.deepEqual(calls.splice(0), [['navigate', '/chat/fixture-room/settings/state'], ['reload']]);
}

t('CI-03c header, mobile tools, settings, summary and scene intents open their intended drawer tab', () => {
  verifyOpeners(chatSrc);
});

t('CI-03d wrong tab and closed drawer counterexamples fail the opener contract', () => {
  assert.throws(() => verifyOpeners(chatSrc.replaceAll("setDrawerTab('budget')", "setDrawerTab('summary')")), assert.AssertionError);
  assert.throws(() => verifyOpeners(chatSrc.replaceAll("setDrawerTab('summary')", "setDrawerTab('budget')")), assert.AssertionError);
  assert.throws(() => verifyOpeners(chatSrc.replaceAll('setDrawer(true)', 'setDrawer(false)')), assert.AssertionError);
});

t('CI-04 the drawer budget tab remains the inspector, untouched', () => {
  assert.ok(drawerSrc.includes("initialTab ?? 'budget'"), 'budget is still the default tab');
  assert.ok(drawerSrc.includes('>컨텍스트</button>'), 'drawer tab label unchanged');
  assert.ok(drawerSrc.includes('prompt-preview'), 'BudgetTab still reads the existing route');
  assert.ok(drawerSrc.includes('조립된 프롬프트 보기'), 'raw prompt view unchanged');
});

console.log(`passed ${passed}`);
