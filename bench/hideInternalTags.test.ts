/**
 * npx tsx bench/hideInternalTags.test.ts
 * hide-internal-tags — party: tags hidden on public surfaces; editor/API keep them.
 *
 * Pure: helper unit + source asserts. No DB, no fetch, no model, no hermes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
let pub: typeof import('../apps/web/src/lib/publicTags.ts');
try {
  pub = require2('../apps/web/src/lib/publicTags.ts');
} catch (e) {
  console.error('RED: publicTags helper missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const { INTERNAL_TAG_PREFIXES, isPublicTag, publicTags } = pub;

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

t('1 isPublicTag: party:role=… is internal; genre tags stay public', () => {
  assert.equal(isPublicTag('party:role=secondary'), false);
  assert.equal(isPublicTag('party:duty=guard'), false);
  assert.equal(isPublicTag('판타지'), true);
  assert.equal(isPublicTag('romance'), true);
  assert.equal(isPublicTag(''), false);
  assert.equal(isPublicTag('  party:locked=1  '), false);
});

t('2 publicTags filters party: and keeps genre', () => {
  const out = publicTags(['판타지', 'party:role=secondary', 'romance', 'party:place=hall']);
  assert.deepEqual(out, ['판타지', 'romance']);
  assert.deepEqual(publicTags(null), []);
  assert.deepEqual(publicTags(undefined), []);
  assert.deepEqual(publicTags([]), []);
});

t('3 INTERNAL_TAG_PREFIXES covers tagsCatalog PREFIX (source assert)', () => {
  const catalog = src('apps/server/src/prompt/tagsCatalog.ts');
  const m = /const PREFIX = '([^']+)';/.exec(catalog);
  assert.ok(m, 'tagsCatalog PREFIX not found');
  assert.equal(m![1], 'party:');
  assert.ok(
    (INTERNAL_TAG_PREFIXES as readonly string[]).includes(m![1]),
    'INTERNAL_TAG_PREFIXES must cover tagsCatalog PREFIX',
  );
  assert.deepEqual([...INTERNAL_TAG_PREFIXES], ['party:']);
});

t('4 HomePage chips/cards/filter use publicTags / isPublicTag', () => {
  const home = src('apps/web/src/pages/HomePage.tsx');
  assert.match(home, /from ['"]\.\.\/lib\/publicTags['"]/);
  assert.match(home, /isPublicTag/);
  assert.match(home, /publicTags\(c\.tags\)/);
  // chips skip internal
  assert.match(home, /!isPublicTag\(key\)/);
  // card display filtered then slice(0, 4)
  assert.match(home, /publicTags\(c\.tags\)\.slice\(0,\s*4\)/);
  // filter matches public tags only
  assert.match(home, /publicTags\(c\.tags\)\.includes\(charFilter\)/);
  // raw unfiltered chip/card paths gone
  assert.equal(/for \(const t of c\.tags \?\? \[\]\) \{\s*const key = t\.trim\(\);\s*if \(!key\) continue;/.test(home), false);
  assert.equal(home.includes('c.tags.slice(0, 4)'), false);
});

t('5 CharacterPage display maps through publicTags; CharacterEditor keeps raw DEFAULT_TAGS', () => {
  const page = src('apps/web/src/pages/CharacterPage.tsx');
  assert.match(page, /from ['"]\.\.\/lib\/publicTags['"]/);
  assert.match(page, /publicTags\(char\.tags\)/);
  assert.equal(page.includes('char.tags.map((t)'), false);

  const editor = src('apps/web/src/components/CharacterEditor.tsx');
  const m = /const DEFAULT_TAGS = (\[[^\]]*\]);/.exec(editor);
  assert.ok(m, 'DEFAULT_TAGS declaration not found');
  const tags = JSON.parse(m![1].replace(/'/g, '"')) as string[];
  assert.deepEqual(tags, ['party:role=secondary']);
  // editor still lists/edits raw tags (no publicTags import)
  assert.equal(editor.includes('publicTags'), false);
  assert.equal(editor.includes('isPublicTag'), false);
});

t('6 filter edge: internal charFilter is cleared/ignored (source)', () => {
  const home = src('apps/web/src/pages/HomePage.tsx');
  assert.match(home, /!isPublicTag\(charFilter\)/);
  assert.ok(
    home.includes("setCharFilter('all')") || home.includes('setCharFilter("all")'),
    'stale internal filter should reset to all',
  );
});

console.log(`\n${passed} passed`);
