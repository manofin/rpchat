import { actorLabel, audienceLabel, type AudienceActor } from '../lib/audienceLabels';

export function WhisperRecipients({ actors, value, onChange, disabled, loading, error }: {
  actors: AudienceActor[]; value: string; onChange: (value: string) => void;
  disabled: boolean; loading: boolean; error: boolean;
}) {
  const selected = value.split(',').filter(Boolean);
  const choices = [...actors, { id:'gm',name:'서술자',description:'',available:true }];
  return <fieldset className="whisper-recipients" disabled={disabled || loading || error}>
    <legend>귓속말 받을 인물</legend>
    {loading ? <span>인물 목록 확인 중…</span> : error ? <span>인물 목록을 불러오지 못했습니다.</span> : choices.map(actor => <div key={actor.id} className="whisper-recipient">
      <label><input type="checkbox" checked={selected.includes(actor.id)} disabled={!actor.available} onChange={e => onChange((e.target.checked ? [...selected, actor.id] : selected.filter(id => id !== actor.id)).join(','))} />{actorLabel(actor.id, actors)}{actor.description ? ` · ${actor.description}` : ''}</label>
      {actor.id !== 'gm' && actor.available && <a href={`/character/${encodeURIComponent(actor.id)}`} target="_blank" rel="noopener noreferrer" aria-label={`${actorLabel(actor.id, actors)} 인물 정보 새 창`}>인물 정보</a>}
    </div>)}
    <p aria-live="polite">{selected.length ? audienceLabel({visibility:'private',recipient_ids:['user',...selected]},actors) : '공개 · 선택하지 않으면 공개로 보냅니다.'}</p>
  </fieldset>;
}
