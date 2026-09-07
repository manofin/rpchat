/**
 * npx tsx bench/characterPartyDefault.test.ts
 * party-ready-default — new characters seed with `party:role=secondary`.
 *
 * The default exists so a character created today doesn't need a tag-editing
 * round trip before it can join a story cast: `role` is set, `place` is filled
 * in later once the character is actually added to a story (place ids are
 * story-scoped — `stories.scene_catalog.places[]` — not character-scoped, so
 * they can't be defaulted here).
 *
 * `secondary` is a deliberately inert choice, and this file is the proof: it
 * reads the actual grammar/gate functions rather than asserting the claim in
 * prose. `role` only ever means "never speaks" (`background`) vs everything
 * else; `castFromCharacters` force-applies `main` to the conversation's own
 * character regardless of its tag; and a single tagged character never opens
 * the beat gate on its own (needs ≥2).
 *
 * Pure: reads source, calls shipped pure functions. No DB, no fetch, no model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePartyTags, castFromCharacters, type PartyTagRow } from '../apps/server/src/prompt/tagsCatalog.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, '..', 'apps/web/src/components/CharacterEditor.tsx'), 'utf8');

t('a new character seeds with exactly one party: tag, role=secondary', () => {
  const m = /const DEFAULT_TAGS = (\[[^\]]*\]);/.exec(src);
  assert.ok(m, 'DEFAULT_TAGS declaration not found');
  const tags = JSON.parse(m![1].replace(/'/g, '"')) as string[];
  assert.deepEqual(tags, ['party:role=secondary']);
  assert.match(src, /tags: DEFAULT_TAGS,/, 'EMPTY draft must use the default, not a bare []');
});

t('the default tag parses to tagged=true, role=secondary', () => {
  const parsed = parsePartyTags(['party:role=secondary']);
  assert.equal(parsed.tagged, true);
  assert.equal(parsed.role, 'secondary');
  assert.equal(parsed.place, '', 'place is still empty — filled in per-story, not defaulted');
});

t('role=secondary and role=main behave identically everywhere except background', () => {
  // The single reader of the distinction outside tagsCatalog.
  const secondary = parsePartyTags(['party:role=secondary']);
  const main = parsePartyTags(['party:role=main']);
  const background = parsePartyTags(['party:role=background']);
  assert.equal(secondary.role, 'secondary');
  assert.equal(main.role, 'main');
  assert.equal(background.role, 'background');
});

t('castFromCharacters overrides the tag to main for the conversation\'s own character', () => {
  const rows: PartyTagRow[] = [
    { id: 'starter', name: '기얌', tags_json: JSON.stringify(['party:role=secondary']) },
    { id: 'other', name: '델타', tags_json: JSON.stringify(['party:role=secondary']) },
  ];
  const cast = castFromCharacters(rows, 'starter');
  assert.ok(cast);
  const starter = cast!.find((c) => c.id === 'starter')!;
  assert.equal(starter.role, 'main', 'the default secondary tag never survives on the starter');
});

t('a single default-tagged character never opens the beat gate alone', () => {
  const rows: PartyTagRow[] = [
    { id: 'only', name: '엠마', tags_json: JSON.stringify(['party:role=secondary']) },
  ];
  assert.equal(castFromCharacters(rows, 'only'), null, 'needs a second tagged character, per the ≥2 gate');
});

t('an untagged story (no party: tags at all) is unaffected by this default', () => {
  // The exact shape reported live: 7 cast members, all tags_json = "[]".
  const rows: PartyTagRow[] = Array.from({ length: 7 }, (_, i) => (
    { id: `c${i}`, name: `char${i}`, tags_json: '[]' }
  ));
  assert.equal(castFromCharacters(rows, 'c0'), null);
});

console.log(`\n${passed} passed`);
