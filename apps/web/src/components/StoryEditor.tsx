import { useEffect, useState } from 'react';
import { ApiError, post, put } from '../lib/api';
import type { SceneCatalog, SceneCatalogPlace, Story } from '../types';
import { Modal, useUi } from './ui';

type Cast = { name: string; note: string };
type Draft = { name: string; tagline: string; setting: string; minor_cast: Cast[]; places: SceneCatalogPlace[] };
type OpeningDraft = {
  scenario: string;
  greeting: string;
  place_id: string;
  weather: string;
  day_index: string;
  clock_minutes: string;
  beat_goal: string;
  present_ids: string[];
};

const EMPTY: Draft = { name: '', tagline: '', setting: '', minor_cast: [], places: [] };
const EMPTY_OPENING: OpeningDraft = {
  scenario: '', greeting: '', place_id: '', weather: '', day_index: '', clock_minutes: '', beat_goal: '', present_ids: [],
};

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

export function StoryEditor({
  open, story, hosted = [], onClose, onSaved,
}: {
  open: boolean;
  story: Story | null;
  hosted?: Array<{ character_id: string; name: string }>;
  onClose: () => void;
  onSaved: (s: Story) => void;
}) {
  const ui = useUi();
  const [d, setD] = useState<Draft>(EMPTY);
  const [opening, setOpening] = useState<OpeningDraft>(EMPTY_OPENING);
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
      const o = story.opening;
      setOpening({
        scenario: o?.scenario ?? '',
        greeting: o?.greeting ?? '',
        place_id: o?.scene?.place_id ?? '',
        weather: o?.scene?.weather ?? '',
        day_index: o?.scene?.day_index != null ? String(o.scene.day_index) : '',
        clock_minutes: o?.scene?.clock_minutes != null ? String(o.scene.clock_minutes) : '',
        beat_goal: o?.scene?.beat_goal ?? '',
        present_ids: o?.present_ids ?? [],
      });
    } else {
      setD(EMPTY);
      setOpening(EMPTY_OPENING);
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
    const scene: Record<string, unknown> = {};
    if (opening.place_id.trim()) scene.place_id = opening.place_id.trim();
    if (opening.weather.trim()) scene.weather = opening.weather.trim();
    if (opening.day_index.trim()) {
      const n = Number(opening.day_index);
      if (Number.isInteger(n)) scene.day_index = n;
    }
    if (opening.clock_minutes.trim()) {
      const n = Number(opening.clock_minutes);
      if (Number.isInteger(n)) scene.clock_minutes = n;
    }
    if (opening.beat_goal.trim()) scene.beat_goal = opening.beat_goal.trim();
    const openingBody = {
      scenario: opening.scenario,
      greeting: opening.greeting,
      scene,
      present_ids: opening.present_ids,
    };
    setSaving(true);
    try {
      const body = {
        name: d.name.trim(), tagline: d.tagline.trim(), setting: d.setting, minor_cast,
        scene_catalog: { ...catalogRest, places },
        opening: openingBody,
      };
      const saved = story ? await put<Story>(`/api/stories/${story.id}`, body) : await post<Story>('/api/stories', body);
      ui.toast('저장됨');
      onSaved(saved);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && e.body && typeof e.body === 'object' && 'fields' in e.body) {
        const fields = (e.body as { fields?: Array<{ field?: string; message?: string }> }).fields ?? [];
        ui.toast(fields.map((f) => `${f.field}: ${f.message}`).join('\n') || e.message, 'err');
      } else {
        ui.toast((e as Error).message, 'err');
      }
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

      <div className="section-title">오프닝</div>
      <div className="small muted" style={{ marginBottom: 8 }}>
        비워 두면 지금과 같이 시작합니다. 시작 버튼은 막지 않습니다.
      </div>
      <div className="field"><label>시작 설정 (시나리오)</label><textarea value={opening.scenario} onChange={(e) => setOpening((p) => ({ ...p, scenario: e.target.value }))} maxLength={8000} placeholder="스토리 1:1 프롬프트의 시나리오. 비우면 캐릭터 카드" /></div>
      <div className="field"><label>첫 대사</label><textarea value={opening.greeting} onChange={(e) => setOpening((p) => ({ ...p, greeting: e.target.value }))} maxLength={10000} placeholder="{{char}} / {{user}} 치환. 파티에서 비우면 인사 없음" /></div>
      <div className="field">
        <label>시작 장소</label>
        <select value={opening.place_id} onChange={(e) => setOpening((p) => ({ ...p, place_id: e.target.value }))}>
          <option value="">카탈로그 첫 장소</option>
          {d.places.filter((p) => p.id.trim()).map((p) => (
            <option key={p.id} value={p.id.trim()}>{p.name?.trim() || p.id.trim()}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>날씨</label>
        <select value={opening.weather} onChange={(e) => setOpening((p) => ({ ...p, weather: e.target.value }))}>
          <option value="">카탈로그 첫 날씨</option>
          {(catalogRest.weathers ?? []).map((w) => (
            <option key={w} value={w}>{w}</option>
          ))}
        </select>
      </div>
      <div className="field"><label>시계 (0–1439분)</label><input type="number" min={0} max={1439} value={opening.clock_minutes} onChange={(e) => setOpening((p) => ({ ...p, clock_minutes: e.target.value }))} placeholder="비우면 09:38" /></div>
      <div className="field"><label>일차 (≥1)</label><input type="number" min={1} value={opening.day_index} onChange={(e) => setOpening((p) => ({ ...p, day_index: e.target.value }))} placeholder="비우면 1" /></div>
      <div className="field"><label>이 비트 목표</label><input value={opening.beat_goal} onChange={(e) => setOpening((p) => ({ ...p, beat_goal: e.target.value }))} maxLength={500} /></div>
      {hosted.length > 0 && (
        <div className="field">
          <label>첫 장면 등장</label>
          {hosted.map((h) => (
            <label key={h.character_id} className="small" style={{ display: 'block', marginTop: 4 }}>
              <input
                type="checkbox"
                checked={opening.present_ids.includes(h.character_id)}
                onChange={() => setOpening((p) => ({
                  ...p,
                  present_ids: p.present_ids.includes(h.character_id)
                    ? p.present_ids.filter((id) => id !== h.character_id)
                    : [...p.present_ids, h.character_id],
                }))}
              />{' '}
              {h.name}
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}
