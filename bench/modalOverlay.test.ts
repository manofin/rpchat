/** Editor controls cover app navigation; ordinary sheets and confirmation ordering stay intact. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import postcss from 'postcss';
import ts from 'typescript';
import { Modal, BottomSheet } from '../apps/web/src/components/ui.tsx';
import { nodes, one, classIs, button } from './helpers/storyUiHarness.ts';

const css = postcss.parse(fs.readFileSync('apps/web/src/app.css', 'utf8'));
function layer(classes: string): number {
  const own = new Set(classes.split(' '));
  let z: number | undefined;
  css.walkRules((rule) => {
    if (!rule.selectors.some((selector) => /^\.[\w-]+$/.test(selector) && own.has(selector.slice(1)))) return;
    rule.walkDecls('z-index', (decl) => { z = Number(decl.value); });
  });
  assert.ok(Number.isFinite(z), `explicit stacking order for ${classes}`);
  return z!;
}
const source = ts.createSourceFile('ui.tsx', fs.readFileSync('apps/web/src/components/ui.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function confirmationLayers(): { backdrop: number; card: number } {
  const provider = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'UiProvider');
  assert.ok(provider);
  const result: Record<string, number> = {};
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const className = attrs.find((a) => a.name.getText(source) === 'className')?.initializer;
      const style = attrs.find((a) => a.name.getText(source) === 'style')?.initializer;
      if (className && ts.isStringLiteral(className) && style && ts.isJsxExpression(style) && style.expression && ts.isObjectLiteralExpression(style.expression)) {
        const z = style.expression.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === 'zIndex');
        if (z && ts.isPropertyAssignment(z) && ts.isNumericLiteral(z.initializer)) result[className.text] = Number(z.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(provider);
  assert.ok(Number.isFinite(result['sheet-backdrop']) && Number.isFinite(result.card));
  return { backdrop: result['sheet-backdrop'], card: result.card };
}
let closes = 0, saves = 0;
const tree = Modal({ open: true, title: '스토리 편집', onClose: () => closes++, children: '설정', footer: React.createElement(React.Fragment, null,
  React.createElement('button', { onClick: () => closes++ }, '취소'), React.createElement('button', { onClick: () => saves++ }, '저장')) });
const backdrop = one(tree, classIs('editor-backdrop'));
const editor = one(tree, classIs('editor-sheet'));
assert.equal(editor.props.role, 'dialog'); assert.equal(editor.props['aria-modal'], 'true');
assert.ok(nodes(editor).some(button('취소'))); assert.ok(nodes(editor).some(button('저장')));
const navZ = layer('app-bottom-nav'), backdropZ = layer(backdrop.props.className), editorZ = layer(editor.props.className), confirm = confirmationLayers();
assert.ok(navZ < backdropZ && backdropZ < editorZ && editorZ < confirm.backdrop && confirm.backdrop < confirm.card,
  `required nav < editor backdrop < editor < confirmation backdrop < confirmation: ${[navZ, backdropZ, editorZ, confirm.backdrop, confirm.card]}`);
console.log('ok 1 actual editor backdrop and dialog cover navigation but stay below confirmation');
one(editor, button('취소')).props.onClick(); one(editor, button('저장')).props.onClick(); backdrop.props.onClick();
assert.equal(closes, 2); assert.equal(saves, 1);
assert.equal(Modal({ open: false, title: '', onClose() {}, children: null }), null);
console.log('ok 2 editor retains close, backdrop and Save callbacks and hides when closed');
const ordinary = renderToStaticMarkup(React.createElement(BottomSheet, { open: true, onClose() {}, children: '대화 선택' }));
assert.match(ordinary, /class="sheet-backdrop"/); assert.match(ordinary, /class="sheet"/); assert.doesNotMatch(ordinary, /editor-backdrop|editor-sheet/);
assert.ok(layer('sheet-backdrop') < layer('sheet') && layer('sheet') < navZ, 'ordinary conversation-sheet layering is unchanged');
console.log('ok 3 ordinary BottomSheet is not promoted into the editor layer');
