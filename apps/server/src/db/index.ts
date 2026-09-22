import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type DB = Database.Database;

export type SchemaInspection = {
  dbPath: string;
  exists: boolean;
  hasMigrationsTable: boolean;
  files: string[];
  applied: string[];
  missing: string[];
  extra: string[];
  problems: string[];
  readError?: string;
};

export type ApplyResult = {
  applied: string[];
  failed?: { file: string; error: string };
};

export function dbPath(dataDir: string): string {
  return path.join(dataDir, 'rpchat.db');
}

export function listMigrationFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export function openDb(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });
  const db = new Database(dbPath(dataDir));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function openReadonlyDb(dataDir: string): DB {
  const file = dbPath(dataDir);
  // Even SQLITE_OPEN_READONLY can create WAL/SHM. Inspect a settled image in
  // memory instead; never ignore pending WAL or recover the source implicitly.
  const state = () => [file, `${file}-wal`, `${file}-shm`, `${file}-journal`].map((p) => {
    try {
      const s = fs.statSync(p, { bigint: true });
      if (!s.isFile()) throw new Error(`검사 대상이 일반 파일이 아님: ${p}`);
      if ((p.endsWith('-wal') || p.endsWith('-journal')) && s.size > 0n) {
        throw new Error('WAL/복구 저널이 남아 있어 무변경 검사를 할 수 없음. 서비스 중지 및 별도 승인된 복구 후 재검사');
      }
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && p !== file) return null;
      throw e;
    }
  });
  const before = state();
  const bytes = fs.readFileSync(file);
  const after = state();
  if (before.some((v, i) => v !== after[i])) throw new Error('검사 중 DB 파일이 변경됨. 서비스 중지 후 재검사');
  if (bytes.length < 100 || bytes.subarray(0, 16).toString() !== 'SQLite format 3\0') {
    throw new Error('유효한 SQLite DB 헤더가 아님');
  }
  // sqlite3_deserialize cannot read WAL-mode images. Only the private buffer's
  // journal-mode bytes change: https://sqlite.org/c3ref/deserialize.html
  if (bytes[18] === 2 && bytes[19] === 2) {
    bytes[18] = 1;
    bytes[19] = 1;
  }
  return new Database(bytes, { readonly: true });
}

export function appliedMigrationNames(db: DB): string[] {
  const has = one<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
  );
  if (!has || has.n < 1) return [];
  return many<{ name: string }>(db, 'SELECT name FROM schema_migrations ORDER BY name').map((r) => r.name);
}

export function inspectSchema(dataDir: string, migrationsDir: string): SchemaInspection {
  const file = dbPath(dataDir);
  const files = listMigrationFiles(migrationsDir);
  const base = (): SchemaInspection => ({
    dbPath: file,
    exists: false,
    hasMigrationsTable: false,
    files,
    applied: [],
    missing: files.slice(),
    extra: [],
    problems: [],
  });
  if (!fs.existsSync(file)) {
    const r = base();
    r.problems.push('DB 없음. db:migrate --data-dir <절대경로>');
    return r;
  }
  let db: DB;
  try {
    db = openReadonlyDb(dataDir);
  } catch (e) {
    const r = base();
    r.exists = true;
    r.readError = `DB를 읽기 전용으로 열 수 없음: ${(e as Error).message}`;
    r.problems.push(r.readError);
    return r;
  }
  try {
    const applied = appliedMigrationNames(db);
    const hasTable = applied.length > 0 || tableExists(db, 'schema_migrations');
    const fileSet = new Set(files);
    const appSet = new Set(applied);
    const missing = files.filter((f) => !appSet.has(f));
    const extra = applied.filter((a) => !fileSet.has(a));
    const problems: string[] = [];
    if (!hasTable || applied.length === 0) problems.push('migration 기록 없음');
    if (missing.length) problems.push(`missing: ${missing.join(',')}`);
    if (extra.length) problems.push(`extra: ${extra.join(',')}`);
    return {
      dbPath: file,
      exists: true,
      hasMigrationsTable: hasTable,
      files,
      applied,
      missing,
      extra,
      problems,
    };
  } catch (e) {
    const r = base();
    r.exists = true;
    r.readError = `스키마를 읽을 수 없음: ${(e as Error).message}`;
    r.problems.push(r.readError);
    return r;
  } finally {
    db.close();
  }
}

function tableExists(db: DB, name: string): boolean {
  return (one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM sqlite_master WHERE type=? AND name=?', 'table', name)?.n ?? 0) > 0;
}

export function applyMigrations(db: DB, dir: string): ApplyResult {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(appliedMigrationNames(db));
  const files = listMigrationFiles(dir);
  const appliedNow: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    try {
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, nowIso());
      })();
      appliedNow.push(f);
    } catch (e) {
      return { applied: appliedNow, failed: { file: f, error: (e as Error).message } };
    }
  }
  return { applied: appliedNow };
}

/** Explicit fixture init. Production boot must not call this. */
export function openMigratedDb(dataDir: string, migrationsDir: string): DB {
  const db = openDb(dataDir);
  const result = applyMigrations(db, migrationsDir);
  if (result.failed) {
    db.close();
    throw new Error(`migration 실패 ${result.failed.file}: ${result.failed.error}`);
  }
  return db;
}

export async function backupDatabase(db: DB, destPath: string): Promise<void> {
  await db.backup(destPath);
}

export function integrityOk(db: DB): boolean {
  const v = db.pragma('integrity_check', { simple: true });
  return v === 'ok';
}

// ---- 작은 헬퍼 ----
export function one<T>(db: DB, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function many<T>(db: DB, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(db: DB, sql: string, ...params: unknown[]): Database.RunResult {
  return db.prepare(sql).run(...params);
}
export function nowIso(): string {
  return new Date().toISOString();
}
export function uid(): string {
  return crypto.randomUUID();
}
export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function getSetting(db: DB, key: string, def: string): string {
  return one<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', key)?.value ?? def;
}
export function setSetting(db: DB, key: string, value: string): void {
  run(db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}
