/**
 * npm run test:benches -- partyU1Probe --output-dir <new directory>
 * CLI tests use synthetic fixtures and a loopback HTTP model only. No DB or real model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assembleProbe, measureRequest } from './helpers/partyU1Probe.ts';
import { estimateMessageTokens } from '../apps/server/src/prompt/tokens.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'bench/fixtures/party-u1');
const conditions = path.join(fixtures, 'conditions.json');
const out = process.env.RPCHAT_BENCH_ARTIFACT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'party-u1-probe-'));
let checks = 0;
let assertions = 0;
const equal = (a: unknown, b: unknown) => { assertions++; assert.deepEqual(a, b); };
const truth = (x: unknown) => { assertions++; assert.ok(x); };
async function t(name: string, fn: () => Promise<void> | void) {
  const before = assertions; await fn(); assert.ok(assertions > before, 'test must assert');
  console.log(`ok ${++checks} ${name}`);
}

async function main() {
  const requests: Array<{ url?: string; body: any }> = [];
  let mode: 'normal' | 'truncated' | 'no-newline' = 'normal';
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body || '{}') });
    if (req.url !== '/v1/chat/completions') { res.writeHead(400); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
    let wire = ': ignored comment\r\n\r\n' + frame({ choices: [{ delta: { role: 'assistant' } }] });
    wire += frame({ choices: [{ delta: { content: mode === 'no-newline' ? '줄바꿈 없음' : '합성 ' } }] });
    if (mode === 'truncated') { res.end(wire + 'data: {"choices":['); return; }
    if (mode === 'normal') wire += frame({ choices: [{ delta: { content: '첫 줄\n다음 줄' } }] });
    wire += frame({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    if (mode === 'normal') wire += frame({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } });
    wire += 'data: [DONE]\r\n\r\n';
    const bytes = Buffer.from(wire);
    // UTF-8 글자 중간과 SSE 줄 경계를 모두 쪼개서 보낸다.
    for (let offset = 0; offset < bytes.length; offset += 7) {
      res.write(bytes.subarray(offset, offset + 7));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'bench/helpers/partyU1Probe.ts', ...args], {
      cwd: root, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, MODEL_BASE_URL: base + '/forbidden-env', LANG: 'C.UTF-8' },
    }, (error, stdout, stderr) => resolve({ code: error ? typeof error.code === 'number' ? error.code : -1 : 0, stdout, stderr }));
  });
  try {
    await t('dry CLI covers four conditions, whole context, token accounting and exact assembly SHA without requests', async () => {
      const output = path.join(out, 'dry.json');
      const result = await run(['--dry', '--conditions', conditions, '--out', output]);
      equal(result.code, 0); equal(requests.length, 0);
      const dry = JSON.parse(fs.readFileSync(output, 'utf8'));
      equal(dry.results.length, 4);
      equal(dry.results.map((r: any) => [r.participantCount, r.allowedSpeakerIds.length]), [[17, 1], [17, 3], [25, 1], [25, 3]]);
      for (const row of dry.results) {
        const cfg = JSON.parse(fs.readFileSync(conditions, 'utf8'));
        const c = cfg.conditions.find((c: any) => c.id === row.conditionId);
        const cast = JSON.parse(fs.readFileSync(path.join(fixtures, c.castFile), 'utf8'));
        const text = row.messages.map((m: any) => m.content).join('\n');
        for (const marker of ['SETTING_HEAD_CANARY', 'SETTING_MID_CANARY', 'SETTING_TAIL_CANARY']) truth(text.includes(marker));
        for (const id of Object.keys(cast)) {
          equal(text.includes(`SCN_${id}`), row.allowedSpeakerIds.includes(id));
          equal(text.includes(`DETAIL_${id}`), row.allowedSpeakerIds.includes(id));
        }
        const comparable = row.messages.map((m: any) => ({ role: m.role, content: m.content }));
        equal(row.assemblySha256, createHash('sha256').update(JSON.stringify(comparable), 'utf8').digest('hex'));
        const total = row.messages.reduce((n: number, m: any) => n + estimateMessageTokens(m.content, 1), 0);
        equal(row.requestBudget.totalEstimatedTokens, total);
        truth(total + row.requestBudget.outputReserveTokens <= row.requestBudget.contextTokens);
        truth(row.sections.length > 0 && row.sections.every((s: any) => Number.isFinite(s.estTokens)));
        truth(row.diagnostics.sections.length > 0);
      }
      equal(JSON.stringify(dry.results.map(({ repetition, ...r }: any) => r)), JSON.stringify(assembleProbe(conditions)));
    });
    await t('model CLI records first token, unvalidated first complete line, completion, usage and raw hash', async () => {
      const output = path.join(out, 'model.json');
      const result = await run(['--model', base, '--model-name', 'loopback-stub', '--max-tokens', '321', '--repeat', '1', '--timeout-ms', '10000', '--conditions', conditions, '--out', output]);
      equal(result.code, 0);
      const measured = JSON.parse(fs.readFileSync(output, 'utf8'));
      equal(requests.length, 4); equal(measured.results.length, 4);
      for (const [i, row] of measured.results.entries()) {
        const m = row.measurement;
        for (const k of ['requestAt', 'firstTokenAt', 'firstCompleteLineAt', 'completedAt']) truth(Number.isFinite(Date.parse(m[k])));
        truth(m.firstTokenMs <= m.firstCompleteLineMs && m.firstCompleteLineMs <= m.completionMs);
        truth(m.firstCompleteLineMeaning.includes('검증 전'));
        equal(m.usage, { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 });
        equal(m.outputSha256, createHash('sha256').update('합성 첫 줄\n다음 줄').digest('hex'));
        equal(requests[i].url, '/v1/chat/completions');
        equal(requests[i].body.model, 'loopback-stub'); equal(requests[i].body.max_tokens, 321);
        equal(requests[i].body.messages, row.messages);
      }
    });
    await t('MODEL_BASE_URL cannot supply a missing explicit --model argument', async () => {
      const before = requests.length;
      const result = await run(['--conditions', conditions, '--out', path.join(out, 'invalid.json'), '--model']);
      truth(result.code !== 0); truth(result.stderr.includes('--model requires a value'));
      equal(requests.length, before); equal(fs.existsSync(path.join(out, 'invalid.json')), false);
    });
    await t('a truncated SSE frame is a failure rather than a completed measurement', async () => {
      mode = 'truncated';
      assertions++;
      await assert.rejects(() => measureRequest(base, 'loopback-stub', [{ role: 'user', content: 'synthetic' }], 10, 5000), /incomplete_sse/);
    });
    await t('missing newline and usage stay null instead of invented timestamps or usage', async () => {
      mode = 'no-newline';
      const r = await measureRequest(base + '/v1', 'loopback-stub', [{ role: 'user', content: 'synthetic' }], 10, 5000);
      truth(r.firstTokenAt !== null); equal(r.firstCompleteLineAt, null); equal(r.firstCompleteLineMs, null); equal(r.usage, null);
      equal(r.outputSha256, createHash('sha256').update('줄바꿈 없음').digest('hex'));
    });
    assert.ok(checks > 0 && assertions > 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
