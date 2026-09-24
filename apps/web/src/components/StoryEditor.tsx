import { useEffect, useState } from 'react';
import { ApiError, del, get, post, postBinary, put } from '../lib/api';
import type { Character, ModelProfile, SceneCatalog, SceneCatalogPlace, Story, StoryEnding, StoryOpening, StoryOpeningExtra } from '../types';
import { instructionBadge } from '../lib/profileInstruction';
import {
  STAT_MAX,
  emptyStat,
  type StoryStatDef,
} from '../lib/storyStats';
import {
  buildConditions,
  conditionsToDraft,
  emptyConditionsDraft,
  hasNarrativeHint,
  type ConditionsDraft,
} from '../lib/endingConditions';
import { LorePanel, type LoreEntry } from './LorePanel';
import { Modal, useUi } from './ui';

/** hint-only; canonical: apps/server/src/media/avatar.ts AVATAR_MAX_BYTES. Server 413 is the verdict. */
const COVER_MAX_BYTES = 8 * 1024 * 1024;
const COVER_ACCEPT = 'image/jpeg,image/png,image/webp';

/** story-editor-tabs A12: user-facing profiles only, same filter as ConversationOutputPage's rpOutputProfiles. */
const rpProfiles = (profiles: ModelProfile[]) => profiles.filter((p) => p.name.startsWith('rp-'));

const FORMAT_OPTIONS: Array<{ value: '' | 'beat' | 'dialog'; label: string }> = [
  { value: '', label: '기본값 없음' },
  { value: 'beat', label: '비트 (기본)' },
  { value: 'dialog', label: '대화형' },
];

type Cast = { name: string; note: string };
type Draft = {
  name: string;
  tagline: string;
  cover: string | null;
  default_profile_name: string;
  default_format: '' | 'beat' | 'dialog';
  setting: string;
  minor_cast: Cast[];
  places: SceneCatalogPlace[];
  stats: StoryStatDef[];
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

const EMPTY: Draft = { name: '', tagline: '', cover: null, default_profile_name: '', default_format: '', setting: '', minor_cast: [], places: [], stats: [] };
const EMPTY_OPENING: OpeningDraft = {
  scenario: '', greeting: '', place_id: '', weather: '', day_index: '', clock_minutes: '', beat_goal: '', present_ids: [],
};
const OPENING_EXTRA_MAX = 7;
type ExtraDraft = OpeningDraft & { id: string; label: string };

const ENDINGS_MAX = 7;
/**
 * ADR-F8h 후속 "엔딩 조건 저작 UI": 조건은 폼에서 직접 저작한다.
 * 드래프트는 항상 `cond`를 들고 다니고, 저장 시 `buildConditions`로 정제한다
 * (빈 조건 → 키 자체를 생략, `{}` 송신 금지 — stories.ts read 경로 규약).
 */
type EndingDraft = {
  id: string;
  title: string;
  description: string;
  badge_label: string;
  cond: ConditionsDraft;
};

function openingFieldsFrom(o: StoryOpening | undefined): OpeningDraft {
  return {
    scenario: o?.scenario ?? '',
    greeting: o?.greeting ?? '',
    place_id: o?.scene?.place_id ?? '',
    weather: o?.scene?.weather ?? '',
    day_index: o?.scene?.day_index != null ? String(o.scene.day_index) : '',
    clock_minutes: o?.scene?.clock_minutes != null ? String(o.scene.clock_minutes) : '',
    beat_goal: o?.scene?.beat_goal ?? '',
    present_ids: o?.present_ids ?? [],
  };
}

function parseExtraOpening(raw: string): OpeningDraft {
  try {
    const doc = JSON.parse(raw) as unknown;
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) return openingFieldsFrom(doc as StoryOpening);
  } catch { /* damaged extra → empty F8d fields */ }
  return { ...EMPTY_OPENING };
}

function extraToDraft(e: StoryOpeningExtra): ExtraDraft {
  return { id: e.id, label: e.label, ...parseExtraOpening(e.opening_json) };
}

function emptyExtra(existing: ExtraDraft[]): ExtraDraft {
  const used = new Set(existing.map((e) => e.id));
  let n = existing.length + 1;
  let id = `extra_${n}`;
  while (used.has(id)) {
    n += 1;
    id = `extra_${n}`;
  }
  return { id, label: `시작 ${n}`, ...EMPTY_OPENING };
}

function endingToDraft(e: StoryEnding): EndingDraft {
  return {
    id: e.id,
    title: e.title,
    description: e.description ?? '',
    badge_label: e.badge_label ?? '',
    cond: conditionsToDraft(e.conditions),
  };
}

function emptyEnding(existing: EndingDraft[]): EndingDraft {
  const used = new Set(existing.map((e) => e.id));
  let n = existing.length + 1;
  let id = `ending_${n}`;
  while (used.has(id)) {
    n += 1;
    id = `ending_${n}`;
  }
  return { id, title: `엔딩 ${n}`, description: '', badge_label: '', cond: emptyConditionsDraft() };
}

function buildOpeningBody(o: OpeningDraft) {
  const scene: Record<string, unknown> = {};
  if (o.place_id.trim()) scene.place_id = o.place_id.trim();
  if (o.weather.trim()) scene.weather = o.weather.trim();
  if (o.day_index.trim()) {
    const n = Number(o.day_index);
    if (Number.isInteger(n)) scene.day_index = n;
  }
  if (o.clock_minutes.trim()) {
    const n = Number(o.clock_minutes);
    if (Number.isInteger(n)) scene.clock_minutes = n;
  }
  if (o.beat_goal.trim()) scene.beat_goal = o.beat_goal.trim();
  return {
    scenario: o.scenario,
    greeting: o.greeting,
    scene,
    present_ids: o.present_ids,
  };
}

/** story-editor-tabs (A1): reflow only — no new field, no payload change.
 * A8 added the `lore` tab (real feature: story-scoped keyword book).
 * A9 shortcuts CRUD moved to /shortcuts hub (this editor is not an entry).
 * A7 (D2=a): `stats` tab — stories.stats_json, display-only. */
type Tab = 'profile' | 'story' | 'opening' | 'endings' | 'places' | 'lore' | 'stats';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'profile', label: '프로필' },
  { key: 'story', label: '스토리 설정' },
  { key: 'opening', label: '시작 설정' },
  { key: 'endings', label: '엔딩' },
  { key: 'places', label: '장소' },
  { key: 'lore', label: '키워드북' },
  { key: 'stats', label: '스탯' },
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
  open, story, hosted = [], initialTab = 'profile', onClose, onSaved,
}: {
  open: boolean;
  story: Story | null;
  hosted?: Array<{ character_id: string; name: string }>;
  initialTab?: 'profile' | 'opening';
  onClose: () => void;
  onSaved: (s: Story) => void;
}) {
  const ui = useUi();
  const [d, setD] = useState<Draft>(EMPTY);
  const [opening, setOpening] = useState<OpeningDraft>(EMPTY_OPENING);
  const [extras, setExtras] = useState<ExtraDraft[]>([]);
  const [endings, setEndings] = useState<EndingDraft[]>([]);
  const [catalogRest, setCatalogRest] = useState<Omit<SceneCatalog, 'places'>>(EMPTY_CATALOG_REST);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [lore, setLore] = useState<LoreEntry[]>([]);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  // Both opening lists share the saved cast; mapping edits are persisted immediately.
  const [roster, setRoster] = useState<Array<{ character_id: string; name: string }>>([]);
  const [chars, setChars] = useState<Character[]>([]);
  const [addPickId, setAddPickId] = useState('');
  const [addingRoster, setAddingRoster] = useState(false);
  const [tab, setTab] = useState<Tab>('profile');

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setRoster(hosted);
    setAddPickId('');
    get<ModelProfile[]>('/api/profiles').then(setProfiles).catch(() => setProfiles([]));
    get<Character[]>('/api/characters').then(setChars).catch(() => setChars([]));
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
        stats: (story.stats_json ?? []).map((s) => ({ ...s })),
      });
      setCatalogRest(rest);
      // Mapping removal is immediate even when the rest of an edit is cancelled.
      // Drop stale references when reopening so an invisible removed cast member
      // cannot prevent the next save; unrelated opening fields remain intact.
      const hostedIds = new Set(hosted.map((c) => c.character_id));
      const openingDraft = openingFieldsFrom(story.opening);
      setOpening({ ...openingDraft, present_ids: openingDraft.present_ids.filter((id) => hostedIds.has(id)) });
      setExtras((story.openings_extra ?? []).map((extra) => {
        const draft = extraToDraft(extra);
        return { ...draft, present_ids: draft.present_ids.filter((id) => hostedIds.has(id)) };
      }));
      setEndings((story.endings ?? []).map(endingToDraft));
    } else {
      setD(EMPTY);
      setOpening(EMPTY_OPENING);
      setExtras([]);
      setEndings([]);
      setCatalogRest(EMPTY_CATALOG_REST);
      setLore([]);
    }
  }, [open, story, initialTab]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  function setCast(i: number, k: keyof Cast, v: string) {
    set('minor_cast', d.minor_cast.map((c, idx) => (idx === i ? { ...c, [k]: v } : c)));
  }

  function setPlace(i: number, k: keyof SceneCatalogPlace, v: string) {
    set('places', d.places.map((p, idx) => (idx === i ? { ...p, [k]: v } : p)));
  }

  const rosterAvailable = chars.filter((c) => !roster.some((h) => h.character_id === c.id));

  async function addRosterMember() {
    if (!story || !addPickId) return;
    setAddingRoster(true);
    try {
      await post(`/api/stories/${story.id}/characters`, { characterId: addPickId, role: 'main' });
      const added = chars.find((c) => c.id === addPickId);
      if (added) setRoster((r) => [...r, { character_id: added.id, name: added.name }]);
      setAddPickId('');
      ui.toast('참여 캐릭터 추가됨');
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    } finally {
      setAddingRoster(false);
    }
  }

  // Remove stale opening references along with the mapping so a later save stays valid.
  async function removeRosterMember(characterId: string) {
    if (!story) return;
    if (!(await ui.confirm('이 캐릭터를 스토리에서 뺄까요? 캐릭터 자체는 남습니다.', { okLabel: '빼기' }))) return;
    try {
      await del(`/api/stories/${story.id}/characters/${characterId}`);
      setRoster((r) => r.filter((h) => h.character_id !== characterId));
      setOpening((p) => ({ ...p, present_ids: p.present_ids.filter((id) => id !== characterId) }));
      setExtras((p) => p.map((x) => ({ ...x, present_ids: x.present_ids.filter((id) => id !== characterId) })));
      ui.toast('참여 캐릭터를 뺐습니다');
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    }
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
    const openingBody = buildOpeningBody(opening);
    setSaving(true);
    try {
      const body = {
        name: d.name.trim(), tagline: d.tagline.trim(), cover: d.cover,
        default_profile_name: d.default_profile_name || null, default_format: d.default_format || null,
        setting: d.setting, minor_cast,
        scene_catalog: { ...catalogRest, places },
        opening: openingBody,
        openings_extra: extras
          .map((e) => ({
            id: e.id.trim(),
            label: e.label.trim(),
            opening_json: JSON.stringify(buildOpeningBody(e)),
          }))
          .filter((e) => e.id && e.label)
          .slice(0, OPENING_EXTRA_MAX),
        endings: endings
          .map((e) => {
            const conditions = buildConditions(e.cond);
            return {
              id: e.id.trim(),
              title: e.title.trim(),
              description: e.description,
              badge_label: e.badge_label,
              // 빈 조건은 키 자체를 생략 (`{}` 송신 금지 — read 경로 규약).
              ...(conditions ? { conditions } : {}),
            };
          })
          .filter((e) => e.id && e.title)
          .slice(0, ENDINGS_MAX),
        stats_json: d.stats
          .map((s) => ({
            id: s.id.trim(),
            label: s.label.trim(),
            min: Number(s.min),
            max: Number(s.max),
            default: Number(s.default),
          }))
          .filter((s) => s.id),
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

  /** ADR-F8h 조건 저작: i번째 엔딩의 cond 드래프트만 갱신. */
  const patchCond = (i: number, fn: (c: ConditionsDraft) => ConditionsDraft) =>
    setEndings((p) => p.map((x, j) => (j === i ? { ...x, cond: fn(x.cond) } : x)));

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
              {t.key === 'stats' ? ` (${d.stats.length})` : ''}
              {t.key === 'opening' ? ` (${extras.length})` : ''}
              {t.key === 'endings' ? ` (${endings.length})` : ''}
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
              {rpProfiles(profiles).map((p) => <option key={p.name} value={p.name}>{p.name}{p.notes ? ` — ${p.notes}` : ''}{instructionBadge(p)}</option>)}
            </select>
            <span className="hint">새 방을 만들 때 한 번 정해져 방에 저장된다. 서술 지침은 1:1과 파티(서술 호출마다 1회) 모두에 적용된다.</span>
          </div>
        </>
      )}

      {tab === 'opening' && (
        <>
          <div className="story-editor-guide">새 대화는 등록된 참여 캐릭터 전체로 시작합니다. 아래에서 명단을 변경할 수 있으며, 기존 대화에는 영향을 주지 않습니다.</div>
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
          <div className="field">
            <label>참여 캐릭터 추가</label>
            <div className="hint">캐릭터 추가·빼기는 즉시 반영됩니다. 한 대화에는 최대 12명이 참여할 수 있습니다.</div>
            {story ? (
              rosterAvailable.length > 0 ? (
                <>
                  <select value={addPickId} onChange={(ev) => setAddPickId(ev.target.value)} disabled={addingRoster}>
                    <option value="">선택</option>
                    {rosterAvailable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <button className="btn block" type="button" style={{ marginTop: 8 }} disabled={!addPickId || addingRoster} onClick={() => void addRosterMember()}>
                    {addingRoster ? '추가 중…' : '추가'}
                  </button>
                </>
              ) : (
                <div className="small muted">추가할 수 있는 캐릭터가 없습니다.</div>
              )
            ) : (
              <div className="small muted">저장 후 참여 캐릭터를 추가할 수 있습니다.</div>
            )}
          </div>
          {roster.length > 0 && (
            <div className="field">
              <label>첫 장면 등장</label>
              {roster.map((h) => (
                <div key={h.character_id} className="row" style={{ alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <label className="small" style={{ flex: 1 }}>
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
                  <button className="btn ghost icon" type="button" onClick={() => void removeRosterMember(h.character_id)} aria-label="빼기">✕</button>
                </div>
              ))}
            </div>
          )}

          <div className="section-title">추가 시작 설정</div>
          <div className="small muted" style={{ marginBottom: 8 }}>
            기본 외에 최대 {OPENING_EXTRA_MAX}개. 각 항목은 id·라벨과 같은 시작 필드입니다.
          </div>
          {extras.map((e, i) => (
            <div key={e.id || i} className="card" style={{ marginBottom: 8 }}>
              <div className="field"><label>id</label>
                <input value={e.id} maxLength={64} onChange={(ev) => setExtras((p) => p.map((x, j) => (j === i ? { ...x, id: ev.target.value } : x)))} />
              </div>
              <div className="field"><label>라벨</label>
                <input value={e.label} maxLength={40} onChange={(ev) => setExtras((p) => p.map((x, j) => (j === i ? { ...x, label: ev.target.value } : x)))} />
              </div>
              <div className="field"><label>시작 설정 (시나리오)</label>
                <textarea value={e.scenario} maxLength={8000} onChange={(ev) => setExtras((p) => p.map((x, j) => (j === i ? { ...x, scenario: ev.target.value } : x)))} />
              </div>
              <div className="field"><label>첫 대사</label>
                <textarea value={e.greeting} maxLength={10000} onChange={(ev) => setExtras((p) => p.map((x, j) => (j === i ? { ...x, greeting: ev.target.value } : x)))} />
              </div>
              <div className="field">
                <label>시작 장소</label>
                <select value={e.place_id} onChange={(ev) => setExtras((p) => p.map((x, j) => (j === i ? { ...x, place_id: ev.target.value } : x)))}>
                  <option value="">카탈로그 첫 장소</option>
                  {d.places.filter((p) => p.id.trim()).map((p) => (
                    <option key={p.id} value={p.id.trim()}>{p.name?.trim() || p.id.trim()}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>날씨</label>
                <select value={e.weather} onChange={(ev) => setExtras((p) => p.map((x, j) => (j === i ? { ...x, weather: ev.target.value } : x)))}>
                  <option value="">카탈로그 첫 날씨</option>
                  {(catalogRest.weathers ?? []).map((w) => (
                    <option key={w} value={w}>{w}</option>
                  ))}
                </select>
              </div>
              <div className="field"><label>시계 (0–1439분)</label>
                <input type="number" min={0} max={1439} value={e.clock_minutes} onChange={(ev) => setExtras((p) => p.map((x, j) => (j === i ? { ...x, clock_minutes: ev.target.value } : x)))} />
              </div>
              <div className="field"><label>일차 (≥1)</label>
                <input type="number" min={1} value={e.day_index} onChange={(ev) => setExtras((p) => p.map((x, j) => (j === i ? { ...x, day_index: ev.target.value } : x)))} />
              </div>
              <div className="field"><label>이 비트 목표</label>
                <input value={e.beat_goal} maxLength={500} onChange={(ev) => setExtras((p) => p.map((x, j) => (j === i ? { ...x, beat_goal: ev.target.value } : x)))} />
              </div>
              {roster.length > 0 && (
                <div className="field">
                  <label>첫 장면 등장</label>
                  {roster.map((h) => (
                    <label key={h.character_id} className="small" style={{ display: 'block', marginTop: 4 }}>
                      <input
                        type="checkbox"
                        checked={e.present_ids.includes(h.character_id)}
                        onChange={() => setExtras((p) => p.map((x, j) => (j === i ? {
                          ...x,
                          present_ids: x.present_ids.includes(h.character_id)
                            ? x.present_ids.filter((id) => id !== h.character_id)
                            : [...x.present_ids, h.character_id],
                        } : x)))}
                      />{' '}
                      {h.name}
                    </label>
                  ))}
                </div>
              )}
              <button className="btn ghost sm" type="button" onClick={() => setExtras((p) => p.filter((_, j) => j !== i))}>이 시작 빼기</button>
            </div>
          ))}
          {extras.length < OPENING_EXTRA_MAX && (
            <button
              className="btn block"
              type="button"
              onClick={() => setExtras((p) => (p.length < OPENING_EXTRA_MAX ? [...p, emptyExtra(p)] : p))}
            >＋ 시작 설정 추가</button>
          )}
        </>
      )}

      {tab === 'endings' && (
        <>
          <div className="section-title">엔딩</div>
          <div className="small muted" style={{ marginBottom: 8 }}>
            최대 {ENDINGS_MAX}개. 독자가 채팅에서 골라 방을 완결합니다. 상세 페이지에는 개수만 표시됩니다.
          </div>
          {endings.map((e, i) => (
            <div key={e.id || i} className="card" style={{ marginBottom: 8 }}>
              <div className="field"><label>id</label>
                <input value={e.id} maxLength={64} onChange={(ev) => setEndings((p) => p.map((x, j) => (j === i ? { ...x, id: ev.target.value } : x)))} />
              </div>
              <div className="field"><label>제목 (1–40자)</label>
                <input value={e.title} maxLength={40} onChange={(ev) => setEndings((p) => p.map((x, j) => (j === i ? { ...x, title: ev.target.value } : x)))} />
              </div>
              <div className="field"><label>설명</label>
                <textarea value={e.description} maxLength={2000} onChange={(ev) => setEndings((p) => p.map((x, j) => (j === i ? { ...x, description: ev.target.value } : x)))} />
              </div>
              <div className="field"><label>뱃지</label>
                <input value={e.badge_label} maxLength={40} onChange={(ev) => setEndings((p) => p.map((x, j) => (j === i ? { ...x, badge_label: ev.target.value } : x)))} />
              </div>
              <div className="field"><label>도달 조건 — 최소 턴 수 (1 이상, 비우면 미사용)</label>
                <input
                  type="number" min={1} step={1} inputMode="numeric" placeholder="예: 10"
                  value={e.cond.minTurns}
                  onChange={(ev) => patchCond(i, (c) => ({ ...c, minTurns: ev.target.value.replace(/[^0-9]/g, '') }))}
                />
              </div>
              <div className="field"><label>도달 조건 — 필요 스탯 (이름 + 최소치)</label>
                {e.cond.stats.map((s, k) => (
                  <div key={k} className="row" style={{ gap: 6, marginBottom: 6 }}>
                    <input
                      value={s.key} maxLength={60} placeholder="스탯 이름" style={{ flex: 2 }}
                      onChange={(ev) => patchCond(i, (c) => ({ ...c, stats: c.stats.map((r, j) => (j === k ? { ...r, key: ev.target.value } : r)) }))}
                    />
                    <input
                      type="number" inputMode="numeric" placeholder="최소치" style={{ flex: 1 }}
                      value={s.min}
                      onChange={(ev) => patchCond(i, (c) => ({ ...c, stats: c.stats.map((r, j) => (j === k ? { ...r, min: ev.target.value } : r)) }))}
                    />
                    <button className="btn ghost sm" type="button" aria-label="스탯 조건 빼기"
                      onClick={() => patchCond(i, (c) => ({ ...c, stats: c.stats.filter((_, j) => j !== k) }))}>✕</button>
                  </div>
                ))}
                <button className="btn ghost sm" type="button"
                  onClick={() => patchCond(i, (c) => ({ ...c, stats: [...c.stats, { key: '', min: '' }] }))}>＋ 스탯 조건 추가</button>
              </div>
              <div className="field"><label>도달 조건 — 필요 플래그</label>
                {e.cond.flags.map((f, k) => (
                  <div key={k} className="row" style={{ gap: 6, marginBottom: 6 }}>
                    <input
                      value={f} maxLength={80} placeholder="플래그 key" style={{ flex: 1 }}
                      onChange={(ev) => patchCond(i, (c) => ({ ...c, flags: c.flags.map((x, j) => (j === k ? ev.target.value : x)) }))}
                    />
                    <button className="btn ghost sm" type="button" aria-label="플래그 조건 빼기"
                      onClick={() => patchCond(i, (c) => ({ ...c, flags: c.flags.filter((_, j) => j !== k) }))}>✕</button>
                  </div>
                ))}
                <button className="btn ghost sm" type="button"
                  onClick={() => patchCond(i, (c) => ({ ...c, flags: [...c.flags, ''] }))}>＋ 플래그 추가</button>
              </div>
              <div className="field"><label>도달 조건 — 서사 힌트 (선택)</label>
                <textarea
                  value={e.cond.hint} maxLength={500} placeholder="예: 주인공이 이름을 다시 불렀다"
                  onChange={(ev) => patchCond(i, (c) => ({ ...c, hint: ev.target.value }))}
                />
                {hasNarrativeHint(e.cond) && (
                  <div className="small" style={{ marginTop: 4 }}>
                    서사 힌트가 있으면 매 턴 백그라운드 LLM 판정(약 11초) 비용이 발생합니다.
                  </div>
                )}
              </div>
              <button className="btn ghost sm" type="button" onClick={() => setEndings((p) => p.filter((_, j) => j !== i))}>이 엔딩 빼기</button>
            </div>
          ))}
          {endings.length < ENDINGS_MAX && (
            <button
              className="btn block"
              type="button"
              onClick={() => setEndings((p) => (p.length < ENDINGS_MAX ? [...p, emptyEnding(p)] : p))}
            >＋ 엔딩 추가</button>
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

      {tab === 'stats' && (
        <>
          <p className="small muted">표시용입니다. 모델이 바꿀 수 없고, 기존 HP/₩ 과는 별개입니다. 최대 {STAT_MAX}개.</p>
          {d.stats.map((s, i) => (
            <div key={i} className="card" style={{ padding: 8, marginBottom: 8 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <div className="field" style={{ flex: 1, minWidth: 80 }}><label>id</label>
                  <input value={s.id} maxLength={20} onChange={(e) => setD((p) => ({ ...p, stats: p.stats.map((x, j) => j === i ? { ...x, id: e.target.value } : x) }))} placeholder="san" />
                </div>
                <div className="field" style={{ flex: 1, minWidth: 80 }}><label>표시</label>
                  <input value={s.label} maxLength={20} onChange={(e) => setD((p) => ({ ...p, stats: p.stats.map((x, j) => j === i ? { ...x, label: e.target.value } : x) }))} placeholder="SAN" />
                </div>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <div className="field" style={{ flex: 1 }}><label>min</label>
                  <input type="number" value={s.min} onChange={(e) => setD((p) => ({ ...p, stats: p.stats.map((x, j) => j === i ? { ...x, min: Number(e.target.value) } : x) }))} />
                </div>
                <div className="field" style={{ flex: 1 }}><label>max</label>
                  <input type="number" value={s.max} onChange={(e) => setD((p) => ({ ...p, stats: p.stats.map((x, j) => j === i ? { ...x, max: Number(e.target.value) } : x) }))} />
                </div>
                <div className="field" style={{ flex: 1 }}><label>기본</label>
                  <input type="number" value={s.default} onChange={(e) => setD((p) => ({ ...p, stats: p.stats.map((x, j) => j === i ? { ...x, default: Number(e.target.value) } : x) }))} />
                </div>
              </div>
              <button className="btn ghost sm" type="button" onClick={() => setD((p) => ({ ...p, stats: p.stats.filter((_, j) => j !== i) }))}>이 스탯 빼기</button>
            </div>
          ))}
          {d.stats.length < STAT_MAX && (
            <button className="btn block" type="button" onClick={() => setD((p) => ({ ...p, stats: [...p.stats, emptyStat()] }))}>＋ 스탯 추가</button>
          )}
        </>
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
