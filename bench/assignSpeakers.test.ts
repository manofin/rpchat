/**
 * npx tsx bench/assignSpeakers.test.ts
 * F9D — isolated Multi Speaker slot force (scores → slots, not prompt instruction).
 * Does not start systemd, touch live DB, call a model, write 0010, or wire generate.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySceneDelta, type PartyCatalog } from '../apps/server/src/prompt/applySceneDelta.ts';
import type { CastMember } from '../apps/server/src/prompt/cast.ts';
import { resolveFocus } from '../apps/server/src/prompt/resolveFocus.ts';
import { assignSpeakers, type AssignSpeakersInput } from '../apps/server/src/prompt/assignSpeakers.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const srcPath = path.join(appRoot, 'apps/server/src/prompt/assignSpeakers.ts');
const pickPath = path.join(appRoot, 'apps/server/src/prompt/cast.ts');
const applyPath = path.join(appRoot, 'apps/server/src/prompt/applySceneDelta.ts');
const chatPath = path.join(appRoot, 'apps/server/src/routes/chat.ts');
const builderPath = path.join(appRoot, 'apps/server/src/prompt/builder.ts');
const convPath = path.join(appRoot, 'apps/server/src/routes/conversations.ts');
const templatesPath = path.join(appRoot, 'apps/server/src/prompt/templates.ts');
const typesPath = path.join(appRoot, 'apps/server/src/types.ts');
const mig010 = path.join(appRoot, 'apps/server/migrations/0010_scene_state.sql');
const HASH_0010 = 'd8357b3624eafc4d7e9497129e3a3166c0f4d498c8adcc53cdc3f6337b57b298';

const HAN: CastMember = {
  id: 'han_soyeon',
  name: '한소연',
  aliases: [],
  duties: ['접수'],
  place: 'bureau_lobby_01',
  role: 'main',
};
const YUKI: CastMember = {
  id: 'yuki',
  name: '유키',
  aliases: [],
  duties: ['측정'],
  place: 'exam_hall_01',
  role: 'secondary',
};
const GUARD: CastMember = {
  id: 'npc_guard',
  name: '경비원',
  aliases: [],
  duties: [],
  place: 'bureau_lobby_01',
  role: 'background',
};
const CLEANER: CastMember = {
  id: 'npc_cleaner',
  name: '청소부',
  aliases: [],
  duties: [],
  place: 'bureau_lobby_01',
  role: 'background',
};
const EXTRA_B: CastMember = {
  id: 'npc_clerk',
  name: '서기',
  aliases: [],
  duties: ['장부'],
  place: 'bureau_lobby_01',
  role: 'secondary',
};
const CAST: CastMember[] = [HAN, YUKI, GUARD, CLEANER];

const CAT: PartyCatalog = {
  locations: ['bureau_lobby_01', 'exam_hall_01'],
  weathers: ['clear'],
  arcs: ['arc_exam'],
  stagesByArc: { arc_exam: ['stg_arrive'] },
  flags: {},
};

function srcOf(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

function input(partial: Partial<AssignSpeakersInput> = {}): AssignSpeakersInput {
  return {
    scores: partial.scores ?? { han_soyeon: 95, yuki: 20, npc_guard: 0, npc_cleaner: 0 },
    cast: partial.cast ?? CAST,
    main_character_id: partial.main_character_id ?? 'han_soyeon',
    main_speaker_id: partial.main_speaker_id === undefined ? 'han_soyeon' : partial.main_speaker_id,
    proposed_lines: partial.proposed_lines,
  };
}

function ids(speakers: { character_id: string }[]): string[] {
  return speakers.map((s) => s.character_id);
}

function main() {
  t('product assignSpeakers.ts exists; dist js absent (no rebuild)', () => {
    assert.equal(fs.existsSync(srcPath), true);
    assert.equal(fs.existsSync(srcPath.replace(/\.ts$/, '.js')), false);
  });

  // f9-aux-speaker-generate moved the extra-slot canon from router scores to the
  // aux gate's eligible_secondary_ids. Scores still pick the MAIN speaker and are
  // still recorded on each slot; they no longer grant a secondary slot.
  t('stage-1 scores: main + one eligible extra; background silent', () => {
    const out = assignSpeakers({ ...input(), eligible_secondary_ids: ['yuki'] });
    assert.equal(out.speakers.length, 2);
    assert.equal(out.speakers[0].slot, 'main');
    assert.equal(out.speakers[0].character_id, 'han_soyeon');
    assert.equal(out.speakers[0].score, 95);
    assert.equal(out.speakers[0].meta.speaker_character_id, 'han_soyeon');
    assert.equal(out.speakers[1].slot, 'extra');
    assert.equal(out.speakers[1].character_id, 'yuki');
    assert.equal(out.speakers[1].score, 20);
    assert.equal(out.speakers[1].meta.speaker_character_id, 'yuki');
    assert.deepEqual(out.silent.sort(), ['npc_cleaner', 'npc_guard']);
  });

  t('extras capped at 2 even when three secondaries are eligible', () => {
    const cast = [HAN, YUKI, EXTRA_B, GUARD];
    const out = assignSpeakers({
      ...input({ cast, scores: { han_soyeon: 95, yuki: 20, npc_clerk: 20, npc_guard: 0 } }),
      eligible_secondary_ids: ['yuki', 'npc_clerk', 'npc_guard'],
    });
    assert.equal(out.speakers.length, 3);
    assert.equal(out.speakers[0].slot, 'main');
    assert.equal(out.speakers.filter((s) => s.slot === 'extra').length, 2);
    assert.deepEqual(ids(out.speakers.filter((s) => s.slot === 'extra')), ['yuki', 'npc_clerk']);
    assert.ok(out.silent.includes('npc_guard'));
  });

  t('background never gets a slot even with a planted positive score', () => {
    const out = assignSpeakers(
      input({
        scores: { han_soyeon: 95, yuki: 20, npc_guard: 99, npc_cleaner: 50 },
      }),
    );
    assert.equal(ids(out.speakers).includes('npc_guard'), false);
    assert.equal(ids(out.speakers).includes('npc_cleaner'), false);
    assert.ok(out.silent.includes('npc_guard'));
    assert.ok(out.silent.includes('npc_cleaner'));
  });

  // SUPERSEDED CONTRACT. These two cases asserted ADR-F9 §6's "router scores all
  // zero → fall back to conversations.character_id". `Notes_260902_210901.txt`
  // §4.1-4 replaces that **for the party path**: no focus means no dialogue slot,
  // because the fallback is precisely the "후보가 있으면 누군가는 말한다" rule §2
  // discards. The 1:1 path is unaffected — it never routed at all.
  t('no focus: nobody speaks, and the conversation main is NOT drafted in', () => {
    const out = assignSpeakers(
      input({ main_speaker_id: null, main_character_id: 'han_soyeon' }),
    );
    assert.deepEqual(out.speakers, []);
    assert.equal(out.speakers.length, 0);
    assert.deepEqual(out.silent.sort(), ['han_soyeon', 'npc_cleaner', 'npc_guard', 'yuki']);
  });

  t('no focus stays silent even when the main is absent from the cast', () => {
    const out = assignSpeakers(
      input({ cast: [YUKI, GUARD], main_speaker_id: null, main_character_id: 'han_soyeon' }),
    );
    assert.deepEqual(out.speakers, []);
    assert.deepEqual(out.silent.sort(), ['npc_guard', 'yuki']);
  });

  // Post f9-aux-speaker-generate the gate, not the score, decides. With no
  // eligibility supplied nobody takes an extra slot regardless of score.
  t('no eligibility → no extra slots', () => {
    const out = assignSpeakers(
      input({
        scores: { han_soyeon: 95, yuki: 0, npc_guard: 0, npc_cleaner: 0 },
      }),
    );
    assert.deepEqual(ids(out.speakers), ['han_soyeon']);
    assert.ok(out.silent.includes('yuki'));
  });

  t('allowed dump 한소연 10 / 유키 2 is kept; background 0', () => {
    const out = assignSpeakers({
      ...input({
        proposed_lines: [
          { character_id: 'han_soyeon', line_count: 10 },
          { character_id: 'yuki', line_count: 2 },
        ],
      }),
      eligible_secondary_ids: ['yuki'],
    });
    assert.deepEqual(out.kept_lines, [
      { character_id: 'han_soyeon', line_count: 10 },
      { character_id: 'yuki', line_count: 2 },
    ]);
    assert.deepEqual(out.dropped_lines, []);
  });

  t('forbidden dump 한소연 6 / 유키 5 / 경비원 4 / 청소부 3: extras cap 2, background 0', () => {
    const out = assignSpeakers({
      ...input({
        proposed_lines: [
          { character_id: 'han_soyeon', line_count: 6 },
          { character_id: 'yuki', line_count: 5 },
          { character_id: 'npc_guard', line_count: 4 },
          { character_id: 'npc_cleaner', line_count: 3 },
        ],
      }),
      eligible_secondary_ids: ['yuki'],
    });
    assert.deepEqual(out.kept_lines, [
      { character_id: 'han_soyeon', line_count: 6 },
      { character_id: 'yuki', line_count: 2 },
    ]);
    assert.deepEqual(out.dropped_lines, [
      { character_id: 'yuki', line_count: 3 },
      { character_id: 'npc_guard', line_count: 4 },
      { character_id: 'npc_cleaner', line_count: 3 },
    ]);
  });

  t('main line cap 10: 12 proposed keeps 10', () => {
    const out = assignSpeakers(
      input({
        scores: { han_soyeon: 95, yuki: 0, npc_guard: 0, npc_cleaner: 0 },
        proposed_lines: [{ character_id: 'han_soyeon', line_count: 12 }],
      }),
    );
    assert.deepEqual(out.kept_lines, [{ character_id: 'han_soyeon', line_count: 10 }]);
    assert.deepEqual(out.dropped_lines, [{ character_id: 'han_soyeon', line_count: 2 }]);
  });

  t('prompt-shaped dump does not grant slots; scores do', () => {
    const out = assignSpeakers(
      input({
        scores: { han_soyeon: 95, yuki: 0, npc_guard: 0, npc_cleaner: 0 },
        proposed_lines: [
          { character_id: 'yuki', line_count: 8 },
          { character_id: 'npc_guard', line_count: 4 },
        ],
      }),
    );
    assert.deepEqual(ids(out.speakers), ['han_soyeon']);
    assert.deepEqual(out.kept_lines, []);
    assert.ok(out.dropped_lines.some((d) => d.character_id === 'yuki' && d.line_count === 8));
    assert.ok(out.dropped_lines.some((d) => d.character_id === 'npc_guard' && d.line_count === 4));
  });

  // f9-focus-eligible replaced the F9C router with resolveFocus. The A-5 invariant
  // this test exists for is unchanged: the focus is read from the POST-apply scene.
  t('A-5 compose: post-apply resolveFocus then assignSpeakers', () => {
    const before = { location: 'bureau_lobby_01', clock_minutes: 0, flags: [] };
    const applied = applySceneDelta(before, { base_version: 1, location: 'exam_hall_01' }, CAT, 1);
    const focus = resolveFocus({
      user_text: '유키, 지금 뭐 해?',
      scene: applied.state,
      cast: CAST,
    });
    assert.equal(focus.focus_id, 'yuki');
    assert.equal(focus.reason, 'targeted');
    const out = assignSpeakers(
      input({ main_speaker_id: focus.focus_id, main_character_id: 'han_soyeon' }),
    );
    assert.equal(out.speakers[0].character_id, 'yuki');
    assert.equal(out.speakers[0].slot, 'main');
    assert.equal(out.speakers[0].meta.speaker_character_id, 'yuki');
  });

  // §4.1-4. This is the behaviour the removed main_character_id fallback made
  // impossible: a beat where nobody was named and nobody is on the hook is
  // narration, not a forced line from the conversation's main character.
  t('focus null ⇒ zero speakers, and extras cannot open without a focus', () => {
    const out = assignSpeakers(
      input({
        main_speaker_id: null,
        main_character_id: 'han_soyeon',
        eligible_secondary_ids: ['yuki'],
      }),
    );
    assert.deepEqual(out.speakers, []);
    assert.deepEqual(out.kept_lines, []);
    assert.ok(out.silent.includes('han_soyeon'));
    assert.ok(out.silent.includes('yuki'));
  });

  t('a background focus is still refused, and does not fall back to main', () => {
    const out = assignSpeakers(
      input({ main_speaker_id: 'npc_guard', main_character_id: 'han_soyeon' }),
    );
    assert.deepEqual(out.speakers, []);
  });

  t('assignSpeakers source: no db, routes, fetch, generate, HARD_RULES', () => {
    const src = srcOf(srcPath);
    assert.equal(/from ['"].*db/.test(src), false);
    assert.equal(/from ['"].*routes\//.test(src), false);
    assert.equal(/\bfetch\s*\(/.test(src), false);
    assert.equal(/adapter/.test(src), false);
    assert.equal(/generate\(/.test(src), false);
    assert.equal(/HARD_RULES/.test(src), false);
    assert.equal(/applySceneDelta/.test(src), false);
  });

  // f9-aux-speaker-generate wired aux speech, so chat.ts imports EXTRA_LINE_CAP from
  // this module. The invariant that survives: chat never *calls* assignSpeakers —
  // speaker selection stays inside composePartyTurn.
  t('speaker selection stays in compose: chat imports a constant, never calls it', () => {
    assert.equal(/\bassignSpeakers\s*\(/.test(srcOf(chatPath)), false);
    assert.equal(/assignSpeakers/.test(srcOf(builderPath)), false);
    assert.equal(/assignSpeakers/.test(srcOf(convPath)), false);
    assert.equal(/assignSpeakers/.test(srcOf(applyPath)), false);
    assert.equal(/assignSpeakers/.test(srcOf(templatesPath)), false);
    assert.equal(/pickSpeaker/.test(srcOf(chatPath)), false);
  });

  t('1:1 HARD_RULES text untouched', () => {
    const src = srcOf(templatesPath);
    assert.ok(src.includes("오직 '{{char}}' 역할만 연기한다"));
  });

  t('0010 bytes unchanged (F9D writes no migration)', () => {
    const buf = fs.readFileSync(mig010);
    const hex = crypto.createHash('sha256').update(buf).digest('hex');
    assert.equal(hex, HASH_0010);
  });

  t('types.ts MessageMeta speaker_character_id is F9F persist, not F9D slot product', () => {
    assert.ok(/speaker_character_id\?:/.test(srcOf(typesPath)));
  });

  t('git does not stage this process; 0010 not in this index add', () => {
    const st = execFileSync(
      'git',
      ['status', '--short', '--', 'apps/server/migrations/0010_scene_state.sql', 'apps/server/src/prompt/assignSpeakers.ts'],
      { cwd: appRoot, encoding: 'utf8' },
    );
    assert.equal(st.includes('A  apps/server/migrations/0010_scene_state.sql'), false);
  });

  // f9-focus-eligible retired the F9C router. What must stay true is that the
  // shared cast type outlived it and nothing in product code routes by score.
  t('the F9C router is gone; cast.ts hosts the shared type', () => {
    assert.equal(fs.existsSync(path.join(appRoot, 'apps/server/src/prompt/pickSpeaker.ts')), false);
    assert.equal(fs.existsSync(pickPath), true);
    const cast = srcOf(pickPath);
    assert.ok(cast.includes('export type CastMember'));
    assert.equal(/const WIN|llm_reached|decided_stage/.test(cast), false, 'no scoring may return here');
    const focus = srcOf(path.join(appRoot, 'apps/server/src/prompt/resolveFocus.ts'));
    assert.equal(/Math\.random|llm_reached/.test(focus), false, 'focus is decided, never drawn');
  });

  console.log(`passed ${passed}`);
}

main();
