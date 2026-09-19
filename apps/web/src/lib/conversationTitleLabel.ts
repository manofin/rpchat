/** Display-only conversation title. Does not mutate the source row. */
export function conversationTitleLabel(row: {
  title?: string | null;
  character_name?: string | null;
  story_name_snapshot?: string | null;
}): string {
  const title = row.title ?? '';
  if (title.trim() !== '') return title;
  const character = (row.character_name ?? '').trim();
  const story = (row.story_name_snapshot ?? '').trim();
  if (character && story) return character === story ? character : `${character} · ${story}`;
  return character || story || '대화';
}
