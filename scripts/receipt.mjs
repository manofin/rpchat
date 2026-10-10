#!/usr/bin/env node
// 영수증 자동 생성/검증 도구.
//
// 목적: 영수증을 손으로 옮기지 않는다. git과 results.json에서 기계로 뽑은 파일을
// 영수증으로 내고, 검증자가 같은 스크립트로 다시 계산해 어긋남을 찾을 수 있게 한다.
//
// 생성: node scripts/receipt.mjs --base <sha> [--head <rev>] [--results <results.json>]
//         [--remote <url> --ref <refs/heads/…>…] --out <새 디렉터리>
// 검증: node scripts/receipt.mjs --check <out 디렉터리>
//
// Node 기본 모듈만 사용한다(새 의존성 없음). 시각은 수집 직전에 기록해 순서를 맞춘다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function die(msg, code) {
  process.stderr.write(`receipt: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { refs: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = argv[++i];
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--head') args.head = argv[++i];
    else if (a === '--results') args.results = argv[++i];
    else if (a === '--remote') args.remote = argv[++i];
    else if (a === '--ref') args.refs.push(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else die(`unknown arg: ${a}`, 1);
  }
  return args;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function nowIso() {
  return new Date().toISOString();
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function sha256Text(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// 결과 파일이 head와 같은 SHA를 가리키는지(results.json gitHead == head).
function resultsHeadMatches(resultsGitHead, headSha) {
  return { resultsHeadMatches: resultsGitHead === headSha, gitHead: resultsGitHead, head: headSha };
}

// 생성 모드 핵심: 인자로 주어진 모든 값을 수집하고 receipt.json + receipt.diff를 쓴다.
function build(args) {
  if (!args.base) die('--base is required', 1);
  if (!args.out) die('--out is required', 1);
  if (fs.existsSync(args.out)) die(`refusing to overwrite existing out dir: ${args.out}`, 1);

  const head = args.head || 'HEAD';
  const headSha = git(['rev-parse', head]).trim();
  const parents = git(['rev-list', '--parents', '-n', '1', headSha]).trim().split(' ').slice(1);
  const branch = (() => { try { return git(['branch', '--show-current']).trim() || null; } catch { return null; } })();
  const repoRoot = git(['rev-parse', '--show-toplevel']).trim();
  const times = {};

  const out = args.out;
  fs.mkdirSync(out, { recursive: true });

  // receipt.diff — git diff --binary 원문 그대로(가공 금지)
  times.diff = nowIso();
  const diffText = git(['diff', '--binary', args.base, head]);
  const diffPath = path.join(out, 'receipt.diff');
  fs.writeFileSync(diffPath, diffText);

  // merge-base
  const mergeBase = git(['merge-base', args.base, head]).trim();

  // status 원문(추적 안 된 파일 포함)
  times.status = nowIso();
  const statusRaw = git(['status', '--porcelain=v1']);

  // numstat 원문 + 파싱
  times.numstat = nowIso();
  const numstatRaw = git(['diff', '--numstat', args.base, head]);
  const numstatParsed = numstatRaw.split('\n').filter(Boolean).map((line) => {
    const [add, del, ...rest] = line.split('\t');
    return { file: rest.join('\t'), added: add === '-' ? null : Number(add), deleted: del === '-' ? null : Number(del) };
  });

  // alternates
  times.alternates = nowIso();
  const altPath = path.join(repoRoot, '.git', 'objects', 'info', 'alternates');
  let alternates = { present: false, content: null };
  if (fs.existsSync(altPath)) {
    alternates = { present: true, content: fs.readFileSync(altPath, 'utf8') };
  }

  // results.json (선택)
  let results = null;
  if (args.results) {
    times.results = nowIso();
    const raw = fs.readFileSync(args.results, 'utf8');
    const parsed = JSON.parse(raw);
    const m = resultsHeadMatches(parsed.gitHead, headSha);
    results = { path: args.results, sha256: sha256Text(raw), gitHead: parsed.gitHead, totals: parsed.totals, interrupted: parsed.interrupted ?? null, ...m };
  }

  // ls-remote (선택)
  let remote = null;
  if (args.remote) {
    times.remote = nowIso();
    const raw = git(['ls-remote', args.remote, ...args.refs]);
    const refShas = {};
    for (const line of raw.split('\n').filter(Boolean)) {
      const [sha, ref] = line.split('\t');
      refShas[ref] = sha;
    }
    remote = { url: args.remote, refs: args.refs, raw, refShas };
  }

  const diffSha = sha256File(diffPath);
  const receipt = {
    tool: 'scripts/receipt.mjs',
    repoPath: repoRoot,
    head: headSha,
    parents,
    branch,
    base: args.base,
    mergeBase,
    statusRaw,
    numstatRaw,
    numstatParsed,
    diff: { path: diffPath, sha256: diffSha },
    alternates,
    results,
    remote,
    collectedAt: times,
  };

  const receiptPath = path.join(out, 'receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  const receiptSha = sha256File(receiptPath);
  process.stdout.write(`${receiptSha}\n`);

  // 기준점 드러내기: results.json gitHead가 head와 다르면 exit 2(파일은 남긴다)
  if (results && !results.resultsHeadMatches) {
    process.stderr.write(`receipt: results.json gitHead (${results.gitHead}) != head (${headSha})\n`);
    process.exit(2);
  }
  process.exit(0);
}

// 검증 모드: 저장된 인자로 값을 다시 계산해(시각 제외) 대조한다.
function check(outDir) {
  if (!fs.existsSync(outDir)) die(`no such out dir: ${outDir}`, 1);
  const receiptPath = path.join(outDir, 'receipt.json');
  const diffPath = path.join(outDir, 'receipt.diff');
  if (!fs.existsSync(receiptPath)) die('receipt.json missing', 1);
  if (!fs.existsSync(diffPath)) die('receipt.diff missing', 1);

  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const errors = [];

  // diff sha256 재계산
  const diffSha = sha256File(diffPath);
  if (diffSha !== receipt.diff.sha256) errors.push(`receipt.diff sha256 mismatch: stored ${receipt.diff.sha256} != actual ${diffSha}`);

  // receipt.json sha256 자기 일관성(필드 변조 시 자기 참조는 어긋나지 않으므로, 대신 핵심 필드를 git에서 재계산)
  const headSha = git(['rev-parse', receipt.head]).trim();
  if (headSha !== receipt.head) errors.push(`head mismatch: stored ${receipt.head} != actual ${headSha}`);

  const parents = git(['rev-list', '--parents', '-n', '1', headSha]).trim().split(' ').slice(1);
  if (JSON.stringify(parents) !== JSON.stringify(receipt.parents)) errors.push(`parents mismatch: stored ${JSON.stringify(receipt.parents)} != actual ${JSON.stringify(parents)}`);

  const mergeBase = git(['merge-base', receipt.base, headSha]).trim();
  if (mergeBase !== receipt.mergeBase) errors.push(`mergeBase mismatch: stored ${receipt.mergeBase} != actual ${mergeBase}`);

  const statusRaw = git(['status', '--porcelain=v1']);
  if (statusRaw !== receipt.statusRaw) errors.push(`statusRaw mismatch`);

  const numstatRaw = git(['diff', '--numstat', receipt.base, headSha]);
  if (numstatRaw !== receipt.numstatRaw) errors.push(`numstatRaw mismatch`);

  const diffText = git(['diff', '--binary', receipt.base, headSha]);
  const actualDiff = fs.readFileSync(diffPath, 'utf8');
  if (diffText !== actualDiff) errors.push(`receipt.diff content mismatch vs git diff --binary`);

  if (receipt.results && receipt.results.path) {
    const raw = fs.readFileSync(receipt.results.path, 'utf8');
    const parsed = JSON.parse(raw);
    if (sha256Text(raw) !== receipt.results.sha256) errors.push(`results.json sha256 mismatch: stored ${receipt.results.sha256} != actual ${sha256Text(raw)}`);
    const rg = resultsHeadMatches(parsed.gitHead, headSha);
    if (rg.resultsHeadMatches !== receipt.results.resultsHeadMatches) errors.push(`resultsHeadMatches mismatch: stored ${receipt.results.resultsHeadMatches} != actual ${rg.resultsHeadMatches}`);
    if (JSON.stringify(parsed.totals) !== JSON.stringify(receipt.results.totals)) errors.push(`results.totals mismatch`);
  }

  // 원격 ref 재계산(저장된 url·ref로 ls-remote를 다시 돌려 refShas 대조)
  if (receipt.remote) {
    const actualRemoteRaw = git(['ls-remote', receipt.remote.url, ...receipt.remote.refs]);
    const actualRefShas = {};
    for (const line of actualRemoteRaw.split('\n').filter(Boolean)) {
      const [sha, ref] = line.split('\t');
      actualRefShas[ref] = sha;
    }
    const stored = JSON.stringify(receipt.remote.refShas);
    const actual = JSON.stringify(actualRefShas);
    if (stored !== actual) errors.push(`remote refShas mismatch: stored ${stored} != actual ${actual}`);
  }

  if (errors.length) {
    process.stderr.write('receipt check FAILED:\n');
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
  process.stdout.write('receipt check OK\n');
  process.exit(0);
}

const args = parseArgs(process.argv);
if (args.check !== undefined) check(args.check);
else build(args);
