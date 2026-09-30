import assert from 'node:assert/strict';
import { applySceneDelta } from '../apps/server/src/prompt/applySceneDelta.js';
import type { Scene } from '../apps/server/src/types.js';

let passed = 0;
const malformed = [{}, { extra_ids: null, unresolved: null },
  { extra_ids: 'abc', unresolved: 3 },
  { focus_id: 4, extra_ids: ['valid', null, 5], unresolved: ['pending', {}] }];
for (const last_beat of malformed) {
  const state = { scene_version: 2, last_beat } as unknown as Scene;
  const bytes = JSON.stringify(state);
  const result = applySceneDelta(state, { base_version: 2 }, {
    weathers: [], locations: [], arcs: [], stagesByArc: {}, flags: {},
  }, 2);
  assert.equal(result.discarded, false);
  assert.equal(result.state.last_beat?.focus_id, null);
  assert.deepEqual(result.state.last_beat?.extra_ids, Array.isArray(last_beat.extra_ids) ? ['valid'] : []);
  assert.deepEqual(result.state.last_beat?.unresolved, Array.isArray(last_beat.unresolved) ? ['pending'] : []);
  assert.equal(JSON.stringify(state), bytes);
  const discarded = applySceneDelta(state, { base_version: 1, advance_minutes: 5 }, {
    weathers: [], locations: [], arcs: [], stagesByArc: {}, flags: {},
  }, 2);
  assert.equal(discarded.discarded, true);
  assert.equal(discarded.state.clock_minutes, undefined);
  console.log(`ok ${++passed} malformed last_beat is normalized without mutating stored input`);
}
const absent = applySceneDelta({}, {}, { weathers: [], locations: [], arcs: [], stagesByArc: {}, flags: {} }, 0);
assert.equal(absent.state.last_beat, undefined);
console.log(`ok ${++passed} absent last_beat remains absent`);
