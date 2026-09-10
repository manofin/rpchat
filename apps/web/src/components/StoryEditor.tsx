import { useEffect, useState } from 'react';
import { ApiError, get, post, postBinary, put } from '../lib/api';
import type { ModelProfile, SceneCatalog, SceneCatalogPlace, Story } from '../types';
import { LorePanel, type LoreEntry } from './LorePanel';
import { Modal, useUi } from './ui';

/** hint-only; canonical: apps/server/src/media/avatar.ts AVATAR_MAX_BYTES. Server 413 is the verdict. */
const COVER_MAX_BYTES = 8 * 1024 * 1024;
const COVER_ACCEPT = 'image/jpeg,image/png,image/webp';

/** story-editor-tabs A12: user-facing profiles only, same filter as ConversationOutputPage's rpOutputProfiles. */
const rpProfiles = (profiles: ModelProfile[]) => profiles.filter((p) => p.name.startsWith('rp-'));

const FORMAT_OPTIONS: Array<{ value: '' | 'beat' | 'dialog' | 'hunter'; label: string }> = [
  { value: '', label: '기본값 없음' },
  { value: 'beat', label: '비트 (기본)' },
  { value: 'dialog', label: '대화형' },
  { value: 'hunter', label: '헌터' },
];

type Cast = { name: string; note: string };
type Draft = {
  name: string;
  tagline: string;
  cover: string | null;
  default_profile_name: string;
  default_format: '' | 'beat' | 'dialog' | 'hunter';
  setting: string;
  minor_cast: Cast[];
  places: SceneCatalogPlace[];
};
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

const EMPTY: Draft = { name: '', tagline: '', cover: null, default_profile_name: '', default_format: '', setting: '', minor_cast: [], places: [] };
const EMPTY_OPENING: OpeningDraft = {
  scenario: '', greeting: '', place_id: '', weather: '', day_index: '', clock_minutes: '', beat_goal: '', present_ids: [],
};

/** story-editor-tabs (A1): reflow only — no new field, no payload change.
 * A8 added the `lore` tab (real feature: story-scoped keyword book). */
type Tab = 'profile' | 'story' | 'opening' | 'places' | 'lore';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'profile', label: '프로필' },
  { key: 'story', label: '스토리 설정' },
  { key: 'opening', label: '시작 설정' },
  { key: 'places', label: '장소' },
  { key: 'lore', label: '키워드북' },
];

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
  const [uploading, setUploading] = useState(false);
  const [lore, setLore] = useState<LoreEntry[]>([]);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [tab, setTab] = useState<Tab>('profile');

  useEffect(() => {
    if (!open) return;
    setTab('profile');
    get<ModelProfile[]>('/api/profiles').then(setProfiles).catch(() => setProfiles([]));
    if (story) {
      get<LoreEntry[]>(`/api/stories/${story.id}/lore`).then(setLore).catch(() => setLore([]));
      const { places, ...rest } = story.scene_catalog ?? { places: [], ...EMPTY_CATALOG_REST };
      setD({
        name: story.name,
        tagline: story.tagline,
        cover: story.cover ?? null,
        default_profile_name: story.default_profile_name ?? '',
        default_format: story.default_format ?? '',
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
      setLore([]);
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
        name: d.name.trim(), tagline: d.tagline.trim(), cover: d.cover,
        default_profile_name: d.default_profile_name || null, default_format: d.default_format || null,
        setting: d.setting, minor_cast,
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

  const profileIncomplete = !d.name.trim();
  const tabIndex = TABS.findIndex((t) => t.key === tab);

  return (
    <Modal
      open={open}
      title={story ? '스토리 편집' : '새 스토리'}
      onClose={onClose}
      toolbar={
        <div className="tabs" style={{ padding: '0 14px 8px' }}>
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={tab === t.key ? 'active' : ''}
              disabled={t.key === 'lore' && !story}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {t.key === 'profile' && profileIncomplete ? ' *' : ''}
              {t.key === 'lore' ? (story ? ` (${lore.length})` : ' (저장 후)') : ''}
            </button>
          ))}
        </div>
      }
      footer={<><button className="btn" onClick={onClose}>취소</button><button className="btn primary" disabled={saving} onClick={save}>{saving ? '저장 중…' : '저장'}</button></>}
    >
      {tab === 'profile' && (
        <>
          <div className="field">
            <label>이미지</label>
            {d.cover && <img src={d.cover} alt="" style={{ width: 96, height: 144, objectFit: 'cover', borderRadius: 8, marginBottom: 8, display: 'block' }} />}
            {story ? (
              <>
                <input
                  type="file"
                  accept={COVER_ACCEPT}
                  disabled={uploading}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    if (file.size > COVER_MAX_BYTES) {
                      ui.toast(`파일이 ${COVER_MAX_BYTES / 1024 / 1024}MB를 넘습니다`, 'err');
                      return;
                    }
                    setUploading(true);
                    try {
                      const saved = await postBinary<Story>(`/api/stories/${story.id}/cover`, file, file.type || 'application/octet-stream');
                      set('cover', saved.cover);
                      ui.toast('이미지 업로드됨');
                    } catch (err) {
                      ui.toast((err as Error).message, 'err');
                    } finally {
                      setUploading(false);
                    }
                  }}
                />
                {d.cover && <button className="btn ghost sm" type="button" onClick={() => set('cover', null)}>삭제</button>}
                <div className="hint">jpeg/png/webp · 최대 {COVER_MAX_BYTES / 1024 / 1024}MB. 변환 없음.</div>
              </>
            ) : (
              <div className="small muted">저장 후 업로드할 수 있습니다.</div>
            )}
          </div>
          <div className="field"><label>이름 *</label><input value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={80} /></div>
          <div className="field"><label>한 줄 소개</label><input value={d.tagline} onChange={(e) => set('tagline', e.target.value)} maxLength={200} /></div>
        </>
      )}

      {tab === 'story' && (
        <>
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

          <div className="section-title">기본값</div>
          <div className="small muted" style={{ marginBottom: 8 }}>
            이 스토리의 새 방을 만들 때만 적용되는 기본값입니다. 기존 방에는 영향이 없습니다.
          </div>
          <div className="field">
            <label>기본 대화 형태</label>
            <select value={d.default_format} onChange={(e) => set('default_format', e.target.value as Draft['default_format'])}>
              {FORMAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>기본 모델 프로필</label>
            <select value={d.default_profile_name} onChange={(e) => set('default_profile_name', e.target.value)}>
              <option value="">기본값 없음</option>
              {rpProfiles(profiles).map((p) => <option key={p.name} value={p.name}>{p.name}{p.notes ? ` — ${p.notes}` : ''}</option>)}
            </select>
          </div>
        </>
      )}

      {tab === 'opening' && (
        <>
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
        </>
      )}

      {tab === 'places' && (
        <>
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
        </>
      )}

      {tab === 'lore' && (
        story ? (
          <LorePanel createUrl={`/api/stories/${story.id}/lore`} lore={lore} setLore={setLore} />
        ) : (
          <div className="small muted">저장 후 키워드북을 추가할 수 있습니다.</div>
        )
      )}

      <div className="row" style={{ justifyContent: 'space-between', marginTop: 16 }}>
        <button
          className="btn ghost sm"
          type="button"
          disabled={tabIndex <= 0}
          onClick={() => setTab(TABS[Math.max(0, tabIndex - 1)].key)}
        >
          ← 이전
        </button>
        <button
          className="btn ghost sm"
          type="button"
          disabled={tabIndex >= TABS.length - 1}
          onClick={() => setTab(TABS[Math.min(TABS.length - 1, tabIndex + 1)].key)}
        >
          다음 →
        </button>
      </div>
    </Modal>
  );
}
