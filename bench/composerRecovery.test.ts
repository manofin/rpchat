/** node --import tsx bench/composerRecovery.test.ts
 * Execute the real ChatPage submit callback without rendering React or sending HTTP.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { expandLeadingShortcut, resolveShortcutSubmit, type Shortcut } from '../apps/web/src/lib/shortcutMacro';

const source = ts.createSourceFile('ChatPage.tsx', fs.readFileSync('apps/web/src/pages/ChatPage.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const submits: ts.FunctionDeclaration[] = [];
const draftChanges: ts.ArrowFunction[] = [];
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'submit') submits.push(node);
  if (ts.isJsxAttribute(node) && node.name.getText(source) === 'onChange' && node.initializer && ts.isJsxExpression(node.initializer)) {
    const expression = node.initializer.expression;
    if (expression && ts.isArrowFunction(expression) && expression.getText(source).includes('expandLeadingShortcut')) draftChanges.push(expression);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(submits.length, 1, 'execute the unique real submit implementation');
assert.equal(draftChanges.length, 1, 'execute the real composer expansion handler');
function compile(code: string) {
  return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}
const submitCode = compile(submits[0].getText(source));
const changeCode = compile(`const change = ${draftChanges[0].getText(source)};`);
const shortcuts: Shortcut[] = [
  { name: '일기', text: '이번 턴 일기를 써라.', mode: 'inject' },
  { name: '요약', text: '이야기를 요약해.', mode: 'insert' },
];
type Request = [string, { inject_instruction?: string } | undefined];
function composer(input: string, generating = false, ended_at: string | null = null) {
  let draft = input;
  const states: string[] = [];
  const requests: Request[] = [];
  let resolveSend!: (value: boolean | undefined) => void;
  let frames = 0;
  const stickyRef = { current: false };
  const setDraft = (value: string) => { draft = value; states.push(value); };
  const common = { resolveShortcutSubmit, expandLeadingShortcut, readShortcuts: () => shortcuts, setDraft };
  return {
    get draft() { return draft; }, states, requests, stickyRef,
    get frames() { return frames; },
    resolveSend: (value: boolean | undefined) => resolveSend(value),
    change(value: string) {
      const handler = new Function(...Object.keys(common), changeCode + '\nreturn change;')(...Object.values(common));
      handler({ target: { value } });
    },
    submit() {
      const deps = {
        ...common, draft, stickyRef, grow: () => {},
        requestAnimationFrame: () => { frames++; },
        chat: { generating, detail: { conversation: { ended_at } }, send: (...args: Request) => {
          requests.push(args);
          return new Promise<boolean | undefined>((resolve) => { resolveSend = resolve; });
        } },
      };
      const submit = new Function(...Object.keys(deps), submitCode + '\nreturn submit;')(...Object.values(deps));
      return submit() as Promise<void>;
    },
  };
}
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  console.log(`ok ${++passed} ${name}`);
}
async function main() {
  for (const [label, input, typeIntoComposer] of [
    ['inject alone', '/일기', false],
    ['inject with speech', '/일기 오늘 일을 정리해', false],
    ['inject whitespace', '  /일기  오늘 일\n둘째 줄  ', false],
    ['ordinary text', '  일반 발화\n둘째 줄  ', false],
    ['unmatched shortcut', '/미등록 추가 발화', false],
    ['insert at submit', '/요약', false],
    ['insert expanded onChange', '/요약 추가 발화', true],
    ['inject preserved onChange', '/일기 추가 발화', true],
  ] as const) {
    await test(`${label}: failed send restores exact draft and retry request`, async () => {
      const c = composer(input);
      if (typeIntoComposer) c.change(input);
      const original = c.draft;
      if (label === 'insert expanded onChange') assert.equal(original, '이야기를 요약해. 추가 발화');
      const resolved = resolveShortcutSubmit(original, shortcuts);
      const pending = c.submit();
      assert.equal(c.draft, '', 'clear composer while request is pending');
      assert.equal(c.stickyRef.current, true);
      assert.deepEqual(c.requests[0], [resolved.content.trim(), resolved.inject_instruction ? { inject_instruction: resolved.inject_instruction } : undefined]);
      c.resolveSend(false);
      await pending;
      assert.equal(c.draft, original, 'failure must restore the unparsed composer input');
      assert.equal(c.frames, 2, 'resize after clear and restore');
      const retry = c.submit();
      assert.deepEqual(c.requests[1], c.requests[0], 'retry preserves content and inject_instruction');
      c.resolveSend(true);
      await retry;
      assert.equal(c.draft, '');
    });
  }
  for (const result of [true, undefined]) {
    await test(`${String(result)} send result does not restore composer`, async () => {
      const c = composer('/일기 추가 발화');
      const pending = c.submit();
      c.resolveSend(result);
      await pending;
      assert.deepEqual(c.states, ['']);
      assert.equal(c.frames, 1);
    });
  }
  for (const [label, input, generating, ended_at] of [
    ['empty input', '  ', false, null],
    ['generation in progress', '/일기', true, null],
    ['ended conversation', '/일기', false, '2026-09-22'],
  ] as const) {
    await test(`${label}: no send or composer mutation`, async () => {
      const c = composer(input, generating, ended_at);
      await c.submit();
      assert.equal(c.draft, input);
      assert.deepEqual(c.requests, []);
      assert.deepEqual(c.states, []);
      assert.equal(c.frames, 0);
      assert.equal(c.stickyRef.current, false);
    });
  }
  console.log(`passed ${passed}`);
}
main().catch((error) => { console.error(error); process.exit(1); });
