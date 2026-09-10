/** npx tsx bench/storyOpeningsEditor.test.ts
 * ADR-F8f Slice 2 (story-multi-opening-slice2-editor): StoryEditor default + extras CRUD.
 * Source inventory only. Helper/bench PASS is not a product PASS.
 * No live HTTP / systemd / DB / commit / deploy / restart.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
try {
  require2('../apps/web/src/components/StoryEditor.tsx');
} catch (e) {
  console.error('RED: StoryEditor missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const ROOT = path.resolve('apps/web/src');
const editorSrc = fs.readFileSync(path.join(ROOT, 'components/StoryEditor.tsx'), 'utf8');
const typesSrc = fs.readFileSync(path.join(ROOT, 'types.ts'), 'utf8');

t('types expose StoryOpeningExtra and Story.openings_extra (wire, not column)', () => {
  assert.ok(typesSrc.includes('export interface StoryOpeningExtra'));
  assert.ok(typesSrc.includes('opening_json: string'));
  assert.match(typesSrc, /export interface Story[\s\S]*openings_extra:\s*StoryOpeningExtra\[\]/);
  assert.equal(typesSrc.includes('openings_extra_json'), true, 'column name documented on the type');
});

t('StoryEditor loads extras and PUT-sends openings_extra array with opening_json string', () => {
  assert.ok(editorSrc.includes('openings_extra'));
  assert.ok(editorSrc.includes('story.openings_extra'));
  assert.match(editorSrc, /openings_extra:\s*[^\n]*extras/);
  assert.ok(editorSrc.includes('opening_json'));
  assert.ok(editorSrc.includes('JSON.stringify'));
  assert.equal(editorSrc.includes('openings_extra_json:'), false, 'PUT key is openings_extra, not the column');
});

t('default opening fields stay; no default-delete control', () => {
  assert.ok(editorSrc.includes('openingBody'));
  assert.ok(editorSrc.includes('오프닝'));
  assert.ok(editorSrc.includes('시작 설정 (시나리오)'));
  assert.ok(editorSrc.includes('첫 대사'));
  assert.equal(editorSrc.includes('이 오프닝 빼기'), false);
  assert.equal(editorSrc.includes('기본 삭제'), false);
});

t('extras CRUD: id, label, F8d fields; cap 7; 8th add refused', () => {
  assert.ok(editorSrc.includes('OPENING_EXTRA_MAX'));
  assert.ok(editorSrc.includes('OPENING_EXTRA_MAX = 7') || editorSrc.includes('OPENING_EXTRA_MAX=7'));
  assert.ok(editorSrc.includes('extras.length < OPENING_EXTRA_MAX'));
  assert.ok(editorSrc.includes('이 시작 빼기'));
  assert.ok(editorSrc.includes('＋ 시작 설정 추가'));
  assert.ok(editorSrc.includes('label'));
  assert.match(editorSrc, /extra\.(id|label)|e\.id|x\.id/);
  assert.ok(editorSrc.includes('present_ids'));
});

t('editor does not POST conversations; start-sheet owns openingId', () => {
  assert.equal(editorSrc.includes('/api/conversations'), false);
});

t('generate-path and pipeline files stay untouched', () => {
  const root = path.resolve('.');
  const changed = execSync(
    'git diff --name-only HEAD -- apps/server/src/prompt/storyOpening.ts apps/server/src/prompt/applySceneDelta.ts apps/server/src/prompt/composeBeat.ts apps/server/src/prompt/resolveFocus.ts apps/server/src/prompt/builder.ts apps/server/src/prompt/templates.ts apps/server/src/config.ts',
    { cwd: root, encoding: 'utf8' },
  ).trim();
  assert.equal(changed, '', `editor bench must not dirty pipeline: ${changed}`);
  const chatDiff = execSync('git diff HEAD -- apps/server/src/routes/chat.ts', { cwd: root, encoding: 'utf8' });
  for (const line of chatDiff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) assert.ok(line.includes('ended_at') || line.includes('already ended') || line.includes('fireEndingEvalJob') || line.includes('endingJudge') || line.includes('Slice 3'), `chat.ts guard-only (+F8h slice-3 eval hook): ${line}`);
  }
  assert.equal(/from ['"][^'"]*applySceneDelta/.test(editorSrc), false);
  assert.equal(/from ['"][^'"]*storyOpening/.test(editorSrc), false);
});

console.log(`passed ${passed}`);
