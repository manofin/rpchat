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

t('sheet column: only .sheet-body absorbs the overflow, handle and tabs never shrink', () => {
  // .tabs 는 overflow-x:auto 라 min-height:auto 가 0 으로 풀린다. flex-shrink 기본값(1)이
  // 남아 있으면 내용이 긴 탭(요약)에서 탭 줄까지 눌려 탭이 잘리고 탭이 안 눌린다.
  const rule = (sel: string) => {
    const m = css.match(new RegExp(`\\${sel} \\{[^}]+\\}`));
    assert.ok(m, `${sel} rule missing`);
    return m![0];
  };
  assert.match(rule('.sheet .handle'), /flex:\s*0 0 auto/);
  assert.match(rule('.sheet .tabs'), /flex:\s*0 0 auto/);
  const body = rule('.sheet .sheet-body');
  assert.match(body, /flex:\s*1 1 auto/);
  assert.match(body, /min-height:\s*0/);
  assert.match(body, /overflow-y:\s*auto/);
});

t('Modal override also uses --app-height, not 94%', () => {
  assert.match(ui, /maxHeight: 'calc\(var\(--app-height\) \* 0\.94\)'/);
  assert.equal(ui.includes("maxHeight: '94%'"), false);
});

console.log(`\n${passed} passed`);
