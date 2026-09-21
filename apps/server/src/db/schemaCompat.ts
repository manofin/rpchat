import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function defaultSchemaCompatPath(): string {
  return path.resolve(here, '..', '..', '..', '..', 'deploy', 'schema-compat.json');
}

export function listMigrationFilenames(migrationsDir: string): string[] {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export function loadRequiredMigrations(compatPath: string): { required: string[]; error?: string } {
  if (!fs.existsSync(compatPath)) return { required: [], error: `schema-compat.json 없음: ${compatPath}` };
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(compatPath, 'utf8'));
  } catch (e) {
    return { required: [], error: `schema-compat.json 파싱 실패: ${(e as Error).message}` };
  }
  if (!data || typeof data !== 'object') return { required: [], error: 'schema-compat.json 이 객체가 아님' };
  const raw = (data as { required_migrations?: unknown }).required_migrations;
  if (!Array.isArray(raw)) return { required: [], error: 'required_migrations 가 배열이 아님' };
  const required = raw.map((x) => String(x));
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const n of required) {
    if (seen.has(n)) dup.push(n);
    else seen.add(n);
  }
  if (dup.length) return { required, error: `required_migrations 중복: ${[...new Set(dup)].join(',')}` };
  return { required };
}

export function diffMigrationManifest(
  files: string[],
  required: string[],
): { missingInSpec: string[]; extraInSpec: string[] } {
  const fileSet = new Set(files);
  const reqSet = new Set(required);
  return {
    missingInSpec: files.filter((f) => !reqSet.has(f)),
    extraInSpec: required.filter((r) => !fileSet.has(r)),
  };
}

/** File set vs deploy/schema-compat.json. Does not open or write a database. */
export function schemaCompatProblems(migrationsDir: string, compatPath: string): string[] {
  const loaded = loadRequiredMigrations(compatPath);
  if (loaded.error) return [loaded.error];
  const files = listMigrationFilenames(migrationsDir);
  const d = diffMigrationManifest(files, loaded.required);
  const problems: string[] = [];
  if (d.missingInSpec.length) problems.push(`migration 파일이 명세에 없음: ${d.missingInSpec.join(',')}`);
  if (d.extraInSpec.length) problems.push(`명세에만 있고 파일 없음: ${d.extraInSpec.join(',')}`);
  return problems;
}
