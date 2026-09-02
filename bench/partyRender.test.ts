/**
 * npx tsx bench/partyRender.test.ts
 * F9F — isolated renderer + generate integration (compose + speaker header).
 * Does not start systemd, touch live DB, call a model, write 0010, or live-generate.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type PartyCatalog } from '../apps/server/src/prompt/applySceneDelta.ts';
import { type CastMember } from '../apps/server/src/prompt/cast.ts';
import {
  planBeat,
  partyCastForGenerate,
} from '../apps/server/src/prompt/composeBeat.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const srcPath = path.join(appRoot, 'apps/server/src/prompt/composeBeat.ts');
const viewPath = path.join(appRoot, 'apps/web/src/components/view.tsx');
const chatPagePath = path.join(appRoot, 'apps/web/src/pages/ChatPage.tsx');
const chatPath = path.join(appRoot, 'apps/server/src/routes/chat.ts');
const builderPath = path.join(appRoot, 'apps/server/src/prompt/builder.ts');
const convPath = path.join(appRoot, 'apps/server/src/routes/conversations.ts');
const templatesPath = path.join(appRoot, 'apps/server/src/prompt/templates.ts');
const typesPath = path.join(appRoot, 'apps/server/src/types.ts');
const webTypesPath = path.join(appRoot, 'apps/web/src/types.ts');
const applyPath = path.join(appRoot, 'apps/server/src/prompt/applySceneDelta.ts');
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

function main() {
  t('product composeBeat.ts exists; dist js absent (no rebuild)', () => {
    assert.equal(fs.existsSync(srcPath), true);
    assert.equal(fs.existsSync(srcPath.replace(/\.ts$/, '.js')), false);
  });

  t('A-5 compose: apply → pickSpeaker → assignSpeakers; persist metas', () => {
    const out = planBeat({
      scene: { location: 'bureau_lobby_01', clock_minutes: 0, flags: [] },
      patch: { base_version: 1, location: 'exam_hall_01' },
      catalog: CAT,
      current_version: 1,
      // f9-focus-eligible: the F9C router is gone, so the speaker is whoever the
      // user aims at. The invariant this test guards is unchanged — compose maps
      // the decided speaker onto a persist row, and background NPCs never appear.
      user_text: '유키, 지금 뭐 해?',
      cast: CAST,
      main_character_id: 'han_soyeon',
    });
    assert.equal(out.called_model, false);
    assert.equal(out.focus.focus_id, 'yuki');
    assert.ok(out.messages.length >= 1);
    const main = out.messages.find((m) => m.slot === 'main');
    assert.ok(main);
    assert.equal(main.speaker_character_id, 'yuki');
    assert.equal(main.speaker_name, '유키');
    assert.equal(main.meta.speaker_character_id, 'yuki');
    assert.equal(out.assigned.speakers[0].slot, 'main');
    assert.equal(
      out.messages.some((m) => m.speaker_character_id === 'npc_guard' || m.speaker_character_id === 'npc_cleaner'),
      false,
    );
  });

  // f9-tags-catalog superseded the F9F stub: the cast now comes from the roster's
  // `party:` tags. An empty/untagged roster still yields null, which is what keeps
  // every existing 1:1 conversation unstamped.
  t('partyCastForGenerate is null for an empty or untagged roster', () => {
    assert.equal(partyCastForGenerate({ character_id: 'han_soyeon' }, []), null);
    assert.equal(
      partyCastForGenerate({ character_id: 'han_soyeon' }, [
        { id: 'han_soyeon', name: '한소연', tags_json: '["일상","존댓말"]' },
        { id: 'yuki', name: '유키', tags_json: '["모험"]' },
      ]),
      null,
    );
  });

  t('composeBeat is pure: no db, fetch, generate, adapter', () => {
    const src = srcOf(srcPath);
    assert.equal(/from ['"].*routes\//.test(src), false);
    assert.equal(/\bfetch\s*\(/.test(src), false);
    assert.equal(/adapter/.test(src), false);
    assert.equal(/generate\(/.test(src), false);
    assert.equal(/better-sqlite/.test(src), false);
  });

  t('chat.ts imports composeBeat; 1:1 still buildPrompt(convNow); no live aux loop', () => {
    const src = srcOf(chatPath);
    assert.ok(/planBeat|composeBeat/.test(src));
    assert.ok(/partyCastForGenerate/.test(src));
    assert.ok(/buildPrompt\(\s*db,\s*convNow/.test(src));
    assert.equal(/from ['"].*pickSpeaker/.test(src), false);
    // f9-aux-speaker-generate wired aux speech, so chat.ts now imports EXTRA_LINE_CAP
    // from assignSpeakers. What still holds: routing/assignment stay inside compose.
    assert.equal(/\bassignSpeakers\s*\(/.test(src), false, 'chat must not assign speakers itself');
    assert.equal(/queue\.enqueue/.test(src), false);
  });

  t('builder/conversations/applySceneDelta do not import composeBeat', () => {
    assert.equal(/composeBeat/.test(srcOf(builderPath)), false);
    assert.equal(/composeBeat/.test(srcOf(convPath)), false);
    assert.equal(/composeBeat/.test(srcOf(applyPath)), false);
  });

  t('1:1 HARD_RULES text untouched', () => {
    const src = srcOf(templatesPath);
    assert.ok(src.includes("오직 '{{char}}' 역할만 연기한다"));
    assert.ok(/export function renderPartyRules/.test(src));
    assert.ok(/const HARD_RULES/.test(src));
  });

  t('SpeakerHeader exported from view.tsx; reuses Avatar', () => {
    const src = srcOf(viewPath);
    assert.ok(/export function SpeakerHeader/.test(src));
    assert.ok(/className=\"speaker-header\"/.test(src) || /className='speaker-header'/.test(src));
    assert.ok(/<Avatar/.test(src));
    assert.ok(/speaker-name/.test(src));
  });

  t('MessageView adds SpeakerHeader only when speaker_character_id; bubble keeps renderContent', () => {
    const src = srcOf(chatPagePath);
    assert.ok(/SpeakerHeader/.test(src));
    assert.ok(/speaker_character_id/.test(src));
    assert.ok(/renderContent\(\s*m\.content\s*\)/.test(src));
  });

  t('MessageMeta (server + web) optional speaker_character_id', () => {
    assert.ok(/speaker_character_id\?:/.test(srcOf(typesPath)));
    assert.ok(/speaker_character_id\?:/.test(srcOf(webTypesPath)));
  });

  t('0010 bytes unchanged (F9F writes no migration)', () => {
    const buf = fs.readFileSync(mig010);
    const hex = crypto.createHash('sha256').update(buf).digest('hex');
    assert.equal(hex, HASH_0010);
  });

  t('git does not stage 0010 as added this process', () => {
    const st = execFileSync(
      'git',
      ['status', '--short', '--', 'apps/server/migrations/0010_scene_state.sql', 'apps/server/src/prompt/composeBeat.ts'],
      { cwd: appRoot, encoding: 'utf8' },
    );
    assert.equal(st.includes('A  apps/server/migrations/0010_scene_state.sql'), false);
  });

  console.log(`passed ${passed}`);
}

main();
