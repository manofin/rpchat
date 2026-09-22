import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = fs.readdirSync(path.join(root, 'bench'))
  .filter((name) => name.endsWith('.test.ts')).sort();
const exclusions = {
  'settingsViewport.test.ts': 'Separate browser validation: requires a configured Chrome binary and viewport screenshots.',
  'partyTurnLiveRo.test.ts': 'Separate private-copy validation: requires an approved RPCHAT_RO_DB and matching private fixture.',
  'characterAssetsWrite.test.ts': 'Source mutation: select this name alone with --allow-source-mutation in a temporary isolated checkout.',
};
const headlessFlags = new Set(['fixMobileClip.test.ts', 'shortcutHub.test.ts']);
const args = process.argv.slice(2);
let outputDir;
let timeoutMs = 180_000;
let listOnly = false;
let allowSourceMutation = false;
const selected = new Set();

function usage() {
  console.log(`Usage: npm run test:benches -- [name ...] [--output-dir /tmp/evidence] [--timeout-ms 180000] [--list]
Discovers only top-level bench/*.test.ts. Runs sequentially with temporary DB defaults and no real model.
Default exclusions: settingsViewport, partyTurnLiveRo, characterAssetsWrite.
fixMobileClip and shortcutHub always use --no-browser; their browser portions are not run.
WARNING: characterAssetsWrite requires a temporary isolated checkout. Select its exact name alone with
--allow-source-mutation; it temporarily rewrites product source and interruption can prevent restoration.
JSON results and individual logs are retained outside the checkout. reportedChecks counts emitted test/group
success lines ("ok N" or "ok - N"), not individual assert calls; excluded tests never count as passes.`);
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help') { usage(); process.exit(0); }
  if (arg === '--list') { listOnly = true; continue; }
  if (arg === '--allow-source-mutation') { allowSourceMutation = true; continue; }
  if (arg === '--output-dir' || arg === '--timeout-ms') {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (arg === '--output-dir') outputDir = path.resolve(value);
    else timeoutMs = Number(value);
    continue;
  }
  const name = arg.replace(/^bench\//, '').replace(/\.test\.ts$/, '') + '.test.ts';
  if (!files.includes(name)) throw new Error(`Unknown top-level bench: ${arg}`);
  selected.add(name);
}
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
  throw new Error('--timeout-ms must be an integer between 1 and 3600000');
}
if (selected.has('characterAssetsWrite.test.ts') && selected.size !== 1) {
  throw new Error('Select characterAssetsWrite alone with --allow-source-mutation in a temporary isolated checkout.');
}
if (allowSourceMutation && !selected.has('characterAssetsWrite.test.ts')) {
  throw new Error('--allow-source-mutation requires selecting characterAssetsWrite alone.');
}
if (!listOnly) {
  for (const name of selected) {
    if (name === 'characterAssetsWrite.test.ts' && allowSourceMutation) continue;
    if (exclusions[name]) throw new Error(`Cannot run ${name}: ${exclusions[name]}`);
  }
}

const results = files.map((name) => {
  let reason = selected.size && !selected.has(name) ? 'Not selected by this invocation.' : exclusions[name];
  if (name === 'characterAssetsWrite.test.ts' && selected.has(name) && allowSourceMutation) reason = undefined;
  return {
    file: `bench/${name}`, status: reason ? 'excluded' : 'pending', ...(reason ? { reason } : {}),
    ...(headlessFlags.has(name) ? { note: 'Optional browser portion excluded (--no-browser).' } : {}),
  };
});
if (listOnly) {
  for (const result of results) console.log(`${result.status.padEnd(8)} ${result.file}${result.reason ? ` — ${result.reason}` : ''}`);
  console.log(`Discovered ${files.length}; selected ${results.filter((r) => r.status === 'pending').length}; excluded ${results.filter((r) => r.status === 'excluded').length}.`);
  process.exit(0);
}
outputDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-benches-'));
fs.mkdirSync(outputDir, { recursive: true });
outputDir = fs.realpathSync(outputDir);
const checkout = fs.realpathSync(root);
if (outputDir === checkout || outputDir.startsWith(checkout + path.sep)) {
  throw new Error('--output-dir must be outside the checkout so evidence does not affect clean-tree fences.');
}
const resultPath = path.join(outputDir, 'results.json');
if (fs.existsSync(resultPath)) throw new Error(`Refusing to overwrite existing results: ${resultPath}`);
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-bench-data-'));
const report = {
  startedAt: new Date().toISOString(),
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  node: process.version, executable: process.execPath, cwd: root, timeoutMs,
  invocation: process.argv.slice(1),
  coverage: 'Top-level tests only; explicit exclusions and optional browser omissions are listed per file.',
  checkCountMeaning: 'Number of emitted test/group success lines (ok N or ok - N), not individual assertion calls.',
  results,
};
let interrupted = false;
let activeChild;

function killGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = true;
    killGroup(activeChild, 'SIGKILL');
  });
}

function saveReport() {
  report.totals = {
    discovered: files.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed' || r.status === 'timeout').length,
    excluded: results.filter((r) => r.status === 'excluded').length,
    notRun: results.filter((r) => r.status === 'pending' || r.status === 'not-run').length,
    reportedChecks: results.reduce((sum, r) => sum + (r.reportedChecks ?? 0), 0),
  };
  fs.writeFileSync(resultPath, JSON.stringify(report, null, 2) + '\n');
}

async function run(result) {
  const name = path.basename(result.file, '.test.ts');
  const mutationFile = name === 'characterAssetsWrite' ? path.join(root, 'apps/server/src/media/assets.ts') : null;
  const mutationHash = () => fs.existsSync(mutationFile)
    ? createHash('sha256').update(fs.readFileSync(mutationFile)).digest('hex') : null;
  if (mutationFile) {
    result.sourceMutation = { file: path.relative(root, mutationFile), sha256Before: mutationHash() };
    if (result.sourceMutation.sha256Before === null) throw new Error('Mutation target is missing; cannot verify restoration.');
    console.log(`WARNING ${result.file} mutates ${result.sourceMutation.file}; use a temporary isolated checkout.`);
  }
  const dataDir = fs.mkdtempSync(path.join(runtimeDir, `${name}-`));
  const artifactDir = path.join(outputDir, `${name}-artifacts`);
  fs.mkdirSync(artifactDir);
  const childArgs = ['--import', 'tsx', result.file];
  if (headlessFlags.has(path.basename(result.file))) childArgs.push('--no-browser');
  const log = path.join(outputDir, `${name}.log`);
  const fd = fs.openSync(log, 'wx');
  // Do not inherit model credentials, DATA_DIR, NODE_OPTIONS, or .env loading flags.
  const env = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    LANG: 'C.UTF-8', HOST: '127.0.0.1', PORT: '0', AUTH_MODE: 'none',
    DATA_DIR: dataDir, MODEL_BASE_URL: 'http://127.0.0.1:1/v1', MODEL_NAME: 'bench-offline', MODEL_API_KEY: '',
    RPCHAT_PROMPT_DUMP: '0', RPCHAT_REQUEST_DUMP: '0',
    TSX_TSCONFIG_PATH: path.join(root, 'apps/web/tsconfig.json'),
    RPCHAT_BENCH_ARTIFACT_DIR: artifactDir,
  };
  const started = Date.now();
  let timedOut = false;
  let killTimer;
  let timer;
  try {
    const outcome = await new Promise((resolve) => {
      const child = spawn(process.execPath, childArgs, {
        cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd],
      });
      activeChild = child;
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), 1000);
      }, timeoutMs);
      child.once('error', (error) => resolve({ exitCode: null, signal: null, error: error.message }));
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    Object.assign(result, outcome, {
      status: timedOut ? 'timeout' : interrupted ? 'failed' : outcome.exitCode === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - started, log, command: [process.execPath, ...childArgs],
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    killGroup(activeChild, 'SIGKILL');
    activeChild = undefined;
    fs.closeSync(fd);
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (mutationFile) {
      result.sourceMutation.sha256After = mutationHash();
      result.sourceMutation.restored = result.sourceMutation.sha256Before === result.sourceMutation.sha256After;
      if (!result.sourceMutation.restored) {
        if (result.status !== 'timeout') result.status = 'failed';
        result.error = 'Source mutation was not restored; inspect the isolated checkout before reusing it.';
      }
    }
  }
  result.reportedChecks = (fs.readFileSync(log, 'utf8').match(/^ok\s+(?:-\s+)?\d+\b/gm) ?? []).length;
  console.log(`${result.status.toUpperCase().padEnd(7)} ${result.file} (${result.reportedChecks} checks, ${result.durationMs} ms)${result.status !== 'passed' ? ` — ${log}` : ''}`);
}

console.log(`Bench evidence: ${outputDir}`);
saveReport();
try {
  for (const result of results) {
    if (result.status === 'excluded') {
      console.log(`EXCLUDED ${result.file} — ${result.reason}`);
      continue;
    }
    if (interrupted) { result.status = 'not-run'; result.reason = 'Runner interrupted.'; continue; }
    await run(result);
    saveReport();
  }
} finally {
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.interrupted = interrupted;
  saveReport();
}
console.log(`TOTAL ${JSON.stringify(report.totals)}\nResults: ${resultPath}`);
process.exitCode = interrupted ? 130 : report.totals.failed ? 1 : 0;
