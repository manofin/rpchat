// CHROME_BIN=<chrome> node --import tsx bench/browser/adventure.ts <new evidence dir>
// Real Chromium + real confirmation routes, synthetic temporary DB; no model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import Fastify from 'fastify';
import { openMigratedDb, one } from '../../apps/server/src/db/index.js';
import { GenerationQueue } from '../../apps/server/src/model/queue.js';
import { characterRoutes } from '../../apps/server/src/routes/characters.js';
import { storyRoutes } from '../../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../../apps/server/src/routes/conversations.js';
import { adventureRoutes } from '../../apps/server/src/routes/adventure.js';
import type { Ctx } from '../../apps/server/src/ctx.js';

async function main() {
  const out = path.resolve(process.argv[2]); fs.mkdirSync(out, { recursive: false });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-adventure-browser-'));
  const db = openMigratedDb(temp, path.resolve('apps/server/migrations'));
  const app = Fastify();
  const ctx = { db, queue: new GenerationQueue(1), resolvedModel: () => 'mock', model: {}, log: app.log } as unknown as Ctx;
  for (const route of [characterRoutes, storyRoutes, conversationRoutes, adventureRoutes]) app.register(route(ctx));
  let room = '';
  let failNextRead = false;
  app.addHook('onRequest', async (req, reply) => {
    if (failNextRead && req.method === 'GET' && req.url === `/api/conversations/${room}`) { failNextRead = false; return reply.code(500).send({ error: '시험용 조회 실패' }); }
  });
  app.post('/fail-next-read', () => { failNextRead = true; return { ok: true }; });
  const compiled = await build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
    import { AdventurePage } from './apps/web/src/pages/AdventurePage'; import { UiProvider } from './apps/web/src/components/ui';
    fetch('/fixture').then(r=>r.json()).then(d=>createRoot(document.getElementById('root')).render(<UiProvider><AdventurePage detail={d} onBack={()=>{}} /></UiProvider>));`,
    resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, format: 'esm', jsx: 'automatic', write: false });
  app.get('/bundle.js', (_req, rep) => rep.type('text/javascript').send(compiled.outputFiles[0].text));
  app.get('/fonts/:name', (req, rep) => { const name = (req.params as { name: string }).name; if (!['noto-serif-kr-400.woff2','noto-serif-kr-500.woff2'].includes(name)) return rep.code(404).send(); return rep.type('font/woff2').send(fs.readFileSync(path.join('apps/web/public/fonts', name))); });
  app.get('/style.css', (_req, rep) => rep.type('text/css').send(fs.readFileSync('apps/web/src/app.css', 'utf8') + `\n@font-face { font-family: 'Test Korean Fallback'; src: url('/fonts/noto-serif-kr-400.woff2'); } body { font-family: system-ui, 'Test Korean Fallback', sans-serif; }`));
  app.get('/fixture', async (_req, rep) => {
    const r = await app.inject({ method: 'GET', url: `/api/conversations/${room}` });
    return rep.type('application/json').send(r.body);
  });
  app.get('/', (_req, rep) => rep.type('text/html').send('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/bundle.js"></script></html>'));
  const api = async (url: string, payload: unknown) => (await app.inject({ method: 'POST', url, payload })).json();
  const actor = await api('/api/characters', { name: '합성 안내자', first_message: '조건을 먼저 확인해 주세요.' });
  const peer = await api('/api/characters', { name: '합성 접수원', first_message: '' });
  const story = await api('/api/stories', { name: '합성 모험' });
  room = (await api('/api/conversations', { characterId: actor.id, storyId: story.id, participantIds: [actor.id, peer.id], scene: { format: 'dialog' } })).id;
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const chrome = spawn(process.env.CHROME_BIN!, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'chrome')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; chrome.stderr.on('data', d => { stderr += d; });
  const wait = async (fn: () => boolean, ms = 10000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > ms) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 25)); } };
  let socket: WebSocket | undefined;
  try {
    await wait(() => /DevTools listening on (ws:\/\/\S+)/.test(stderr));
    const wsUrl = stderr.match(/DevTools listening on (ws:\/\/\S+)/)![1];
    const debugAddress = wsUrl.replace('ws:', 'http:').split('/devtools')[0];
    const targets = await (await fetch(`${debugAddress}/json/list`)).json() as any[];
    socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject; });
    let id = 0; const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    socket.onmessage = e => { const m = JSON.parse(String(e.data)); if (!m.id) return; const p = pending.get(m.id); pending.delete(m.id); if (m.error) p?.reject(new Error(JSON.stringify(m.error))); else p?.resolve(m.result); };
    const rpc = (method: string, params = {}): Promise<any> => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket!.send(JSON.stringify({ id: next, method, params })); });
    const js = async (expression: string) => { const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    await rpc('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
    await rpc('Page.navigate', { url: address });
    await js(`new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{if(document.querySelector('form')){clearInterval(t);resolve(true)}else if(n++>200){clearInterval(t);reject('form missing')}},25)})`);
    await js(`window.fill=(label,value)=>{const el=document.querySelector('[aria-label="'+label+'"]');if(!el)throw Error(label); const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));};window.waitFor=async(text)=>{for(let i=0;i<200;i++){if(document.body.innerText.includes(text))return;await new Promise(r=>setTimeout(r,25));}throw Error('missing '+text)};window.submit=async()=>{document.querySelector('form button[type="submit"]').click();await window.waitFor('취소');};window.accept=async()=>{[...document.querySelectorAll('button')].filter(b=>b.textContent==='확인하고 기록').at(-1).click();await window.waitFor('확인 내역을 대화에 기록했습니다.');};`);
    for (const [label, value] of [['통화 단위', '은화'], ['현재 소지금', '2'], ['경지 (미정이면 비움)', '불'], ['확인한 경험치', '0']]) await js(`fill(${JSON.stringify(label)},${JSON.stringify(value)})`);
    await js('document.fonts.ready');
    await js('submit()');
    await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='취소').click()`);
    assert.equal(JSON.parse((one<any>(db, 'SELECT scene_json FROM conversations WHERE id=?', room)).scene_json).adventure, undefined);
    console.log('ok 1 cancelling confirmation writes no state');
    await js('submit()'); await js('accept()');
    assert.equal(JSON.parse((one<any>(db, 'SELECT scene_json FROM conversations WHERE id=?', room)).scene_json).adventure.balance, 2);
    console.log('ok 2 mobile confirmation persists initial state through real API');
    await js(`fill('기록할 행동','register')`);
    await js(`fill('등록 기관','유사단')`); await js(`fill('실제로 낸 등록비','1')`);
    await js('submit()'); await js('accept()');
    const state = JSON.parse((one<any>(db, 'SELECT scene_json FROM conversations WHERE id=?', room)).scene_json).adventure;
    assert.equal(state.balance, 1); assert.equal(state.registration.organization, '유사단');
    await js(`waitFor('1 은화')`);
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    console.log('ok 3 registration deducts only the confirmed fee and mobile layout fits');
    await js(`fill('기록할 행동','payment')`);
    for (const [label, value] of [['방향','pay'], ['실제 금액','1'], ['상대','창구'], ['지급·수령 이유','확인한 비용']]) await js(`fill(${JSON.stringify(label)},${JSON.stringify(value)})`);
    await js(`fetch('/fail-next-read',{method:'POST'}).then(r=>r.json())`);
    await js('submit()');
    await js(`[...document.querySelectorAll('button')].filter(b=>b.textContent==='확인하고 기록').at(-1).click(); waitFor('시험용 조회 실패')`);
    assert.equal(JSON.parse(one<any>(db, 'SELECT scene_json FROM conversations WHERE id=?', room).scene_json).adventure.balance, 0);
    await js('submit()'); await js('accept()');
    assert.equal(JSON.parse(one<any>(db, 'SELECT scene_json FROM conversations WHERE id=?', room).scene_json).adventure.balance, 0);
    console.log('ok 4 retry after successful write and failed reload does not double charge');
    fs.writeFileSync(path.join(out, 'mobile.png'), Buffer.from((await rpc('Page.captureScreenshot', { captureBeyondViewport: true })).data, 'base64'));
    await rpc('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    fs.writeFileSync(path.join(out, 'desktop.png'), Buffer.from((await rpc('Page.captureScreenshot', { captureBeyondViewport: true })).data, 'base64'));
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed: 4, failed: 0, viewports: [360, 1100], modelCalls: 0, koreanSystemFontFallback: true, registrationState: state, finalState: JSON.parse(one<any>(db, 'SELECT scene_json FROM conversations WHERE id=?', room).scene_json).adventure }, null, 2));
  } finally {
    socket?.close();
    const closed = new Promise<void>(resolve => chrome.once('close', () => resolve()));
    chrome.kill();
    await closed;
    await app.close();
    db.close();
    // Chromium's workers can finish profile writes just after the parent exits.
    await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
