import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { defaultSchemaCompatPath, schemaCompatProblems } from './schemaCompat.js';
import {
  applyMigrations,
  backupDatabase,
  dbPath,
  inspectSchema,
  integrityOk,
  openDb,
} from './index.js';

function requireAbsDataDir(argv: string[]): string {
  const i = argv.indexOf('--data-dir');
  if (i < 0 || !argv[i + 1] || argv[i + 1].startsWith('--')) {
    console.error('필수: --data-dir <절대경로>. 라이브 경로 기본값 없음.');
    process.exit(2);
  }
  const raw = argv[i + 1];
  if (!path.isAbsolute(raw)) {
    console.error(`--data-dir 는 절대경로여야 함: ${raw}`);
    process.exit(2);
  }
  return raw;
}

function printInspection(r: ReturnType<typeof inspectSchema>): void {
  console.log(`exists=${r.exists}`);
  console.log(`has_migrations_table=${r.hasMigrationsTable}`);
  console.log(`files=${r.files.length}`);
  console.log(`applied=${r.applied.length}`);
  console.log(`missing=${r.missing.join(',') || '(none)'}`);
  console.log(`extra=${r.extra.join(',') || '(none)'}`);
  if (r.problems.length) {
    for (const p of r.problems) console.log(`problem=${p}`);
  }
}

async function migrate(dataDir: string): Promise<number> {
  const file = dbPath(dataDir);
  const mig = config.migrationsDir;
  let backupPath = '';

  if (fs.existsSync(file)) {
    const pre = inspectSchema(dataDir, mig);
    if (pre.readError) {
      printInspection(pre);
      console.error('DB 검사 실패 — migration 시작 안 함.');
      return 1;
    }
    if (pre.extra.length) {
      printInspection(pre);
      console.error('extra in DB — 자동 downgrade·복원 없음. migration 시작 안 함.');
      return 1;
    }
    if (pre.problems.length === 0) {
      printInspection(pre);
      console.log('applied_now=(none)');
      console.log('status=ok');
      return 0;
    }
    const db = openDb(dataDir);
    backupPath = path.join(dataDir, `rpchat-pre-migrate-${stamp()}.db`);
    try {
      await backupDatabase(db, backupPath);
    } catch (e) {
      db.close();
      console.error(`백업 실패, migration 시작 안 함: ${(e as Error).message}`);
      return 1;
    }
    const bak = new Database(backupPath, { readonly: true, fileMustExist: true });
    const ok = integrityOk(bak);
    bak.close();
    if (!ok) {
      db.close();
      console.error(`백업 integrity_check 실패, migration 시작 안 함: ${backupPath}`);
      return 1;
    }
    console.log(`backup=${backupPath}`);
    const result = applyMigrations(db, mig);
    db.close();
    return reportApply(result, backupPath);
  }

  const db = openDb(dataDir);
  const result = applyMigrations(db, mig);
  db.close();
  console.log('backup=(none)');
  return reportApply(result, '');
}

function reportApply(result: { applied: string[]; failed?: { file: string; error: string } }, backupPath: string): number {
  console.log(`applied_now=${result.applied.join(',') || '(none)'}`);
  if (backupPath) console.log(`backup=${backupPath}`);
  if (result.failed) {
    console.error(`failed_file=${result.failed.file}`);
    console.error(`failed_error=${result.failed.error}`);
    console.error('자동 복원 없음.');
    return 1;
  }
  console.log('status=ok');
  return 0;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd !== 'check' && cmd !== 'migrate') {
    console.error('usage: db:check|db:migrate --data-dir <절대경로>');
    process.exit(2);
  }
  const dataDir = requireAbsDataDir(argv);
  const specProblems = schemaCompatProblems(config.migrationsDir, defaultSchemaCompatPath());
  if (specProblems.length) {
    for (const p of specProblems) console.error(`[schema-compat] ${p}`);
    process.exit(1);
  }
  const before = fs.existsSync(dbPath(dataDir));
  if (cmd === 'check') {
    const r = inspectSchema(dataDir, config.migrationsDir);
    const after = fs.existsSync(dbPath(dataDir));
    if (after !== before) {
      console.error('check 가 DB 파일을 만들거나 지웠음');
      process.exit(1);
    }
    printInspection(r);
    process.exit(r.problems.length ? 1 : 0);
  }
  process.exit(await migrate(dataDir));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
