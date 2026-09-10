/** npx tsx bench/storyEndingsEditor.test.ts
 * ADR-F8g Slice 2 (story-endings-slice2-editor): StoryEditor endings tab CRUD.
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
const pageSrc = fs.readFileSync(path.join(ROOT, 'pages/StoryPage.tsx'), 'utf8');

t('types expose StoryEnding and Story.endings (wire, not column)', () => {
  assert.ok(typesSrc.includes('export interface StoryEnding'));
  assert.match(typesSrc, /export interface StoryEnding[\s\S]*id:\s*string[\s\S]*title:\s*string[\s\S]*description:\s*string[\s\S]*badge_label:\s*string/);
  assert.match(typesSrc, /export interface Story[\s\S]*endings:\s*StoryEnding\[\]/);
  assert.equal(typesSrc.includes('endings_json:'), false, 'PUT key is endings, not the column');
});

t('StoryEditor has an endings tab loading story.endings and PUT-sending endings', () => {
  assert.ok(editorSrc.includes("'endings'"));
  assert.ok(editorSrc.includes('엔딩'));
  assert.ok(editorSrc.includes('story.endings'));
  assert.match(editorSrc, /endings:\s*[^\\n]*endings/);
  assert.equal(editorSrc.includes('endings_json:'), false, 'PUT key is endings, not the column');
});

t('endings CRUD: id, title, description, badge_label; cap 7; 8th add refused', () => {
  assert.ok(editorSrc.includes('ENDINGS_MAX'));
  assert.ok(editorSrc.includes('ENDINGS_MAX = 7') || editorSrc.includes('ENDINGS_MAX=7'));
  assert.ok(editorSrc.includes('endings.length < ENDINGS_MAX'));
  assert.ok(editorSrc.includes('이 엔딩 빼기'));
  assert.ok(editorSrc.includes('＋ 엔딩 추가'));
  assert.ok(editorSrc.includes('badge_label'));
  assert.ok(editorSrc.includes('description'));
});

t('Slice 3 reader runtime stays out: no endings on StoryPage, no reach action in editor', () => {
  assert.equal(pageSrc.includes('endings'), false);
  assert.equal(editorSrc.includes('/api/conversations'), false);
  assert.equal(editorSrc.includes('ended_at'), false);
  assert.equal(editorSrc.includes('reached_ending_id'), false);
});

t('generate-path and pipeline files stay untouched', () => {
  const root = path.resolve('.');
  const changed = execSync(
    'git diff --name-only HEAD -- apps/server/src/prompt/storyOpening.ts apps/server/src/prompt/applySceneDelta.ts apps/server/src/prompt/composeBeat.ts apps/server/src/routes/chat.ts apps/server/src/prompt/resolveFocus.ts apps/server/src/prompt/builder.ts apps/server/src/prompt/templates.ts apps/server/src/config.ts',
    { cwd: root, encoding: 'utf8' },
  ).trim();
  assert.equal(changed, '', `editor bench must not dirty pipeline: ${changed}`);
  assert.equal(/from ['"][^'"]*applySceneDelta/.test(editorSrc), false);
  assert.equal(/from ['"][^'"]*storyOpening/.test(editorSrc), false);
});

console.log(`passed ${passed}`);
