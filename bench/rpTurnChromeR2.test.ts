/**
 * npx tsx bench/rpTurnChromeR2.test.ts
 * R2 — Turn chrome parity (Crack-play roadmap). Web display / timing only.
 * Isolated: no browser, no DB, no model, no network, no systemd.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleChoices } from '../apps/web/src/lib/choices.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
const chat = src('apps/web/src/pages/ChatPage.tsx');
const css = src('apps/web/src/app.css');
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

t('visibleChoices trims, drops empty/dupes, caps at 3, never invents copy', () => {
  assert.deepEqual(visibleChoices(['문을 연다', '창을 본다', '기다린다']), ['문을 연다', '창을 본다', '기다린다']);
  assert.deepEqual(visibleChoices(['  문을 연다  ', '', '문을 연다', '창을 본다', '네 번째']), ['문을 연다', '창을 본다', '네 번째']);
  assert.deepEqual(visibleChoices(['하나만', '둘', '셋', '넷']), ['하나만', '둘', '셋']);
  assert.deepEqual(visibleChoices(null), []);
  assert.deepEqual(visibleChoices(undefined), []);
  assert.deepEqual(visibleChoices(['', '   ']), []);
});

t('ChoiceChips consumes meta.choices through visibleChoices only', () => {
  assert.match(chat, /import\s*\{\s*visibleChoices\s*\}\s*from\s*['"]\.\.\/lib\/choices['"]/);
  assert.match(chat, /visibleChoices\(choices\)/);
  assert.doesNotMatch(chat, /choices\.slice\(0,\s*3\)/);
  assert.equal((chat.match(/m\.meta\.choices\.map\(/g) ?? []).length, 0);
});

t('generating: composer stays typable; send slot is stop; submit still latched', () => {
  const at = chat.indexOf('className={`composer');
  assert.ok(at >= 0, 'composer wrapper must exist');
  const composer = chat.slice(at, at + 1600);
  assert.ok(composer.includes('gen-status'), 'loading copy lives inside composer');
  assert.ok(composer.includes('<GenerationStatus progress={chat.generationProgress}'), 'main generation shows server progress');
  assert.ok(composer.includes('stop-gen'), 'stop occupies the send slot');
  assert.ok(composer.includes('aria-label="생성 중단"'));
  assert.ok(composer.includes('chat.stop'));
  assert.ok(!/textarea[\s\S]{0,400}disabled=\{chat\.generating\}/.test(composer), 'textarea must stay enabled while generating');
  assert.match(chat, /const generating = chat\.generating \|\| sideMode\.generating/);
  const file = ts.createSourceFile('ChatPage.tsx', chat, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const name of ['submit', 'onChoice']) {
    let body = '';
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) body = node.getText(file);
      if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) body = node.initializer!.getText(file);
      ts.forEachChild(node, visit);
    }
    visit(file);
    assert.ok(body, `${name} callback must exist`);
    const js = ts.transpileModule(`exports.callback = ${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const output: { callback?: (input?: string) => unknown } = {};
    new Function('exports', 'draft', 'generating', 'chat', js)(output, 'pending text', true, { detail: { conversation: { ended_at: null } } });
    // No side effects or extra dependencies are available: the busy guard must return first.
    const result = output.callback!('choice text');
    if (name === 'onChoice') assert.equal(result, undefined);
  }
  assert.match(chat, /if \(!generating\) submit\(\)/);
});

t('chips stay hidden while generating — stale suggestions cannot send', () => {
  assert.match(chat, /showTurnChoices = !!\([\s\S]*!generating\)/);
  assert.match(chat, /!props\.hideChoices && !props\.streaming && !props\.generating/);
});

t('pencil remains composer inject, not immediate send', () => {
  const edit = /const onEditChoice = \(c: string\) => \{[\s\S]*?\n  \};/.exec(chat)?.[0] ?? '';
  assert.ok(edit.includes('setDraft(c)'));
  assert.ok(!edit.includes('chat.send'));
  assert.match(chat, /aria-label="추천 답변 편집"/);
});

t('composer is one sticky unit on narrow viewports', () => {
  assert.match(cssCode, /\.composer\s*\{/);
  assert.match(cssCode, /\.chat-main \.composer\s*\{[^}]*position:\s*sticky/);
  assert.match(cssCode, /\.chip-edit\s*\{[^}]*min-width:\s*44px/);
  assert.match(cssCode, /\.chip-edit\s*\{[^}]*min-height:\s*44px/);
  assert.match(cssCode, /\.inputbar \.btn\.stop-gen\s*\{/);
});

t('R2 web files do not import server prompt or change useChat SSE', () => {
  assert.doesNotMatch(chat, /from ['"]\.\.\/\.\.\/server/);
  assert.doesNotMatch(src('apps/web/src/lib/choices.ts'), /buildPrompt|HARD_RULES|PROMPT_VERSION|applySceneDelta/);
  assert.doesNotMatch(src('apps/web/src/pages/useChat.ts'), /visibleChoices|stop-gen/);
});

console.log(`\n${passed} passed`);
