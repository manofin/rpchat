/** Display-only desc header strip. Does not mutate stored character/story text. */

const TERMINAL = /[.?!。？！]/;
const HEADER =
  /^[A-Z][A-Z0-9 .\/-]*(?:\s*&\s*[A-Z][A-Z0-9 .\/-]*)+(?:\s*\([^)]*\))?$/;

function isDescSectionHeader(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return false;
  if (TERMINAL.test(trimmed)) return false;
  return HEADER.test(trimmed);
}

export function stripDescSectionHeaders(text: string | null | undefined): string {
  if (text == null || text === '') return '';
  const kept = text.split('\n').filter((line) => !isDescSectionHeader(line));
  while (kept.length > 0 && kept[0].trim() === '') kept.shift();
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return kept.join('\n');
}
