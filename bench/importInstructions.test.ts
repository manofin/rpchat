/** npx tsx bench/importInstructions.test.ts
 * profile-instruction (0023) — local instruction files → model_profiles (db:import-instructions).
 *
 *   plan      → create / update / unchanged / skip (empty, bad name, over limit); non-.md ignored
 *   apply     → create clones rp-balanced sampling + first-heading notes; update touches only
 *               text + enabled; stored text/sha are the file bytes; re-plan → unchanged
 *   public    → docs/instructions ships only an empty example (plans to skip) + README
 *   CLI       → --dry-run writes nothing; real run backs up first and reports written=N;
 *               a DB without 0023 is refused
 *   live WAL  → with a live writer holding a non-empty WAL (service running), dry-run and real
 *               import both work (db:check's settled-file inspection would refuse here)
 *
 * Synthetic files only — never the private engine text. Temp dirs, real migrations.
 * Isolated: no systemd, no live DB, no model call.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { inspectSchema, openDb, openMigratedDb } from '../apps/server/src/db/index.ts';
import { applyInstructionImport, planInstructionImport } from '../apps/server/src/db/importInstructions.ts';

let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const MIG = path.resolve('apps/server/migrations');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ALPHA = '# 알파 합성 엔진\n## CORE\n- {{user}} 대필 금지.\n';
const BETA_NEW = '# 베타 합성 엔진 v2\n- 새 규칙\n';

function fixtureDirs() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-import-instr-data-'));
  const db = openMigratedDb(dataDir, MIG);
  const ins = db.prepare('INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes, instruction_enabled, instruction_text) VALUES (?,?,?,?,?,?,?,?,?,?)');
  ins.run('rp-balanced', null, 0.8, 0.95, 800, '[]', 'system', '기본', 0, null);
  ins.run('rp-beta', 'other-model', 0.3, 0.5, 123, '["X"]', 'merge', '베타 메모', 0, '# 옛 원문');
  ins.run('rp-gamma', null, 0.8, 0.95, 800, '[]', 'system', null, 1, '# 감마\n');
  db.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-import-instr-files-'));
  fs.writeFileSync(path.join(dir, 'rp-alpha.md'), ALPHA);
  fs.writeFileSync(path.join(dir, 'rp-beta.md'), BETA_NEW);
  fs.writeFileSync(path.join(dir, 'rp-gamma.md'), '# 감마\n');
  fs.writeFileSync(path.join(dir, 'rp-empty.md'), '  \n\n');
  fs.writeFileSync(path.join(dir, 'Bad_Name.md'), '# 이름 위반');
  fs.writeFileSync(path.join(dir, 'rp-huge.md'), 'x'.repeat(20001));
  fs.writeFileSync(path.join(dir, 'notes.txt'), '무시');
  return { dataDir, dir };
}

const cli = (args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'apps/server/src/db/cli.ts', ...args], { encoding: 'utf8', env: { ...process.env, INSTRUCTIONS_DIR: '' } });

const profiles = (dataDir: string) => {
  const db = new Database(path.join(dataDir, 'rpchat.db'), { readonly: true });
  const rows = db.prepare('SELECT * FROM model_profiles ORDER BY name').all();
  db.close();
  return rows as Array<Record<string, unknown>>;
};

async function main() {
  await t('plan: create / update / unchanged / skip reasons; non-.md ignored', () => {
    const { dataDir, dir } = fixtureDirs();
    const db = openMigratedDb(dataDir, MIG);
    const plans = planInstructionImport(db, dir, 1);
    db.close();
    const by = Object.fromEntries(plans.map((p) => [p.file, p]));
    assert.deepEqual(Object.keys(by).sort(), ['Bad_Name.md', 'rp-alpha.md', 'rp-beta.md', 'rp-empty.md', 'rp-gamma.md', 'rp-huge.md']);
    assert.equal(by['rp-alpha.md'].action, 'create');
    assert.equal(by['rp-alpha.md'].notes, '알파 합성 엔진');
    assert.equal(by['rp-alpha.md'].sha256, sha(ALPHA));
    assert.equal(by['rp-alpha.md'].chars, ALPHA.length);
    assert.equal(by['rp-beta.md'].action, 'update');
    assert.equal(by['rp-gamma.md'].action, 'unchanged');
    assert.equal(by['rp-empty.md'].action, 'skip');
    assert.match(by['rp-empty.md'].reason!, /빈 파일/);
    assert.match(by['Bad_Name.md'].reason!, /이름 규칙/);
    assert.match(by['rp-huge.md'].reason!, /상한 초과/);
  });

  await t('apply: create clones rp-balanced sampling; update touches only text+enabled; then unchanged', () => {
    const { dataDir, dir } = fixtureDirs();
    const db = openMigratedDb(dataDir, MIG);
    const written = applyInstructionImport(db, planInstructionImport(db, dir, 1));
    assert.equal(written, 2);
    const alpha = db.prepare("SELECT * FROM model_profiles WHERE name='rp-alpha'").get() as Record<string, unknown>;
    assert.deepEqual(
      { model: alpha.model, temperature: alpha.temperature, top_p: alpha.top_p, max_tokens: alpha.max_tokens, stop_json: alpha.stop_json, system_mode: alpha.system_mode },
      { model: null, temperature: 0.8, top_p: 0.95, max_tokens: 800, stop_json: '[]', system_mode: 'system' },
    );
    assert.equal(alpha.notes, '알파 합성 엔진');
    assert.equal(alpha.instruction_enabled, 1);
    assert.equal(alpha.instruction_text, ALPHA);
    assert.equal(sha(alpha.instruction_text as string), sha(ALPHA));
    const beta = db.prepare("SELECT * FROM model_profiles WHERE name='rp-beta'").get() as Record<string, unknown>;
    assert.deepEqual(
      { model: beta.model, temperature: beta.temperature, top_p: beta.top_p, max_tokens: beta.max_tokens, stop_json: beta.stop_json, system_mode: beta.system_mode, notes: beta.notes },
      { model: 'other-model', temperature: 0.3, top_p: 0.5, max_tokens: 123, stop_json: '["X"]', system_mode: 'merge', notes: '베타 메모' },
    );
    assert.equal(beta.instruction_text, BETA_NEW);
    assert.equal(beta.instruction_enabled, 1);
    assert.ok(!db.prepare("SELECT 1 FROM model_profiles WHERE name IN ('rp-empty','rp-huge','Bad_Name')").get());
    assert.ok(planInstructionImport(db, dir, 1).every((p) => p.action === 'unchanged' || p.action === 'skip'));
    db.close();
  });

  await t('public docs/instructions: only an empty example + README, which plan to skip', () => {
    const tracked = execFileSync('git', ['ls-files', 'docs/instructions'], { encoding: 'utf8' }).trim();
    const onDisk = fs.readdirSync('docs/instructions').sort();
    assert.deepEqual(onDisk, ['README.md', 'rp-example.md']);
    assert.equal(fs.statSync('docs/instructions/rp-example.md').size, 0, 'example stays empty');
    if (tracked) assert.deepEqual(tracked.split('\n').sort(), ['docs/instructions/README.md', 'docs/instructions/rp-example.md']);
    const { dataDir } = fixtureDirs();
    const db = openMigratedDb(dataDir, MIG);
    const plans = planInstructionImport(db, path.resolve('docs/instructions'), 1);
    db.close();
    assert.ok(plans.every((p) => p.action === 'skip'), JSON.stringify(plans.map((p) => [p.file, p.action])));
  });

  await t('CLI --dry-run: prints per-file plan, writes nothing, no backup file', () => {
    const { dataDir, dir } = fixtureDirs();
    const before = JSON.stringify(profiles(dataDir));
    const r = cli(['import-instructions', '--data-dir', dataDir, '--dir', dir, '--dry-run']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /dry_run=true/);
    assert.match(r.stdout, new RegExp(`file=rp-alpha\\.md name=rp-alpha action=create chars=${ALPHA.length} est_tokens=\\d+ sha256=${sha(ALPHA)}`));
    assert.match(r.stdout, /written=0/);
    assert.equal(JSON.stringify(profiles(dataDir)), before);
    assert.ok(!fs.readdirSync(dataDir).some((f) => f.startsWith('rpchat-pre-import-instructions-')));
  });

  await t('CLI real run: backup first, then written=2; default dir is <data-dir>/instructions', () => {
    const { dataDir, dir } = fixtureDirs();
    fs.cpSync(dir, path.join(dataDir, 'instructions'), { recursive: true });
    const r = cli(['import-instructions', '--data-dir', dataDir]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, new RegExp(`dir=${path.join(dataDir, 'instructions').replace(/[/\\-]/g, '\\$&')}`));
    assert.match(r.stdout, /backup=.*rpchat-pre-import-instructions-/);
    assert.match(r.stdout, /written=2/);
    const bak = fs.readdirSync(dataDir).find((f) => f.startsWith('rpchat-pre-import-instructions-'))!;
    const bdb = new Database(path.join(dataDir, bak), { readonly: true });
    assert.equal((bdb.prepare("SELECT instruction_text FROM model_profiles WHERE name='rp-beta'").get() as { instruction_text: string }).instruction_text, '# 옛 원문', 'backup is pre-write');
    bdb.close();
    const again = cli(['import-instructions', '--data-dir', dataDir]);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /written=0/);
  });

  await t('CLI refuses a DB without 0023, and a relative --dir', () => {
    const oldMig = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-import-instr-mig-'));
    for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql') && x < '0023')) fs.copyFileSync(path.join(MIG, f), path.join(oldMig, f));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-import-instr-old-'));
    openMigratedDb(dataDir, oldMig).close();
    const { dir } = fixtureDirs();
    const r = cli(['import-instructions', '--data-dir', dataDir, '--dir', dir, '--dry-run']);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /missing=0023_profile_instruction\.sql/);
    assert.match(r.stderr, /0023 필요/);
    const rel = cli(['import-instructions', '--data-dir', dataDir, '--dir', 'relative/dir', '--dry-run']);
    assert.equal(rel.status, 2);
  });

  await t('live WAL: service-like writer holds a non-empty WAL → dry-run and import still work', () => {
    const { dataDir, dir } = fixtureDirs();
    // Stand-in for the running service: its own WAL connection, no checkpoint, still open.
    const live = openDb(dataDir);
    live.pragma('wal_autocheckpoint = 0');
    live.prepare("INSERT INTO settings (key, value) VALUES ('wal_probe', '1')").run();
    const wal = path.join(dataDir, 'rpchat.db-wal');
    assert.ok(fs.existsSync(wal) && fs.statSync(wal).size > 0, 'WAL must be non-empty for this case');
    // Why the loader cannot use inspectSchema: the settled-file check refuses a live WAL.
    assert.ok(inspectSchema(dataDir, MIG).problems.some((p) => /WAL/.test(p)));

    const dry = cli(['import-instructions', '--data-dir', dataDir, '--dir', dir, '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /name=rp-alpha action=create/);
    assert.match(dry.stdout, /written=0/);
    assert.equal(live.prepare("SELECT 1 FROM model_profiles WHERE name='rp-alpha'").get(), undefined, 'dry-run wrote nothing');

    const real = cli(['import-instructions', '--data-dir', dataDir, '--dir', dir]);
    assert.equal(real.status, 0, real.stderr + real.stdout);
    assert.match(real.stdout, /written=2/);
    // The live connection sees the committed rows on its next read.
    const row = live.prepare("SELECT instruction_enabled, instruction_text FROM model_profiles WHERE name='rp-alpha'").get() as { instruction_enabled: number; instruction_text: string };
    assert.deepEqual(row, { instruction_enabled: 1, instruction_text: ALPHA });
    assert.equal((live.prepare("SELECT value FROM settings WHERE key='wal_probe'").get() as { value: string }).value, '1');
    live.close();
  });

  console.log(`PASS=${passed}`);
}

main().catch((e) => {
  console.error('RED', e);
  process.exit(1);
});
