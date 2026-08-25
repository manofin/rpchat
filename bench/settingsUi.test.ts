/** npx tsx bench/settingsUi.test.ts
 * Gate 2 — settings UI shell. No server writes.
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SettingsBadge,
  SettingsBottomAction,
  SettingsEmptyState,
  SettingsNavigationRow,
  SettingsPageHeader,
  SettingsPageLayout,
  SettingsSection,
  SettingsToggleRow,
  SettingsValueRow,
} from '../apps/web/src/components/settings.tsx';
import { applySceneImageToggle, isRowNavigable } from '../apps/web/src/lib/conversationSettings.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

t('section title renders', () => {
  const html = renderToStaticMarkup(
    createElement(SettingsSection, { title: '채팅방 설정' }, createElement('div', null, 'row')),
  );
  assert.match(html, /채팅방 설정/);
});

t('navigation row shows title and current value; chevron is decorative', () => {
  const html = renderToStaticMarkup(
    createElement(SettingsNavigationRow, {
      title: '대화 프로필',
      value: '나',
      href: '/chat/c1/settings/profile',
    }),
  );
  assert.match(html, /대화 프로필/);
  assert.match(html, />나</);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /min-height:44px|settings-row/);
});

t('disabled row is not navigable and states 미연결', () => {
  const html = renderToStaticMarkup(
    createElement(SettingsNavigationRow, {
      title: '잠금',
      href: '/nope',
      disabled: true,
    }),
  );
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /미연결/);
  assert.equal(
    isRowNavigable({
      id: 'x',
      section: 'room',
      title: '잠금',
      state: 'disabled',
      control: 'navigate',
      href: '/nope',
    }),
    false,
  );
});

t('toggle does not invoke a PATCH callback', () => {
  let patches = 0;
  applySceneImageToggle(() => {
    patches += 1;
  });
  const html = renderToStaticMarkup(
    createElement(SettingsToggleRow, {
      title: '상황 이미지 보기',
      checked: false,
      disabled: true,
      onChange: () => {
        patches += 1;
      },
    }),
  );
  assert.match(html, /상황 이미지 보기/);
  assert.match(html, /role="switch"/);
  assert.equal(patches, 0);
});

t('value row and badge render; empty state is explicit', () => {
  const value = renderToStaticMarkup(createElement(SettingsValueRow, { title: '앱 버전', value: '0.1.0' }));
  const badge = renderToStaticMarkup(createElement(SettingsBadge, { children: '균형' }));
  const empty = renderToStaticMarkup(createElement(SettingsEmptyState, { message: '대화를 찾을 수 없습니다.' }));
  const footer = renderToStaticMarkup(createElement(SettingsBottomAction, { children: '닫기' }));
  assert.match(value, /앱 버전/);
  assert.match(value, /0\.1\.0/);
  assert.match(badge, /균형/);
  assert.match(empty, /대화를 찾을 수 없습니다/);
  assert.match(footer, /닫기/);
});

t('layout uses dedicated settings container, not chat-scroll', () => {
  const html = renderToStaticMarkup(
    createElement(
      SettingsPageLayout,
      {
        header: createElement(SettingsPageHeader, {
          title: '긴대화방이름테스트용제목입니다정말로깁니다',
          subtitle: '서리',
          onBack: () => undefined,
        }),
      },
      createElement('p', null, 'body'),
    ),
  );
  assert.match(html, /settings-screen/);
  assert.match(html, /settings-main/);
  assert.doesNotMatch(html, /chat-scroll/);
  assert.match(html, /긴대화방이름테스트용제목입니다정말로깁니다/);
});

t('navigation row is a button so Enter/Space activate the whole row', () => {
  const html = renderToStaticMarkup(
    createElement(SettingsNavigationRow, {
      title: '플레이 가이드',
      href: '/chat/c1/settings/guide',
    }),
  );
  assert.match(html, /<button/);
  assert.doesNotMatch(html, /settings-chevron[^>]*onClick/);
});

console.log(`passed ${passed}`);
