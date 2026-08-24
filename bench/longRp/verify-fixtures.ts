/** long-rp-fixtures-v1 게이트. 실행: npx tsx bench/longRp/verify-fixtures.ts */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const HORIZONS = [30, 60, 100] as const;
const KINDS = new Set(['fact', 'relationship', 'unresolved']);

const data = JSON.parse(
  fs.readFileSync(new URL('./fixtures/long-rp-fixtures-v1.json', import.meta.url), 'utf8'),
);

assert.equal(data._meta?.id, 'long-rp-fixtures-v1');
assert.deepEqual(data._meta?.horizons, [...HORIZONS]);
assert.ok(Array.isArray(data.facts) && data.facts.length === 20, `facts n=${data.facts?.length}`);
assert.ok(Array.isArray(data.probes) && data.probes.length === 9, `probes n=${data.probes?.length}`);

const ids = new Set<string>();
const due: Record<number, number> = { 30: 0, 60: 0, 100: 0 };
const kindCount: Record<string, number> = {};

for (const f of data.facts) {
  assert.ok(typeof f.id === 'string' && /^F\d{2}$/.test(f.id), `bad fact id ${f.id}`);
  assert.ok(!ids.has(f.id), `dup fact ${f.id}`);
  ids.add(f.id);
  assert.ok(KINDS.has(f.kind), `${f.id} bad kind`);
  kindCount[f.kind] = (kindCount[f.kind] ?? 0) + 1;
  assert.ok(Number.isInteger(f.introduced_by_turn) && f.introduced_by_turn >= 1 && f.introduced_by_turn <= 100, `${f.id} turn`);
  assert.ok(Array.isArray(f.must_hold_at) && f.must_hold_at.length > 0, `${f.id} hold`);
  for (const h of f.must_hold_at) {
    assert.ok((HORIZONS as readonly number[]).includes(h), `${f.id} horizon ${h}`);
    assert.ok(f.introduced_by_turn <= h, `${f.id} introduced after hold ${h}`);
    due[h] += 1;
  }
  assert.ok(typeof f.text === 'string' && f.text.length >= 8, `${f.id} text`);
  assert.ok(typeof f.contradiction === 'string' && f.contradiction.length >= 8, `${f.id} contradiction`);
}

assert.equal(due[30], 8, `due30=${due[30]}`);
assert.equal(due[60], 14, `due60=${due[60]}`);
assert.equal(due[100], 20, `due100=${due[100]}`);
assert.equal(kindCount.fact, 11);
assert.equal(kindCount.relationship, 6);
assert.equal(kindCount.unresolved, 3);

const probeIds = new Set<string>();
const probesByH: Record<number, number> = { 30: 0, 60: 0, 100: 0 };
for (const p of data.probes) {
  assert.ok(typeof p.id === 'string' && !probeIds.has(p.id), `probe id ${p.id}`);
  probeIds.add(p.id);
  assert.ok((HORIZONS as readonly number[]).includes(p.horizon), `probe horizon ${p.horizon}`);
  probesByH[p.horizon] += 1;
  assert.ok(Array.isArray(p.fact_ids) && p.fact_ids.length > 0, `${p.id} facts`);
  for (const fid of p.fact_ids) {
    assert.ok(ids.has(fid), `${p.id} unknown ${fid}`);
    const fact = data.facts.find((x: { id: string }) => x.id === fid);
    assert.ok(fact.must_hold_at.includes(p.horizon), `${p.id} ${fid} not due at ${p.horizon}`);
  }
  assert.ok(typeof p.ask === 'string' && p.ask.length >= 4, `${p.id} ask`);
  assert.ok(typeof p.expect === 'string' && p.expect.length >= 4, `${p.id} expect`);
}
assert.deepEqual(probesByH, { 30: 3, 60: 3, 100: 3 });

console.log('JSON_PARSE_OK');
console.log(`due ${JSON.stringify(due)} kinds ${JSON.stringify(kindCount)}`);
console.log('FIXTURE_OK long-rp=20 probes=9');
