/** npx tsx bench/episodeRelationBuild.test.ts
 * episode-relation-build — ADR §5 OR-by-union episode inject (builder.ts).
 * Temp DB + 0022. No hermes / no live dataDir. Model-free SQL/helper.
 *
 * EXPLAIN mechanical: SCAN summaries = FAIL; rel SEARCH idx_summaries_relation;
 * union both SEARCH (or MULTI-INDEX) with no SCAN.
 * Cross-story = OBSERVE only (not a FAIL gate). Dedupe required.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import {
  episodeRelationInjectParts,
  loadApprovedEpisodeCandidates,
} from '../apps/server/src/prompt/builder.ts';

let passed = 0;
const observations: string[] = [];

function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function explain(db: ReturnType<typeof openMigratedDb>, sql: string, ...binds: unknown[]) {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>;
  return rows.map((r) => r.detail);
}

function assertNoFullScan(details: string[], label: string) {
  const joined = details.join('\n');
  console.log(`--- EXPLAIN ${label} ---\n${joined}\n---`);
  for (const d of details) {
    const line = d.trim();
    if (/^SCAN summaries$/i.test(line) || /^SCAN TABLE summaries$/i.test(line)) {
      assert.fail(`${label}: full table SCAN summaries (no index):\n${joined}`);
    }
    if (/SCAN summaries(?!\s+USING)/i.test(d) && !/USING (?:INDEX|COVERING INDEX)/i.test(d)) {
      assert.fail(`${label}: SCAN summaries without USING INDEX:\n${joined}`);
    }
  }
}

function seedBase(db: ReturnType<typeof openMigratedDb>) {
  const t0 = '2026-01-01T00:00:00.000Z';
  db.exec(`
    INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
    VALUES
      ('char-1','C1','','','','','','','','','[]','${t0}','${t0}'),
      ('char-2','C2','','','','','','','','','[]','${t0}','${t0}');
    INSERT INTO personas (id, name, address_as, appearance, personality, relationship, is_default, created_at, updated_at)
    VALUES
      ('persona-a','A','','','','',0,'${t0}','${t0}'),
      ('persona-b','B','','','','',0,'${t0}','${t0}');
    INSERT INTO stories (id, name, tagline, setting, minor_cast, scene_catalog, created_at, updated_at)
    VALUES
      ('story-a','StoryA','','','[]','{}','${t0}','${t0}'),
      ('story-b','StoryB','','','[]','{}','${t0}','${t0}');
    INSERT INTO conversations (id, character_id, persona_id, title, mode, profile_name, scene_json, prompt_version, created_at, updated_at, story_id)
    VALUES
      ('conv-a','char-1','persona-a','A','chat','rp-balanced','{}','pv','${t0}','${t0}','story-a'),
      ('conv-b','char-1','persona-a','B','chat','rp-balanced','{}','pv','${t0}','${t0}','story-b'),
      ('conv-other-persona','char-1','persona-b','OP','chat','rp-balanced','{}','pv','${t0}','${t0}',NULL),
      ('conv-other-char','char-2','persona-a','OC','chat','rp-balanced','{}','pv','${t0}','${t0}',NULL),
      ('conv-null','char-1',NULL,'N','chat','rp-balanced','{}','pv','${t0}','${t0}',NULL);
  `);
  return t0;
}

function insertEpisode(
  db: ReturnType<typeof openMigratedDb>,
  opts: {
    id: string;
    conversation_id: string;
    content: string;
    created_at: string;
    rel_character_id: string | null;
    rel_persona_id: string | null;
    status?: string;
  },
) {
  db.prepare(
    `INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier, rel_character_id, rel_persona_id)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, 'episode', ?, ?)`,
  ).run(
    opts.id,
    opts.conversation_id,
    opts.content,
    opts.status ?? 'approved',
    opts.created_at,
    opts.rel_character_id,
    opts.rel_persona_id,
  );
}

function main() {
  const builderSrc = fs.readFileSync('apps/server/src/prompt/builder.ts', 'utf8');

  t('source: episode SELECT uses UNION (not naive OR); whole/state/scene stay conv-only', () => {
    assert.match(builderSrc, /UNION \$\{relSql\}|UNION \$\{relSql\}/);
    assert.match(builderSrc, /loadApprovedEpisodeCandidates/);
    assert.equal(/tier = 'episode'[\s\S]{0,80}OR \(rel_character_id/.test(builderSrc), false);
    assert.equal(/conversation_id = \? OR/.test(builderSrc), false);
    // whole / state still conversation-scoped LIMIT 5
    assert.match(
      builderSrc,
      /SELECT \* FROM summaries WHERE conversation_id = \? AND tier = 'whole' AND status = 'approved' ORDER BY created_at DESC LIMIT 5/,
    );
    assert.match(
      builderSrc,
      /SELECT \* FROM summaries WHERE conversation_id = \? AND tier = 'state' AND status = 'approved' ORDER BY created_at DESC LIMIT 5/,
    );
    // scene approvedEpisodeIds gate stays conversation-only
    assert.match(
      builderSrc,
      /SELECT id FROM summaries WHERE conversation_id = \? AND tier = 'episode' AND status = 'approved'/,
    );
  });

  t('source: NULL persona uses IS NULL (never = NULL / = ? with null bind on rel_persona)', () => {
    const partsNull = episodeRelationInjectParts(null);
    assert.match(partsNull.relSql, /rel_persona_id IS NULL/);
    assert.equal(partsNull.relSql.includes('rel_persona_id = ?'), false);
    const partsSet = episodeRelationInjectParts('persona-a');
    assert.match(partsSet.relSql, /rel_persona_id = \?/);
    assert.equal(partsSet.unionSql.includes('UNION ALL'), false);
    assert.match(partsSet.unionSql, / UNION /);
  });

  t('extra SELECT for inject stamp = 0: binds from conv fields only', () => {
    const binds = episodeRelationInjectParts;
    void binds;
    // loadApprovedEpisodeCandidates body must not call SELECT on characters/personas
    const start = builderSrc.indexOf('export function loadApprovedEpisodeCandidates');
    const end = builderSrc.indexOf('export function buildPrompt', start);
    const fn = builderSrc.slice(start, end);
    assert.equal(/FROM characters/i.test(fn), false);
    assert.equal(/FROM personas/i.test(fn), false);
    assert.match(fn, /episodeRelationInjectBinds\(conv\)/);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-episode-relation-build-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  const t0 = seedBase(db);

  insertEpisode(db, {
    id: 'ep-same',
    conversation_id: 'conv-a',
    content: 'same-conv episode',
    created_at: '2026-01-02T00:00:00.000Z',
    rel_character_id: 'char-1',
    rel_persona_id: 'persona-a',
  });
  insertEpisode(db, {
    id: 'ep-rel-other-conv',
    conversation_id: 'conv-b',
    content: 'cross-story relation episode from story-b',
    created_at: '2026-01-03T00:00:00.000Z',
    rel_character_id: 'char-1',
    rel_persona_id: 'persona-a',
  });
  insertEpisode(db, {
    id: 'ep-other-persona',
    conversation_id: 'conv-other-persona',
    content: 'wrong persona',
    created_at: '2026-01-04T00:00:00.000Z',
    rel_character_id: 'char-1',
    rel_persona_id: 'persona-b',
  });
  insertEpisode(db, {
    id: 'ep-other-char',
    conversation_id: 'conv-other-char',
    content: 'wrong character',
    created_at: '2026-01-05T00:00:00.000Z',
    rel_character_id: 'char-2',
    rel_persona_id: 'persona-a',
  });
  insertEpisode(db, {
    id: 'ep-null-bucket',
    conversation_id: 'conv-null',
    content: 'null persona bucket',
    created_at: '2026-01-06T00:00:00.000Z',
    rel_character_id: 'char-1',
    rel_persona_id: null,
  });

  const convA = { id: 'conv-a', character_id: 'char-1', persona_id: 'persona-a' as string | null };

  t('same-conv episode still in candidates (regression)', () => {
    const rows = loadApprovedEpisodeCandidates(db, convA);
    assert.ok(rows.some((r) => r.id === 'ep-same'), rows.map((r) => r.id).join(','));
  });

  t('other conv same (char,persona) + rel_* → in candidates', () => {
    const rows = loadApprovedEpisodeCandidates(db, convA);
    assert.ok(rows.some((r) => r.id === 'ep-rel-other-conv'), rows.map((r) => r.id).join(','));
  });

  t('other persona / other character excluded from rel branch', () => {
    const rows = loadApprovedEpisodeCandidates(db, convA);
    const ids = new Set(rows.map((r) => r.id));
    assert.equal(ids.has('ep-other-persona'), false);
    assert.equal(ids.has('ep-other-char'), false);
    assert.equal(ids.has('ep-null-bucket'), false);
  });

  t('dedupe: dual-match same-conv+rel row appears exactly once', () => {
    const rows = loadApprovedEpisodeCandidates(db, convA);
    const hits = rows.filter((r) => r.id === 'ep-same');
    assert.equal(hits.length, 1, `expected 1 ep-same, got ${hits.length}`);
  });

  t('persona switch: old row via conv branch; foreign new-persona via rel', () => {
    // Simulate A→B on conv-a: persona_id now B; old ep-same stays injectable via conversation_id.
    const switched = { id: 'conv-a', character_id: 'char-1', persona_id: 'persona-b' as string | null };
    insertEpisode(db, {
      id: 'ep-foreign-b',
      conversation_id: 'conv-other-persona',
      content: 'foreign for persona B',
      created_at: '2026-01-07T00:00:00.000Z',
      rel_character_id: 'char-1',
      rel_persona_id: 'persona-b',
    });
    // Note: ep-other-persona already has persona-b; ep-foreign-b also.
    const rows = loadApprovedEpisodeCandidates(db, switched);
    const ids = new Set(rows.map((r) => r.id));
    assert.ok(ids.has('ep-same'), 'old same-conv episode retained via conv branch');
    assert.ok(ids.has('ep-other-persona') || ids.has('ep-foreign-b'), 'new-persona foreign via rel');
    assert.equal(ids.has('ep-rel-other-conv'), false, 'persona-a foreign must drop on switch');
  });

  t('NULL persona bucket: IS NULL matches; =id persona episodes excluded', () => {
    const rows = loadApprovedEpisodeCandidates(db, {
      id: 'conv-null',
      character_id: 'char-1',
      persona_id: null,
    });
    const ids = new Set(rows.map((r) => r.id));
    assert.ok(ids.has('ep-null-bucket'));
    assert.equal(ids.has('ep-same'), false);
    assert.equal(ids.has('ep-rel-other-conv'), false);
  });

  const parts = episodeRelationInjectParts('persona-a');
  const partsNull = episodeRelationInjectParts(null);

  t('EXPLAIN conv branch: SEARCH idx_summaries_conv*, no SCAN', () => {
    const details = explain(db, parts.convSql, 'conv-a');
    assertNoFullScan(details, 'conversation-branch');
    assert.match(details.join('\n'), /idx_summaries_conv(?:_tier_status)?/i);
  });

  t('EXPLAIN rel branch: SEARCH idx_summaries_relation, no SCAN', () => {
    const details = explain(db, parts.relSql, 'char-1', 'persona-a');
    assertNoFullScan(details, 'relation-branch');
    assert.match(details.join('\n'), /idx_summaries_relation/i);
  });

  t('EXPLAIN rel NULL bucket: SEARCH idx_summaries_relation, no SCAN', () => {
    const details = explain(db, partsNull.relSql, 'char-1');
    assertNoFullScan(details, 'relation-branch-null');
    assert.match(details.join('\n'), /idx_summaries_relation/i);
  });

  t('EXPLAIN OR-by-union: both SEARCH, no SCAN summaries', () => {
    const details = explain(db, parts.unionSql, 'conv-a', 'char-1', 'persona-a');
    assertNoFullScan(details, 'or-by-union');
    const joined = details.join('\n');
    assert.match(joined, /idx_summaries_relation/i, joined);
    assert.match(joined, /idx_summaries_conv(?:_tier_status)?/i, joined);
  });

  t('OBSERVE cross-story (measurement, not gate)', () => {
    // conv-a is story-a; ep-rel-other-conv lives on conv-b / story-b
    const rows = loadApprovedEpisodeCandidates(db, convA);
    const cross = rows.filter((r) => r.id === 'ep-rel-other-conv');
    if (cross.length) {
      const msg = `OBSERVE cross-story inject: ep=ep-rel-other-conv from_story=story-b into_conv_story=story-a`;
      observations.push(msg);
      console.log(msg);
    } else {
      const msg =
        'OBSERVE cross-story inject: NOT fired in fixture (ep-rel-other-conv absent from conv-a candidates)';
      observations.push(msg);
      console.log(msg);
    }
    // Never FAIL on observation outcome
    assert.ok(true);
  });

  // Write observation note for later ADR evidence
  const artifactDir = process.env.RPCHAT_BENCH_ARTIFACT_DIR
    ? path.resolve(process.env.RPCHAT_BENCH_ARTIFACT_DIR)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-episode-relation-evidence-'));
  fs.mkdirSync(artifactDir, { recursive: true });
  const notePath = path.join(artifactDir, 'episodeRelationBuild.observation.md');
  fs.writeFileSync(
    notePath,
    [
      '# episode-relation-build — cross-story observation',
      '',
      'Not a pass/fail gate. Evidence for a later story-boundary ADR.',
      '',
      ...observations.map((o) => `- ${o}`),
      '',
      `Recorded at bench run (temp DB fixture; t0=${t0}).`,
      '',
    ].join('\n'),
  );
  console.log(`wrote ${notePath}`);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

main();
