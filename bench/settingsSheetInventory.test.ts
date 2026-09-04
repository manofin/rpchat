/** npx tsx bench/settingsSheetInventory.test.ts
 * Gate 2 follow-up lock, re-stated for the RPChat UI 확장 drawer shell:
 * where the in-chat settings entry goes, and which write paths still exist.
 *
 * The entry moved from `navigate(`/chat/${id}/settings`)` to the right-hand
 * tools drawer. That is the contract asserted here — restoring the old
 * navigation to make this file pass would undo the slice it is meant to lock.
 * The hub *route* is a separate thing and is asserted to still exist: only the
 * in-chat jump was removed, not the deep link.
 *
 * Source inventory + pure lib only. Does not open a browser or call APIs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  WEB_APP_VERSION, buildHubItems, isRowNavigable, resolveSettingsRoute, summarizeConversationDetail,
} from '../apps/web/src/lib/conversationSettings.ts';
import type { Character, Conversation, ConversationDetail, Persona } from '../apps/web/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const read = (rel: string) => fs.readFileSync(path.resolve(rel), 'utf8');
/** Comment-stripped, so a mention in prose never satisfies a code assertion. */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** JSX attributes wrap; compare on collapsed whitespace. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

const chat = read('apps/web/src/pages/ChatPage.tsx');
const chatCode = code('apps/web/src/pages/ChatPage.tsx');
const tools = read('apps/web/src/pages/ConversationTools.tsx');
const settingsPage = read('apps/web/src/pages/ConversationSettingsPage.tsx');
const app = read('apps/web/src/App.tsx');

/** The `<OverlayDrawer …>` element that wraps `marker`. */
function drawerAround(source: string, marker: string): string {
  const at = source.indexOf(marker);
  assert.ok(at > 0, `expected ${marker} in source`);
  const start = source.lastIndexOf('<OverlayDrawer', at);
  const end = source.indexOf('</OverlayDrawer>', at);
  assert.ok(start >= 0 && end > start, `${marker} is not inside an OverlayDrawer`);
  return flat(source.slice(start, end));
}

// ── write paths: unchanged by the drawer slice ──────────────────────────────

t('no remaining setSettings(true) — sheet has no user entry', () => {
  assert.equal((chat.match(/setSettings\(true\)/g) || []).length, 0);
});

t('sheet is still mounted on ChatPage (write path preserved)', () => {
  assert.match(chat, /<ConversationSettings open=\{settings\}/);
});

t('same-persona click is a no-op — cannot reapply via old sheet', () => {
  assert.match(chat, /if \(p\.id === current\) return;/);
});

t('old sheet still PATCHes personaId on a different pick', () => {
  assert.match(chat, /patch\(`\/api\/conversations\/\$\{conversationId\}`, \{ personaId: p\.id \}\)/);
});

t('old sheet still writes profileName', () => {
  assert.match(chat, /save\(\{ profileName: e\.target\.value \}\)/);
});

t('new hub page does not PATCH persona or profile', () => {
  assert.doesNotMatch(settingsPage, /personaId/);
  assert.doesNotMatch(settingsPage, /profileName/);
  assert.doesNotMatch(settingsPage, /\bpatch\(/);
});

// ── entry point: the drawer, not a route jump ───────────────────────────────

t('the in-chat settings entry opens the tools drawer instead of navigating', () => {
  // Title tap — the affordance that used to jump to the hub route.
  assert.match(flat(chatCode), /className="title" onClick=\{\(\) => setToolsOpen\(true\)\}/);
  // And an explicit control, so the entry does not depend on knowing the title is tappable.
  assert.match(flat(chatCode), /data-test="chat-tools"[^>]*onClick=\{\(\) => setToolsOpen\(\(v\) => !v\)\}/);
  assert.ok(!chatCode.includes('navigate(`/chat/${id}/settings`)'), 'in-chat hub navigation is intentionally gone');
});

t('the tools drawer is right-side, closable, and carries this conversation id', () => {
  const drawer = drawerAround(chatCode, '<ConversationTools');
  assert.ok(drawer.includes('side="right"'), 'settings live on the right');
  assert.ok(drawer.includes('open={toolsOpen}'));
  assert.ok(drawer.includes('onClose={() => setToolsOpen(false)}'), 'the drawer must be closable');
  assert.match(drawer, /<ConversationTools conversationId=\{id\}/);
  // The list rail is the other side, so "right" above is a real choice.
  assert.ok(drawerAround(chatCode, '<ChatListRail').includes('side="left"'));
});

t('mobile gets an overlay, desktop gets a rail that starts open', () => {
  const drawer = drawerAround(chatCode, '<ConversationTools');
  assert.ok(drawer.includes("mode={desktop ? 'rail' : 'overlay'}"));
  assert.match(chatCode, /useState\(desktop\)/, 'the desktop rail is open on arrival');
  // Leaving the desktop breakpoint must not strand an open rail as a stuck overlay.
  assert.match(flat(chatCode), /if \(desktop\) \{ setListOpen\(false\); return; \} setListOpen\(false\); setToolsOpen\(false\);/);
});

// ── inventory: the drawer keeps every hub row ───────────────────────────────

const conversation = {
  id: 'c1', character_id: 'ch1', persona_id: 'p1', title: '방', mode: 'chat',
  profile_name: 'rp-balanced', scene: { place: '항구', time: '밤' }, head_message_id: null,
  prompt_version: 'pv', favorite: false, archived: false, created_at: '', updated_at: '',
  last_message_at: null, user_note: 'x'.repeat(20), persona_applied_at: '2026-08-25T00:00:00Z',
} as unknown as Conversation;
const character = { id: 'ch1', name: '서리', avatar: '/a.png', tags: [] } as unknown as Character;
const persona = { id: 'p1', name: '나', is_default: true } as unknown as Persona;
const detail: ConversationDetail = {
  conversation, character, persona, messages: [], activeGeneration: null,
};
const items = buildHubItems(summarizeConversationDetail(detail, WEB_APP_VERSION));

t('every navigable hub row is reachable inside the drawer', () => {
  const navigable = items.filter(isRowNavigable).map((i) => i.id).sort();
  const handled = [...new Set([...tools.matchAll(/(?:leaf|id) === '([a-z-]+)'/g)].map((m) => m[1]))].sort();
  assert.ok(navigable.length > 0, 'fixture must produce navigable rows');
  // Set equality both ways: a new hub leaf that the drawer forgot fails here, and
  // so does a drawer branch for a row the hub no longer offers.
  assert.deepEqual(handled, navigable);
});

t('each drawer leaf gets the conversation id and a back that returns to the hub', () => {
  const mounts = [...tools.matchAll(/<Conversation\w+Page conversationId=\{conversationId\} onBack=\{goHub\} \/>/g)];
  assert.equal(mounts.length, items.filter(isRowNavigable).length);
  // goHub returns to the drawer's own hub view and refreshes the chat behind it;
  // it must not navigate the app away.
  assert.match(tools, /const goHub = \(\) => \{\s*setLeaf\(null\);\s*onChanged\(\);/);
  assert.ok(!code('apps/web/src/pages/ConversationTools.tsx').includes('navigate('));
});

t('read-only rows survive the move as value rows, not dropped items', () => {
  const readOnly = items.filter((i) => i.state === 'read-only').map((i) => i.id);
  assert.ok(readOnly.includes('start') && readOnly.includes('about'));
  assert.ok(tools.includes('SettingsValueRow'), 'value rows still render in the drawer');
  assert.ok(tools.includes('SettingsToggleRow'), 'disabled toggles still render in the drawer');
  assert.ok(tools.includes('buildHubItems'), 'the drawer reads the same catalog as the hub page');
});

// ── the route stayed: only the in-chat jump was removed ─────────────────────

t('the hub route still resolves and still renders — the deep link is intact', () => {
  assert.deepEqual(resolveSettingsRoute('/chat/c1/settings'), { kind: 'hub', conversationId: 'c1' });
  assert.deepEqual(resolveSettingsRoute('/chat/c1/settings/memory'), {
    kind: 'leaf', conversationId: 'c1', leaf: 'memory',
  });
  assert.ok(app.includes('resolveSettingsRoute') && app.includes('<ConversationSettingsPage'));
});

t('a leaf keeps its route-based back when no drawer onBack is passed', () => {
  const guide = read('apps/web/src/pages/ConversationGuidePage.tsx');
  assert.match(guide, /onBack\?: \(\) => void/);
  assert.match(guide, /const goBack = onBack \?\? \(\(\) => back\(settingsBackFallback\(conversationId, 'leaf'\)\)\)/);
  // The standalone page mounts leaves without onBack, which is what makes the
  // fallback the live path for a deep link.
  assert.match(settingsPage, /<ConversationMemoryPage conversationId=\{route\.conversationId\} \/>/);
});

console.log(`passed ${passed}`);
