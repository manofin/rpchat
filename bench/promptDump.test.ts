/** npx tsx bench/promptDump.test.ts
 * dumpGenerationPrompt (min spec, user `코드` 2026-08-27).
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 * Live generate / Serve restart / E item-4 observation are not this bench.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require2 = createRequire(import.meta.url);
let dumpGenerationPrompt: typeof import('../apps/server/src/prompt/dump.js')['dumpGenerationPrompt'];
try {
  dumpGenerationPrompt = require2('../apps/server/src/prompt/dump.ts').dumpGenerationPrompt;
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
const chatSrc = fs.readFileSync(path.join(here, '../apps/server/src/routes/chat.ts'), 'utf8');
const adapterSrc = fs.readFileSync(path.join(here, '../apps/server/src/model/adapter.ts'), 'utf8');
const settingsSrc = fs.readFileSync(path.join(here, '../apps/server/src/routes/settings.ts'), 'utf8');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-prompt-dump-'));
}

const sample = [
  { role: 'system' as const, content: '### 유저노트\nmarker' },
  { role: 'user' as const, content: 'hello' },
];

t('gate off (unset) writes nothing', () => {
  const prev = process.env.RPCHAT_PROMPT_DUMP;
  delete process.env.RPCHAT_PROMPT_DUMP;
  const dir = tmpDir();
  try {
    dumpGenerationPrompt({
      dataDir: dir,
      generationId: 'g1',
      conversationId: 'c1',
      messageId: 'm1',
      createdAt: '2026-08-27T00:00:00Z',
      messages: sample,
    });
    assert.equal(fs.existsSync(path.join(dir, 'prompt-dump', 'last.json')), false);
  } finally {
    if (prev === undefined) delete process.env.RPCHAT_PROMPT_DUMP;
    else process.env.RPCHAT_PROMPT_DUMP = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('gate "true" / "0" / empty writes nothing', () => {
  const prev = process.env.RPCHAT_PROMPT_DUMP;
  const dir = tmpDir();
  try {
    for (const v of ['true', '0', '']) {
      process.env.RPCHAT_PROMPT_DUMP = v;
      dumpGenerationPrompt({
        dataDir: dir,
        generationId: 'g1',
        conversationId: 'c1',
        messageId: 'm1',
        createdAt: '2026-08-27T00:00:00Z',
        messages: sample,
      });
      assert.equal(fs.existsSync(path.join(dir, 'prompt-dump', 'last.json')), false, `wrote with env=${JSON.stringify(v)}`);
    }
  } finally {
    if (prev === undefined) delete process.env.RPCHAT_PROMPT_DUMP;
    else process.env.RPCHAT_PROMPT_DUMP = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('gate 1 writes last.json payload + 0600 + overwrite', () => {
  const prev = process.env.RPCHAT_PROMPT_DUMP;
  process.env.RPCHAT_PROMPT_DUMP = '1';
  const dir = tmpDir();
  const file = path.join(dir, 'prompt-dump', 'last.json');
  try {
    dumpGenerationPrompt({
      dataDir: dir,
      generationId: 'g1',
      conversationId: 'c1',
      messageId: 'm1',
      createdAt: '2026-08-27T00:00:00Z',
      messages: sample,
    });
    const first = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(first).sort(), [
      'conversationId',
      'createdAt',
      'generationId',
      'messageId',
      'messages',
    ]);
    assert.equal(first.generationId, 'g1');
    assert.equal(first.conversationId, 'c1');
    assert.equal(first.messageId, 'm1');
    assert.equal(first.createdAt, '2026-08-27T00:00:00Z');
    assert.deepEqual(first.messages, [
      { role: 'system', content: '### 유저노트\nmarker' },
      { role: 'user', content: 'hello' },
    ]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    dumpGenerationPrompt({
      dataDir: dir,
      generationId: 'g2',
      conversationId: 'c2',
      messageId: 'm2',
      createdAt: '2026-08-27T00:00:01Z',
      messages: [{ role: 'user', content: 'second' }],
    });
    const second = JSON.parse(fs.readFileSync(file, 'utf8')) as { generationId: string };
    assert.equal(second.generationId, 'g2');
    assert.equal(fs.readdirSync(path.join(dir, 'prompt-dump')).length, 1);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    if (prev === undefined) delete process.env.RPCHAT_PROMPT_DUMP;
    else process.env.RPCHAT_PROMPT_DUMP = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('generate() dumps built.messages before stream; complete() does not', () => {
  assert.ok(chatSrc.includes("from '../prompt/dump.js'"), 'chat.ts imports dump helper');
  const dumpAt = chatSrc.indexOf('dumpGenerationPrompt(');
  const streamAt = chatSrc.indexOf('ctx.model.stream(');
  assert.ok(dumpAt >= 0 && streamAt >= 0 && dumpAt < streamAt, 'dump immediately before stream');
  assert.match(chatSrc.slice(dumpAt, streamAt), /messages:\s*built\.messages/);
  assert.equal(adapterSrc.includes('dumpGenerationPrompt'), false);
  assert.equal(/register\(.*prompt-dump|\/api\/prompt-dump/.test(chatSrc + settingsSrc), false);
});

console.log(`passed ${passed}`);
