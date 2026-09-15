/**
 * npx tsx bench/characterExamplesOrder.test.ts
 * C16 example-pair order: move up/down + boundary no-op + C5 serialize round-trip.
 * Binds CharacterEditor helpers (not grep theater). No live HTTP / DB / deploy.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseExampleDialogue, serializeExamplePairs } from '../apps/web/src/lib/characterExamplePairs.ts';

const require2 = createRequire(import.meta.url);
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const editorPath = path.join(root, 'apps/web/src/components/CharacterEditor.tsx');
const editor = fs.readFileSync(editorPath, 'utf8');

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function sliceFn(src: string, startTok: string, endTok: string): string {
  const start = src.indexOf(startTok);
  assert.ok(start >= 0, `missing ${startTok}`);
  const end = src.indexOf(endTok, start + startTok.length);
  assert.ok(end > start, `missing ${endTok} after ${startTok}`);
  return src.slice(start, end);
}

type PairRow = { id: string; user: string; char: string };

function bindMove() {
  const helpersSrc = sliceFn(editor, 'function commitExampleRows', 'const setupIncomplete');
  assert.ok(helpersSrc.includes('function moveExamplePair'), 'moveExamplePair missing from CharacterEditor helpers');
  const wrapped = `
    export function bind(ctx) {
      const exampleRowsRef = ctx.exampleRowsRef;
      function setExampleRows(next) {
        ctx.rows.splice(0, ctx.rows.length, ...next);
        exampleRowsRef.current = ctx.rows;
      }
      function set(k, v) {
        if (k !== 'example_dialogue') throw new Error('unexpected set key ' + k);
        ctx.d.example_dialogue = v;
        ctx.setCalls.push({ k, v });
      }
      function createExampleRow(user, char) {
        return { id: 'created', user: user ?? '', char: char ?? '' };
      }
      const serializeExamplePairs = ctx.serializeExamplePairs;
      const FIELD_LIMITS = { example_dialogue: 20000 };
      function insertCharacterToken() { throw new Error('insertCharacterToken must not run in C16 bind'); }
      function applyTokenCaretRestore() {}
      function pairRefKey(rowId, side) { return rowId + ':' + side; }
      ${helpersSrc}
      return { commitExampleRows, moveExamplePair, addExamplePair, removeExamplePair };
    }
  `;
  const { transformSync } = require2('esbuild');
  const js = transformSync(wrapped, { loader: 'ts', format: 'cjs' }).code;
  const exported: { bind?: (ctx: unknown) => Record<string, unknown> } = {};
  const moduleObj = { exports: exported };
  new Function('exports', 'module', 'require', js)(exported, moduleObj, require2);
  const bind = exported.bind ?? (moduleObj.exports as { bind: typeof exported.bind }).bind;
  assert.equal(typeof bind, 'function');

  const rows: PairRow[] = [];
  const ctx = {
    rows,
    exampleRowsRef: { current: rows as PairRow[] },
    d: { example_dialogue: '' as string },
    setCalls: [] as Array<{ k: string; v: string }>,
    serializeExamplePairs,
  };
  const bound = bind!(ctx) as {
    commitExampleRows: (next: PairRow[]) => void;
    moveExamplePair: (rowId: string, direction: 'up' | 'down') => void;
  };
  return { bound, ctx };
}

function threePairs(): PairRow[] {
  return [
    { id: 'a', user: 'u1', char: 'c1' },
    { id: 'b', user: 'u2', char: 'c2' },
    { id: 'c', user: 'u3', char: 'c3' },
  ];
}

const ABC = '{{user}}: u1\n{{char}}: c1\n{{user}}: u2\n{{char}}: c2\n{{user}}: u3\n{{char}}: c3';
const BAC = '{{user}}: u2\n{{char}}: c2\n{{user}}: u1\n{{char}}: c1\n{{user}}: u3\n{{char}}: c3';
const ACB = '{{user}}: u1\n{{char}}: c1\n{{user}}: u3\n{{char}}: c3\n{{user}}: u2\n{{char}}: c2';

t('C16-1 move up of middle pair rewrites example_dialogue serialize order', () => {
  const { bound, ctx } = bindMove();
  bound.commitExampleRows(threePairs());
  assert.equal(ctx.d.example_dialogue, ABC);
  const callsBefore = ctx.setCalls.length;
  bound.moveExamplePair('b', 'up');
  assert.equal(ctx.d.example_dialogue, BAC);
  assert.equal(ctx.setCalls.length, callsBefore + 1);
  assert.equal(ctx.setCalls.at(-1)?.k, 'example_dialogue');
  assert.equal(ctx.setCalls.at(-1)?.v, BAC);
  assert.deepEqual(ctx.rows.map((r) => r.id), ['b', 'a', 'c']);
});

t('C16-2 move down of middle pair rewrites example_dialogue serialize order', () => {
  const { bound, ctx } = bindMove();
  bound.commitExampleRows(threePairs());
  bound.moveExamplePair('b', 'down');
  assert.equal(ctx.d.example_dialogue, ACB);
  assert.deepEqual(ctx.rows.map((r) => r.id), ['a', 'c', 'b']);
});

t('C16-3 first pair move up is a no-op (boundary)', () => {
  const { bound, ctx } = bindMove();
  bound.commitExampleRows(threePairs());
  const callsBefore = ctx.setCalls.length;
  bound.moveExamplePair('a', 'up');
  assert.equal(ctx.d.example_dialogue, ABC);
  assert.deepEqual(ctx.rows.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(ctx.setCalls.length, callsBefore);
});

t('C16-4 last pair move down is a no-op (boundary)', () => {
  const { bound, ctx } = bindMove();
  bound.commitExampleRows(threePairs());
  const callsBefore = ctx.setCalls.length;
  bound.moveExamplePair('c', 'down');
  assert.equal(ctx.d.example_dialogue, ABC);
  assert.deepEqual(ctx.rows.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(ctx.setCalls.length, callsBefore);
});

t('C16-5 single pair move up/down is a no-op', () => {
  const { bound, ctx } = bindMove();
  bound.commitExampleRows([{ id: 'only', user: 'u', char: 'c' }]);
  const one = '{{user}}: u\n{{char}}: c';
  assert.equal(ctx.d.example_dialogue, one);
  const callsBefore = ctx.setCalls.length;
  bound.moveExamplePair('only', 'up');
  bound.moveExamplePair('only', 'down');
  assert.equal(ctx.d.example_dialogue, one);
  assert.equal(ctx.setCalls.length, callsBefore);
  assert.deepEqual(ctx.rows.map((r) => r.id), ['only']);
});

t('C16-6 unknown rowId is a no-op', () => {
  const { bound, ctx } = bindMove();
  bound.commitExampleRows(threePairs());
  const callsBefore = ctx.setCalls.length;
  bound.moveExamplePair('missing', 'up');
  bound.moveExamplePair('missing', 'down');
  assert.equal(ctx.d.example_dialogue, ABC);
  assert.equal(ctx.setCalls.length, callsBefore);
});

t('C16-7 after reorder, parseExampleDialogue round-trips C5 bytes', () => {
  const { bound, ctx } = bindMove();
  bound.commitExampleRows(threePairs());
  bound.moveExamplePair('b', 'up');
  bound.moveExamplePair('c', 'up');
  const text = ctx.d.example_dialogue;
  const parsed = parseExampleDialogue(text);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(serializeExamplePairs(parsed.pairs), text);
  assert.equal(text.includes('<START>'), false);
  assert.deepEqual(parsed.pairs, [
    { user: 'u2', char: 'c2' },
    { user: 'u3', char: 'c3' },
    { user: 'u1', char: 'c1' },
  ]);
});

t('C16-8 move helper uses commitExampleRows / set, not setD, not sort', () => {
  const helpers = sliceFn(editor, 'function moveExamplePair', 'const setupIncomplete');
  assert.ok(helpers.includes('commitExampleRows('));
  assert.equal(helpers.includes('setD'), false);
  assert.equal(helpers.includes('sort('), false);
  assert.equal(helpers.includes('toSorted'), false);
});

t('C16-9 structured intro rows expose 위로/아래로 with first/last disabled', () => {
  const intro = sliceFn(editor, "tab === 'intro'", "tab === 'prompt'");
  const structured = sliceFn(intro, "exampleMode === 'raw'", 'FieldCount value={d.example_dialogue}');
  assert.ok(structured.includes('>위로</button>'));
  assert.ok(structured.includes('>아래로</button>'));
  assert.ok(structured.includes('moveExamplePair(row.id, \'up\')'));
  assert.ok(structured.includes('moveExamplePair(row.id, \'down\')'));
  assert.ok(structured.includes('disabled={i === 0}'));
  assert.ok(structured.includes('disabled={i === exampleRows.length - 1}'));
  assert.equal(structured.includes('key={i}'), false);
  assert.equal(structured.includes('key={index}'), false);
  assert.ok(structured.includes('key={row.id}'));
  for (const other of ["tab === 'setup'", "tab === 'prompt'", "tab === 'detail'", "tab === 'lore'"] as const) {
    const start = editor.indexOf(other);
    assert.ok(start >= 0, other);
  }
  const setup = sliceFn(editor, "tab === 'setup'", "tab === 'intro'");
  const prompt = sliceFn(editor, "tab === 'prompt'", "tab === 'detail'");
  const detail = sliceFn(editor, "tab === 'detail'", "tab === 'lore'");
  const lore = editor.slice(editor.indexOf("tab === 'lore'"));
  for (const section of [setup, prompt, detail, lore]) {
    assert.equal(section.includes('>위로</button>'), false);
    assert.equal(section.includes('>아래로</button>'), false);
  }
});

t('C16-10 TokenChips field= count stays 8', () => {
  assert.equal((editor.match(/<TokenChips field="/g) ?? []).length, 8);
});

t('C16-11 CharacterEditor.tsx has 0 as unknown', () => {
  assert.equal(editor.includes('as unknown'), false);
});

t('C16-12 apps/server and prompt truncateToTokens are untouched vs HEAD', () => {
  const serverDiff = execSync('git diff HEAD -- apps/server', { cwd: root, encoding: 'utf8' });
  assert.equal(serverDiff, '');
  const builderPath = path.join(root, 'apps/server/src/prompt/builder.ts');
  const builder = fs.readFileSync(builderPath, 'utf8');
  const head = execSync('git show HEAD:apps/server/src/prompt/builder.ts', { cwd: root, encoding: 'utf8' });
  assert.equal(builder, head);
  const tokensPath = path.join(root, 'apps/server/src/prompt/tokens.ts');
  const tokens = fs.readFileSync(tokensPath, 'utf8');
  const tokensHead = execSync('git show HEAD:apps/server/src/prompt/tokens.ts', { cwd: root, encoding: 'utf8' });
  assert.equal(tokens, tokensHead);
});

t('C16-13 raw fallback has no move buttons', () => {
  const rawBranch = sliceFn(editor, "exampleMode === 'raw'", ': (');
  assert.equal(rawBranch.includes('>위로</button>'), false);
  assert.equal(rawBranch.includes('>아래로</button>'), false);
  assert.equal(rawBranch.includes('moveExamplePair'), false);
});

console.log(`\n${passed} passed`);
