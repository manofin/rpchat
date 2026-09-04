/**
 * npx tsx bench/designTokens.test.ts
 * RPChat 역할색 디자인 적용 — semantic role tokens and their contrast contract.
 *
 * The design input (StoryForge 추천안) is written for a light paper product; this
 * app is KAMI dark. So what was adopted is the *principle* — one accent must not
 * stand for every state — and the palette had to be re-derived: the document's raw
 * values fail WCAG as text on this app's brightest surface. That derivation is not
 * a comment here, it is recomputed below from the stylesheet on every run, so a
 * later "just nudge the hex" cannot quietly drop a token under threshold.
 *
 * Pure: reads source, computes contrast, runs two shipped pure functions.
 * No browser, no DB, no model, no network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHubItems, summarizeConversationDetail, WEB_APP_VERSION } from '../apps/web/src/lib/conversationSettings.ts';
import { visualAssistantOrder } from '../apps/web/src/lib/chatLayout.ts';
import { serializeHunterBeat } from '../apps/server/src/prompt/renderHunter.ts';
import type { Character, Conversation, ConversationDetail, Message, Persona } from '../apps/web/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => fs.readFileSync(path.join(dir, '..', rel), 'utf8');
const css = src('apps/web/src/app.css');
/** Comment-stripped, so a hex quoted in prose never counts as a declaration. */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

// ── token table ─────────────────────────────────────────────────────────────

/** `--name: value;` pairs from `:root`, with one level of `var()` alias resolved. */
function rootTokens(): Record<string, string> {
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(cssCode);
  assert.ok(root, ':root block must exist');
  const out: Record<string, string> = {};
  for (const m of root![1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  for (const [k, v] of Object.entries(out)) {
    const alias = /^var\((--[\w-]+)\)$/.exec(v);
    if (alias && out[alias[1]]) out[k] = out[alias[1]];
  }
  return out;
}
const T = rootTokens();

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const ch = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const ROLES = ['coral', 'violet', 'teal', 'gold'] as const;
/**
 * Every background a role token can be painted on, brightest last. `--kami-surface`
 * is the assistant bubble — the streaming cursor sits inside one, which is why the
 * text tokens are calibrated against it rather than against the page background.
 */
const SURFACES = ['--bg', '--kami-deep', '--panel-1', '--panel-2', '--kami-charcoal', '--kami-surface'];

// ── 1. existence and separation ─────────────────────────────────────────────

t('the four role tokens exist in both a fill and a text form', () => {
  for (const r of ROLES) {
    assert.match(T[`--role-${r}`] ?? '', /^#[0-9A-Fa-f]{6}$/, `--role-${r}`);
    assert.match(T[`--role-${r}-text`] ?? '', /^#[0-9A-Fa-f]{6}$/, `--role-${r}-text`);
  }
  // Distinct meanings need distinct values; two roles sharing a hex is the
  // "one accent for every state" failure this slice exists to undo.
  const fills = ROLES.map((r) => T[`--role-${r}`].toUpperCase());
  assert.equal(new Set(fills).size, ROLES.length, 'role fills must be four different colors');
  const texts = ROLES.map((r) => T[`--role-${r}-text`].toUpperCase());
  assert.equal(new Set(texts).size, ROLES.length, 'role text tokens must be four different colors');
});

t('danger, link accent and the role colors stay independent tokens', () => {
  const roleValues = new Set(ROLES.flatMap((r) => [T[`--role-${r}`], T[`--role-${r}-text`]].map((v) => v.toUpperCase())));
  // --danger must not collapse into Coral: the primary CTA and a destructive
  // action would then read the same.
  assert.ok(!roleValues.has(T['--danger'].toUpperCase()), '--danger must not equal a role color');
  assert.ok(T['--accent'] && !roleValues.has(T['--accent'].toUpperCase()), '--accent (links) must stay separate');
  assert.match(cssCode, /\.btn\.danger[^}]*var\(--danger\)/, '.btn.danger still uses --danger');
  assert.match(cssCode, /^a \{ color: var\(--accent\)/m, 'links still use --accent');
});

t('identity and measurement keep their old colors — they are not states', () => {
  // Avatar gradient identifies a character; the budget bar measures tokens.
  assert.match(cssCode, /\.avatar \{[^}]*linear-gradient\(135deg, var\(--accent-2\)/);
  assert.match(cssCode, /\.budget-row \.bar i \{[^}]*background: var\(--accent\)/);
});

// ── 2·3·4. contrast, measured ───────────────────────────────────────────────

t('every role text token clears 4.5:1 on every surface it can land on', () => {
  for (const r of ROLES) {
    for (const s of SURFACES) {
      const ratio = contrast(T[`--role-${r}-text`], T[s]);
      assert.ok(ratio >= 4.5, `--role-${r}-text on ${s} = ${ratio.toFixed(2)} (<4.5)`);
    }
  }
});

t('body and panel text clear 4.5:1 on the panel surfaces they were moved onto', () => {
  for (const s of ['--panel-1', '--panel-2']) {
    for (const fg of ['--kami-text', '--kami-text-strong', '--kami-text-muted']) {
      const ratio = contrast(T[fg], T[s]);
      assert.ok(ratio >= 4.5, `${fg} on ${s} = ${ratio.toFixed(2)}`);
    }
  }
  // The INFO sheet must read as a step above the page, not as a second bubble.
  const step = contrast(T['--panel-2'], T['--bg']);
  assert.ok(step > 1.05 && step < 1.6, `--panel-2 vs --bg = ${step.toFixed(2)} — visible but calm`);
});

t('role fills used as lines or marks clear 3:1 where they are actually painted', () => {
  // Gold: the choice group's left rule, on the chip's charcoal.
  assert.ok(contrast(T['--role-gold'], T['--kami-charcoal']) >= 3, 'gold rule on chip');
  // Coral: the active conversation rail, on the rail's deep background.
  assert.ok(contrast(T['--role-coral'], T['--kami-deep']) >= 3, 'coral rail on list');
  // Teal: the ok dot, on the page.
  assert.ok(contrast(T['--role-teal'], T['--bg']) >= 3, 'teal dot on page');
  // The label on a filled Coral CTA — #fff would be 3.64 here.
  assert.ok(contrast(T['--role-on-fill'], T['--role-coral']) >= 4.5, 'CTA label on coral fill');
});

t('violet is only shipped in the form that passes: raw violet is never a line', () => {
  // Measured: raw #7667C8 is 2.86 on charcoal and 2.50 on surface — below the 3:1
  // a non-text boundary needs. So the alias exists and points at the text value…
  assert.equal(T['--role-violet-line'], T['--role-violet-text']);
  assert.ok(contrast(T['--role-violet'], T['--kami-surface']) < 3, 'the exception is real, not decorative');
  assert.ok(contrast(T['--role-violet-line'], T['--kami-surface']) >= 3);
  // …and no rule paints the raw token, so the failing case cannot ship.
  const uses = cssCode.match(/var\(--role-violet\)/g) ?? [];
  assert.equal(uses.length, 0, 'raw --role-violet must not be used in a declaration');
  // The one violet surface in the product is the streaming cursor, inside a bubble.
  assert.match(cssCode, /\.cursor::after[^}]*var\(--role-violet-text\)/);
});

// ── colour budget ───────────────────────────────────────────────────────────

t('narration, lines and the INFO sheets carry no role color at all', () => {
  // The turn's reading matter stays neutral; colour marks state, not prose.
  for (const sel of ['.beat-narration', '.beat-line-hunter', '.beat-info', '.beat-panel']) {
    const rule = new RegExp(`\\${sel} \\{[^}]*\\}`).exec(cssCode)?.[0] ?? '';
    assert.ok(rule, `${sel} rule must exist`);
    assert.ok(!/--role-/.test(rule), `${sel} must not use a role color`);
  }
  assert.match(cssCode, /\.beat-panel \{[^}]*background: var\(--panel-2\)/, 'INFO panel is a neutral step, not a tint');
});

t('one turn shows at most two role colors, and never one per choice', () => {
  // Blocks that can be on screen together in a single turn.
  const turnRules = (cssCode.match(/^\.(beat|chip|chips|cursor)[^{]*\{[^}]*\}/gm) ?? []).join('\n');
  const used = new Set([...turnRules.matchAll(/var\(--role-(\w+?)(?:-text|-line)?\)/g)].map((m) => m[1]));
  // teal = the system voice, gold = the recommendation group, violet = streaming.
  // Choices only render when nothing is streaming, so at most two are ever visible.
  assert.ok(used.size <= 3, `turn-scope role colors: ${[...used].join(', ')}`);
  assert.ok(!/\.chip:nth-child|\.chip\.coral|\.chip\.violet|\.chip\.teal/.test(cssCode),
    'the three choices must not be painted one colour each');
  const chip = /^\.chip \{[^}]*\}/m.exec(cssCode)?.[0] ?? '';
  assert.match(chip, /border-left: 3px solid var\(--role-gold\)/, 'recommendation is a rule, not a fill');
  assert.ok(!/background: var\(--role-gold\)/.test(chip), 'the chip body stays neutral');
});

// ── 6·7. what must not have arrived ─────────────────────────────────────────

t('no Tailwind, no framework, and no light theme or toggle came with the palette', () => {
  assert.ok(!/@tailwind|@apply/.test(css));
  assert.ok(!/^\s*inset-[xy]\s*:/m.test(css), 'Tailwind utility names are not CSS properties');
  const pkg = src('apps/web/package.json');
  for (const dep of ['tailwindcss', '"next"', 'styled-components', '@emotion']) {
    assert.ok(!pkg.includes(dep), dep);
  }
  assert.equal((css.match(/color-scheme:\s*dark/g) ?? []).length, 1, 'KAMI dark stays the only scheme');
  assert.ok(!/color-scheme:\s*light/.test(css));
  assert.ok(!/prefers-color-scheme/.test(css), 'no theme switching in this slice');
  assert.ok(!/data-theme|\.theme-light|toggleTheme/.test(css + src('apps/web/src/pages/ChatPage.tsx')));
});

// ── 8·9. contracts this slice must not have moved ───────────────────────────

const conversation = {
  id: 'c1', character_id: 'ch1', persona_id: 'p1', title: '방', mode: 'chat',
  profile_name: 'rp-balanced', scene: { place: '항구', time: '밤' }, head_message_id: null,
  prompt_version: 'pv', favorite: false, archived: false, created_at: '', updated_at: '',
  last_message_at: null, user_note: 'x'.repeat(20), persona_applied_at: '2026-08-25T00:00:00Z',
} as unknown as Conversation;
const detail: ConversationDetail = {
  conversation,
  character: { id: 'ch1', name: '서리', avatar: '/a.png', tags: [] } as unknown as Character,
  persona: { id: 'p1', name: '나', is_default: true } as unknown as Persona,
  messages: [],
  activeGeneration: null,
};

t('the settings hub item set is byte-identical to the pre-slice contract', () => {
  const items = buildHubItems(summarizeConversationDetail(detail, WEB_APP_VERSION));
  assert.deepEqual(items.map((i) => i.id), ['guide', 'profile', 'user-note', 'output', 'memory', 'style', 'scene-image', 'start', 'about']);
  assert.deepEqual(items.map((i) => i.section), ['room', 'room', 'room', 'room', 'room', 'global', 'global', 'start', 'about']);
  // Only the drawer's presentation moved: section order and titles.
  const tools = src('apps/web/src/pages/ConversationTools.tsx');
  assert.match(tools, /SECTION_ORDER[^=]*=\s*\['start', 'room', 'global', 'about'\]/);
  assert.ok(!/buildHubItems\s*\(/.test(tools.split('const SECTION_TITLE')[0]), 'the catalog is still read, not rebuilt');
});

t('hunter/dialog/beat block order and content are untouched by the restyle', () => {
  // Server serialization: the panel is still last, and nothing was renamed.
  const blocks = serializeHunterBeat({
    panel: 'INFO\n\n⏳️-1',
    script: [
      { kind: 'narration', text: '비가 그쳤다' },
      { kind: 'line', character_id: 'kde', name: '강다은', text: '"물러서라."' },
      { kind: 'system', text: '가호 및 스킬 생성 완료' },
    ],
  });
  assert.deepEqual(blocks.map((b) => b.kind), ['narration', 'line', 'system', 'panel']);
  assert.equal(blocks[0].text, '『비가 그쳤다』');
  assert.deepEqual(blocks.map((b) => b.seq), [0, 1, 2, 3]);

  // Client permutation: still a view-only move of INFO/panel to the end, with the
  // same set of messages going in and coming out.
  const msg = (id: string, kind?: string): Message =>
    ({ id, role: 'assistant', content: '', meta: kind ? { block_kind: kind } : {} } as unknown as Message);
  const input = [msg('a', 'narration'), msg('b', 'panel'), msg('c', 'line')];
  const out = visualAssistantOrder(input, true);
  assert.deepEqual(out.map((m) => m.id), ['a', 'c', 'b']);
  assert.equal(out.length, input.length);
});

console.log(`\n${passed} passed`);
