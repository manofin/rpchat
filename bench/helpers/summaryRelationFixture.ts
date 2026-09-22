import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DB } from '../../apps/server/src/db/index.js';

/** 수동 최소 스키마를 쓰는 builder 벤치도 실제 relation migration을 적용한다. */
export function migrateSummaryRelationFixture(db: DB): void {
  assert.equal(db.name, ':memory:', 'summary relation fixture migration is memory-only');
  db.exec(readFileSync(new URL('../../apps/server/migrations/0022_summaries_relation_scope.sql', import.meta.url), 'utf8'));
}
