/**
 * npx tsx bench/schemaCompatManifest.test.ts
 * SchemaCompatibilityManifest — required_migrations equals apps/server/migrations/*.sql.
 * Isolated: no live DB, no SQL apply, no new migration files.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultSchemaCompatPath,
  diffMigrationManifest,
  listMigrationFilenames,
  loadRequiredMigrations,
  schemaCompatProblems,
} from '../apps/server/src/db/schemaCompat.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const PREVIOUSLY_MISSING = [
  '0011_scene_catalog.sql',
  '0013_story_participant_snapshot.sql',
  '0015_story_cover.sql',
  '0016_lorebook_story_scope.sql',
  '0017_story_defaults.sql',
  '0018_story_stats.sql',
  '0019_story_openings_extra.sql',
  '0020_story_endings.sql',
  '0021_character_play_guide.sql',
  '0022_summaries_relation_scope.sql',
];

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scm-'));
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const migDir = path.join(root, 'apps/server/migrations');
  const compatPath = path.join(root, 'deploy/schema-compat.json');

  // 0023_profile_instruction.sql (profile-instruction) moved the snapshot 22 → 23.
  await t('live tree: 23 sql files, 23 required, sets equal', () => {
    const files = listMigrationFilenames(migDir);
    const loaded = loadRequiredMigrations(compatPath);
    assert.equal(loaded.error, undefined);
    assert.equal(files.length, 23);
    assert.equal(loaded.required.length, 23);
    assert.equal(files[22], '0023_profile_instruction.sql');
    const d = diffMigrationManifest(files, loaded.required);
    assert.deepEqual(d.missingInSpec, []);
    assert.deepEqual(d.extraInSpec, []);
    assert.deepEqual(schemaCompatProblems(migDir, compatPath), []);
  });

  await t('live tree includes the 10 names previously absent from the spec', () => {
    const loaded = loadRequiredMigrations(compatPath);
    for (const name of PREVIOUSLY_MISSING) {
      assert.ok(loaded.required.includes(name), name);
      assert.ok(fs.existsSync(path.join(migDir, name)), name);
    }
    assert.equal(PREVIOUSLY_MISSING.length, 10);
  });

  await t('defaultSchemaCompatPath points at deploy/schema-compat.json', () => {
    assert.equal(defaultSchemaCompatPath(), compatPath);
  });

  await t('non-sql files in migrations dir are ignored', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, '0001_init.sql'), '--');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x');
    fs.writeFileSync(path.join(dir, '0002_search.sql.bak'), 'x');
    assert.deepEqual(listMigrationFilenames(dir), ['0001_init.sql']);
    fs.rmSync(dir, { recursive: true });
  });

  await t('helper: disk file missing from spec is missingInSpec', () => {
    const dir = tmpDir();
    const spec = path.join(dir, 'schema-compat.json');
    fs.writeFileSync(path.join(dir, '0001_init.sql'), '--');
    fs.writeFileSync(path.join(dir, '0011_scene_catalog.sql'), '--');
    fs.writeFileSync(spec, JSON.stringify({ required_migrations: ['0001_init.sql'] }));
    const d = diffMigrationManifest(listMigrationFilenames(dir), loadRequiredMigrations(spec).required);
    assert.deepEqual(d.missingInSpec, ['0011_scene_catalog.sql']);
    assert.deepEqual(d.extraInSpec, []);
    const problems = schemaCompatProblems(dir, spec);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /0011_scene_catalog\.sql/);
    fs.rmSync(dir, { recursive: true });
  });

  await t('helper: spec name with no file is extraInSpec', () => {
    const dir = tmpDir();
    const spec = path.join(dir, 'schema-compat.json');
    fs.writeFileSync(path.join(dir, '0001_init.sql'), '--');
    fs.writeFileSync(spec, JSON.stringify({ required_migrations: ['0001_init.sql', '0099_ghost.sql'] }));
    const d = diffMigrationManifest(listMigrationFilenames(dir), loadRequiredMigrations(spec).required);
    assert.deepEqual(d.missingInSpec, []);
    assert.deepEqual(d.extraInSpec, ['0099_ghost.sql']);
    fs.rmSync(dir, { recursive: true });
  });

  await t('helper: duplicate required_migrations is a problem', () => {
    const dir = tmpDir();
    const spec = path.join(dir, 'schema-compat.json');
    fs.writeFileSync(spec, JSON.stringify({ required_migrations: ['0001_init.sql', '0001_init.sql'] }));
    const loaded = loadRequiredMigrations(spec);
    assert.match(loaded.error ?? '', /중복/);
    const problems = schemaCompatProblems(dir, spec);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /중복/);
    fs.rmSync(dir, { recursive: true });
  });

  await t('helper: missing json file is a problem; does not create a db', () => {
    const dir = tmpDir();
    const problems = schemaCompatProblems(dir, path.join(dir, 'no-such.json'));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /없음/);
    assert.equal(fs.existsSync(path.join(dir, 'rpchat.db')), false);
    fs.rmSync(dir, { recursive: true });
  });

  await t('index.ts checks schemaCompatProblems before openDb', () => {
    const src = fs.readFileSync(path.join(root, 'apps/server/src/index.ts'), 'utf8');
    const iCompat = src.indexOf('schemaCompatProblems');
    const iOpen = src.indexOf('openDb(');
    assert.ok(iCompat >= 0, 'schemaCompatProblems call missing');
    assert.ok(iOpen > iCompat, 'openDb must follow schemaCompatProblems');
    assert.equal(src.includes('db:migrate'), false);
    assert.equal(src.includes('db:check'), false);
  });

  // Originally "no new sql files added by this lock (22 existing only)". Re-scoped when
  // profile-instruction added 0023: still a snapshot — any further migration must edit this.
  await t('sql files after 0022 are exactly 0023_profile_instruction.sql', () => {
    const files = listMigrationFilenames(migDir);
    assert.deepEqual(files.filter((f) => f > '0022_summaries_relation_scope.sql'), ['0023_profile_instruction.sql']);
    assert.equal(files.length, 23);
  });

  console.log(`${passed} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
