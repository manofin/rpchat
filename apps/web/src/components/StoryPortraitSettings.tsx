import type { PortraitCatalogDraft } from '../lib/storyPortraits';

export function StoryPortraitSettings({ draft, onChange }: {
  draft: PortraitCatalogDraft;
  onChange: (draft: PortraitCatalogDraft) => void;
}) {
  function changeRow(index: number, key: 'name' | 'index', value: string) {
    onChange({ ...draft, emotions: draft.emotions.map((row, i) => i === index ? { ...row, [key]: value } : row) });
  }
  const names = [...new Set(draft.emotions.map(row => row.name.trim()).filter(Boolean))];
  return (
    <section aria-label="상황 이미지 설정">
      <div className="section-title">상황 이미지</div>
      <p className="hint">캐릭터 편집에서 올린 상황 이미지의 의상 이름과 번호를 연결합니다. 이미지가 없으면 대화는 계속되고 이미지 자리에는 안내가 표시됩니다.</p>
      <div className="field">
        <label htmlFor="story-portrait-outfits">의상 이름 (줄마다 하나)</label>
        <textarea id="story-portrait-outfits" value={draft.outfits} onChange={e => onChange({ ...draft, outfits: e.target.value })} />
        <span className="hint">첫 의상이 새 방의 기본 의상입니다. 캐릭터에 기본 의상이 지정돼 있으면 그 값을 사용합니다.</span>
      </div>
      {draft.emotions.map((row, i) => (
        <div className="card" key={i} style={{ marginBottom: 8, padding: 12 }}>
          <div className="field">
            <label htmlFor={`story-portrait-name-${i}`}>표정 이름</label>
            <input id={`story-portrait-name-${i}`} maxLength={40} value={row.name} onChange={e => changeRow(i, 'name', e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`story-portrait-index-${i}`}>이미지 번호</label>
            <input id={`story-portrait-index-${i}`} type="number" min={0} max={9999} step={1} value={row.index} onChange={e => changeRow(i, 'index', e.target.value)} />
          </div>
          <button className="btn ghost sm" type="button" onClick={() => onChange({ ...draft, emotions: draft.emotions.filter((_, j) => i !== j) })}>표정 삭제</button>
        </div>
      ))}
      <button className="btn block" type="button" disabled={draft.emotions.length >= 50} onClick={() => onChange({ ...draft, emotions: [...draft.emotions, { name: '', index: '' }] })}>＋ 표정 추가</button>
      <div className="field">
        <label htmlFor="story-portrait-default">새 방의 시작 표정</label>
        <select id="story-portrait-default" value={draft.defaultEmotion} onChange={e => onChange({ ...draft, defaultEmotion: e.target.value })}>
          <option value="">지정하지 않음</option>
          {draft.defaultEmotion && !names.includes(draft.defaultEmotion) ? <option value={draft.defaultEmotion}>다시 선택 필요</option> : null}
          {names.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <span className="hint">새 방에만 적용됩니다. 기존 방의 표정은 바뀌지 않으며, 대화 중 표정 자동 변경은 아직 지원하지 않습니다.</span>
      </div>
    </section>
  );
}
