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
import { applyInstructionImport, formatPlanLine, migrationProblemsLive, planInstructionImport } from './importInstructions.js';
import { getCalibration } from '../prompt/tokens.js';

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

/**
 * import-instructions: 로컬 지침 파일(<이름>.md) → model_profiles.instruction_text.
 * --dir 생략 시 INSTRUCTIONS_DIR, 그것도 없으면 <data-dir>/instructions.
 *
 * 실행 조건(서비스 실행 중 가능 — WAL 허용):
 * - DB 파일이 있어야 하고, migration 이 최신(missing·extra 0, 즉 0023 적용)이어야 한다.
 *   검사는 일반 SQLite 연결로 한다(db:check 의 무변경 파일 검사는 WAL 이 있으면 거부하므로 쓰지 않음).
 * - --dry-run: 읽기 전용 연결. DB 내용을 쓰지 않는다.
 * - 실제 적재: 일반 연결(busy_timeout 5000) → 온라인 백업·integrity 확인 → create/update 한 트랜잭션.
 *   생성 경로는 턴마다 프로필을 한 번 읽으므로 한 턴 안에서 지침이 섞이지 않는다. 재시작 불필요.
 */
async function importInstructions(dataDir: string, argv: string[]): Promise<number> {
  const di = argv.indexOf('--dir');
  const rawDir = di >= 0 ? argv[di + 1] : (process.env.INSTRUCTIONS_DIR || path.join(dataDir, 'instructions'));
  if (!rawDir || rawDir.startsWith('--') || !path.isAbsolute(rawDir)) {
    console.error(`--dir(또는 INSTRUCTIONS_DIR)는 절대경로여야 함: ${rawDir ?? '(없음)'}`);
    return 2;
  }
  const dryRun = argv.includes('--dry-run');
  if (!fs.existsSync(dbPath(dataDir))) {
    console.error(`DB 없음: ${dbPath(dataDir)} — 적재 시작 안 함.`);
    return 1;
  }
  const db = dryRun ? new Database(dbPath(dataDir), { readonly: true, fileMustExist: true }) : openDb(dataDir);
  if (dryRun) db.pragma('busy_timeout = 5000');
  const mig = migrationProblemsLive(db, config.migrationsDir);
  if (mig.missing.length || mig.extra.length) {
    db.close();
    console.log(`missing=${mig.missing.join(',') || '(none)'}`);
    console.log(`extra=${mig.extra.join(',') || '(none)'}`);
    console.error('스키마가 최신이 아님(0023 필요) — 적재 시작 안 함.');
    return 1;
  }
  console.log(`dir=${rawDir}`);
  console.log(`dry_run=${dryRun}`);
  const plans = planInstructionImport(db, rawDir, getCalibration(db));
  if (dryRun) {
    db.close();
    for (const p of plans) console.log(formatPlanLine(p));
    console.log('written=0');
    console.log('status=ok');
    return 0;
  }
  for (const p of plans) console.log(formatPlanLine(p));
  if (!plans.some((p) => p.action === 'create' || p.action === 'update')) {
    db.close();
    console.log('written=0');
    console.log('status=ok');
    return 0;
  }
  const backupPath = path.join(dataDir, `rpchat-pre-import-instructions-${stamp()}.db`);
  try {
    await backupDatabase(db, backupPath);
  } catch (e) {
    db.close();
    console.error(`백업 실패, 적재 시작 안 함: ${(e as Error).message}`);
    return 1;
  }
  const bak = new Database(backupPath, { readonly: true, fileMustExist: true });
  const ok = integrityOk(bak);
  bak.close();
  if (!ok) {
    db.close();
    console.error(`백업 integrity_check 실패, 적재 시작 안 함: ${backupPath}`);
    return 1;
  }
  console.log(`backup=${backupPath}`);
  const written = applyInstructionImport(db, plans);
  db.close();
  console.log(`written=${written}`);
  console.log('status=ok');
  return 0;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd !== 'check' && cmd !== 'migrate' && cmd !== 'import-instructions') {
    console.error('usage: db:check|db:migrate --data-dir <절대경로> | db:import-instructions --data-dir <절대경로> [--dir <절대경로>] [--dry-run]');
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
  if (cmd === 'import-instructions') process.exit(await importInstructions(dataDir, argv));
  process.exit(await migrate(dataDir));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
