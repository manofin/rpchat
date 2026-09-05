/**
 * npx tsx bench/lightTheme.test.ts
 * light-paper-theme-toggle — the light theme's own contrast contract, and proof
 * that KAMI dark (bench/designTokens.test.ts's contract) did not move.
 *
 * design-role-tokens-spec.md §6 named this "a separate slice." The base derived
 * here is the brief's own light palette quoted in that spec's §1 (Ink #201D24 /
 * Paper #F8F5F0 / Panel #FFFDF9), re-fit to this app's token structure the same
 * way §2 re-derived the dark role-text values: contrast is recomputed from the
 * shipped `:root[data-theme='light']` block on every run, not asserted as hex
 * literals, so a later "just nudge the hex" fails here instead of shipping.
 *
 * Pure: reads source, computes contrast. No browser, no DB, no model, no network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTheme, parseTheme, persistTheme, readTheme, THEME_STORAGE_KEY } from '../apps/web/src/lib/theme.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => fs.readFileSync(path.join(dir, '..', rel), 'utf8');
const css = src('apps/web/src/app.css');
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

function block(re: RegExp): string {
  const m = re.exec(cssCode);
  assert.ok(m, `block not found: ${re}`);
  return m![1];
}
const darkBlock = block(/:root\s*\{([\s\S]*?)\n\}/);
const lightBlock = block(/:root\[data-theme=['"]light['"]\]\s*\{([\s\S]*?)\n\}/);

function parseTokens(blockText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of blockText.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const D = parseTokens(darkBlock);
/** Light tokens with one alias level resolved, falling back to dark — the real cascade. */
const L: Record<string, string> = { ...D, ...parseTokens(lightBlock) };
for (const [k, v] of Object.entries(L)) {
  const alias = /^var\((--[\w-]+)\)$/.exec(v);
  if (alias) L[k] = L[alias[1]];
}

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
const SURFACES = ['--bg', '--kami-deep', '--panel-1', '--panel-2', '--kami-charcoal', '--kami-surface'];

// ── the light block itself ──────────────────────────────────────────────────

t('a single :root[data-theme=light] override block exists, with color-scheme: light once', () => {
  assert.match(lightBlock, /color-scheme:\s*light/);
  assert.equal((cssCode.match(/color-scheme:\s*light/g) ?? []).length, 1);
  assert.equal((cssCode.match(/data-theme=/g) ?? []).length, 1, 'exactly one theme-scoped selector');
});

t('no Tailwind-shaped declarations in the light block', () => {
  assert.ok(!/^\s*inset-[xy]\s*:/m.test(lightBlock));
});

// ── dark did not move ────────────────────────────────────────────────────────

t('KAMI dark base :root is byte-identical on every token this slice could have touched', () => {
  // Snapshot at the point this slice started (v0.0.19-106-gc4475b5). Any diff
  // here is dark-theme regression, not a light-theme change.
  const expect: Record<string, string> = {
    '--bg': '#0f1115', '--bg-2': '#161a22', '--bg-3': '#1e2430',
    '--fg': '#e8eaf0', '--fg-2': '#a3a9b8', '--fg-3': '#6b7283',
    '--accent': '#7c5cff', '--accent-2': '#5b42d6',
    '--danger': '#ff5c6c', '--ok': '#3ddc97', '--warn': '#ffb454',
    '--user-bubble': '#2a2f6b', '--char-bubble': '#1d222c',
    '--kami-ink': '#2D5A8A', '--kami-deep': '#141413', '--kami-charcoal': '#30302E', '--kami-surface': '#3A3935',
    '--kami-text-strong': '#F2F0E8', '--kami-text': '#D4D0C6', '--kami-text-muted': '#AAA69B', '--kami-text-faint': '#817E75',
    '--kami-line': 'rgba(232,230,220,0.18)', '--kami-line-soft': 'rgba(232,230,220,0.10)',
    '--role-coral': '#E4574F', '--role-violet': '#7667C8', '--role-teal': '#2C9C91', '--role-gold': '#C9963E',
    '--role-coral-text': '#EB857F', '--role-violet-text': '#A49ADA', '--role-teal-text': '#33B4A7', '--role-gold-text': '#CB9944',
    '--role-on-fill': '#1A1113',
    '--panel-1': '#17171A', '--panel-2': '#202024',
  };
  for (const [k, v] of Object.entries(expect)) assert.equal(D[k], v, k);
  assert.match(darkBlock, /color-scheme:\s*dark;/);
});

t('the light block redefines only surface/text/line tokens — brand fills stay theme-invariant', () => {
  const lightKeys = Object.keys(parseTokens(lightBlock));
  // Raw role fills, --role-on-fill, --accent-2 and --kami-ink pair with their own
  // label or already clear the light surfaces unmodified (spec derivation above);
  // redefining them here would mean the CTA and avatar change color per theme.
  for (const forbidden of ['--role-coral', '--role-violet', '--role-teal', '--role-gold', '--role-on-fill', '--accent-2', '--kami-ink', '--radius', '--app-height']) {
    assert.ok(!lightKeys.includes(forbidden), `${forbidden} must not be redefined for light`);
  }
});

// ── the light contract, recomputed ──────────────────────────────────────────

t('every role text token clears 4.5:1 on every light surface it can land on', () => {
  for (const r of ROLES) {
    for (const s of SURFACES) {
      const ratio = contrast(L[`--role-${r}-text`], L[s]);
      assert.ok(ratio >= 4.5, `light --role-${r}-text on ${s} = ${ratio.toFixed(2)} (<4.5)`);
    }
  }
});

t('body and panel text clear 4.5:1 on light panel-1/panel-2', () => {
  for (const s of ['--panel-1', '--panel-2']) {
    for (const fg of ['--kami-text', '--kami-text-strong', '--kami-text-muted']) {
      const ratio = contrast(L[fg], L[s]);
      assert.ok(ratio >= 4.5, `light ${fg} on ${s} = ${ratio.toFixed(2)}`);
    }
  }
  const step = contrast(L['--panel-2'], L['--bg']);
  assert.ok(step > 1.05 && step < 1.6, `light --panel-2 vs --bg = ${step.toFixed(2)}`);
});

t('role fills used as lines clear 3:1 on light surfaces, same as dark', () => {
  // Gold: raw fails on the light chip background (2.04), which is exactly why
  // --role-gold-line exists; it must resolve to the light text value here.
  assert.ok(contrast(L['--role-gold'], L['--kami-charcoal']) < 3, 'the light gold exception is real, not decorative');
  assert.equal(L['--role-gold-line'], L['--role-gold-text']);
  assert.ok(contrast(L['--role-gold-line'], L['--kami-charcoal']) >= 3, 'gold rule on light chip');
  // Coral and teal pass unmodified in light too (measured, not assumed).
  assert.ok(contrast(L['--role-coral'], L['--kami-deep']) >= 3, 'coral rail on light list');
  assert.ok(contrast(L['--role-teal'], L['--bg']) >= 3, 'teal dot on light page');
  assert.ok(contrast(L['--role-on-fill'], L['--role-coral']) >= 4.5, 'CTA label on coral fill (theme-invariant)');
});

t('dark rendering of the gold rule is unchanged by the new alias', () => {
  assert.equal(D['--role-gold-line'], 'var(--role-gold)');
  assert.match(cssCode, /\.chip \{[^}]*border-left: 3px solid var\(--role-gold-line\)/);
});

t('danger, warn and accent stay legible as text on light surfaces', () => {
  for (const tok of ['--danger', '--warn', '--accent']) {
    const ratio = contrast(L[tok], L['--bg']);
    assert.ok(ratio >= 4.5, `light ${tok} on --bg = ${ratio.toFixed(2)}`);
  }
  // kami-ink (message border, jump-flash outline) was not redefined — confirm it
  // still clears a non-text 3:1 on the light page rather than assuming it.
  assert.ok(contrast(L['--kami-ink'], L['--bg']) >= 3);
});

// ── the toggle mechanism ─────────────────────────────────────────────────────

t('lib/theme.ts: parse/read fall back to dark, apply sets and clears data-theme', () => {
  assert.equal(parseTheme(undefined), 'dark');
  assert.equal(parseTheme(null), 'dark');
  assert.equal(parseTheme('light'), 'light');
  assert.equal(parseTheme('nonsense'), 'dark');
  assert.equal(THEME_STORAGE_KEY, 'rpchat.theme');

  const root = { dataset: {} as { theme?: string } };
  applyTheme('light', root);
  assert.equal(root.dataset.theme, 'light');
  applyTheme('dark', root);
  assert.equal(root.dataset.theme, undefined);

  // readTheme/persistTheme must not throw where localStorage is unavailable.
  assert.equal(readTheme(), 'dark');
  persistTheme('light');
});

t('main.tsx applies the persisted theme at boot, the same way it applies the font preset', () => {
  const main = src('apps/web/src/main.tsx');
  assert.match(main, /applyTheme\(readTheme\(\)\)/);
  assert.match(main, /applyFontPreset\(readFontPreset\(\)\)/, 'existing boot-time preset application stays');
});

t('SettingsPage and TopNav host theme toggles, wired to persist + apply', () => {
  const settings = src('apps/web/src/pages/SettingsPage.tsx');
  assert.match(settings, /persistTheme\(next\)/);
  assert.match(settings, /applyTheme\(next\)/);
  assert.match(settings, /readTheme\(\)/);
  const topnav = src('apps/web/src/components/TopNav.tsx');
  assert.match(topnav, /persistTheme\(/);
  assert.match(topnav, /applyTheme\(/);
  assert.match(topnav, /readTheme\(/);
  assert.match(topnav, /theme-toggle/);
  // Pages: Settings remains the only *page* importer; chrome toggle lives in TopNav.
  const pageFiles = fs.readdirSync(path.join(dir, '..', 'apps/web/src/pages')).filter((f) => f.endsWith('.tsx'));
  const importers = pageFiles.filter((f) => src(`apps/web/src/pages/${f}`).includes("from '../lib/theme'"));
  assert.deepEqual(importers, ['SettingsPage.tsx']);
});

console.log(`\n${passed} passed`);
