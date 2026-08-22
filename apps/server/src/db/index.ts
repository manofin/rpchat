import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type DB = Database.Database;

export function openDb(dataDir: string, migrationsDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });
  const db = new Database(path.join(dataDir, 'rpchat.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, migrationsDir);
  return db;
}

function migrate(db: DB, dir: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(many<{ name: string }>(db, 'SELECT name FROM schema_migrations').map((r) => r.name));
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, nowIso());
    })();
  }
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
