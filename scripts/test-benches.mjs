import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Node major fence (engines.node >=22) — fail before discovering/running benches
{
  const assertScript = path.join(root, 'scripts', 'assert-node-major.mjs');
  const assertResult = spawnSync(process.execPath, [assertScript], { stdio: 'inherit' });
  if (assertResult.status !== 0) process.exit(assertResult.status ?? 1);
}

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
let manifestPath;
let manifestMode = false;
let resolvedManifest;
const selected = new Set();
const entryTimeoutMs = new Map();
const entryGroups = new Map();
const manifestExcludeReasons = new Map();
const MANIFEST_PIN_REASON = 'Not in LOCK-CoreRegressionCI pin list (CI gate scope).';

function usage() {
  console.log(`Usage: npm run test:benches -- [name ...] [--output-dir /tmp/evidence] [--timeout-ms 180000] [--list] [--manifest path.json]
Discovers only top-level bench/*.test.ts. Runs sequentially with temporary DB defaults and no real model.
Default exclusions: settingsViewport, partyTurnLiveRo, characterAssetsWrite.
fixMobileClip and shortcutHub always use --no-browser; their browser portions are not run.
WARNING: characterAssetsWrite requires a temporary isolated checkout. Select its exact name alone with
--allow-source-mutation; it temporarily rewrites product source and interruption can prevent restoration.
--manifest selects run[] only. Unknown names fail before execute. Other benches are excluded and never count as passes.
Per-entry timeoutMs overrides manifest defaultTimeoutMs, which overrides --timeout-ms.
JSON results and individual logs are retained outside the checkout. reportedChecks counts emitted test/group
success lines ("ok N" or "ok - N"), not individual assert calls; excluded tests never count as passes.`);
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help') { usage(); process.exit(0); }
  if (arg === '--list') { listOnly = true; continue; }
  if (arg === '--allow-source-mutation') { allowSourceMutation = true; continue; }
  if (arg === '--output-dir' || arg === '--timeout-ms' || arg === '--manifest') {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (arg === '--output-dir') outputDir = path.resolve(value);
    else if (arg === '--timeout-ms') timeoutMs = Number(value);
    else manifestPath = value;
    continue;
  }
  const name = arg.replace(/^bench\//, '').replace(/\.test\.ts$/, '') + '.test.ts';
  if (!files.includes(name)) throw new Error(`Unknown top-level bench: ${arg}`);
  selected.add(name);
}
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
  throw new Error('--timeout-ms must be an integer between 1 and 3600000');
}

function assertTimeout(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) {
    throw new Error(`${label} must be an integer between 1 and 3600000`);
  }
}

function benchFileName(raw) {
  const name = String(raw).replace(/^bench\//, '').replace(/\.test\.ts$/, '') + '.test.ts';
  if (!files.includes(name)) throw new Error(`Unknown top-level bench: ${raw}`);
  return name;
}

if (manifestPath) {
  manifestMode = true;
  resolvedManifest = path.resolve(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolvedManifest, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read manifest ${resolvedManifest}: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Manifest must be a JSON object: ${resolvedManifest}`);
  }
  if (!Array.isArray(manifest.run) || manifest.run.length < 1) {
    throw new Error('Manifest run must be a non-empty array');
  }
  if (manifest.defaultTimeoutMs !== undefined) {
    assertTimeout(manifest.defaultTimeoutMs, 'defaultTimeoutMs');
    timeoutMs = manifest.defaultTimeoutMs;
  }
  if (manifest.jobTimeoutMinutes !== undefined) {
    if (!Number.isSafeInteger(manifest.jobTimeoutMinutes) || manifest.jobTimeoutMinutes < 1 || manifest.jobTimeoutMinutes > 360) {
      throw new Error('jobTimeoutMinutes must be an integer between 1 and 360');
    }
  }
  if (manifest.exclude !== undefined) {
    if (!Array.isArray(manifest.exclude)) throw new Error('Manifest exclude must be an array');
    for (const entry of manifest.exclude) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string' || !entry.name) {
        throw new Error('Manifest exclude entries require a name');
      }
      if (typeof entry.reason !== 'string' || !entry.reason) {
        throw new Error(`Manifest exclude entry ${entry.name} requires a reason`);
      }
      const name = benchFileName(entry.name);
      if (manifestExcludeReasons.has(name)) throw new Error(`Duplicate manifest exclude name: ${entry.name}`);
      manifestExcludeReasons.set(name, entry.reason);
    }
  }
  for (const name of manifestExcludeReasons.keys()) {
    if (selected.has(name)) throw new Error(`Cannot run ${name}: ${manifestExcludeReasons.get(name)}`);
  }
  const seen = new Set();
  for (const entry of manifest.run) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string' || !entry.name) {
      throw new Error('Manifest run entries require a name');
    }
    if (typeof entry.group !== 'string' || !entry.group) {
      throw new Error(`Manifest run entry ${entry.name} requires a group`);
    }
    const name = benchFileName(entry.name);
    if (seen.has(name)) throw new Error(`Duplicate manifest run name: ${entry.name}`);
    seen.add(name);
    if (manifestExcludeReasons.has(name)) throw new Error(`Manifest run name is also excluded: ${entry.name}`);
    if (exclusions[name]) throw new Error(`Cannot run ${name}: ${exclusions[name]}`);
    if (entry.timeoutMs !== undefined) assertTimeout(entry.timeoutMs, `timeoutMs for ${entry.name}`);
    selected.add(name);
    entryTimeoutMs.set(name, entry.timeoutMs ?? timeoutMs);
    entryGroups.set(name, entry.group);
  }
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
  const mutationOverride = name === 'characterAssetsWrite.test.ts' && selected.has(name) && allowSourceMutation;
  let reason;
  if (mutationOverride) reason = undefined;
  else if (exclusions[name]) reason = exclusions[name];
  else if (manifestExcludeReasons.has(name)) reason = manifestExcludeReasons.get(name);
  else if (manifestMode && !selected.has(name)) reason = MANIFEST_PIN_REASON;
  else if (selected.size && !selected.has(name)) reason = 'Not selected by this invocation.';
  return {
    file: `bench/${name}`, status: reason ? 'excluded' : 'pending', ...(reason ? { reason } : {}),
    ...(!reason && entryTimeoutMs.has(name) ? { timeoutMs: entryTimeoutMs.get(name) } : {}),
    ...(entryGroups.has(name) ? { group: entryGroups.get(name) } : {}),
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
  ...(resolvedManifest ? { manifest: resolvedManifest } : {}),
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
  const benchTimeoutMs = result.timeoutMs ?? timeoutMs;
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
      }, benchTimeoutMs);
      child.once('error', (error) => resolve({ exitCode: null, signal: null, error: error.message }));
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    Object.assign(result, outcome, {
      status: timedOut ? 'timeout' : interrupted ? 'failed' : outcome.exitCode === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - started, log, command: [process.execPath, ...childArgs],
      timeoutMs: benchTimeoutMs,
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
