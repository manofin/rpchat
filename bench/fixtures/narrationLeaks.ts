/** Combined leaks whose cleanup exposes another leading/trailing fragment. */
export const narrationLeaks = [
  {
    name: 'reversed BeatUi and orphan choices',
    raw: '본문 ★주입확인★\n{"roster":[]}\n</choices>',
    expected: '본문 ★주입확인★',
  },
  {
    name: 'consecutive leading OOC paragraphs',
    raw: '(OOC: 설정 확인)\n\n(OOC: 추가 확인)\n\n본문 ★주입확인★',
    expected: '본문 ★주입확인★',
  },
  {
    name: 'combined leading OOC, paired choices and reversed tail',
    raw: '(OOC: 설정 확인)\n\n(OOC: 추가 확인)\n\n앞<choices>["a"]</choices>뒤 ★주입확인★\n{"roster":[]}\n</choices>',
    expected: '앞뒤 ★주입확인★',
  },
  {
    name: 'repeated trailing orphan choices',
    raw: '본문 ★주입확인★\n{"roster":[]}\n</choices>\n</choices>',
    expected: '본문 ★주입확인★',
  },
  {
    name: 'OOC exposed by paired choices',
    raw: '<choices>["a"]</choices>(OOC: 설정 확인)\n\n본문 ★주입확인★',
    expected: '본문 ★주입확인★',
  },
] as const;
