/**
 * profile-instruction (0023) — 로컬 지침 파일 → model_profiles 적재.
 *
 * 지침 원문은 비공개 런타임 데이터다. 공개 repo 에는 이 적재 도구와 빈 예제
 * (docs/instructions/)만 있고, 실제 파일은 git 밖 디렉터리(기본 `<DATA_DIR>/instructions`,
 * 환경변수 INSTRUCTIONS_DIR 또는 CLI --dir)에 둔다. 런타임(buildPrompt / 파티 IC)은 파일을
 * 읽지 않는다 — DB 가 유일한 원천이다.
 *
 * 파일 규칙: `<프로필이름>.md`, 이름은 PUT /api/profiles 와 같은 `^[a-z0-9-]{2,40}$`.
 * 본문 = instruction_text (그대로 저장, sha256 은 저장값 기준).
 * - 빈 파일(공백뿐)·이름 규칙 위반·상한 초과 → skip
 * - 새 프로필 → create: 샘플링은 rp-balanced 행에서 복제, notes = 첫 줄 제목(60자), enabled=1
 * - 기존 프로필 → 같은 원문·enabled=1 이면 unchanged, 아니면 update(원문·enabled=1 만, 샘플링·notes 불변)
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appliedMigrationNames, listMigrationFiles, type DB } from './index.js';
import { estimateTokens } from '../prompt/tokens.js';

export const PROFILE_NAME_RE = /^[a-z0-9-]{2,40}$/;
/** routes/settings.ts PROFILE_INSTRUCTION_MAX 와 같은 값(문자). */
export const INSTRUCTION_FILE_MAX = 20000;

export type InstructionImportAction = 'create' | 'update' | 'unchanged' | 'skip';

export interface InstructionImportPlan {
  file: string;
  name: string;
  action: InstructionImportAction;
  reason?: string;
  chars: number;
  sha256: string;
  estTokens: number;
  notes?: string | null;
  text?: string;
}

function firstHeading(text: string): string | null {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  return line.replace(/^#+\s*/, '').slice(0, 60) || null;
}

/**
 * 실행 조건 검사 — 서비스가 떠 있어도(WAL 이 남아 있어도) 쓸 수 있는 방식.
 * `inspectSchema` 는 settled 파일 이미지를 무변경으로 검사하는 db:check 용이라 WAL 이 남아
 * 있으면 거부한다. 적재는 일반 SQLite 연결(WAL 반영)로 schema_migrations 를 읽어 migration
 * 파일 집합과 비교한다. missing/extra 가 있으면 적재하지 않는다.
 */
export function migrationProblemsLive(db: DB, migrationsDir: string): { missing: string[]; extra: string[] } {
  const files = listMigrationFiles(migrationsDir);
  const applied = appliedMigrationNames(db);
  const fileSet = new Set(files);
  const appSet = new Set(applied);
  return { missing: files.filter((f) => !appSet.has(f)), extra: applied.filter((a) => !fileSet.has(a)) };
}

export function planInstructionImport(db: DB, dir: string, calibration = 1): InstructionImportPlan[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`지침 디렉터리 없음: ${dir}`);
  const plans: InstructionImportPlan[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const name = file.slice(0, -'.md'.length);
    const full = path.join(dir, file);
    if (!fs.statSync(full).isFile()) continue;
    const text = fs.readFileSync(full, 'utf8');
    const base = {
      file,
      name,
      chars: text.length,
      sha256: createHash('sha256').update(text).digest('hex'),
      estTokens: estimateTokens(text, calibration),
    };
    if (!PROFILE_NAME_RE.test(name)) { plans.push({ ...base, action: 'skip', reason: '이름 규칙 위반(^[a-z0-9-]{2,40}$)' }); continue; }
    if (!text.trim()) { plans.push({ ...base, action: 'skip', reason: '빈 파일' }); continue; }
    if (text.length > INSTRUCTION_FILE_MAX) { plans.push({ ...base, action: 'skip', reason: `상한 초과(${INSTRUCTION_FILE_MAX}자)` }); continue; }
    const cur = db.prepare('SELECT instruction_enabled, instruction_text FROM model_profiles WHERE name = ?').get(name) as
      | { instruction_enabled: number; instruction_text: string | null }
      | undefined;
    if (!cur) plans.push({ ...base, action: 'create', notes: firstHeading(text), text });
    else if (cur.instruction_text === text && cur.instruction_enabled === 1) plans.push({ ...base, action: 'unchanged' });
    else plans.push({ ...base, action: 'update', text });
  }
  return plans;
}

/** create/update 만 한 트랜잭션으로 쓴다. 반환: 실제로 쓴 행 수. */
export function applyInstructionImport(db: DB, plans: InstructionImportPlan[]): number {
  const src = db.prepare("SELECT model, temperature, top_p, max_tokens, stop_json, system_mode FROM model_profiles WHERE name = 'rp-balanced'").get() as
    | { model: string | null; temperature: number; top_p: number; max_tokens: number; stop_json: string; system_mode: string }
    | undefined;
  const sampling = src ?? { model: null, temperature: 0.8, top_p: 0.95, max_tokens: 400, stop_json: '[]', system_mode: 'system' };
  const insert = db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes, instruction_enabled, instruction_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  const update = db.prepare('UPDATE model_profiles SET instruction_enabled = 1, instruction_text = ? WHERE name = ?');
  let written = 0;
  db.transaction(() => {
    for (const p of plans) {
      if (p.action === 'create') {
        insert.run(p.name, sampling.model, sampling.temperature, sampling.top_p, sampling.max_tokens, sampling.stop_json, sampling.system_mode, p.notes ?? null, p.text);
        written++;
      } else if (p.action === 'update') {
        update.run(p.text, p.name);
        written++;
      }
    }
  })();
  return written;
}

export function formatPlanLine(p: InstructionImportPlan): string {
  return [
    `file=${p.file}`, `name=${p.name}`, `action=${p.action}`, `chars=${p.chars}`,
    `est_tokens=${p.estTokens}`, `sha256=${p.sha256}`, ...(p.reason ? [`reason=${p.reason}`] : []),
  ].join(' ');
}
