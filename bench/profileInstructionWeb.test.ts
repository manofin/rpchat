/** npx tsx bench/profileInstructionWeb.test.ts
 * profile-instruction (0023) — web wiring.
 *
 *   helper   → hasInstruction / instructionBadge mirror server resolvePromptPolicy;
 *              estimateInstructionTokens == server estimateTokens; limits/regex shared
 *   settings → PUT payload carries instruction_enabled + instruction_text; clone path validated
 *   editors  → CharacterEditor select bound to default_profile_name (draft restore keeps it);
 *              Story / Output selects only gain a badge; rpOutputProfiles / buildProfileNamePatch unchanged
 *   private  → RPCHAT_PRIVATE_INSTRUCTIONS_DIR=<abs dir of private *.md> (optional): no 16-char
 *              window (containing Hangul) of those files appears in any git-tracked file or in
 *              apps/web/dist — catches fragments, not only copied lines. Unset → the check prints a skip notice. The private text itself never
 *              enters this repo — the bench only reads it from outside at run time.
 *
 * Source + pure helpers only. Isolated: no server, no DB, no browser.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROFILE_INSTRUCTION_MAX as WEB_MAX,
  PROFILE_NAME_RE as WEB_RE,
  estimateInstructionTokens,
  hasInstruction,
  instructionBadge,
} from '../apps/web/src/lib/profileInstruction.ts';
import { buildProfileNamePatch, rpOutputProfiles } from '../apps/web/src/pages/ConversationOutputPage.tsx';
import { resolvePromptPolicy } from '../apps/server/src/prompt/promptPolicy.ts';
import { estimateTokens } from '../apps/server/src/prompt/tokens.ts';
import { PROFILE_INSTRUCTION_MAX as SERVER_MAX } from '../apps/server/src/routes/settings.ts';
import { INSTRUCTION_FILE_MAX, PROFILE_NAME_RE as SERVER_RE } from '../apps/server/src/db/importInstructions.ts';
import type { ModelProfile } from '../apps/web/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}
const src = (rel: string) => fs.readFileSync(path.resolve(rel), 'utf8');

const prof = (o: Partial<ModelProfile>): ModelProfile => ({
  name: 'rp-x', model: null, temperature: 0.8, top_p: 0.95, max_tokens: 800, stop: [], system_mode: 'system', notes: null,
  instruction_enabled: 0, instruction_text: null, ...o,
});

const syntheticInstruction = [
  'PROFILE: TEST_STYLE_ALPHA',
  'SCENE_POLICY: concise-action',
  'OUTPUT_MARKER: synthetic-only',
].join('\n');

t('hasInstruction / badge == server resolvePromptPolicy on the same matrix', () => {
  const matrix: Array<[number, string | null]> = [[0, null], [0, 'x'], [1, null], [1, ' \n '], [1, '# 엔진']];
  for (const [en, tx] of matrix) {
    const server = resolvePromptPolicy({ instruction_enabled: en, instruction_text: tx }).includeEngineInstruction;
    assert.equal(hasInstruction(prof({ instruction_enabled: en, instruction_text: tx })), server, `${en}/${JSON.stringify(tx)}`);
    assert.equal(instructionBadge(prof({ instruction_enabled: en, instruction_text: tx })), server ? ' · 지침' : '');
  }
});

t('estimateInstructionTokens == server estimateTokens (hangul / latin / CJK / calibration)', () => {
  assert.equal(syntheticInstruction.includes('PRIVATE_FIXTURE_MARKER'), false);
  for (const s of ['', syntheticInstruction, '漢字とかな', `${'인과 '.repeat(300)}\n## CORE`]) {
    for (const cal of [1, 1.173, 0.5]) assert.equal(estimateInstructionTokens(s, cal), estimateTokens(s, cal), `${s.slice(0, 10)} × ${cal}`);
  }
});

t('limits and name rule are the same on web, API and file loader', () => {
  assert.equal(WEB_MAX, SERVER_MAX);
  assert.equal(WEB_MAX, INSTRUCTION_FILE_MAX);
  assert.equal(WEB_RE.source, SERVER_RE.source);
  assert.ok(src('apps/server/src/routes/settings.ts').includes(`/${SERVER_RE.source}/.test(req.params.name)`), 'API create regex');
});

t('SettingsPage: payload carries both instruction fields; clone validates name and collisions', () => {
  const s = src('apps/web/src/pages/SettingsPage.tsx');
  const payload = s.slice(s.indexOf('function profilePayload'), s.indexOf('function ProfilesSection'));
  assert.ok(payload.includes('instruction_enabled: p.instruction_enabled === 1'));
  assert.ok(payload.includes('instruction_text: p.instruction_text'));
  assert.ok(s.includes('await put(`/api/profiles/${p.name}`, profilePayload(p))'));
  assert.ok(s.includes('await put(`/api/profiles/${name}`, profilePayload(p))'));
  assert.ok(s.includes('PROFILE_NAME_RE.test(name)') && s.includes("profiles?.some((x) => x.name === name)"));
  assert.ok(s.includes('checked={edit.instruction_enabled === 1}'));
  assert.ok(s.includes('maxLength={PROFILE_INSTRUCTION_MAX}'));
});

t('CharacterEditor: select bound to default_profile_name; new draft null; restore keeps saved value', () => {
  const s = src('apps/web/src/components/CharacterEditor.tsx');
  assert.ok(s.includes("default_profile_name: null, tags: DEFAULT_TAGS"));
  assert.ok(s.includes("value={d.default_profile_name ?? ''}"));
  assert.ok(s.includes("set('default_profile_name', e.target.value || null)"));
  assert.ok(s.includes("pendingDraft.default_profile_name !== undefined ? pendingDraft.default_profile_name : (character?.default_profile_name ?? null)"));
  assert.ok(s.includes("get<ModelProfile[]>('/api/profiles')"));
});

t('Story / Output selects only gain the badge; output helpers unchanged', () => {
  const story = src('apps/web/src/components/StoryEditor.tsx');
  assert.ok(story.includes("{p.name}{p.notes ? ` — ${p.notes}` : ''}{instructionBadge(p)}"));
  const out = src('apps/web/src/pages/ConversationOutputPage.tsx');
  assert.ok(out.includes('max {p.max_tokens}{instructionBadge(p)}'));
  const list = [prof({ name: 'rp-a' }), prof({ name: 'summary' }), prof({ name: 'rp-b', instruction_enabled: 1, instruction_text: 'x' })];
  assert.deepEqual(rpOutputProfiles(list).map((p) => p.name), ['rp-a', 'rp-b']);
  assert.deepEqual(buildProfileNamePatch('rp-b'), { profileName: 'rp-b' });
  assert.equal(buildProfileNamePatch('summary'), null);
});

t('web source does not bundle the bench fixture marker', () => {
  for (const rel of ['apps/web/src/lib/profileInstruction.ts', 'apps/web/src/pages/SettingsPage.tsx', 'apps/web/src/components/CharacterEditor.tsx']) {
    const s = src(rel);
    assert.equal(s.includes('PRIVATE_FIXTURE_MARKER'), false, rel);
    assert.equal(s.includes('TEST_STYLE_ALPHA'), false, rel);
  }
});

t('private instruction text is absent from tracked files and the web build (RPCHAT_PRIVATE_INSTRUCTIONS_DIR)', () => {
  const dir = process.env.RPCHAT_PRIVATE_INSTRUCTIONS_DIR;
  if (!dir) {
    console.log('  skip: RPCHAT_PRIVATE_INSTRUCTIONS_DIR not set — private-text absence not checked on this run');
    return;
  }
  assert.ok(path.isAbsolute(dir) && fs.statSync(dir).isDirectory(), `not an absolute directory: ${dir}`);
  const WINDOW = 16;
  const lines = new Set<string>();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    for (const raw of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const line = raw.trim();
      for (let i = 0; i + WINDOW <= line.length; i++) {
        const w = line.slice(i, i + WINDOW);
        if (/[\uac00-\ud7a3]/.test(w)) lines.add(w);
      }
    }
  }
  assert.ok(lines.size > 0, `no distinctive lines found under ${dir}`);
  const targets = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const dist = path.resolve('apps/web/dist');
  if (fs.existsSync(dist)) {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    targets.push(...walk(dist).map((f) => path.relative(process.cwd(), f)));
  }
  const hits = new Set<string>();
  for (const rel of targets) {
    if (!fs.existsSync(rel) || !fs.statSync(rel).isFile()) continue;
    const body = fs.readFileSync(rel, 'utf8');
    for (const line of lines) {
      if (body.includes(line)) {
        hits.add(rel);
        break;
      }
    }
  }
  assert.deepEqual([...hits], [], `private instruction text found in:\n${[...hits].join('\n')}`);
  console.log(`  checked ${lines.size} private ${WINDOW}-char windows × ${targets.length} files`);
});

console.log(`PASS=${passed}`);
