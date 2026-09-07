/**
 * npx tsx bench/characterEditorSheet.test.ts
 * CharacterEditor save footer must stay reachable: tabs are `.tabs` inside
 * the Modal `.sheet`, never a nested `.sheet` (that class is position:fixed
 * + opaque background and paints over 저장). Height uses --app-height, not
 * layout-viewport %. Source inventory only. No live HTTP / DB / deploy.
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
const editor = fs.readFileSync(path.join(dir, '..', 'apps/web/src/components/CharacterEditor.tsx'), 'utf8');
const ui = fs.readFileSync(path.join(dir, '..', 'apps/web/src/components/ui.tsx'), 'utf8');
const css = fs.readFileSync(path.join(dir, '..', 'apps/web/src/app.css'), 'utf8');

t('tabs are className="tabs", not a nested .sheet', () => {
  assert.equal(editor.includes('className="sheet tabs"'), false);
  assert.equal(editor.includes("className='sheet tabs'"), false);
  assert.match(editor, /toolbar=\{\s*<div className="tabs"/);
});

t('footer still has 저장 and 취소', () => {
  assert.match(editor, /footer=\{<>.*취소.*저장/);
});

t('Modal sheet-body keeps minHeight 0 so the footer stays in the flex column', () => {
  assert.match(ui, /className="sheet-body" style=\{\{ flex: 1, minHeight: 0 \}\}/);
});

t('.sheet max-height follows --app-height and clips overflow', () => {
  const sheet = css.match(/\.sheet \{[^}]+\}/);
  assert.ok(sheet, '.sheet rule missing');
  assert.match(sheet![0], /max-height:\s*calc\(var\(--app-height\)\s*\*\s*0\.86\)/);
  assert.match(sheet![0], /overflow:\s*hidden/);
  assert.equal(sheet![0].includes('max-height: 86%'), false);
});

t('Modal override also uses --app-height, not 94%', () => {
  assert.match(ui, /maxHeight: 'calc\(var\(--app-height\) \* 0\.94\)'/);
  assert.equal(ui.includes("maxHeight: '94%'"), false);
});

console.log(`\n${passed} passed`);
