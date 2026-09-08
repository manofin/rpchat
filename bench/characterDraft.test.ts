/**
 * npx tsx bench/characterDraft.test.ts
 * S2 draft-type-boundary — CharacterEditor Draft 강제 캐스트 제거.
 * Isolated: no systemd, no live DB, no model, no migration, no generate.
 * Runtime-identical: EMPTY.tags stays DEFAULT_TAGS (S3에서 변경).
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
const src = fs.readFileSync(
  path.join(dir, '..', 'apps/web/src/components/CharacterEditor.tsx'),
  'utf8',
);

t('1 no as unknown as Draft', () => {
  assert.equal(src.includes('as unknown as Draft'), false);
});

t('2 no new forced casts in the editor', () => {
  assert.equal(src.includes('as unknown'), false);
});

t('3 EMPTY runtime unchanged: tags still DEFAULT_TAGS', () => {
  assert.match(src, /tags: DEFAULT_TAGS,/);
});

t('4 Draft stays a plain Omit of Character', () => {
  assert.match(
    src,
    /type Draft = Omit<Character, 'id' \| 'created_at' \| 'updated_at' \| 'archived' \| 'conversation_count' \| 'last_chat_at'>;/,
  );
});

t('5 save still sends the whole draft', () => {
  assert.ok(src.includes('await put<Character>(`/api/characters/${character.id}`, d)'));
  assert.ok(src.includes("await post<Character>('/api/characters', d)"));
});

console.log(`passed ${passed}`);
