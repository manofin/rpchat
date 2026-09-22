/**
 * npx tsx bench/explicitMigrationLifecycle.test.ts
 * ExplicitMigrationLifecycle — boot does not migrate; db:check is read-only;
 * db:migrate requires absolute --data-dir. Isolated temp dirs only.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  applyMigrations,
  appliedMigrationNames,
  backupDatabase,
  dbPath,
  inspectSchema,
  openDb,
  openMigratedDb,
} from '../apps/server/src/db/index.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIG = path.join(root, 'apps/server/migrations');

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eml-'));
}

function diskState(dir: string): unknown {
  return fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    return {
      name, size: stat.size, mtime: stat.mtimeMs,
      hash: stat.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null,
    };
  });
}

function cli(args: string[]) {
  const ignoredDefault = tmp();
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/server/src/db/cli.ts', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DATA_DIR: ignoredDefault },
      timeout: 15000,
    });
    assert.deepEqual(fs.readdirSync(ignoredDefault), [], 'CLI must never use the DATA_DIR default');
    return result;
  } finally {
    fs.rmSync(ignoredDefault, { recursive: true, force: true });
  }
}

async function main() {
  await t('check without --data-dir exits 2; does not use DATA_DIR default', () => {
    const r = cli(['check']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--data-dir/);
    assert.match(r.stderr, /기본값 없음/);
  });

  await t('check relative --data-dir exits 2', () => {
    const r = cli(['check', '--data-dir', 'data']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /절대경로/);
  });

  await t('check missing DB: exit 1, no file created', () => {
    const dir = tmp();
    const r = cli(['check', '--data-dir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /DB 없음/);
    assert.equal(fs.existsSync(dbPath(dir)), false);
    fs.rmSync(dir, { recursive: true });
  });

  await t('openDb does not apply migrations', () => {
    const dir = tmp();
    const db = openDb(dir);
    assert.equal(appliedMigrationNames(db).length, 0);
    db.close();
    const ins = inspectSchema(dir, MIG);
    assert.ok(ins.problems.some((p) => p.includes('기록 없음')));
    assert.ok(ins.missing.length > 0);
    fs.rmSync(dir, { recursive: true });
  });

  await t('inspectSchema does not create a DB', () => {
    const dir = tmp();
    inspectSchema(dir, MIG);
    assert.equal(fs.existsSync(dbPath(dir)), false);
    fs.rmSync(dir, { recursive: true });
  });

  await t('db:migrate empty abs dir then db:check ok', () => {
    const dir = tmp();
    const m = cli(['migrate', '--data-dir', dir]);
    assert.equal(m.status, 0, m.stderr + m.stdout);
    assert.match(m.stdout, /status=ok/);
    assert.match(m.stdout, /applied_now=0001_init\.sql/);
    const c = cli(['check', '--data-dir', dir]);
    assert.equal(c.status, 0, c.stderr + c.stdout);
    assert.match(c.stdout, /missing=\(none\)/);
    assert.match(c.stdout, /extra=\(none\)/);
    fs.rmSync(dir, { recursive: true });
  });

  await t('db:migrate is idempotent', () => {
    const dir = tmp();
    assert.equal(cli(['migrate', '--data-dir', dir]).status, 0);
    const again = cli(['migrate', '--data-dir', dir]);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.match(again.stdout, /applied_now=\(none\)/);
    fs.rmSync(dir, { recursive: true });
  });

  await t('old DB: missing files fail check; no extra write', () => {
    const dir = tmp();
    const one = tmp();
    fs.writeFileSync(path.join(one, '0001_init.sql'), fs.readFileSync(path.join(MIG, '0001_init.sql')));
    const db = openMigratedDb(dir, one);
    db.close();
    const before = diskState(dir);
    const ins = inspectSchema(dir, MIG);
    assert.ok(ins.missing.includes('0002_search.sql'));
    const c = cli(['check', '--data-dir', dir]);
    assert.equal(c.status, 1);
    assert.match(c.stdout, /missing=/);
    const boot = spawnSync(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, AUTH_MODE: 'none', HOST: '127.0.0.1', PORT: '0', DATA_DIR: dir,
        RPCHAT_PROMPT_DUMP: '0', RPCHAT_REQUEST_DUMP: '0' },
    });
    assert.equal(boot.status, 1, boot.stderr + boot.stdout);
    assert.match(boot.stderr, /\[schema\].*missing/);
    assert.deepEqual(diskState(dir), before, 'check must not create WAL/SHM or modify any file');
    fs.rmSync(dir, { recursive: true });
    fs.rmSync(one, { recursive: true });
  });

  await t('newer DB extra fails check and migrate; no downgrade', () => {
    const dir = tmp();
    const db = openMigratedDb(dir, MIG);
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES ('0099_future.sql', ?)").run(
      new Date().toISOString(),
    );
    const names = appliedMigrationNames(db);
    db.close();
    const c = cli(['check', '--data-dir', dir]);
    assert.equal(c.status, 1);
    assert.match(c.stdout, /extra=0099_future\.sql/);
    const m = cli(['migrate', '--data-dir', dir]);
    assert.equal(m.status, 1);
    assert.match(m.stderr + m.stdout, /extra/);
    const db2 = openDb(dir);
    assert.deepEqual(appliedMigrationNames(db2).sort(), names.sort());
    db2.close();
    fs.rmSync(dir, { recursive: true });
  });

  await t('settled WAL-mode DB check succeeds without sidecars', () => {
    const dir = tmp();
    openMigratedDb(dir, MIG).close();
    const before = diskState(dir);
    const c = cli(['check', '--data-dir', dir]);
    assert.equal(c.status, 0, c.stderr + c.stdout);
    assert.deepEqual(diskState(dir), before);
    fs.rmSync(dir, { recursive: true });
  });

  await t('uncheckpointed WAL rejects check and migrate without changing files', () => {
    const dir = tmp();
    const db = openMigratedDb(dir, MIG);
    try {
      assert.ok(fs.statSync(`${dbPath(dir)}-wal`).size > 0);
      const before = diskState(dir);
      assert.match(inspectSchema(dir, MIG).readError ?? '', /WAL/);
      for (const command of ['check', 'migrate']) {
        const r = cli([command, '--data-dir', dir]);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stdout + r.stderr, /WAL/);
        assert.deepEqual(diskState(dir), before);
      }
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true });
    }
  });

  await t('corrupt DB and recovery journal fail without disk changes', () => {
    for (const kind of ['corrupt', 'journal']) {
      const dir = tmp();
      if (kind === 'corrupt') fs.writeFileSync(dbPath(dir), 'invalid fixture');
      else {
        openMigratedDb(dir, MIG).close();
        fs.writeFileSync(`${dbPath(dir)}-journal`, 'pending recovery fixture');
      }
      const before = diskState(dir);
      for (const command of ['check', 'migrate']) {
        const r = cli([command, '--data-dir', dir]);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.deepEqual(diskState(dir), before);
      }
      fs.rmSync(dir, { recursive: true });
    }
  });

  await t('SQL failure stops; no auto restore; prior files stay applied', () => {
    const dir = tmp();
    const mig = tmp();
    fs.writeFileSync(path.join(mig, '0001_ok.sql'), 'CREATE TABLE t (id INTEGER);');
    fs.writeFileSync(path.join(mig, '0002_bad.sql'), 'THIS IS NOT SQL;');
    const db = openDb(dir);
    const result = applyMigrations(db, mig);
    assert.deepEqual(result.applied, ['0001_ok.sql']);
    assert.equal(result.failed?.file, '0002_bad.sql');
    assert.deepEqual(appliedMigrationNames(db), ['0001_ok.sql']);
    db.close();
    fs.rmSync(dir, { recursive: true });
    fs.rmSync(mig, { recursive: true });
  });

  await t('backup API failure is visible; dest dir is not a db file', async () => {
    const dir = tmp();
    const db = openMigratedDb(dir, MIG);
    const dest = path.join(dir, 'not-a-file');
    fs.mkdirSync(dest);
    await assert.rejects(() => backupDatabase(db, dest));
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  await t('index.ts inspects schema before writable openDb; no openMigratedDb', () => {
    const src = fs.readFileSync(path.join(root, 'apps/server/src/index.ts'), 'utf8');
    const iIns = src.indexOf('inspectSchema(');
    const iOpen = src.indexOf('openDb(');
    assert.ok(iIns >= 0 && iOpen > iIns);
    assert.equal(src.includes('openMigratedDb'), false);
    assert.equal(src.includes('applyMigrations('), false);
  });

  await t('cli migrate existing missing files writes a pre-migrate backup', () => {
    const dir = tmp();
    const one = tmp();
    fs.writeFileSync(path.join(one, '0001_init.sql'), fs.readFileSync(path.join(MIG, '0001_init.sql')));
    const db = openMigratedDb(dir, one);
    db.close();
    const m = cli(['migrate', '--data-dir', dir]);
    assert.equal(m.status, 0, m.stderr + m.stdout);
    assert.match(m.stdout, /backup=/);
    const bak = /backup=(.+\.db)/.exec(m.stdout)?.[1];
    assert.ok(bak && fs.existsSync(bak), m.stdout);
    const c = cli(['check', '--data-dir', dir]);
    assert.equal(c.status, 0, c.stderr + c.stdout);
    fs.rmSync(dir, { recursive: true });
    fs.rmSync(one, { recursive: true });
  });

  console.log(`${passed} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
