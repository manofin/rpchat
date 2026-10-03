import type { Character } from '../types';
import { CharacterPortrait } from './CharacterPortrait';

export function CharacterIntroCard({ character }: { character: Pick<Character, 'name' | 'tagline' | 'description' | 'avatar'> }) {
  const summary = character.description.trim() || character.tagline.trim();
  if (!character.avatar && !summary) return null;
  return <section className="chat-intro-card" aria-label={`${character.name} 캐릭터 소개`}>
    {character.avatar ? <div className="chat-intro-media"><img src={character.avatar} alt={`${character.name} 대표 이미지`} width={600} height={800} loading="lazy" decoding="async" /></div> : null}
    <div className="chat-intro-copy">
      <span className="chat-intro-kicker">캐릭터 소개</span>
      <strong>{character.name}</strong>
      {character.tagline ? <span>{character.tagline}</span> : null}
      {summary && summary !== character.tagline.trim() ? <p>{summary}</p> : null}
    </div>
  </section>;
}

export type RosterPortraitOption = { id: string; name: string; chip: string; image_url: string };

export function RosterPortraitStage({ options, selectedId, onSelect }: {
  options: RosterPortraitOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const selected = options.find(option => option.id === selectedId) ?? options[0];
  if (!selected) return null;
  return <section className="roster-portrait-stage" aria-label="현재 캐릭터 초상화">
    {options.length > 1 ? <div className="roster-portrait-tabs" aria-label="초상화 선택">
      {options.map(option => <button type="button" key={option.id} aria-pressed={option.id === selected.id} onClick={() => onSelect(option.id)}>{option.chip} {option.name}</button>)}
    </div> : null}
    <CharacterPortrait key={selected.image_url} src={selected.image_url} name={`${selected.name} ${selected.chip}`} />
  </section>;
}
