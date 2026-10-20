// CHROME_BIN=<chrome> RPCHAT_PLAYWRIGHT_MODULE=<module> node --import tsx bench/browser/summaryBranches.ts <new evidence dir>
// Actual React components and HTTP, synthetic summaries only. No operational API or model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { build } from 'esbuild';
import type { Summary } from '../../apps/web/src/types';

async function main() {
  const out = path.resolve(process.argv[2]);
  fs.mkdirSync(out, { recursive: false });
  const { chromium } = await import(process.env.RPCHAT_PLAYWRIGHT_MODULE || 'playwright');
  const app = Fastify();
  let head = 'A';
  let failNext = false;
  let holdNext = false;
  let release: (() => void) | undefined;
  let held = false;
  let reads = 0;
  let applies = 0;
  let writes = 0;
  const rows: Summary[] = [
    { id: 'A', conversation_id: 'fixture', tier: 'state', status: 'approved', created_at: '2026-10-01', content: 'A 상태 · 여관에 머문다', covers_until_message_id: 'source-A' },
    { id: 'B', conversation_id: 'fixture', tier: 'state', status: 'approved', created_at: '2026-10-02', content: 'B 상태 · 항구로 떠났다', covers_until_message_id: 'source-B' },
    { id: 'draft-A', conversation_id: 'fixture', tier: 'state', status: 'draft', created_at: '2026-10-03', content: 'A 상태 · 여관에서 기다린다', covers_until_message_id: 'source-A' },
    { id: 'loose', conversation_id: 'fixture', tier: 'state', status: 'approved', created_at: '2026-10-04', content: '연결되지 않은 오래된 상태', covers_until_message_id: null },
    { id: 'legacy', conversation_id: 'fixture', tier: 'whole', status: 'approved', created_at: '2026-10-04', content: '이전 서버 응답', covers_until_message_id: null },
  ];
  app.get('/api/conversations/fixture/summaries', async (_req, reply) => {
    reads++;
    if (failNext) { failNext = false; return reply.code(500).send({ error: '시험용 조회 실패' }); }
    const result = rows.map((row) => row.id === 'legacy' ? row : ({ ...row, branch_head_id: head, branch_scope: !row.covers_until_message_id ? 'unlinked' : row.covers_until_message_id === `source-${head}` ? 'current' : 'other' }));
    if (holdNext) { holdNext = false; held = true; await new Promise<void>(resolve => { release = resolve; }); held = false; }
    return result;
  });
  app.patch('/api/summaries/:id', async (req) => { writes++; Object.assign(rows.find(row => row.id === (req.params as { id: string }).id)!, req.body); return { ok: true }; });
  app.get('/api/messages/:id', async (req) => ({ id: (req.params as { id: string }).id, conversation_id: 'fixture', role: 'assistant', content: 'raw hidden', eventVersion: 1, events: [{ id: 'text-1', type: 'narration', text: '다른 분기의 실제 원문', audience: 'public' }], status: 'complete', meta: {}, created_at: '2026-10-02', siblings: { index: 0, count: 1, ids: [] } }));
  app.post('/applied', () => { applies++; return {}; });
  const bundle = await build({ stdin: { contents: `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client'; import {SummaryTab} from './apps/web/src/pages/ChatDrawer'; import {MessageSourcePreview} from './apps/web/src/components/MessageSourcePreview'; import {UiProvider} from './apps/web/src/components/ui';
    // A transport may deliver a response after cancellation. Force that case here.
    const realFetch=window.fetch; window.fetch=(url,init)=>realFetch(url,String(url).endsWith('/summaries') ? {...init,signal:undefined}:init);
    function Fixture(){const [head,setHead]=useState('A');const [revision,setRevision]=useState(0);const [source,setSource]=useState(null);const [visible,setVisible]=useState(true);window.fixture={setHead,setRevision,setVisible};return <UiProvider><div style={{padding:16,maxWidth:640,margin:'auto'}}>{visible&&<SummaryTab conversationId="fixture" headMessageId={head} revision={revision} open={true} onApplied={()=>{fetch('/applied',{method:'POST'});setRevision(n=>n+1)}} onClose={()=>{setSource(new URLSearchParams(location.search).get('jump'))}}/>}<MessageSourcePreview conversationId="fixture" messageId={source} onClose={()=>setSource(null)}/></div></UiProvider>};createRoot(document.getElementById('root')).render(<Fixture/>);`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, format: 'esm', jsx: 'automatic', write: false });
  app.get('/bundle.js', (_req, reply) => reply.type('text/javascript').send(bundle.outputFiles[0].text));
  app.get('/fonts/:name', (_req, reply) => reply.type('font/woff2').send(fs.readFileSync('apps/web/public/fonts/noto-serif-kr-400.woff2')));
  app.get('/style.css', (_req, reply) => reply.type('text/css').send(fs.readFileSync('apps/web/src/app.css', 'utf8') + `\n@font-face {font-family:'Test Korean';src:url('/fonts/noto-serif-kr-400.woff2')} body,button,textarea,.section-title {font-family:system-ui,'Test Korean',sans-serif}`));
  app.get('/*', (_req, reply) => reply.type('text/html').send('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/bundle.js"></script></html>'));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  const browserErrors: string[] = [];
  page.on('pageerror', (error: Error) => browserErrors.push(error.message));
  let passed = 0;
  const ok = (message: string) => { console.log(`ok ${++passed} ${message}`); };
  const expectCurrent = async (id: string) => {
    await page.waitForFunction((expected: string) => document.querySelector('[data-summary-id]')?.getAttribute('data-summary-id') === expected, id);
    const card = page.locator(`[data-summary-id="${id}"]`);
    assert.ok((await card.innerText()).includes('현재 분기'));
  };
  const changeHead = async (value: string) => { head = value; await page.evaluate((h: string) => (window as any).fixture.setHead(h), value); };
  try {
    await page.goto(address);
    await expectCurrent('A');
    assert.equal(await page.locator('[data-summary-id="B"] ins, [data-summary-id="B"] del').count(), 0);
    assert.equal(await page.getByText('근거 미연결', { exact: true }).count(), 1);
    assert.equal(await page.getByText('분기 미확인', { exact: true }).count(), 1);
    ok('current A selected while B, unlinked and old-response rows remain visible');
    await changeHead('B'); await expectCurrent('B');
    await changeHead('A'); await expectCurrent('A');
    ok('A to B to A refreshes current state and badges');
    holdNext = true;
    await changeHead('B');
    await page.waitForFunction(() => document.body.innerText.includes('요약을 불러오는 중'));
    for (let i = 0; i < 100 && !held; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(held, true);
    await changeHead('A'); await expectCurrent('A');
    release!();
    await page.waitForTimeout(100);
    await expectCurrent('A');
    ok('late B response cannot overwrite A even when fetch ignores abort');
    await changeHead('C');
    await page.getByText('현재 분기에서 확인된 승인 상태가 없습니다.').waitFor();
    assert.equal(await page.locator('[data-summary-id]').count(), 5);
    ok('no current approved state is explicit; no offbranch fallback or data loss');
    await changeHead('A'); await expectCurrent('A');
    await page.locator('[data-summary-id="draft-A"]').getByRole('button', { name: '승인', exact: true }).click();
    await expectCurrent('draft-A');
    assert.equal(applies, 1); assert.equal(writes, 1);
    await page.getByText('승인됨. 현재 분기와 맥락 예산에 따라 사용됩니다.').waitFor();
    ok('approve refreshes current state, notifies parent and avoids prompt-inclusion guarantee');
    await page.locator('[data-summary-id="B"]').getByRole('button', { name: '범위 끝 원문' }).click();
    await page.getByText('다른 분기의 실제 원문', { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.toast-stack .banner').waitFor({ state: 'detached' });
    await page.screenshot({ path: path.join(out, 'source-mobile.png'), fullPage: true });
    assert.equal(head, 'A'); assert.equal(writes, 1);
    await page.getByRole('button', { name: '원문 닫기' }).click();
    ok('offbranch source is visible without selecting a head or writing data');
    failNext = true;
    await page.evaluate(() => (window as any).fixture.setRevision((n: number) => n + 1));
    await page.getByRole('alert').filter({ hasText: '시험용 조회 실패' }).waitFor();
    assert.equal(await page.locator('[data-summary-id]').count(), 0);
    await page.getByRole('button', { name: '다시 불러오기' }).click(); await expectCurrent('draft-A');
    ok('failed read clears stale cards and retry recovers');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, 'mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1100, height: 850 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true });
    assert.deepEqual(browserErrors, []);
    ok('360px and desktop layouts fit; no browser errors');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed, failed: 0, reads, writes, modelCalls: 0, fixture: 'Synthetic HTTP API; actual SummaryTab and MessageSourcePreview', browserErrors }, null, 2));
  } finally {
    release?.();
    await browser.close();
    await app.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
