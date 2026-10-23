// Uses actual React components with synthetic HTTP fixtures. No operational DB or model.
// CHROME_BIN=<chrome> RPCHAT_PLAYWRIGHT_MODULE=<module> node --import tsx bench/browser/memoryContext.ts <new evidence dir>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { build } from 'esbuild';

async function main() {
  const out = path.resolve(process.argv[2]);
  fs.mkdirSync(out, { recursive: false });
  const { chromium } = await import(process.env.RPCHAT_PLAYWRIGHT_MODULE || 'playwright');
  const app = Fastify();
  let head = 'A';
  let holdNext = false;
  let held = false;
  let release: (() => void) | undefined;
  let changeDuringPreview = false;
  let failContext = false;
  let knowledgeHeadOverride: string | null = null;
  let reads = 0;
  let writes = 0;
  app.addHook('onRequest', async req => { if (req.method !== 'GET' && req.method !== 'HEAD') writes++; });
  const detail = () => ({
    conversation: {
      id: 'fixture', head_message_id: head, profile_name: 'rp-default', persona_id: 'persona',
      persona_name_snapshot: '이든', persona_applied_at: '2026-10-19T00:00:00Z', updated_at: head,
      scene: {
        place: head === 'A' ? '여관' : '항구', day_index: 2, clock_minutes: 540, response_length: 'short',
        ...(head === 'A' ? { adventure: {
          version: 1, revision: 2, currency: '은화', balance: 19, registration: null, rank: '', experience: 0, skills: [],
          items: [{ id: 'key', name: '203호 열쇠', quantity: 1, ownership: 'loan', owner: '여관' }],
          quests: [{ id: 'map', title: '지도 제작', stage: 'offered', reward: 30 }],
        } } : {}),
      },
    },
    persona: { name: '다른 카탈로그 이름' },
    messages: head === 'A' ? [{ id: 'receipt', role: 'assistant', status: 'complete', meta: { adventure_receipt: { key: 'k' } }, content: '확인 기록\n숙박비 지급 1 은화' }] : [],
  });
  const memory = { id: 'memory', content: '사용자가 나리에게 열쇠를 돌려주기로 약속했다.', status: 'pinned', source: 'user', scope: 'character',
    conversation_id: null, character_id: 'nari', importance: 5, created_at: '', evidence_message_ids: ['foreign-evidence'] };
  app.get('/api/conversations/fixture', async (_req, reply) => {
    reads++;
    const snapshot = detail();
    if (holdNext) { holdNext = false; held = true; await new Promise<void>(resolve => { release = resolve; }); held = false; }
    if (failContext) return reply.code(503).send({ error: '합성 상태 조회 실패' });
    return snapshot;
  });
  app.get('/api/conversations/fixture/summaries', async () => [{
    id: `state-${head}`, conversation_id: 'fixture', tier: 'state', status: 'draft',
    content: `분기 ${head} 요약 초안`, covers_from_message_id: head, covers_until_message_id: head,
    created_at: '2026-10-19T00:00:00Z', branch_scope: 'current', branch_head_id: head,
  }]);
  app.get('/api/conversations/fixture/memories', async () => ({ pinned: [memory], candidates: [] }));
  app.get('/api/conversations/fixture/knowledge', async () => ({
    enabled: true, headMessageId: knowledgeHeadOverride ?? head, userName: '이든',
    actors: [{ id: 'nari', name: '나리' }, { id: 'sera', name: '세라' }], memories: [memory],
    entries: [{ memory_id: 'memory', anchor_message_id: 'anchor', kind: 'promise', known_by: ['nari'], subject_id: 'user', target_id: 'sera', status: 'active' }],
    excluded: head === 'B' ? [{ memory_id: 'memory', reason: 'assignment-off-branch' }] : [], invalidContract: false,
  }));
  app.put('/api/conversations/fixture/knowledge/:id', async () => ({}));
  app.get('/api/conversations/fixture/prompt-preview', async () => {
    const model = `fixture-model-${head}`;
    if (changeDuringPreview) { changeDuringPreview = false; head = 'B'; }
    return { model, budget: { est_total: 123, available: 2000, context_tokens: 4096, reply_reserve: 2096 } };
  });
  app.get('/api/messages/:id', async req => ({
    id: (req.params as { id: string }).id, conversation_id: 'actual-source-room', role: 'assistant',
    eventVersion: 1, events: [{ id: 'n1', type: 'narration', text: '타 대화의 실제 근거', audience: 'public' }],
    content: 'raw hidden', status: 'complete', meta: {}, created_at: '2026-10-19T00:00:00Z', siblings: { index: 0, count: 1, ids: [] },
  }));
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ConversationMemoryPage} from './apps/web/src/pages/ConversationMemoryPage'; import {ConversationMemoryContext} from './apps/web/src/components/ConversationMemoryContext'; import {UiProvider} from './apps/web/src/components/ui';
      const realFetch=window.fetch; window.fetch=(url,init)=>realFetch(url,String(url)==='/api/conversations/fixture' ? {...init,signal:undefined}:init);
      createRoot(document.getElementById('root')).render(<UiProvider><div style={{padding:12,maxWidth:700,margin:'auto'}}>{location.pathname==='/expected' ? <ConversationMemoryContext conversationId="fixture" headMessageId="A"/> : <ConversationMemoryPage conversationId="fixture"/>}</div></UiProvider>);`,
    loader: 'tsx', resolveDir: process.cwd() }, bundle: true, format: 'esm', jsx: 'automatic', write: false,
  });
  app.get('/bundle.js', (_req, reply) => reply.type('text/javascript').send(bundle.outputFiles[0].text));
  app.get('/fonts/test.woff2', (_req, reply) => reply.type('font/woff2').send(fs.readFileSync('apps/web/public/fonts/noto-serif-kr-400.woff2')));
  app.get('/style.css', (_req, reply) => reply.type('text/css').send(fs.readFileSync('apps/web/src/app.css', 'utf8') + fs.readFileSync('apps/web/src/settings-leaf.css', 'utf8') +
    "\n@font-face {font-family:'Test Korean';src:url('/fonts/test.woff2')} body,button,select,summary,.section-title {font-family:system-ui,'Test Korean',sans-serif}"));
  app.get('/*', (_req, reply) => reply.type('text/html').send('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/bundle.js"></script></html>'));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  let checks = 0;
  const ok = (name: string) => console.log(`ok ${++checks} ${name}`);
  const focus = async () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const holdContextRefresh = async () => {
    holdNext = true;
    await focus();
    for (let n = 0; n < 100 && !held; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(held, true);
    await page.getByText('현재 분기의 상태를 확인하는 중…', { exact: true }).waitFor();
  };
  const expectHead = async (expected: string) => page.waitForFunction(
    (h: string) => document.querySelector('[data-test="memory-context"]')?.getAttribute('data-head-message-id') === h, expected);
  try {
    await page.goto(address);
    await expectHead('A');
    await page.getByText('소지금 19 은화', { exact: true }).waitFor();
    await page.getByText('물품 1종 · 의뢰 1건', { exact: true }).click();
    await page.getByText('지도 제작 · 제안 · 제안 보수 30 은화', { exact: true }).waitFor();
    ok('confirmed resources and proposed quest are visible without promoting prose');

    await page.getByRole('button', { name: '기억', exact: true }).click();
    const memoryInput = page.getByPlaceholder('기억할 사실을 직접 추가');
    await memoryInput.fill('아직 저장하지 않은 기억');
    await holdContextRefresh();
    assert.equal(await memoryInput.isVisible(), false);
    release!();
    await memoryInput.waitFor();
    assert.equal(await memoryInput.inputValue(), '아직 저장하지 않은 기억');
    await page.getByRole('button', { name: '요약', exact: true }).click();
    await page.locator('[data-summary-id="state-A"]').getByRole('button', { name: '편집', exact: true }).click();
    const summaryInput = page.getByRole('textbox', { name: '요약 내용', exact: true });
    await summaryInput.fill('아직 저장하지 않은 요약');
    await holdContextRefresh();
    assert.equal(await page.getByRole('button', { name: '저장', exact: true }).count(), 0);
    release!();
    await summaryInput.waitFor();
    assert.equal(await summaryInput.inputValue(), '아직 저장하지 않은 요약');
    ok('same-head focus refresh preserves unsaved memory input and summary edits');

    failContext = true;
    await holdContextRefresh();
    assert.equal(await page.getByRole('button', { name: '지금까지 대화 요약하기', exact: true }).count(), 0);
    release!();
    await page.getByText('합성 상태 조회 실패', { exact: false }).waitFor();
    assert.equal(await page.locator('[data-test="memory-context"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: '지금까지 대화 요약하기', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '저장', exact: true }).count(), 0);
    failContext = false;
    await page.getByRole('button', { name: '다시 확인', exact: true }).click();
    await summaryInput.waitFor();
    assert.equal(await summaryInput.inputValue(), '아직 저장하지 않은 요약');
    assert.equal(writes, 0);
    await page.getByRole('button', { name: '취소', exact: true }).click();
    ok('context loading or failure hides stale summary actions; retry restores the unsaved draft without writes');

    head = 'B'; await focus(); await expectHead('B');
    assert.equal(await page.locator('[data-test="memory-confirmed-state"]').count(), 0);
    await page.getByText('이 분기에는 확인된 모험 상태가 없습니다.', { exact: false }).waitFor();
    head = 'A'; await focus(); await expectHead('A');
    ok('focus refreshes A to B to A and clears unconfirmed branch amounts');

    head = 'B'; holdNext = true; await focus();
    for (let n = 0; n < 100 && !held; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(held, true);
    head = 'A'; await focus(); await expectHead('A');
    release!(); await page.waitForTimeout(100); await expectHead('A');
    ok('a late response from B cannot overwrite current A');

    await page.getByText('이 대화의 적용 설정', { exact: true }).click();
    await page.getByText('대화 프로필: 이든 · 적용 당시 정보', { exact: true }).waitFor();
    await page.getByRole('button', { name: '모델·맥락 예상 확인', exact: true }).click();
    await page.locator('[data-test="memory-applied-preview"]').waitFor();
    assert.ok((await page.locator('[data-test="memory-applied-preview"]').innerText()).includes('fixture-model-A'));
    changeDuringPreview = true;
    await page.getByRole('button', { name: '모델·맥락 예상 확인', exact: true }).click();
    await expectHead('B');
    assert.equal(await page.locator('[data-test="memory-applied-preview"]').count(), 0);
    ok('preview is discarded if selected state changes while it is being read');

    await page.getByRole('button', { name: '인물별 기억', exact: true }).click();
    await page.locator('[data-test="knowledge-entry-details"]').waitFor();
    const card = await page.locator('[data-test="knowledge-entry-details"]').innerText();
    assert.ok(card.includes('주체: 이든 → 대상: 세라'));
    assert.ok(card.includes('기억을 아는 인물: 나리'));
    assert.ok(card.includes('다른 분기에서 지정한 인식 범위입니다.'));
    await page.getByRole('button', { name: '기억 근거 1 원문', exact: true }).click();
    await page.getByText('타 대화의 실제 근거', { exact: true }).waitFor();
    assert.equal(head, 'B');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, 'source-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '원문 닫기', exact: true }).click();
    ok('knowledge identifies subject and recipients; source uses actual owning conversation without switching branch');

    head = 'A';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expectHead('A');
    await page.waitForFunction(() => !document.querySelector('[data-test="knowledge-excluded"]'));
    await page.getByRole('button', { name: '인식 범위 지정', exact: true }).click();
    await page.locator('form').getByRole('combobox').first().waitFor();
    await page.locator('select').first().selectOption('injury');
    await focus(); await expectHead('A');
    assert.equal(await page.locator('select').first().inputValue(), 'injury');
    ok('visibility refresh clears obsolete exclusion and same-head refresh preserves unsaved form');

    await page.getByRole('button', { name: '취소', exact: true }).click();
    knowledgeHeadOverride = 'B'; await focus();
    await page.locator('[data-test="knowledge-branch-changed"]').waitFor();
    assert.equal(await page.locator('[data-test="knowledge-entry-details"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: '인식 범위 지정', exact: true }).count(), 0);
    knowledgeHeadOverride = null; await focus(); await expectHead('A');
    await page.locator('[data-test="knowledge-entry-details"]').waitFor();
    ok('knowledge from another server head stays hidden and cannot be edited under the expected head');
    await page.screenshot({ path: path.join(out, 'mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true });
    head = 'B'; await page.goto(`${address}/expected`);
    await page.locator('[data-test="memory-context-branch-changed"]').waitFor();
    assert.equal(await page.locator('[data-test="memory-context"]').count(), 0);
    ok('context hides server B when its caller is still displaying expected A');
    assert.deepEqual(errors, []);
    assert.equal(writes, 0);
    ok('mobile and desktop render without horizontal overflow or browser errors; no writes or model calls');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed: checks, failed: 0, reads, writes, errors, modelCalls: 0 }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed: checks, failed: 1, reads, writes, errors, error: String(error), modelCalls: 0 }, null, 2));
    await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    release?.();
    await browser.close();
    await app.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
