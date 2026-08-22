/**
 * loreEntryActive 단위 테스트. 실행:
 *   npx tsx bench/loreMatch.test.ts
 */
import assert from 'node:assert/strict';
import { loreEntryActive } from '../apps/server/src/prompt/loreMatch.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const scan = (...parts: string[]) => parts.join('\n').toLowerCase();

t('always_on 은 키워드 없이 삽입', () => {
  assert.equal(loreEntryActive({ always_on: 1, keywords: [], scanText: scan('안녕') }), true);
});

t('1차만 맞으면 삽입 (selective 꺼짐)', () => {
  assert.equal(loreEntryActive({
    always_on: 0,
    keywords: ['서리'],
    secondary_keys: ['과거'],
    selective: 0,
    scanText: scan('서리가 책을 덮었다'),
  }), true);
});

t('1차 없으면 미삽입', () => {
  assert.equal(loreEntryActive({
    always_on: 0,
    keywords: ['서리'],
    secondary_keys: ['과거'],
    selective: 0,
    scanText: scan('과거 이야기만'),
  }), false);
});

t('selective+2차: 1차만 있으면 미삽입', () => {
  assert.equal(loreEntryActive({
    always_on: false,
    keywords: ['서리'],
    secondary_keys: ['과거'],
    selective: true,
    scanText: scan('서리가 차를 따랐다'),
  }), false);
});

t('selective+2차: 1차와 2차 함께 있으면 삽입', () => {
  assert.equal(loreEntryActive({
    always_on: false,
    keywords: ['서리'],
    secondary_keys: ['과거', '만년필'],
    selective: true,
    scanText: scan('서리의 과거를 묻는다'),
  }), true);
});

t('selective여도 2차가 비면 1차만으로 삽입 (기존 보존)', () => {
  assert.equal(loreEntryActive({
    always_on: 0,
    keywords: ['서리'],
    secondary_keys: [],
    selective: 1,
    scanText: scan('서리'),
  }), true);
});

t('대소문자 무시', () => {
  assert.equal(loreEntryActive({
    always_on: 0,
    keywords: ['Kai'],
    secondary_keys: ['Sword'],
    selective: 1,
    scanText: scan('kai dropped the SWORD'),
  }), true);
});

t('2차만 있고 1차 없음 → 후보 아님', () => {
  assert.equal(loreEntryActive({
    always_on: 0,
    keywords: [],
    secondary_keys: ['과거'],
    selective: 1,
    scanText: scan('과거'),
  }), false);
});

console.log(`\nPASS ${passed}/8`);
if (passed !== 8) {
  console.error(`expected 8 tests, got ${passed}`);
  process.exit(1);
}
