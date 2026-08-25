/** npx tsx bench/routerSettings.test.ts
 * Gate 2 — conversation-settings-shell
 * Characterizes live match() then locks settings routes on top of it.
 */
import assert from 'node:assert/strict';
import { match } from '../apps/web/src/lib/router.ts';
import {
  SETTINGS_LEAVES,
  resolveSettingsRoute,
} from '../apps/web/src/lib/conversationSettings.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const CID = '09e7827f-aaaa-4d97-96dc-e00c4b25a819';

t('live /chat/:id still matches a bare chat path', () => {
  assert.deepEqual(match(`/chat/${CID}`, '/chat/:id'), { id: CID });
});

t('live /chat/:id does not swallow /settings (segment-length lock)', () => {
  assert.equal(match(`/chat/${CID}/settings`, '/chat/:id'), null);
  assert.equal(match(`/chat/${CID}/settings/profile`, '/chat/:id'), null);
});

t('/chat/:id/settings is the settings hub', () => {
  assert.deepEqual(resolveSettingsRoute(`/chat/${CID}/settings`), {
    kind: 'hub',
    conversationId: CID,
  });
});

t('each registered settings leaf matches its path', () => {
  for (const leaf of SETTINGS_LEAVES) {
    assert.deepEqual(resolveSettingsRoute(`/chat/${CID}/settings/${leaf}`), {
      kind: 'leaf',
      conversationId: CID,
      leaf,
    });
  }
});

t('unknown settings leaf is not a settings route (existing not-found)', () => {
  assert.equal(resolveSettingsRoute(`/chat/${CID}/settings/nope`), null);
  assert.equal(resolveSettingsRoute(`/chat/${CID}/settings/scene-image`), null);
});

t('bare chat path is not a settings route', () => {
  assert.equal(resolveSettingsRoute(`/chat/${CID}`), null);
});

t('malformed conversation segment still pattern-matches; 404 is page-level', () => {
  assert.deepEqual(resolveSettingsRoute('/chat/not-a-uuid/settings'), {
    kind: 'hub',
    conversationId: 'not-a-uuid',
  });
});

console.log(`passed ${passed}`);
