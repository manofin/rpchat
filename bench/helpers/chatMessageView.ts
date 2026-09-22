import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { MessageEvents } from '../../apps/web/src/components/EventRenderer.tsx';
import { SpeakerHeader, renderContent } from '../../apps/web/src/components/view.tsx';
import { isEmptyUserMessage } from '../../apps/web/src/lib/chatLayout.ts';
import { hasEventContract } from '../../apps/web/src/lib/chatEvents.ts';
import { visibleChoices } from '../../apps/web/src/lib/choices.ts';
import type { Message } from '../../apps/web/src/types.ts';

// Execute the shipped functions without mounting the page's network effects.
const source = ts.createSourceFile('ChatPage.tsx', readFileSync(new URL('../../apps/web/src/pages/ChatPage.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = ['MessageView', 'ChoiceChips'].map((name) => {
  const matches = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `one production ${name} function`);
  return matches[0].getText(source);
});
const compiled = ts.transpileModule(functions.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;
const deps = { React, useState: React.useState, useRef: React.useRef, MessageEvents, SpeakerHeader, renderContent, isEmptyUserMessage, hasEventContract, visibleChoices };
type ChoiceProps = { choices: string[]; onChoice: (text: string) => void; onEdit: (text: string) => void; disabled: boolean };
type ViewOptions = Partial<{
  streaming: boolean; generating: boolean; isLastAssistant: boolean; hideChoices: boolean;
  focusId: string | null; sceneFormat: 'beat' | 'dialog';
}>;
const views = new Function(...Object.keys(deps), `${compiled}\nreturn { MessageView, ChoiceChips };`)(...Object.values(deps)) as {
  MessageView: React.ComponentType<Record<string, unknown>>;
  ChoiceChips: (props: ChoiceProps) => React.ReactElement | null;
};
export const choiceChips = views.ChoiceChips;

export function renderChatMessage(m: Message, options: ViewOptions = {}): string {
  const noop = () => {};
  return renderToStaticMarkup(React.createElement(views.MessageView, {
    m, charName: 'fallback must not replace actor', userName: '나', sceneFormat: 'beat',
    streaming: false, generating: false, isLastAssistant: true,
    onRegenerate: noop, onSwipeLeft: noop, onSwipeRight: noop, onEdit: noop,
    onBranchEdit: noop, onDelete: noop, onBookmark: noop, onChoice: noop, onEditChoice: noop,
    ...options,
  }));
}
