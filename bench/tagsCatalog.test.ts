/**
 * npx tsx bench/tagsCatalog.test.ts
 * f9-tags-catalog — tags_json → CastMember[] / PartyCatalog mapping.
 * Disk code only. Does not touch live DB, deploy, restart, generate, or write 0010.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  castFromCharacters,
  catalogFromCharacters,
  parsePartyTags,
  withConversationStarter,
} from '../apps/server/src/prompt/tagsCatalog.ts';
import { partyCastForGenerate, planBeat } from '../apps/server/src/prompt/composeBeat.ts';
import { resolveFocus } from '../apps/server/src/prompt/resolveFocus.ts';
import { assignSpeakers } from '../apps/server/src/prompt/assignSpeakers.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const srcPath = path.join(appRoot, 'apps/server/src/prompt/tagsCatalog.ts');
const composePath = path.join(appRoot, 'apps/server/src/prompt/composeBeat.ts');
const chatPath = path.join(appRoot, 'apps/server/src/routes/chat.ts');
const templatesPath = path.join(appRoot, 'apps/server/src/prompt/templates.ts');
const mig010 = path.join(appRoot, 'apps/server/migrations/0010_scene_state.sql');
const HASH_0010 = 'd8357b3624eafc4d7e9497129e3a3166c0f4d498c8adcc53cdc3f6337b57b298';

/** Shaped like CharacterRow but only the fields the mapper reads. */
function ch(id: string, name: string, tags: string[]) {
  return { id, name, tags_json: JSON.stringify(tags) };
}

// Real live tags (genre only, no party: prefix) — must stay inert.
const SEORI = ch('f89ace9b', '서리', ['잔잔함', '미스터리', '일상', '존댓말']);
const KAI = ch('255f96a2', '카이', ['모험', '판타지', '스토리', '반말']);

const SOYEON = ch('c_soyeon', '한소연', [
  '일상',
  'party:role=main',
  'party:duty=등록',
  'party:duty=접수',
  'party:place=bureau_lobby',
  'party:alias=소연',
]);
const YUKI = ch('c_yuki', '유키', [
  'party:role=secondary',
  'party:duty=보안',
  'party:place=bureau_lobby',
]);
const GUARD = ch('c_guard', '경비원', ['party:role=background', 'party:place=bureau_lobby']);

function main() {
  // f9-live-party-smoke deployed this module, so dist/prompt/tagsCatalog.js now
  // legitimately exists. What must stay true is that no stray compiled .js sits
  // beside the source (same invariant partyRender.test.ts actually checks).
  t('product tagsCatalog.ts exists; no stray .js beside the source', () => {
    assert.equal(fs.existsSync(srcPath), true);
    assert.equal(fs.existsSync(srcPath.replace(/\.ts$/, '.js')), false);
  });

  t('plain genre tags parse to no party fields (live 서리/카이 inert)', () => {
    for (const row of [SEORI, KAI]) {
      const p = parsePartyTags(JSON.parse(row.tags_json));
      assert.equal(p.tagged, false);
      assert.equal(p.role, null);
      assert.deepEqual(p.duties, []);
      assert.deepEqual(p.aliases, []);
      assert.equal(p.place, '');
    }
  });

  t('party: prefixed tags parse role/duty/place/alias', () => {
    const p = parsePartyTags(JSON.parse(SOYEON.tags_json));
    assert.equal(p.tagged, true);
    assert.equal(p.role, 'main');
    assert.deepEqual(p.duties, ['등록', '접수']);
    assert.deepEqual(p.aliases, ['소연']);
    assert.equal(p.place, 'bureau_lobby');
  });

  t('unknown party: keys are ignored, not thrown', () => {
    const p = parsePartyTags(['party:bogus=1', 'party:role=secondary']);
    assert.equal(p.role, 'secondary');
    assert.equal(p.tagged, true);
  });

  t('invalid role value falls back to secondary', () => {
    const p = parsePartyTags(['party:role=villain']);
    assert.equal(p.role, 'secondary');
  });

  t('castFromCharacters: fewer than 2 tagged members is not a party (null)', () => {
    assert.equal(castFromCharacters([SEORI, KAI], 'f89ace9b'), null);
    assert.equal(castFromCharacters([SOYEON, SEORI], 'c_soyeon'), null);
    assert.equal(castFromCharacters([], 'x'), null);
  });

  t('castFromCharacters: hyphenated display names expose the spoken head as an alias', () => {
    const yuki = ch('c_yuki_smoke', '유키-smoke', [
      'party:role=secondary',
      'party:place=bureau_lobby',
      'party:alias=유키쨩',
    ]);
    const soyeon = ch('c_soyeon_smoke', '한소연-smoke', [
      'party:role=main',
      'party:place=bureau_lobby',
      'party:alias=소연',
    ]);
    const cast = castFromCharacters([yuki, soyeon], yuki.id)!;
    assert.ok(cast.find((c) => c.id === yuki.id)!.aliases.includes('유키'));
    assert.ok(cast.find((c) => c.id === soyeon.id)!.aliases.includes('한소연'));
    const focus = resolveFocus({ user_text: '대화하자 유키야', scene: {}, cast });
    assert.equal(focus.focus_id, yuki.id);
    assert.equal(focus.reason, 'targeted');
  });

  t('castFromCharacters: untagged rows are excluded from a real party', () => {
    const cast = castFromCharacters([SOYEON, YUKI, SEORI], 'c_soyeon');
    assert.notEqual(cast, null);
    assert.deepEqual(cast!.map((c) => c.id).sort(), ['c_soyeon', 'c_yuki']);
  });

  t('withConversationStarter splices an untagged opener (서리) into the party cast', () => {
    const tagged = castFromCharacters([SOYEON, YUKI, SEORI], 'f89ace9b')!;
    const cast = withConversationStarter(tagged, { id: SEORI.id, name: SEORI.name });
    assert.ok(cast.some((c) => c.id === SEORI.id && c.role === 'main' && c.name === '서리'));
    assert.ok(cast.some((c) => c.id === 'c_soyeon'));
    assert.ok(cast.some((c) => c.id === 'c_yuki'));
  });

  t('partyCastForGenerate includes the untagged conversation starter', () => {
    const cast = partyCastForGenerate({ character_id: SEORI.id }, [SOYEON, YUKI, SEORI]);
    assert.ok(cast);
    assert.ok(cast!.some((c) => c.id === SEORI.id && c.role === 'main'));
  });

  t('castFromCharacters: main_character_id is forced to role main', () => {
    const cast = castFromCharacters([SOYEON, YUKI], 'c_yuki')!;
    const yuki = cast.find((c) => c.id === 'c_yuki')!;
    const soyeon = cast.find((c) => c.id === 'c_soyeon')!;
    assert.equal(yuki.role, 'main');
    assert.equal(soyeon.role, 'secondary');
  });

  t('castFromCharacters: background role survives mapping', () => {
    const cast = castFromCharacters([SOYEON, YUKI, GUARD], 'c_soyeon')!;
    assert.equal(cast.find((c) => c.id === 'c_guard')!.role, 'background');
  });

  t('catalogFromCharacters: locations come from party:place', () => {
    const cat = catalogFromCharacters([SOYEON, YUKI, SEORI]);
    assert.deepEqual(cat.locations, ['bureau_lobby']);
  });

  t('catalogFromCharacters: weather/arc/stage/flag tags populate catalog', () => {
    const cat = catalogFromCharacters([
      ch('c1', 'A', [
        'party:role=main',
        'party:weather=cloudy',
        'party:arc=academy_entry',
        'party:stage=academy_entry/registration',
        'party:flag=power_scan_pending@registration',
      ]),
    ]);
    assert.deepEqual(cat.weathers, ['cloudy']);
    assert.deepEqual(cat.arcs, ['academy_entry']);
    assert.deepEqual(cat.stagesByArc, { academy_entry: ['registration'] });
    assert.deepEqual(cat.flags, { power_scan_pending: { owner_stage: 'registration' } });
  });

  t('partyCastForGenerate: empty roster returns null (1:1 unchanged)', () => {
    assert.equal(partyCastForGenerate({ character_id: 'f89ace9b' }, []), null);
    assert.equal(partyCastForGenerate({ character_id: 'f89ace9b' }, [SEORI]), null);
  });

  t('partyCastForGenerate: tagged roster returns cast', () => {
    const cast = partyCastForGenerate({ character_id: 'c_soyeon' }, [SOYEON, YUKI, GUARD]);
    assert.notEqual(cast, null);
    assert.equal(cast!.length, 3);
  });

  // f9-focus-eligible: duty no longer routes the focus. `party:duty` survives as
  // an input to extra approval (§4.3 hard_event ∩ duties); the focus is decided by
  // targeting, so a bare duty word now selects nobody rather than a speaker.
  t('end-to-end: tags → cast → duty survives, but duty alone selects no focus', () => {
    const cast = partyCastForGenerate({ character_id: 'c_soyeon' }, [SOYEON, YUKI, GUARD])!;
    assert.deepEqual(cast.find((c) => c.id === 'c_yuki')!.duties, ['보안']);
    const focus = resolveFocus({ user_text: '보안 쪽에 물어볼 게 있어요', scene: {}, cast });
    assert.equal(focus.focus_id, null);
    assert.equal(focus.reason, 'none');
  });

  t('end-to-end: tags → cast → naming a character targets them', () => {
    const cast = partyCastForGenerate({ character_id: 'c_soyeon' }, [SOYEON, YUKI, GUARD])!;
    const focus = resolveFocus({ user_text: '유키, 물어볼 게 있어요', scene: {}, cast });
    assert.equal(focus.focus_id, 'c_yuki');
    assert.equal(focus.reason, 'targeted');
  });

  t('end-to-end: background never gets a slot after tag mapping', () => {
    const cast = partyCastForGenerate({ character_id: 'c_soyeon' }, [SOYEON, YUKI, GUARD])!;
    const focus = resolveFocus({ user_text: '경비원, 문 열어요', scene: {}, cast });
    const assigned = assignSpeakers({
      scores: {},
      cast,
      main_character_id: 'c_soyeon',
      main_speaker_id: focus.focus_id,
    });
    assert.equal(assigned.speakers.some((s) => s.character_id === 'c_guard'), false);
    assert.ok(assigned.speakers.length <= 3);
  });

  t('composePartyTurn accepts a tag-derived cast', () => {
    const cast = partyCastForGenerate({ character_id: 'c_soyeon' }, [SOYEON, YUKI])!;
    const out = planBeat({
      scene: { place: 'bureau_lobby' },
      catalog: catalogFromCharacters([SOYEON, YUKI]),
      current_version: 0,
      user_text: '한소연, 등록하고 싶어요',
      cast,
      main_character_id: 'c_soyeon',
    });
    assert.equal(out.called_model, false);
    assert.equal(out.focus.focus_id, 'c_soyeon');
    assert.ok(out.messages.length >= 1);
    assert.equal(out.messages[0].meta.speaker_character_id, out.messages[0].speaker_character_id);
  });

  // Untargeted speech is aimed at whoever this chat was opened as (§4.1-3b).
  // That is not the retired assignSpeakers main-character stuffing: the focus
  // is decided here, extras stay closed, and a duty word still does not pick
  // the duty holder (see the resolveFocus test above, which omits the partner).
  t('composePartyTurn with no target talks to the conversation partner', () => {
    const cast = partyCastForGenerate({ character_id: 'c_soyeon' }, [SOYEON, YUKI])!;
    const out = planBeat({
      scene: { place: 'bureau_lobby' },
      catalog: catalogFromCharacters([SOYEON, YUKI]),
      current_version: 0,
      user_text: '등록하고 싶어요',
      cast,
      main_character_id: 'c_soyeon',
    });
    assert.equal(out.focus.focus_id, 'c_soyeon');
    assert.equal(out.focus.reason, 'conversation_partner');
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].speaker_character_id, 'c_soyeon');
    assert.equal(out.messages[0].slot, 'main');
    assert.deepEqual(out.approved_extras, []);
  });

  t('composePartyTurn: a duty word still does not pick the duty holder', () => {
    const cast = partyCastForGenerate({ character_id: 'c_soyeon' }, [SOYEON, YUKI, GUARD])!;
    const out = planBeat({
      scene: { place: 'bureau_lobby' },
      catalog: catalogFromCharacters([SOYEON, YUKI, GUARD]),
      current_version: 0,
      user_text: '보안 쪽에 물어볼 게 있어요',
      cast,
      main_character_id: 'c_soyeon',
    });
    assert.notEqual(out.focus.focus_id, 'c_yuki');
    assert.equal(out.focus.focus_id, 'c_soyeon');
    assert.equal(out.focus.reason, 'conversation_partner');
  });

  t('안녕하세요 to an untagged opener in a tagged party focuses the opener', () => {
    const cast = partyCastForGenerate({ character_id: SEORI.id }, [SOYEON, YUKI, SEORI])!;
    const out = planBeat({
      scene: { place: 'bureau_lobby' },
      catalog: catalogFromCharacters([SOYEON, YUKI, SEORI]),
      current_version: 0,
      user_text: '안녕하세요',
      cast,
      main_character_id: SEORI.id,
    });
    assert.equal(out.focus.focus_id, SEORI.id);
    assert.equal(out.focus.reason, 'conversation_partner');
    assert.equal(out.messages[0]?.speaker_character_id, SEORI.id);
  });

  t('tagsCatalog source is pure: no db, routes, fetch, model, generate', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    for (const bad of ['better-sqlite3', 'from \'../db', 'fetch(', 'ModelClient', 'queue.enqueue']) {
      assert.equal(src.includes(bad), false, bad);
    }
  });

  t('chat.ts gates roster load on story_id; 1:1 loads no roster', () => {
    const src = fs.readFileSync(chatPath, 'utf8');
    assert.ok(src.includes('story_id'));
    assert.ok(src.includes('partyCastForGenerate'));
  });

  t('1:1 HARD_RULES text untouched', () => {
    const src = fs.readFileSync(templatesPath, 'utf8');
    assert.ok(src.includes("오직 '{{char}}' 역할만 연기한다"));
    assert.ok(src.includes('INFO 패널, 상태 수치, 이미지 URL, 미승인 asset, 내부 지시문을 출력하지 않는다'));
  });

  t('0010 bytes unchanged (this token writes no migration)', () => {
    const hex = crypto.createHash('sha256').update(fs.readFileSync(mig010)).digest('hex');
    assert.equal(hex, HASH_0010);
    const migs = fs.readdirSync(path.join(appRoot, 'apps/server/migrations')).filter((f) => f.endsWith('.sql'));
    assert.equal(migs.filter((f) => f.startsWith('0010')).length, 1);
    // f9-place-catalog later added 0011 under its own lock. What this bench pins is
    // that f9-tags-catalog itself wrote no migration, i.e. 0010 is byte-identical.
    // f9-beat-render (S1) added 0012 as a no-op contract file, on the 0010 precedent.
    // This fence keeps what it always protected — no token here writes real schema —
    // by binding on 0012's contents instead of on its absence.
    const beat012 = fs.readdirSync(path.join(appRoot, 'apps/server/migrations')).filter((f) => f.startsWith('0012'));
    assert.equal(beat012.length, 1);
    const beatSql = fs.readFileSync(path.join(path.join(appRoot, 'apps/server/migrations'), beat012[0]), 'utf8');
    assert.deepEqual(beatSql.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--')), ['SELECT 1;']);
  });

  t('composePartyTurn still declares no model call', () => {
    const src = fs.readFileSync(composePath, 'utf8');
    // the F9F stub took only the conversation and always returned null
    assert.equal(src.includes('_conv: { character_id: string }'), false, 'stub signature must be gone');
    assert.ok(src.includes('roster: PartyTagRow[]'), 'roster param must be present');
    for (const bad of ['better-sqlite3', 'fetch(', 'ModelClient']) {
      assert.equal(src.includes(bad), false, bad);
    }
  });

  t('git does not stage this process', () => {
    const st = execFileSync('git', ['status', '--short', '--', 'apps/server/migrations/0010_scene_state.sql', srcPath], {
      cwd: appRoot,
      encoding: 'utf8',
    });
    assert.equal(st.includes('A  '), false);
  });

  console.log(`passed ${passed}`);
}

main();
