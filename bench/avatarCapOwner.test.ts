/**
 * npx tsx bench/avatarCapOwner.test.ts
 * S5 avatar-cap-owner — 서버가 canonical, 클라이언트 pre-check는 힌트.
 * Isolated: no systemd, no live DB, no model, no migration, no generate.
 * No shared pkg (apps/ = server + web): 웹이 서버 파일을 import하지 않고,
 * bench가 수치 동등 + hint 표기를 잠근다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
const { AVATAR_MAX_BYTES } = require2('../apps/server/src/media/avatar.ts');

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

t('1 server canonical is 8MB', () => {
  assert.equal(AVATAR_MAX_BYTES, 8 * 1024 * 1024);
});

t('2 avatar route derives limits from the canonical const', () => {
  const routes = read('apps/server/src/routes/characters.ts');
  assert.ok(routes.includes("from '../media/avatar.js'"));
  assert.ok(routes.includes('bodyLimit: AVATAR_MAX_BYTES'));
  assert.ok(routes.includes('inspectAvatar(buf)'));
});

t('3 web does not import the server file', () => {
  const editor = read('apps/web/src/components/CharacterEditor.tsx');
  assert.equal(/from '[^']*media\/avatar/.test(editor), false);
  assert.equal(/require\(['"][^'"]*media\/avatar/.test(editor), false);
});

t('4 client pre-check is marked hint-only', () => {
  const editor = read('apps/web/src/components/CharacterEditor.tsx');
  assert.match(editor, /hint-only; canonical: .*media\/avatar\.ts AVATAR_MAX_BYTES/);
});

t('5 client display text derives from its hint const, no hardcoded 8MB', () => {
  const editor = read('apps/web/src/components/CharacterEditor.tsx');
  assert.equal(editor.includes('8MB'), false);
  assert.equal(editor.includes('8 MB'), false);
});

t('6 server reject message is the canonical result shown to the user', () => {
  const editor = read('apps/web/src/components/CharacterEditor.tsx');
  assert.ok(editor.includes('ui.toast((err as Error).message'));
});

console.log(`passed ${passed}`);
