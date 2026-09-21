/** npx tsx bench/sanitizeNarration.test.ts
 * 서버정제 — narration persist 전 sanitizeNarration; 웹 sanitizeBubbleContent no-op 폐포.
 */
import assert from 'node:assert/strict';
import { sanitizeNarration } from '../apps/server/src/prompt/templates.ts';
import { sanitizeBubbleContent } from '../apps/web/src/lib/sanitizeBubble.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function main() {
  const normals = [
    '첫 문단이다.\n\n둘째 문단이 이어진다.',
    '그녀는 *천천히* 고개를 돌렸다.',
    '"괜찮아." 그가 말했다.',
    '서리가 만년필을 내려놓았다.',
  ];

  t('정상 narration 무변경 (멀티문단 *별표* 따옴표 한국어)', () => {
    for (const x of normals) {
      assert.equal(sanitizeNarration(x), x);
    }
  });

  const leaks = [
    '본문이 이어진다.\n<choices>["a","b"]</choices>',
    '본문이 이어진다.\n{"location_badge":"x","roster":[]}',
    '(OOC: 설정 확인)\n\n본문',
    '본문이 이어진다.\n</choices>',
  ];

  t('누출 스트립 (choices / BeatUi / OOC / 고아 close)', () => {
    for (const raw of leaks) {
      assert.notEqual(sanitizeNarration(raw), raw);
    }
  });

  const all = [...normals, ...leaks];

  t('멱등 sanitizeNarration(sanitizeNarration(x))===sanitizeNarration(x)', () => {
    for (const x of all) {
      assert.equal(sanitizeNarration(sanitizeNarration(x)), sanitizeNarration(x));
    }
  });

  t('클라 no-op 폐포 sanitizeBubbleContent(sanitizeNarration(x))===sanitizeNarration(x)', () => {
    for (const x of all) {
      const s = sanitizeNarration(x);
      assert.equal(sanitizeBubbleContent(s), s);
    }
  });

  console.log(`\n${passed} passed`);
}

main();
