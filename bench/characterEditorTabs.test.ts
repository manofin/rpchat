/**
 * npx tsx bench/characterEditorTabs.test.ts
 * C1 character-authoring tab-shell reflow: 카드/로어 → 설정/인트로/프롬프트/상세/로어.
 * Source inventory only. No live HTTP / DB / deploy. Do not weaken
 * characterEditorSheet.test.ts — this file is additive.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const editorPath = path.join(dir, '..', 'apps/web/src/components/CharacterEditor.tsx');
const editor = fs.readFileSync(editorPath, 'utf8');

function sgHits(pattern: string, file: string): number {
  try {
    const out = execSync(`ast-grep -p '${pattern}' --lang tsx ${file}`, { encoding: 'utf8' });
    return out.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0; // ast-grep은 무매칭 시 exit 1
  }
}

function tabLabels(): string[] {
  const m = /const TABS: Array<\{ key: Tab; label: string \}> = \[([\s\S]*?)\];/.exec(editor);
  assert.ok(m, 'TABS declaration missing');
  return [...m![1].matchAll(/label: '([^']+)'/g)].map((x) => x[1]);
}

function tabKeys(): string[] {
  const m = /const TABS: Array<\{ key: Tab; label: string \}> = \[([\s\S]*?)\];/.exec(editor);
  assert.ok(m, 'TABS declaration missing');
  return [...m![1].matchAll(/key: '([^']+)'/g)].map((x) => x[1]);
}

function tabSection(key: string, next: string | null): string {
  const startTok = `tab === '${key}'`;
  const start = editor.indexOf(startTok);
  assert.ok(start >= 0, `tab === '${key}' missing`);
  const endTok = next ? `tab === '${next}'` : '← 이전';
  const end = editor.indexOf(endTok, start + startTok.length);
  assert.ok(end > start, `end marker ${JSON.stringify(endTok)} missing after ${key}`);
  return editor.slice(start, end);
}

t('tab key set is 5: 설정/인트로/프롬프트/상세/로어', () => {
  assert.deepEqual(tabLabels(), ['설정', '인트로', '프롬프트', '상세', '로어']);
  assert.deepEqual(tabKeys(), ['setup', 'intro', 'prompt', 'detail', 'lore']);
  assert.equal(tabLabels().length, 5);
  assert.equal(editor.includes("setTab('card')"), false);
  assert.equal(editor.includes("tab === 'card'"), false);
});

t('tabs are className="tabs", not a nested .sheet', () => {
  assert.equal(editor.includes('className="sheet tabs"'), false);
  assert.equal(editor.includes("className='sheet tabs'"), false);
  assert.match(editor, /toolbar=\{\s*<div className="tabs"/);
  assert.equal(sgHits('<div className="sheet tabs" />', editorPath), 0);
});

t('save footer always renders 취소/저장 independent of tab', () => {
  assert.match(editor, /footer=\{<>.*취소.*저장/);
});

t('설정 tab holds name/tagline/avatar fields', () => {
  const s = tabSection('setup', 'intro');
  for (const needle of ['이름 *', '한 줄 소개', '아바타 URL (선택)', '아바타 파일']) {
    assert.ok(s.includes(needle), `설정 missing ${needle}`);
  }
  assert.ok(s.includes('FROST_CHARACTER_ID'), 'avatar file still gated on frost id');
});

t('인트로 tab holds first_message/example_dialogue + hint', () => {
  const s = tabSection('intro', 'prompt');
  assert.ok(s.includes('첫 메시지'));
  assert.ok(s.includes('예시 대화'));
  assert.ok(s.includes('컨텍스트가 부족하면 이 블록이 먼저 잘립니다.'));
});

t('example_dialogue placeholder is a JS newline escape, not a literal backslash-n', () => {
  const line = editor.split('\n').find((l) => l.includes("set('example_dialogue'") && l.includes('placeholder='));
  assert.ok(line, 'example_dialogue placeholder line missing');
  const m = /placeholder=\{'([^']*)'\}/.exec(line);
  assert.ok(m, 'placeholder JSX expression missing');
  const nl = String.fromCharCode(0x5c, 0x6e);
  const dbl = String.fromCharCode(0x5c, 0x5c, 0x6e);
  assert.equal(m[1], '{{user}}: ...' + nl + '{{char}}: ...');
  assert.equal(m[1].includes(dbl), false);
});

t('프롬프트 tab holds personality/speech_style/scenario/taboos', () => {
  const s = tabSection('prompt', 'detail');
  for (const needle of ['성격', '말투', '기본 장면 / 시나리오', '금기 / 하지 말 것']) {
    assert.ok(s.includes(needle), `프롬프트 missing ${needle}`);
  }
});

t('상세 tab holds description/tags', () => {
  const s = tabSection('detail', 'lore');
  assert.ok(s.includes('설명 / 배경'));
  assert.ok(s.includes('태그'));
});

t('로어 tab keeps LorePanel; disabled without character', () => {
  const s = tabSection('lore', null);
  assert.ok(s.includes('LorePanel'));
  assert.ok(editor.includes('disabled={t.key === \'lore\' && !character}') || editor.includes('disabled={t.key === "lore" && !character}'));
});

t('fields stay on their mapped tab (no cross-tab label leak)', () => {
  const setup = tabSection('setup', 'intro');
  const intro = tabSection('intro', 'prompt');
  const prompt = tabSection('prompt', 'detail');
  const detail = tabSection('detail', 'lore');
  const lore = tabSection('lore', null);
  assert.equal(setup.includes('첫 메시지'), false);
  assert.equal(setup.includes('성격'), false);
  assert.equal(setup.includes('설명 / 배경'), false);
  assert.equal(intro.includes('이름 *'), false);
  assert.equal(intro.includes('성격'), false);
  assert.equal(prompt.includes('첫 메시지'), false);
  assert.equal(prompt.includes('태그'), false);
  assert.equal(detail.includes('말투'), false);
  assert.equal(detail.includes('LorePanel'), false);
  assert.equal(lore.includes('이름 *'), false);
  assert.equal(lore.includes('예시 대화'), false);
});

t('scene_background / voice_profile strings are 0 in CharacterEditor.tsx', () => {
  assert.equal(editor.includes('scene_background'), false);
  assert.equal(editor.includes('voice_profile'), false);
  assert.equal(sgHits('scene_background', editorPath), 0);
  assert.equal(sgHits('voice_profile', editorPath), 0);
});

t('prev/next tab buttons exist in the body, not the save footer', () => {
  assert.ok(editor.includes('← 이전'));
  assert.ok(editor.includes('다음 →'));
  const footer = /footer=\{<>.*취소.*저장/.exec(editor)?.[0] ?? '';
  assert.equal(footer.includes('이전'), false);
  assert.equal(footer.includes('다음'), false);
});

t('single draft: save still sends d; tab state is not per-field', () => {
  assert.ok(editor.includes('await put<Character>(`/api/characters/${character.id}`, d)'));
  assert.ok(editor.includes("await post<Character>('/api/characters', d)"));
  assert.equal(editor.includes('useState<Draft>(EMPTY)'), true);
});

console.log(`\n${passed} passed`);
