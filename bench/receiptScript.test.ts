/** npx tsx bench/receiptScript.test.ts
 * 코드-receipt-fence: 영수증 자동 생성/검증 스크립트(scripts/receipt.mjs)의 동작 fence.
 * 임시 디렉터리에 git 저장소와 bare 원격을 만들어 생성(--out)과 검증(--check)을 검증한다.
 *
 * Isolation: 임시 mkdtemp 디렉터리 안의 일회용 git repo/bare 원격만 사용.
 * 네트워크·라이브 자산·실제 원격(rpchat)은 쓰지 않는다. 임시 디렉터리는 마지막에 지운다.
 * Regression control: 스크립트가 diff를 가공하면 a)가 실패하고, 변조를 못 잡으면 f)가 실패한다.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RECEIPT = path.resolve('scripts/receipt.mjs');

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function makeRepo(root) {
  sh('git', ['init', '-b', 'main', root]);
  sh('git', ['-C', root, 'config', 'user.email', 't@t']);
  sh('git', ['-C', root, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  sh('git', ['-C', root, 'add', '.']);
  sh('git', ['-C', root, 'commit', '-m', 'c1']);
  return root;
}

function receiptOut(args, cwd) {
  return sh('node', [RECEIPT, ...args], { cwd });
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-bench-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`ok ${checks} ${name}`);
}

// 커밋 3종: 추가만 / 삭제 포함 / 이름 바꾸기. head는 별도 브랜치로 만들어 base..head diff를 만든다.
withTmp((root) => {
  const repo = path.join(root, 'repo');
  makeRepo(repo);
  // base 에 존재하는 파일 3종: keep(변경), del(삭제), src(이름 바꾸기 원본)
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'del.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'src.txt'), 'base\n');
  sh('git', ['-C', repo, 'add', '.']);
  sh('git', ['-C', repo, 'commit', '-m', 'c2 three files']);
  // base 는 세 파일(keep/del/src)이 존재하는 c2 다. c1 을 base 로 잡으면 이 세 파일이
  // base..HEAD 에서 추가와 삭제/이름바꾸기가 동시에 일어나 net-zero 로 사라져 삭제가 안 보인다.
  const base = sh('git', ['-C', repo, 'rev-parse', 'HEAD']).trim();
  // feat: keep 수정(추가만 파일은 별도), del 삭제, src 이름 바꾸기
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'base\nadd\n'); // add-only (내용 추가)
  fs.writeFileSync(path.join(repo, 'added.txt'), 'new\n'); // add-only (새 파일)
  // fixture: 200자 넘는 비ASCII(한국어) 한 줄 변경 + 끝 개행 없는 파일
  const longKorean = '가'.repeat(210);
  fs.writeFileSync(path.join(repo, 'long.txt'), `${longKorean}\n`); // base 버전(개행 있음)
  fs.writeFileSync(path.join(repo, 'noeol.txt'), 'no trailing newline'); // 끝 개행 없음
  sh('git', ['-C', repo, 'add', '.']);
  sh('git', ['-C', repo, 'commit', '-m', 'fixture long-korean + no-eol (base)']);
  fs.writeFileSync(path.join(repo, 'long.txt'), `${longKorean} 수정\n`); // feat 에서 한 줄 변경(210자+)
  fs.writeFileSync(path.join(repo, 'noeol.txt'), 'no trailing newline now'); // feat 에서 변경(끝 개행 없음 유지)
  sh('git', ['-C', repo, 'add', '.']);
  sh('git', ['-C', repo, 'commit', '-m', 'feat edits + add']);
  // 삭제는 별도 커밋(rename 과 같은 커밋에 넣으면 git rename 추론에 삭제가 가려짐)
  sh('git', ['-C', repo, 'rm', 'del.txt']); // deletion
  sh('git', ['-C', repo, 'commit', '-m', 'feat del']);
  // 이름 바꾸기도 별도 커밋
  sh('git', ['-C', repo, 'mv', 'src.txt', 'dst.txt']); // rename
  sh('git', ['-C', repo, 'add', '-A']);
  sh('git', ['-C', repo, 'commit', '-m', 'feat rename']);

  const outDir = path.join(root, 'receipt');
  receiptOut(['--base', base, '--out', outDir], repo);

  // a) receipt.diff == git diff --binary 원문 (Buffer 바이트 비교)
  const actualDiff = sh('git', ['-C', repo, 'diff', '--binary', base, 'HEAD']);
  const storedBuf = fs.readFileSync(path.join(outDir, 'receipt.diff'));
  const actualBuf = Buffer.from(actualDiff, 'utf8');
  assert.ok(Buffer.compare(storedBuf, actualBuf) === 0, 'a) receipt.diff must byte-equal git diff --binary');
  ok('a receipt.diff byte-identical (long-korean + no-eol fixtures)');

  // b) numstat: 추가(added>=1) / 삭제(deleted>=1) / 이름 바꾸기('=> ') 각 1건.
  //    rename 추론이 del/src 중 어느 쪽을 소스로 삼을지 비결정적이므로, 파일명 단정이 아니라
  //    방향(added/deleted/'=>')으로 단정한다. 각 시나리오가 1건씩 존재함은 확실하다.
  const receipt = JSON.parse(fs.readFileSync(path.join(outDir, 'receipt.json'), 'utf8'));
  const addFiles = receipt.numstatParsed.filter((n) => n.added >= 1).map((n) => n.file);
  const delFiles = receipt.numstatParsed.filter((n) => n.deleted >= 1).map((n) => n.file);
  const renames = receipt.numstatParsed.filter((n) => n.file.includes(' => ')).map((n) => n.file);
  assert.ok(addFiles.includes('added.txt'), `b) add-only present: ${addFiles}`);
  assert.equal(delFiles.length, 1, `b) exactly one deletion (del/src rename 추론 비결정): ${delFiles}`);
  assert.equal(renames.length, 1, `b) exactly one rename: ${renames}`);
  ok('b numstat add/del/rename each 1');

  // c) 추적 안 된 파일 + 미커밋 변경이 status 원문에 나타난다
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'u\n');
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'base\nadd\nmod\n');
  const outDir2 = path.join(root, 'receipt2');
  receiptOut(['--base', base, '--out', outDir2], repo);
  const r2 = JSON.parse(fs.readFileSync(path.join(outDir2, 'receipt.json'), 'utf8'));
  assert.ok(r2.statusRaw.includes('untracked.txt'), 'c) untracked file in status');
  assert.ok(r2.statusRaw.includes('keep.txt'), 'c) uncommitted change in status');
  ok('c untracked + uncommitted in status');

  // d) results.json gitHead != head 이면 exit 2 + resultsHeadMatches=false
  const outDir3 = path.join(root, 'receipt3');
  const wrongResults = path.join(root, 'wrong-results.json');
  fs.writeFileSync(wrongResults, JSON.stringify({ gitHead: 'deadbeef', totals: {}, interrupted: false }));
  let dExit = 0;
  try {
    receiptOut(['--base', base, '--results', wrongResults, '--out', outDir3], repo);
  } catch (e) {
    dExit = e.status ?? 1;
  }
  assert.equal(dExit, 2, 'd) exit 2 when results gitHead != head');
  const r3 = JSON.parse(fs.readFileSync(path.join(outDir3, 'receipt.json'), 'utf8'));
  assert.equal(r3.results.resultsHeadMatches, false, 'd) resultsHeadMatches=false');
  ok('d results gitHead mismatch -> exit 2 + resultsHeadMatches false');

  // e) 이미 있는 --out 은 exit 1 이고 기존 파일이 그대로다
  let eExit = 0;
  try {
    receiptOut(['--base', base, '--out', outDir], repo); // outDir already exists
  } catch (e) {
    eExit = e.status ?? 1;
  }
  assert.equal(eExit, 1, 'e) refuse overwrite exit 1');
  assert.ok(fs.existsSync(path.join(outDir, 'receipt.json')), 'e) existing file preserved');
  ok('e refuse overwrite existing --out -> exit 1, file preserved');

  // g) 변조 없으면 --check exit 0
  const okCheck = sh('node', [RECEIPT, '--check', outDir2], { cwd: repo });
  assert.match(okCheck, /receipt check OK/, 'g) clean check exit 0');
  ok('g clean check exit 0');
});

// f) 변조 감지: diff 1바이트 변조 / receipt.json 필드 변조 / 원격 ref 이동
withTmp((root) => {
  const repo = path.join(root, 'repo');
  makeRepo(repo);
  fs.writeFileSync(path.join(repo, 'x.txt'), 'x\n');
  sh('git', ['-C', repo, 'add', '.']);
  sh('git', ['-C', repo, 'commit', '-m', 'add x']);
  const base = sh('git', ['-C', repo, 'rev-parse', 'HEAD~1']).trim();

  // bare 원격
  const bare = path.join(root, 'bare.git');
  sh('git', ['init', '--bare', bare]);
  sh('git', ['-C', repo, 'remote', 'add', 'origin', bare]);
  sh('git', ['-C', repo, 'push', 'origin', 'HEAD:refs/heads/main']);
  sh('git', ['-C', repo, 'checkout', '-b', 'feat', base]);
  fs.writeFileSync(path.join(repo, 'y.txt'), 'y\n');
  sh('git', ['-C', repo, 'add', '.']);
  sh('git', ['-C', repo, 'commit', '-m', 'add y']);
  sh('git', ['-C', repo, 'push', 'origin', 'HEAD:refs/heads/feat']);

  // 원본 영수증
  const outDir = path.join(root, 'r');
  receiptOut(['--base', base, '--remote', bare, '--ref', 'refs/heads/feat', '--out', outDir], repo);

  // f1) receipt.diff 1바이트 변조
  const diffPath = path.join(outDir, 'receipt.diff');
  const orig = fs.readFileSync(diffPath);
  const tampered = Buffer.from(orig);
  tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0x01;
  fs.writeFileSync(diffPath, tampered);
  let code = 0;
  try { sh('node', [RECEIPT, '--check', outDir], { cwd: repo }); } catch (e) { code = e.status ?? 1; }
  assert.equal(code, 1, 'f1) tampered diff -> exit 1');
  fs.writeFileSync(diffPath, orig); // restore
  ok('f1 tampered receipt.diff byte -> check exit 1');

  // f2) receipt.json 필드 변조
  const rjPath = path.join(outDir, 'receipt.json');
  const rj = JSON.parse(fs.readFileSync(rjPath, 'utf8'));
  rj.head = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  fs.writeFileSync(rjPath, JSON.stringify(rj, null, 2));
  code = 0;
  try { sh('node', [RECEIPT, '--check', outDir], { cwd: repo }); } catch (e) { code = e.status ?? 1; }
  assert.equal(code, 1, 'f2) tampered head -> exit 1');
  ok('f2 tampered receipt.json field -> check exit 1');

  // f3) 원격 ref 이동 (amend 로 실제 내용을 바꿔 SHA 를 변경하고 force-push)
  const outDir3 = path.join(root, 'r3');
  receiptOut(['--base', base, '--remote', bare, '--ref', 'refs/heads/feat', '--out', outDir3], repo);
  fs.writeFileSync(path.join(repo, 'z.txt'), 'z\n');
  sh('git', ['-C', repo, 'add', '.']);
  sh('git', ['-C', repo, 'commit', '-q', '--amend', '--no-edit']); // 내용 변경 -> SHA 변경
  sh('git', ['-C', repo, 'push', '-f', 'origin', 'HEAD:refs/heads/feat']); // move remote ref
  code = 0;
  let checkOut = '';
  try { checkOut = sh('node', [RECEIPT, '--check', outDir3], { cwd: repo }); } catch (e) { code = e.status ?? 1; checkOut = (e.stdout || '') + (e.stderr || ''); }
  assert.equal(code, 1, 'f3) moved remote ref -> exit 1');
  assert.match(checkOut, /remote refShas mismatch/, 'f3) item name reported');
  ok('f3 moved remote ref -> check exit 1 + item name');
});

// h) alternates 가 있는 clone 에서 그 사실이 기록된다
withTmp((root) => {
  const src = path.join(root, 'src');
  makeRepo(src);
  // alternates 대상은 실제로 존재하는 디렉터리여야 git 가 죽지 않는다. src 의 objects 를 쓴다.
  const objDir = path.join(src, '.git', 'objects');
  const clone = path.join(root, 'clone');
  sh('git', ['clone', '--shared', src, clone]);
  fs.mkdirSync(path.join(clone, '.git', 'objects', 'info'), { recursive: true });
  fs.writeFileSync(path.join(clone, '.git', 'objects', 'info', 'alternates'), objDir);
  fs.writeFileSync(path.join(clone, 'n.txt'), 'n\n');
  sh('git', ['-C', clone, 'config', 'user.email', 't@t']);
  sh('git', ['-C', clone, 'config', 'user.name', 't']);
  sh('git', ['-C', clone, 'add', '.']);
  sh('git', ['-C', clone, 'commit', '-m', 'n']);
  const base = sh('git', ['-C', clone, 'rev-parse', 'HEAD~1']).trim();
  const outDir = path.join(root, 'r');
  receiptOut(['--base', base, '--out', outDir], clone);
  const rj = JSON.parse(fs.readFileSync(path.join(outDir, 'receipt.json'), 'utf8'));
  assert.equal(rj.alternates.present, true, 'h) alternates.present=true');
  assert.ok(rj.alternates.content.includes('objects'), 'h) alternates content recorded');
  ok('h alternates recorded (present + content)');
});

console.log(`receiptScript: all assertions passed (${checks} checks)`);
