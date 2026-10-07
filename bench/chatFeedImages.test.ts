import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CharacterIntroCard, CharacterIntroMedia, RosterPortraitStage, shouldShowCharacterIntro } from '../apps/web/src/components/ChatFeedImages.tsx';
import { BeatUiPanel } from '../apps/web/src/components/view.tsx';
import { rosterPortraitOptions } from '../apps/web/src/lib/rosterPortraits.ts';

let passed = 0;
function t(name: string, fn: () => void) { fn(); console.log(`ok ${++passed} ${name}`); }
const avatar = '/media/avatars/11111111-1111-4111-8111-111111111111.webp';
const nari = '/media/assets/nari/uniform/1.webp';
const sera = '/media/assets/sera/uniform/2.webp';

t('solo feed intro uses authored card data and reserved portrait dimensions', () => {
  const html = renderToStaticMarkup(createElement(CharacterIntroCard, { character: { name: '나리', tagline: '기록자', description: '오래된 전시장을 지킨다.', avatar } }));
  assert.match(html, /aria-label="나리 캐릭터 소개"/);
  assert.match(html, /width="600" height="800"/);
  for (const value of ['캐릭터 소개', '나리', '기록자', '오래된 전시장을 지킨다.']) assert.ok(html.includes(value), value);
});

t('empty character metadata adds no decorative feed card', () => {
  assert.equal(renderToStaticMarkup(createElement(CharacterIntroCard, { character: { name: '빈 카드', tagline: '', description: '', avatar: null } })), '');
});

t('intro is limited to an empty new solo feed so existing solo and story rendering stay unchanged', () => {
  assert.equal(shouldShowCharacterIntro(null, 0), true);
  assert.equal(shouldShowCharacterIntro(null, 1), false);
  assert.equal(shouldShowCharacterIntro('story-1', 0), false);
});

t('intro image failure stays inside the reserved media frame', () => {
  let failed = false;
  const media = CharacterIntroMedia({ src: avatar, name: '나리', failed: false, onError() { failed = true; } }) as any;
  media.props.children.props.onError();
  assert.equal(failed, true);
  const fallback = renderToStaticMarkup(createElement(CharacterIntroMedia, { src: avatar, name: '나리', failed: true, onError() {} }));
  assert.match(fallback, /class="chat-intro-media"/);
  assert.match(fallback, /role="status">이미지를 불러올 수 없습니다/);
});

t('roster selection switches only among server-provided emotion assets', () => {
  const options = [{ id: 'nari', name: '나리', chip: '🙂', image_url: nari }, { id: 'sera', name: '세라', chip: '😠', image_url: sera }];
  let selected = 'nari';
  const tree = RosterPortraitStage({ options, selectedId: selected, onSelect(id) { selected = id; } }) as any;
  tree.props.children[0].props.children[1].props.onClick();
  assert.equal(selected, 'sera');
  const html = renderToStaticMarkup(createElement(RosterPortraitStage, { options, selectedId: selected, onSelect() {} }));
  assert.match(html, /src="\/media\/assets\/sera\/uniform\/2.webp"/);
  assert.doesNotMatch(html, /src="\/media\/assets\/nari\/uniform\/1.webp"/);
  assert.match(html, /세라 😠의 모습/);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
});

t('roster chips become accessible buttons only when a current asset is selectable', () => {
  const html = renderToStaticMarkup(createElement(BeatUiPanel, { ui: { roster: [
    { id: 'nari', name: '나리', chip: '🙂', locked: false, in_room: true, image_url: nari },
    { id: 'sera', name: '세라', chip: '🔒', locked: true, in_room: true, image_url: null },
  ] }, selectedRosterId: 'nari', onRosterSelect() {} }));
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /세라 이번 턴 대사 없음/);
});

t('current roster authority joins only canonical server metadata', () => {
  const ui = { roster: [{ id: 'nari', name: '나리', chip: '🙂', locked: false, in_room: true }] };
  const decode = (image_url: unknown, name = '나리') => rosterPortraitOptions(ui, [{ id: 'nari', name, image_url, emotion: '🙂' }]);
  assert.equal(decode(nari)[0].image_url, nari);
  for (const value of ['https://example.test/a.webp', '/media/assets/nari/uniform/1.webp?x=1', '/media/avatars/a.webp', 'data:image/png;base64,x']) assert.deepEqual(decode(value), []);
  assert.deepEqual(decode(nari, '다른 인물'), []);
  assert.deepEqual(rosterPortraitOptions({ roster: [{ ...ui.roster[0], locked: true }] }, [{ id: 'nari', name: '나리', image_url: nari }]), []);
});

t('feed stages keep a fixed 3:4 media ratio and preserve party-only placement', () => {
  const css = fs.readFileSync(new URL('../apps/web/src/app.css', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('../apps/web/src/pages/ChatPage.tsx', import.meta.url), 'utf8');
  const route = fs.readFileSync(new URL('../apps/server/src/routes/chat.ts', import.meta.url), 'utf8');
  for (const selector of ['.character-portrait-frame', '.chat-intro-media']) {
    const block = css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)) + 1);
    assert.match(block, /aspect-ratio:\s*3\s*\/\s*4/);
  }
  assert.match(page, /shouldShowCharacterIntro\(conv\.story_id, shownMessages\.length\)/);
  assert.match(page, /<CharacterIntroCard key=\{char\.id\}/);
  assert.match(page, /<RosterPortraitStage options=\{rosterPortraits\}/);
  assert.match(route, /roster_portraits:\s*rosterPortraits/);
});

console.log(`${passed} passed`);
