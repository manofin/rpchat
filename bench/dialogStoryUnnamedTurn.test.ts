/** npx tsx bench/dialogStoryUnnamedTurn.test.ts
 * LOCK-Speaker0-FIX — story-room dialog turn that names nobody (ADR-F8e C-focus-β).
 *
 * The planner deliberately gives such a turn speakers=[] (pinned separately by
 * storyPeerCastGenerateContract ok 4; unchanged here). This bench pins what the
 * dialog path does *with* that empty allow-list:
 *   1. Pass S is narration-only: no `이름 | 대사` example, an explicit
 *      "이번 턴은 캐릭터 대사 없음" rule.
 *   2. If the model still writes `name | line` rows, each row stays as its own
 *      prose paragraph (no lump, no orphan `|`), and nobody becomes a speaker.
 *   3. Controls: a named / second-person turn and a non-empty allow-list keep the
 *      previous prompt bytes and parser behavior.
 *
 * Fixture shape mirrors the 2026-10-09 07:23 KST smoke turn (story room,
 * participant snapshot null, 2 present cast + 1 absent, standing focus on the
 * main, 41-char unnamed greeting, 5 narration paragraphs alternating with
 * 5 `name | line` rows A,B,A,B,A). All names and text are SYNTHETIC.
 * Isolated: no systemd, no live DB, no model call.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { finishDialogBeat, planDialogBeat, type DialogPlanInput } from '../apps/server/src/prompt/composeDialog.ts';
import { parseScript } from '../apps/server/src/prompt/dialogScript.ts';
import type { CastMember } from '../apps/server/src/prompt/cast.ts';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.ts';
import type { Scene } from '../apps/server/src/types.ts';

let passed = 0;
let n = 0;
const failed: string[] = [];
// Runs every case (no fail-fast) so a before/after receipt shows each one.
function t(name: string, fn: () => void) {
  n++;
  try {
    fn();
    passed++;
    console.log(`ok ${n} ${name}`);
  } catch (err) {
    failed.push(name);
    console.log(`not ok ${n} ${name}\n  # ${(err as Error).message.split('\n')[0]}`);
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '카페', role: 'secondary', ...o,
});

// Synthetic cast: main + secondary present, one secondary absent.
const CAST: CastMember[] = [
  member({ id: 'dy', name: '도윤', aliases: ['윤이'] }),
  member({ id: 'mr', name: '마루', place: '창고' }),
  member({ id: 'hr', name: '서하린', aliases: ['하린'], role: 'main' }),
];
const CAT = catalogFromStory(JSON.stringify({
  places: [{ id: '카페', default_focus: 'hr' }],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg'] },
  weathers: ['맑음'],
}));
const SCENE: Scene = {
  format: 'dialog',
  location: '카페',
  turn_no: 2,
  present_ids: ['hr', 'dy'],
  last_beat: { focus_id: 'hr', extra_ids: ['dy'], unresolved: [] },
} as Scene;

// No cast name/alias, no `*stage direction*`, no second-person token.
const UNNAMED = '오랜만에 단골 카페 문을 열고 들어가 창가 자리에 조용히 앉는다.';

const input = (user_text: string, extra: Partial<DialogPlanInput> = {}): DialogPlanInput => ({
  conversation_id: 'spk0-synthetic',
  scene: SCENE,
  catalog: CAT,
  current_version: 0,
  user_text,
  user_name: '여행자',
  cast: CAST,
  main_character_id: 'hr',
  story_room: true,
  participant_ids: null,
  ...extra,
});

// Same shape as the stored 07:23 output: N, A, N, B, N, A, N, B, N, A (blank-separated).
const NARR = [
  '창밖으로 늦은 오후의 빛이 비스듬히 들어와 탁자 위 찻잔에 닿았다. 가게 안은 조용했고 커피 머신만 낮게 웅웅거렸다.',
  '하린은 앞치마 끈을 다시 묶으며 계산대 쪽으로 몸을 돌렸다.',
  '도윤이 메뉴판을 내려놓고 물컵을 채웠다.',
  '잠시 대답을 기다리는 침묵이 흘렀다.',
  '문 위의 종이 한 번 울렸다.',
];
const ROWS: Array<[string, string]> = [
  ['서하린', '어, 왔네. 오늘은 좀 늦었다?'],
  ['도윤', '자리 비워 뒀어요. 늘 앉던 창가 쪽으로.'],
  ['서하린', '오늘 원두 새로 들어왔는데, 한번 마셔 볼래?'],
  ['도윤', '저도 아직 못 마셔 봤어요. 같이 맛봐요.'],
  ['서하린', '그럼 두 잔 내릴게.'],
];
const SCRIPT = NARR.flatMap((n, i) => [n, '', `${ROWS[i][0]} | ${ROWS[i][1]}`, ''])
  .slice(0, -1)
  .join('\n');

const body = (blocks: { kind: string }[]) => blocks.filter((b) => !['header', 'info', 'ui'].includes(b.kind));

// sha256 of the Pass S prompt for the named control, captured at BASE 742bedb.
// The fix must not change a single byte of the prompt when speakers are non-empty.
const NAMED_PASS_S_SHA_742BEDB = '6d9e7937f0bfbb57713fb5560294e8af536e03e0f98c6e34e76a218d2c39ab6e';
const SECOND_PERSON_PASS_S_SHA_742BEDB = 'daedc7ddf0ec84b07a48b9bf44e4f8ccd32469339f80b97bb86483a5ddea1ab8';

// ---- planner: the F8e decision itself is untouched -------------------------

t('fixture: unnamed story-room greeting plans focus none, speakers [], both present cast ambient', () => {
  const plan = planDialogBeat(input(UNNAMED));
  assert.equal(plan.focus.focus_id, null);
  assert.equal(plan.focus.reason, 'none');
  assert.deepEqual(plan.speakers, []);
  assert.deepEqual(plan.ambient.map((a) => a.character_id).sort(), ['dy', 'hr']);
});

// ---- 1. prompt: narration-only when speakers=[] ----------------------------

t('speakers=[] → Pass S has no `이름 | 대사` example and says this turn has no character dialogue', () => {
  const p = planDialogBeat(input(UNNAMED)).pass_s;
  assert.ok(!p.includes('`이름 | 대사`'), 'format example must be gone');
  assert.ok(!p.includes('이름 | 그래서'), 'placeholder example line must be gone');
  assert.ok(!p.includes('서술과 대사를 번갈아 쓴다'), 'alternate-with-dialogue rule must be gone');
  assert.ok(p.includes('이번 턴은 캐릭터 대사 없음'), 'explicit no-dialogue rule');
  assert.ok(!p.includes('(없음).'), 'no empty allow-list line');
  // Still the dialog pass (routing marker unchanged), ambient rule still present.
  assert.ok(p.includes('대본으로 쓴다'));
  assert.ok(p.includes('이번 턴에 말하지 않는다'));
  assert.ok(p.includes('서하린') && p.includes('도윤'));
  // The user's voice stays fenced off.
  assert.ok(p.includes('여행자의 대사·행동·생각·감정을 만들어 내거나 확정하지 않는다'));
});

// ---- 2. parser fallback: rows become per-line prose -------------------------

t('speakers=[] + model writes `name | line` rows → one prose paragraph per row, no lump', () => {
  const plan = planDialogBeat(input(UNNAMED));
  const fin = finishDialogBeat(input(UNNAMED), plan, SCRIPT);
  const blocks = body(fin.blocks);
  assert.equal(blocks.length, 10, `expected 10 paragraphs, got ${blocks.length}`);
  assert.ok(blocks.every((b) => b.kind === 'narration'), 'never a speaker block');
  const texts = blocks.map((b: any) => b.text as string);
  for (let i = 0; i < NARR.length; i++) {
    assert.equal(texts[2 * i], NARR[i]);
    assert.equal(texts[2 * i + 1], ROWS[i][1]);
  }
});

t('speakers=[] fallback leaves no orphan `|` and invents no speaker', () => {
  const plan = planDialogBeat(input(UNNAMED));
  const fin = finishDialogBeat(input(UNNAMED), plan, SCRIPT);
  const blocks = body(fin.blocks) as any[];
  assert.ok(blocks.every((b) => !b.text.includes('|')), 'no `|` in any block');
  assert.ok(blocks.every((b) => b.speaker_character_id === null && b.speaker_name === null));
  assert.deepEqual(fin.parsed.spoke_ids, []);
  assert.deepEqual(fin.parsed.rejected_names, ['서하린', '도윤']);
  assert.equal(fin.parsed.dropped_lines, 0);
  assert.equal(fin.scene.last_beat?.focus_id, null);
  assert.deepEqual(fin.scene.last_beat?.extra_ids, []);
  assert.equal(fin.scene.turn_no, 3);
});

t('speakers=[] fallback: plain narration still merges, a lone row is still its own paragraph', () => {
  const r = parseScript('첫 줄.\n둘째 줄.\n서하린 | 응.\n셋째 줄.', []);
  assert.deepEqual(r.items, [
    { kind: 'narration', text: '첫 줄.\n둘째 줄.' },
    { kind: 'narration', text: '응.' },
    { kind: 'narration', text: '셋째 줄.' },
  ]);
  assert.deepEqual(r.spoke_ids, []);
});

// ---- 3. controls: non-empty allow-list unchanged ---------------------------

t('control: naming a cast member → targeted, 2 speakers, Pass S bytes identical to 742bedb', () => {
  const plan = planDialogBeat(input(`하린, ${UNNAMED}`));
  assert.equal(plan.focus.reason, 'targeted');
  assert.deepEqual(plan.speakers.map((s) => s.id), ['hr', 'dy']);
  assert.ok(plan.pass_s.includes('`이름 | 대사`'));
  assert.ok(plan.pass_s.includes('대사를 쓸 수 있는 인물은 다음뿐이다: 서하린, 도윤'));
  assert.ok(!plan.pass_s.includes('이번 턴은 캐릭터 대사 없음'));
  assert.equal(sha(plan.pass_s), NAMED_PASS_S_SHA_742BEDB);
});

t('control: second person reconfirms the standing focus → 2 speakers', () => {
  const plan = planDialogBeat(input(`너 ${UNNAMED}`));
  assert.equal(plan.focus.reason, 'targeted');
  assert.equal(plan.speakers.length, 2);
  assert.equal(sha(plan.pass_s), SECOND_PERSON_PASS_S_SHA_742BEDB);
});

t('control: same script with speakers allowed → 5 narration + 5 line blocks', () => {
  const plan = planDialogBeat(input(`하린, ${UNNAMED}`));
  const fin = finishDialogBeat(input(`하린, ${UNNAMED}`), plan, SCRIPT);
  assert.deepEqual(body(fin.blocks).map((b) => b.kind),
    ['narration', 'line', 'narration', 'line', 'narration', 'line', 'narration', 'line', 'narration', 'line']);
  assert.deepEqual(fin.parsed.rejected_names, []);
});

t('control: non-empty allow-list still demotes an unapproved name with its full text (unchanged)', () => {
  const r = parseScript('앞 문단.\n마루 | 나도 있어.\n뒤 문단.', [{ id: 'hr', name: '서하린' }]);
  assert.deepEqual(r.items, [{ kind: 'narration', text: '앞 문단.\n마루 | 나도 있어.\n뒤 문단.' }]);
  assert.deepEqual(r.rejected_names, ['마루']);
});

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
