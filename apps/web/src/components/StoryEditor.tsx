import { useEffect, useState } from 'react';
import { post, put } from '../lib/api';
import type { SceneCatalog, SceneCatalogPlace, Story } from '../types';
import { Modal, useUi } from './ui';

type Cast = { name: string; note: string };
type Draft = { name: string; tagline: string; setting: string; minor_cast: Cast[]; places: SceneCatalogPlace[] };

const EMPTY: Draft = { name: '', tagline: '', setting: '', minor_cast: [], places: [] };

/**
 * story-place-catalog-editor: everything in the catalog except `places`. Kept out
 * of `Draft` on purpose — this section never renders it, so nothing here should
 * ever go through `set()`. `PUT /api/stories/:id` replaces the whole
 * `scene_catalog` object when the key is sent at all, so saving with only
 * `{ places }` would silently erase weather/arc/duty tokens a beat turn already
 * wrote. Round-tripping the untouched rest is what keeps this editor at the same
 * "0 bytes outside places" contract the omission path already has.
 */
const EMPTY_CATALOG_REST: Omit<SceneCatalog, 'places'> = {
  weathers: [], arcs: [], stagesByArc: {}, flags: {}, outfits: [], items: [], grades: [], emotions: {}, stages: {}, dutySlots: {},
};

export function StoryEditor({ open, story, onClose, onSaved }: { open: boolean; story: Story | null; onClose: () => void; onSaved: (s: Story) => void }) {
  const ui = useUi();
  const [d, setD] = useState<Draft>(EMPTY);
  const [catalogRest, setCatalogRest] = useState<Omit<SceneCatalog, 'places'>>(EMPTY_CATALOG_REST);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (story) {
      const { places, ...rest } = story.scene_catalog ?? { places: [], ...EMPTY_CATALOG_REST };
      setD({
        name: story.name,
        tagline: story.tagline,
        setting: story.setting,
        minor_cast: (story.minor_cast ?? []).map((c) => ({ name: c.name, note: c.note })),
        places: places.map((p) => ({ ...p })),
      });
      setCatalogRest(rest);
    } else {
      setD(EMPTY);
      setCatalogRest(EMPTY_CATALOG_REST);
    }
  }, [open, story]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  function setCast(i: number, k: keyof Cast, v: string) {
    set('minor_cast', d.minor_cast.map((c, idx) => (idx === i ? { ...c, [k]: v } : c)));
  }

  function setPlace(i: number, k: keyof SceneCatalogPlace, v: string) {
    set('places', d.places.map((p, idx) => (idx === i ? { ...p, [k]: v } : p)));
  }

  async function save() {
    if (!d.name.trim()) return ui.toast('이름은 필수', 'err');
    const minor_cast = d.minor_cast
      .map((c) => ({ name: c.name.trim(), note: c.note.trim() }))
      .filter((c) => c.name);
    // party:place=<id> must match one of these ids exactly (applySceneDelta's
    // location allow-list); trailing/leading space would never match a typed tag.
    const places = d.places
      .map((p) => ({ ...p, id: p.id.trim(), name: p.name?.trim() || undefined }))
      .filter((p) => p.id);
    setSaving(true);
    try {
      const body = {
        name: d.name.trim(), tagline: d.tagline.trim(), setting: d.setting, minor_cast,
        scene_catalog: { ...catalogRest, places },
      };
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

      <div className="section-title">장소</div>
      <div className="small muted" style={{ marginBottom: 8 }}>
        캐릭터 태그 <code>party:place=</code> 뒤에 아래 id를 그대로 붙여 넣으면 그 장소가 배정됩니다.
      </div>
      {d.places.map((p, i) => (
        <div key={i} className="card" style={{ marginBottom: 8 }}>
          <div className="field">
            <label>id * (태그에 쓸 값, 영문 권장)</label>
            <input value={p.id} onChange={(e) => setPlace(i, 'id', e.target.value)} maxLength={60} placeholder="예: bureau_lobby" />
          </div>
          <div className="field"><label>표시 이름</label><input value={p.name ?? ''} onChange={(e) => setPlace(i, 'name', e.target.value)} maxLength={80} /></div>
          <button className="btn ghost sm" type="button" onClick={() => set('places', d.places.filter((_, idx) => idx !== i))}>이 장소 빼기</button>
        </div>
      ))}
      <button className="btn block" type="button" onClick={() => set('places', [...d.places, { id: '', name: '' }])}>＋ 장소 추가</button>
    </Modal>
  );
}
