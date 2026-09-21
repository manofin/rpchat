/** Display-only conversation title. Does not mutate the source row. */

type TitleRow = {
  title?: string | null;
  character_name?: string | null;
  story_name_snapshot?: string | null;
};

type MetaRow = {
  character_name?: string | null;
  story_name_snapshot?: string | null;
};

/** character·story join: trim, identical values once, ` · ` separator. Empty when neither is set. */
export function conversationMetaLabel(row: MetaRow): string {
  const character = (row.character_name ?? '').trim();
  const story = (row.story_name_snapshot ?? '').trim();
  if (character && story) return character === story ? character : `${character} · ${story}`;
  return character || story || '';
}

export function conversationTitleLabel(row: TitleRow): string {
  const title = row.title ?? '';
  if (title.trim() !== '') return title;
  return conversationMetaLabel(row) || '대화';
}

/** Label vs meta after the same join. Favorite `★ ` is not part of the label helper. */
export function conversationTitleMatchesMeta(row: TitleRow): boolean {
  const meta = conversationMetaLabel(row);
  return meta !== '' && conversationTitleLabel(row) === meta;
}
