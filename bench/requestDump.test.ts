/** npx tsx bench/requestDump.test.ts
 * dumpRequestBody (E-bytes min spec, user `E-bytes` 코드 2026-08-29).
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 * Live generate / Serve restart / E(B) / env RPCHAT_REQUEST_DUMP=1 are not this bench.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require2 = createRequire(import.meta.url);
let dumpRequestBody: typeof import('../apps/server/src/model/requestDump.js')['dumpRequestBody'];
try {
  dumpRequestBody = require2('../apps/server/src/model/requestDump.ts').dumpRequestBody;
} catch (e) {
  console.error('RED: helper module missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const adapterSrc = fs.readFileSync(path.join(here, '../apps/server/src/model/adapter.ts'), 'utf8');
const chatSrc = fs.readFileSync(path.join(here, '../apps/server/src/routes/chat.ts'), 'utf8');
const dumpSrc = fs.readFileSync(path.join(here, '../apps/server/src/prompt/dump.ts'), 'utf8');
const settingsSrc = fs.readFileSync(path.join(here, '../apps/server/src/routes/settings.ts'), 'utf8');
const indexSrc = fs.readFileSync(path.join(here, '../apps/server/src/index.ts'), 'utf8');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-request-dump-'));
}

const sampleBody: Record<string, unknown> = {
  model: 'm',
  messages: [{ role: 'user', content: 'hello' }],
  temperature: 0.7,
  top_p: 0.9,
  max_tokens: 128,
  stream: true,
  stream_options: { include_usage: true },
  chat_template_kwargs: { enable_thinking: false },
  stop: ['\n'],
};

t('gate off (unset) writes nothing', () => {
  const prev = process.env.RPCHAT_REQUEST_DUMP;
  delete process.env.RPCHAT_REQUEST_DUMP;
  const dir = tmpDir();
  try {
    dumpRequestBody({
      dataDir: dir,
      generationId: 'g1',
      createdAt: '2026-08-29T00:00:00Z',
      url: 'http://127.0.0.1:8080/v1/chat/completions',
      body: sampleBody,
    });
    assert.equal(fs.existsSync(path.join(dir, 'prompt-dump', 'last-request.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'prompt-dump', 'last.json')), false);
  } finally {
    if (prev === undefined) delete process.env.RPCHAT_REQUEST_DUMP;
    else process.env.RPCHAT_REQUEST_DUMP = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('gate "true" / "0" / empty / PROMPT_DUMP=1 writes nothing', () => {
  const prevR = process.env.RPCHAT_REQUEST_DUMP;
  const prevP = process.env.RPCHAT_PROMPT_DUMP;
  const dir = tmpDir();
  try {
    for (const v of ['true', '0', '']) {
      process.env.RPCHAT_REQUEST_DUMP = v;
      dumpRequestBody({
        dataDir: dir,
        generationId: 'g1',
        createdAt: '2026-08-29T00:00:00Z',
        url: 'http://127.0.0.1:8080/v1/chat/completions',
        body: sampleBody,
      });
      assert.equal(
        fs.existsSync(path.join(dir, 'prompt-dump', 'last-request.json')),
        false,
        `wrote with env=${JSON.stringify(v)}`,
      );
    }
    delete process.env.RPCHAT_REQUEST_DUMP;
    process.env.RPCHAT_PROMPT_DUMP = '1';
    dumpRequestBody({
      dataDir: dir,
      generationId: 'g1',
      createdAt: '2026-08-29T00:00:00Z',
      url: 'http://127.0.0.1:8080/v1/chat/completions',
      body: sampleBody,
    });
    assert.equal(fs.existsSync(path.join(dir, 'prompt-dump', 'last-request.json')), false, 'PROMPT_DUMP must not open request dump');
  } finally {
    if (prevR === undefined) delete process.env.RPCHAT_REQUEST_DUMP;
    else process.env.RPCHAT_REQUEST_DUMP = prevR;
    if (prevP === undefined) delete process.env.RPCHAT_PROMPT_DUMP;
    else process.env.RPCHAT_PROMPT_DUMP = prevP;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('gate 1 writes last-request.json payload + 0600 + overwrite; not last.json', () => {
  const prev = process.env.RPCHAT_REQUEST_DUMP;
  process.env.RPCHAT_REQUEST_DUMP = '1';
  const dir = tmpDir();
  const file = path.join(dir, 'prompt-dump', 'last-request.json');
  try {
    dumpRequestBody({
      dataDir: dir,
      generationId: 'g1',
      createdAt: '2026-08-29T00:00:00Z',
      url: 'http://127.0.0.1:8080/v1/chat/completions',
      body: sampleBody,
    });
    const first = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(first).sort(), ['body', 'createdAt', 'generationId', 'url']);
    assert.equal(first.generationId, 'g1');
    assert.equal(first.createdAt, '2026-08-29T00:00:00Z');
    assert.equal(first.url, 'http://127.0.0.1:8080/v1/chat/completions');
    assert.deepEqual(first.body, sampleBody);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(dir, 'prompt-dump', 'last.json')), false);

    dumpRequestBody({
      dataDir: dir,
      generationId: 'g2',
      createdAt: '2026-08-29T00:00:01Z',
      url: 'http://127.0.0.1:8080/v1/chat/completions',
      body: { model: 'm2', messages: [], stream: true },
    });
    const second = JSON.parse(fs.readFileSync(file, 'utf8')) as { generationId: string };
    assert.equal(second.generationId, 'g2');
    assert.equal(fs.readdirSync(path.join(dir, 'prompt-dump')).length, 1);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    if (prev === undefined) delete process.env.RPCHAT_REQUEST_DUMP;
    else process.env.RPCHAT_REQUEST_DUMP = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('stream() dumps after body before fetch; complete() has no generationId; dump.ts untouched', () => {
  assert.ok(adapterSrc.includes("from './requestDump.js'"), 'adapter imports requestDump');
  const dumpAt = adapterSrc.indexOf('dumpRequestBody(');
  const fetchAt = adapterSrc.indexOf('fetch(`${this.baseUrl}/chat/completions`');
  assert.ok(dumpAt >= 0 && fetchAt >= 0 && dumpAt < fetchAt, 'dump immediately before fetch');
  const between = adapterSrc.slice(dumpAt, fetchAt);
  assert.match(between, /generationId:\s*p\.generationId/);
  assert.match(between, /\bbody\b/);
  assert.match(adapterSrc, /if \(p\.generationId\)/);
  assert.match(adapterSrc, /generationId\?:\s*string/);
  assert.match(chatSrc, /generationId,/);
  assert.match(indexSrc, /config\.dataDir/);
  assert.equal(dumpSrc.includes('dumpRequestBody'), false);
  assert.equal(dumpSrc.includes('RPCHAT_REQUEST_DUMP'), false);
  assert.equal(dumpSrc.includes('last-request.json'), false);
  assert.equal(/register\(.*prompt-dump|\/api\/prompt-dump/.test(adapterSrc + chatSrc + settingsSrc), false);
  const completeAt = adapterSrc.indexOf('async complete(');
  const completeBody = adapterSrc.slice(completeAt);
  assert.match(completeBody, /return this\.stream\(p, \(\) => \{\}\)/);
});

console.log(`passed ${passed}`);
