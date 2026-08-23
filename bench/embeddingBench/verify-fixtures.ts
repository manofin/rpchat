/** Task 1 게이트: JSON 파싱 + n 검증 + 분할 검증. 실행: npx tsx bench/embeddingBench/verify-fixtures.ts */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const lore = JSON.parse(fs.readFileSync(new URL('./fixtures/lore-v1.json', import.meta.url), 'utf8'));
const mem = JSON.parse(fs.readFileSync(new URL('./fixtures/memory-v1.json', import.meta.url), 'utf8'));

assert.equal(lore.cases.length, 25, `lore n=${lore.cases.length}`);
assert.equal(mem.pairs.length, 20, `memory n=${mem.pairs.length}`);

const lc: Record<string, number> = {};
for (const c of lore.cases) lc[c.label] = (lc[c.label] ?? 0) + 1;
console.log('lore split:', JSON.stringify(lc));
assert.equal(lc.must_fire, 10);
assert.equal(lc.must_not_fire, 10);
assert.equal(lc.ambiguous, 5);

// 모든 entryId가 스냅샷(주석 상수)에 존재하는지
const snapshotIds = [
  '1870f500-673f-4706-ba3c-15ec5a7238bc',
  '1be5ac19-0932-418c-b8e6-1ba6f74a3196',
  '6bce220c-5363-4d68-b1d6-878a45e60db3',
  '7b60162c-bee3-4e66-bb7e-6e9249272dc5',
  '810e7ed3-31a7-4b9a-9038-bcaf44e4b5f5',
];
for (const c of lore.cases) assert.ok(snapshotIds.includes(c.entryId), `${c.id} bad entryId`);

// 애매 케이스는 키워드를 포함하지 않아야 함(설계 규칙) — 스냅샷 키워드 수동 대조
const kwByEntry: Record<string, string[]> = {
  '1870f500-673f-4706-ba3c-15ec5a7238bc': ['도서관', '기록보관소', '서가', '열람실', '보관소'],
  '1be5ac19-0932-418c-b8e6-1ba6f74a3196': ['만년필', '펜', '잉크'],
  '7b60162c-bee3-4e66-bb7e-6e9249272dc5': ['협곡', '산맥', '다리', '여울', '절벽'],
  '810e7ed3-31a7-4b9a-9038-bcaf44e4b5f5': ['쫓', '추격', '소리', '포식자', '그것'],
};
for (const c of lore.cases.filter((x: any) => x.label === 'ambiguous')) {
  for (const k of kwByEntry[c.entryId]) {
    if (k === '그것') continue; // 범용 지시어 — 의미기반 케이스에서 배제 불가, 기록만
    assert.ok(!c.text.includes(k), `${c.id} contains keyword ${k}`);
  }
}

const mc: Record<string, number> = {};
for (const p of mem.pairs) mc[p.label] = (mc[p.label] ?? 0) + 1;
console.log('memory split:', JSON.stringify(mc));
assert.deepEqual(mc, { new: 5, conflict: 5, complement: 3, duplicate: 5, transient: 2 });

console.log('FIXTURE_OK lore=25 memory=20');
