import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { ModelClient } from '../apps/server/src/model/adapter.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const logs: any[] = [];
const requests: Array<{ input: unknown; init?: RequestInit }> = [];
console.warn = (...args) => { logs.push(args); };
globalThis.fetch = async (input, init) => {
  requests.push({ input, init });
  return originalFetch(input, init);
};
const params = { model: 'fixture', messages: [{ role: 'user' as const, content: 'PRIVATE_PROMPT' }] };
let passed = 0;
async function t(name: string, fn: () => Promise<void>) {
  logs.length = 0; requests.length = 0;
  await fn();
  console.log(`ok ${++passed} ${name}`);
}
const respond = (res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
  res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
};
async function serverTest(handler: http.RequestListener, fn: (client: ModelClient) => Promise<void>, timeout = 1000) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  try { await fn(new ModelClient(`http://127.0.0.1:${port}/v1`, 'PRIVATE_KEY', timeout, '/tmp')); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function main() {
try {
  await t('post-send pre-Response socket failure retries once with identical request and signal', async () => {
    let calls = 0;
    await serverTest((req, res) => {
      req.resume(); req.on('end', () => ++calls === 1 ? req.socket.destroy() : respond(res));
    }, async client => {
      const result = await client.complete(params);
      assert.equal(result.text, 'ok'); assert.equal(calls, 2); assert.equal(requests.length, 2);
      assert.equal(requests[0].input, requests[1].input); assert.equal(requests[0].init, requests[1].init);
      assert.ok(logs.some(row => row[1]?.outcome === 'recovered' && row[1]?.kind === 'complete'));
      assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
    });
  });
  await t('pre-connect refusal makes exactly two requests then final failure', async () => {
    const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as {port:number}).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    const client = new ModelClient(`http://127.0.0.1:${port}/v1`, '', 1000, '/tmp');
    await assert.rejects(client.complete(params));
    assert.equal(requests.length, 2); assert.equal(requests[0].init, requests[1].init);
    assert.ok(logs.some(row => row[1]?.outcome === 'final-failure' && row[1]?.code === 'ECONNREFUSED'));
  });
  await t('second post-send failure terminates without third request', async () => {
    let calls = 0;
    await serverTest((req) => { req.resume(); req.on('end', () => { calls++; req.socket.destroy(); }); }, async client => {
      await assert.rejects(client.stream(params, () => {}));
      assert.equal(calls, 2); assert.equal(requests.length, 2);
      assert.ok(logs.some(row => row[1]?.outcome === 'final-failure' && row[1]?.kind === 'stream'));
    });
  });
  await t('headers received without body: no retry', async () => {
    await serverTest((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
      setTimeout(() => res.destroy(), 20);
    }, async client => { await assert.rejects(client.stream(params, () => {})); assert.equal(requests.length, 1); });
  });
  await t('partial streamed output: no replay or duplicate token', async () => {
    await serverTest((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      setTimeout(() => res.destroy(), 25);
    }, async client => {
      let text = ''; await assert.rejects(client.stream(params, delta => { text += delta; }));
      assert.equal(text, 'partial'); assert.equal(requests.length, 1);
      assert.ok(!logs.some(row => row[1]?.outcome === 'recovered'));
    });
  });
  await t('already cancelled request sends nothing', async () => {
    const controller = new AbortController(); controller.abort();
    const client = new ModelClient('http://127.0.0.1:1/v1', '', 1000, '/tmp');
    await assert.rejects(client.complete({ ...params, signal: controller.signal }));
    assert.equal(requests.length, 0);
    assert.equal(logs[0]?.[1]?.outcome, 'aborted');
    assert.equal(logs[0]?.[1]?.reasonName, 'AbortError');
  });
  await t('abort through generation registry between failure and retry prevents retry', async () => {
    const queue = new GenerationQueue(1), controller = new AbortController();
    queue.register({id:'g', conversationId:'fixture', messageId:'fixture', startedAt:'fixture', controller});
    const wrapped = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      try { return await wrapped(input, init); } catch (error) { assert.equal(queue.abort('g'), true); throw error; }
    };
    try {
      await serverTest(req => { req.resume(); req.on('end', () => req.socket.destroy()); }, async client => {
        await assert.rejects(queue.run(() => client.complete({...params, signal:controller.signal}), controller.signal));
        assert.equal(requests.length, 1); assert.equal(controller.signal.aborted, true);
        assert.equal(logs[0]?.[1]?.outcome, 'aborted');
        assert.equal(logs[0]?.[1]?.reasonName, 'AbortError');
      });
    } finally { globalThis.fetch = wrapped; queue.unregister('g'); }
  });
  await t('timeout is original logical-call budget, not renewed on retry', async () => {
    let calls = 0;
    await serverTest(req => {
      req.resume(); req.on('end', () => { if (++calls === 1) req.socket.destroy(); });
    }, async client => {
      await assert.rejects(client.complete(params)); assert.equal(requests.length, 2);
      assert.equal(requests[0].init, requests[1].init);
      assert.equal(requests[0].init?.signal?.aborted, true);
      assert.equal(logs[0]?.[1]?.outcome, 'aborted');
      assert.equal(logs[0]?.[1]?.reasonName, 'TimeoutError');
    }, 100);
  });
  await t('each allowed connection cause retries once, without accepting unclassified errors', async () => {
    const wrapped = globalThis.fetch;
    try {
      for (const code of ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
        let calls = 0;
        globalThis.fetch = async () => {
          if (++calls === 1) throw new TypeError('fetch failed', {cause:{code}});
          return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        };
        const client = new ModelClient('http://127.0.0.1:1/v1', '', 1000, '/tmp');
        assert.equal((await client.complete(params)).text, 'ok'); assert.equal(calls, 2);
      }
      for (const error of [new TypeError('fetch failed'), new TypeError('application error', {cause:{code:'ECONNRESET'}})]) {
        let calls = 0;
        globalThis.fetch = async () => { calls++; throw error; };
        const client = new ModelClient('http://127.0.0.1:1/v1', '', 1000, '/tmp');
        await assert.rejects(client.complete(params)); assert.equal(calls, 1);
      }
    } finally { globalThis.fetch = wrapped; }
  });
  await t('HTTP failure is not retried and logs contain no response details', async () => {
    await serverTest((_req, res) => { res.writeHead(503); res.end('PRIVATE_ERROR'); }, async client => {
      await assert.rejects(client.complete(params)); assert.equal(requests.length, 1);
      assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
      assert.equal(logs[0]?.[1]?.outcome, 'http-error');
      assert.equal(logs[0]?.[1]?.status, 503);
    });
  });
  await t('unknown cause and application exceptions are not retried', async () => {
    const wrapped = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      requests.push({input, init}); throw new TypeError('fetch failed', {cause:{code:'UNKNOWN_CODE'}});
    };
    try {
      const client = new ModelClient('http://127.0.0.1:1/v1', '', 1000, '/tmp');
      await assert.rejects(client.complete(params)); assert.equal(requests.length, 1);
      assert.equal(logs[0]?.[1]?.outcome, 'other-error');
    } finally { globalThis.fetch = wrapped; }
  });
  await t('retry remains inside occupied GenerationQueue(1) slot', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const retryEntered = new Promise<void>(r => { entered = r; });
    let calls = 0;
    await serverTest((req, res) => {
      req.resume(); req.on('end', () => {
        if (++calls === 1) req.socket.destroy();
        else { entered(); void gate.then(() => respond(res)); }
      });
    }, async client => {
      const queue = new GenerationQueue(1);
      const first = queue.run(() => client.complete(params));
      try {
        await retryEntered;
        let secondEntered = false;
        const second = queue.run(async () => { secondEntered = true; return 'next'; });
        assert.equal(queue.queued, 1); assert.equal(secondEntered, false); assert.equal(calls, 2);
        release(); assert.equal((await first).text, 'ok'); assert.equal(await second, 'next');
      } finally { release(); }
    });
  });
  await t('elapsed log measures previous logical-call completion without prompt changes', async () => {
    let calls = 0;
    await serverTest((req, res) => {
      req.resume(); req.on('end', () => ++calls === 2 ? req.socket.destroy() : respond(res));
    }, async client => {
      await client.stream(params, () => {}); await client.complete(params);
      const recovered = logs.find(row => row[1]?.outcome === 'recovered')?.[1];
      assert.equal(typeof recovered?.sincePreviousCallMs, 'number'); assert.ok(recovered.sincePreviousCallMs >= 0);
      const body = JSON.parse(String(requests[0].init?.body));
      assert.deepEqual(body.messages, params.messages); assert.equal(body.stream, true);
      assert.equal(body.chat_template_kwargs.enable_thinking, false);
    });
  });
  await t('successful 1:1 wire body exactly matches pre-retry serialization', async () => {
    await serverTest((_req, res) => respond(res), async client => {
      const p = {...params, temperature:0.9, top_p:0.95, max_tokens:200, stop:['END']};
      await client.stream(p, () => {});
      assert.equal(requests.length, 1);
      assert.equal(requests[0].init?.body, JSON.stringify({model:p.model, messages:p.messages,
        temperature:p.temperature, top_p:p.top_p, max_tokens:p.max_tokens, stream:true,
        stream_options:{include_usage:true}, chat_template_kwargs:{enable_thinking:false}, stop:p.stop}));
      assert.equal(logs.length, 0);
    });
  });
  await t('complete preserves public stream delegation with original parameters', async () => {
    const client = new ModelClient('http://127.0.0.1:1/v1', '', 1000, '/tmp');
    let calls = 0;
    client.stream = async (p, onToken) => {
      assert.equal(p, params); onToken('discard'); calls++;
      return {text:'delegated', finishReason:null, usage:null, ttftMs:null, totalMs:0};
    };
    assert.equal((await client.complete(params)).text, 'delegated'); assert.equal(calls, 1);
    assert.equal(requests.length, 0);
  });
  await t('custom cancellation reason is classified without logging private names or messages', async () => {
    const controller = new AbortController();
    const reason = new Error('PRIVATE_CANCEL_MESSAGE'); reason.name = 'PRIVATE_CANCEL_NAME';
    controller.abort(reason);
    const client = new ModelClient('http://127.0.0.1:1/v1', '', 1000, '/tmp');
    await assert.rejects(client.complete({...params, signal:controller.signal}), error => error === reason);
    assert.equal(requests.length, 0);
    assert.equal(logs[0]?.[1]?.outcome, 'aborted');
    assert.equal(logs[0]?.[1]?.reasonName, 'UNKNOWN');
    assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
  });
  await t('token callback exception is not classified as a connection failure', async () => {
    await serverTest((_req, res) => respond(res), async client => {
      const error = new Error('PRIVATE_CALLBACK_ERROR');
      await assert.rejects(client.stream(params, () => { throw error; }), caught => caught === error);
      assert.equal(requests.length, 1);
      assert.equal(logs[0]?.[1]?.outcome, 'other-error');
      assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
    });
  });
} finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
console.log(`${passed} checks passed; loopback only, real model calls 0`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
