import { useEffect, useState } from 'react';
import { post, put } from '../lib/api';
import type { Story } from '../types';
import { Modal, useUi } from './ui';

type Cast = { name: string; note: string };
type Draft = { name: string; tagline: string; setting: string; minor_cast: Cast[] };

const EMPTY: Draft = { name: '', tagline: '', setting: '', minor_cast: [] };

export function StoryEditor({ open, story, onClose, onSaved }: { open: boolean; story: Story | null; onClose: () => void; onSaved: (s: Story) => void }) {
  const ui = useUi();
  const [d, setD] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (story) {
      setD({
        name: story.name,
        tagline: story.tagline,
        setting: story.setting,
        minor_cast: (story.minor_cast ?? []).map((c) => ({ name: c.name, note: c.note })),
      });
    } else {
      setD(EMPTY);
    }
  }, [open, story]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  function setCast(i: number, k: keyof Cast, v: string) {
    set('minor_cast', d.minor_cast.map((c, idx) => (idx === i ? { ...c, [k]: v } : c)));
  }

  async function save() {
    if (!d.name.trim()) return ui.toast('이름은 필수', 'err');
    const minor_cast = d.minor_cast
      .map((c) => ({ name: c.name.trim(), note: c.note.trim() }))
      .filter((c) => c.name);
    setSaving(true);
    try {
      const body = { name: d.name.trim(), tagline: d.tagline.trim(), setting: d.setting, minor_cast };
      const saved = story ? await put<Story>(`/api/stories/${story.id}`, body) : await post<Story>('/api/stories', body);
      ui.toast('저장됨');
      onSaved(saved);
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title={story ? '스토리 편집' : '새 스토리'}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>취소</button><button className="btn primary" disabled={saving} onClick={save}>{saving ? '저장 중…' : '저장'}</button></>}
    >
      <div className="field"><label>이름 *</label><input value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={80} /></div>
      <div className="field"><label>한 줄 소개</label><input value={d.tagline} onChange={(e) => set('tagline', e.target.value)} maxLength={200} /></div>
      <div className="field"><label>설정</label><textarea value={d.setting} onChange={(e) => set('setting', e.target.value)} placeholder="세계관·배경·규칙" /></div>
      <div className="section-title">조연</div>
      {d.minor_cast.map((c, i) => (
        <div key={i} className="card" style={{ marginBottom: 8 }}>
          <div className="field"><label>이름</label><input value={c.name} onChange={(e) => setCast(i, 'name', e.target.value)} maxLength={80} /></div>
          <div className="field"><label>설정</label><textarea value={c.note} onChange={(e) => setCast(i, 'note', e.target.value)} /></div>
          <button className="btn ghost sm" type="button" onClick={() => set('minor_cast', d.minor_cast.filter((_, idx) => idx !== i))}>이 조연 빼기</button>
        </div>
      ))}
      <button className="btn block" type="button" onClick={() => set('minor_cast', [...d.minor_cast, { name: '', note: '' }])}>＋ 조연 추가</button>
    </Modal>
  );
}
