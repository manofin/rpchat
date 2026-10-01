/** TSX_TSCONFIG_PATH=apps/web/tsconfig.json npx tsx bench/storyOrphanUx.test.ts
 * LOCK-StoryOrphanUX P0 — empty roster + existing rooms shows a notice, not a restore write.
 * No live HTTP / systemd / DB / commit / deploy / restart.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StoryDetailView } from '../apps/web/src/pages/StoryPage.tsx';
import { storyFixture, character, storyHarness, nodes, one, named, button, tick } from './helpers/storyUiHarness.ts';

let passed = 0;
async function t(name: string, fn: () => unknown) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const pageSrc = fs.readFileSync(path.resolve('apps/web/src/pages/StoryPage.tsx'), 'utf8');
const cssSrc = fs.readFileSync(path.resolve('apps/web/src/app.css'), 'utf8');
const ORPHAN_COPY = '현재 등장인물은 없지만 기존 대화';
const EMPTY_COPY = '아직 등록된 등장 캐릭터가 없습니다.';
const CTA = ['기존 대화 보기', '등장인물 복원', '등장인물 추가'] as const;

function viewHtml(story = storyFixture(), roomCount = 0) {
  return renderToStaticMarkup(React.createElement(StoryDetailView, {
    story,
    characters: [character('b'), character('a')],
    roomCount,
    onViewRooms() {},
    onAddCast() {},
  }));
}

async function main() {
  await t('orphan roster with rooms shows the exact notice and three CTAs in order', () => {
    const n = 3;
    const html = viewHtml(storyFixture({ characters: [] }), n);
    assert.match(html, new RegExp(`${ORPHAN_COPY} ${n}개가 있습니다\\.`));
    assert.equal(html.includes(EMPTY_COPY), false);
    assert.match(html, /story-orphan-notice/);
    const actions = html.slice(html.indexOf('story-orphan-actions'));
    let cursor = 0;
    for (const label of CTA) {
      const at = actions.indexOf(label);
      assert.ok(at > cursor, `${label} follows the previous CTA`);
      cursor = at;
    }
    assert.match(actions, /<button[^>]*disabled[^>]*>등장인물 복원<\/button>/);
    assert.match(actions, /title="등장인물 복원은 아직 준비 중입니다"/);
    assert.match(actions, /aria-label="등장인물 복원은 아직 준비 중입니다"/);
    assert.match(actions, /aria-disabled="true"/);
    assert.equal(actions.includes('자동'), false);
    const view = StoryDetailView({
      story: storyFixture({ characters: [] }),
      roomCount: n,
      onViewRooms() {},
      onAddCast() {},
    });
    const restore = one(view, button('등장인물 복원'));
    assert.equal(restore.props.disabled, true);
    assert.equal(restore.props.onClick, undefined);
    assert.equal(typeof one(view, button('기존 대화 보기')).props.onClick, 'function');
    assert.equal(typeof one(view, button('등장인물 추가')).props.onClick, 'function');
  });

  await t('empty roster and no rooms keeps the existing empty copy', () => {
    const html = viewHtml(storyFixture({ characters: [] }), 0);
    assert.match(html, new RegExp(EMPTY_COPY));
    assert.equal(html.includes(ORPHAN_COPY), false);
    assert.equal(html.includes('story-orphan-notice'), false);
    for (const label of CTA) assert.equal(html.includes(label), false, label);
  });

  await t('roster greater than zero keeps the cast grid and hides the orphan notice', () => {
    const html = viewHtml(storyFixture(), 4);
    assert.match(html, /story-cast-grid/);
    assert.match(html, /인물-b/);
    assert.equal(html.includes(ORPHAN_COPY), false);
    assert.equal(html.includes(EMPTY_COPY), false);
    assert.equal(html.includes('story-orphan-notice'), false);
    assert.equal(nodes(StoryDetailView({ story: storyFixture(), characters: [character('b')], roomCount: 4 })).some((node) => node.props.className === 'story-cast-card'), true);
  });

  await t('page passes first-page room count and opens the chooser without a restore write', async () => {
    const story = storyFixture({ characters: [] });
    const rooms = [{ id: 'room-1' }, { id: 'room-2' }];
    const gets: string[] = [];
    const writes: string[] = [];
    const h = storyHarness('StoryDetailPage', { id: story.id }, { api: {
      get: async (url: string) => {
        gets.push(url);
        if (url === '/api/characters') return [];
        if (url.includes('/api/conversations')) return rooms;
        return story;
      },
      post: async (url: string) => { writes.push(`POST ${url}`); },
      del: async (url: string) => { writes.push(`DELETE ${url}`); },
      put: async (url: string) => { writes.push(`PUT ${url}`); },
    } });
    h.render(); h.runEffects(); await tick();
    const tree = h.render();
    assert.equal(h.state.roomCount, 2);
    const detail = one(tree, named('StoryDetailView'));
    assert.equal(detail.props.roomCount, 2);
    const html = renderToStaticMarkup(React.createElement(StoryDetailView, {
      story,
      characters: [],
      roomCount: detail.props.roomCount,
      onViewRooms: detail.props.onViewRooms,
      onAddCast: detail.props.onAddCast,
    }));
    assert.match(html, /현재 등장인물은 없지만 기존 대화 2개가 있습니다\./);
    assert.deepEqual(gets.filter((url) => url.includes('/api/conversations')), [`/api/conversations?storyId=${encodeURIComponent(story.id)}&limit=50&offset=0`]);
    detail.props.onViewRooms();
    assert.equal(h.state.starter, 'choose');
    assert.match(html, /disabled[^>]*>등장인물 복원</);
    detail.props.onAddCast();
    assert.equal(h.state.editor, 'opening');
    assert.equal(h.state.starter, null);
    assert.deepEqual(writes, []);
  });

  await t('orphan UX does not write story_characters or hide or delete rooms', () => {
    const noticeStart = pageSrc.indexOf('story-orphan-notice');
    const noticeEnd = pageSrc.indexOf(EMPTY_COPY, noticeStart);
    assert.ok(noticeStart > 0 && noticeEnd > noticeStart);
    const notice = pageSrc.slice(noticeStart, noticeEnd);
    assert.equal(/\b(post|put|del|fetch)\s*\(/.test(notice), false);
    assert.equal(notice.includes('onClick={onViewRooms}'), true);
    assert.equal(notice.includes('onClick={onAddCast}'), true);
    assert.equal(notice.includes('등장인물 복원'), true);
    const restoreBtn = notice.match(/<button[^>]*>등장인물 복원<\/button>/);
    assert.ok(restoreBtn, 'restore CTA is a button');
    assert.match(restoreBtn[0], /\bdisabled\b/);
    assert.equal(restoreBtn[0].includes('onClick'), false);
    assert.equal(pageSrc.includes('story_characters'), false);
    assert.equal(pageSrc.includes("del('/api/conversations"), false);
    assert.equal(pageSrc.includes('del(`/api/conversations'), false);
    assert.equal(pageSrc.includes('snapshot'), false);
    assert.match(pageSrc, /P0: N is the first page length \(limit 50, offset 0\)/);
    assert.match(pageSrc, /아직 등록된 등장 캐릭터가 없습니다\./);
    assert.match(cssSrc, /\.story-orphan-actions \{ display: grid; gap: 8px; margin-top: 8px; \}/);
    assert.match(pageSrc, /<ConversationRow key=\{conv\.id\} conv=\{conv\} onChanged=\{refresh\} \/>/);
  });

  console.log(`passed ${passed}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
