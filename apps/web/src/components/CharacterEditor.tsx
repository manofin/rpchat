import { useEffect, useState } from 'react';
import { get, post, postBinary, put } from '../lib/api';
import {
  FIELD_LIMITS,
  fieldCountTone,
  formatFieldCount,
  overLimitFields,
  type LimitedField,
} from '../lib/characterFieldLimits';
import type { Character } from '../types';
import { LorePanel, type LoreEntry } from './LorePanel';
import { Modal, useUi } from './ui';

const FROST_CHARACTER_ID = 'f89ace9b-8684-4d97-96dc-e00c4b25a819';
const AVATAR_ACCEPT = 'image/jpeg,image/png,image/webp';
/** hint-only; canonical: apps/server/src/media/avatar.ts AVATAR_MAX_BYTES. Server 413 is the verdict. */
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;

type Draft = Omit<Character, 'id' | 'created_at' | 'updated_at' | 'archived' | 'conversation_count' | 'last_chat_at'>;

/**
 * party-ready-default: every new character starts tagged for the beat engine.
 * `role` only ever distinguishes `background` (never speaks) from everything
 * else — `main` gets force-applied to whichever character opened the
 * conversation regardless of its own tag (`withConversationStarter`), and no
 * code path treats `main` differently from `secondary` — so `secondary` is a
 * safe, inert default. It stays inert until the character is added to a story
 * alongside a second `party:`-tagged character (`castFromCharacters`'s ≥2
 * gate) and given a `party:place=<id>` that exists in that story's catalog.
 */
const DEFAULT_TAGS = ['party:role=secondary'];

const EMPTY: Draft = {
  name: '', tagline: '', avatar: null, description: '', personality: '', speech_style: '', scenario: '',
  first_message: '', example_dialogue: '', taboos: '', tags: DEFAULT_TAGS, // scene/voice optional
};

function FieldCount({ value, field }: { value: string; field: LimitedField }) {
  const max = FIELD_LIMITS[field];
  const len = value.length;
  const tone = fieldCountTone(len, max);
  return (
    <span className={`field-count${tone === 'ok' ? '' : ` ${tone}`}`} aria-live="polite">
      {formatFieldCount(len, max)}
    </span>
  );
}

export function CharacterEditor({ open, character, onClose, onSaved }: { open: boolean; character: Character | null; onClose: () => void; onSaved: (c: Character) => void }) {
  const ui = useUi();
  const [d, setD] = useState<Draft>(EMPTY);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [lore, setLore] = useState<LoreEntry[]>([]);
  const [tab, setTab] = useState<'card' | 'lore'>('card');
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTab('card');
    if (character) {
      const { id, created_at, updated_at, archived, conversation_count, last_chat_at, ...rest } = character;
      setD(rest as Draft);
      get<LoreEntry[]>(`/api/characters/${character.id}/lore`).then(setLore).catch(() => setLore([]));
    } else {
      setD(EMPTY);
      setLore([]);
    }
  }, [open, character]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  async function save() {
    if (!d.name.trim()) return ui.toast('이름은 필수', 'err');
    const overs = overLimitFields({
      name: d.name,
      tagline: d.tagline,
      avatar: d.avatar,
      description: d.description,
      personality: d.personality,
      speech_style: d.speech_style,
      scenario: d.scenario,
      first_message: d.first_message,
      example_dialogue: d.example_dialogue,
      taboos: d.taboos,
    });
    if (overs.length) {
      ui.toast(`글자 수 초과: ${overs.join(', ')} (그래도 저장 시도)`, 'warn');
    }
    setSaving(true);
    try {
      const saved = character ? await put<Character>(`/api/characters/${character.id}`, d) : await post<Character>('/api/characters', d);
      ui.toast('저장됨');
      onSaved(saved);
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  }

  function addTag() {
    const t = tagInput.trim();
    if (t && !d.tags.includes(t)) set('tags', [...d.tags, t]);
    setTagInput('');
  }

  return (
    <Modal
      open={open}
      title={character ? '캐릭터 편집' : '새 캐릭터'}
      onClose={onClose}
      toolbar={
        <div className="tabs" style={{ padding: '0 0 10px' }}>
          <button className={tab === 'card' ? 'active' : ''} onClick={() => setTab('card')}>카드</button>
          <button className={tab === 'lore' ? 'active' : ''} onClick={() => setTab('lore')} disabled={!character}>로어{character ? ` (${lore.length})` : ' (저장 후)'}</button>
        </div>
      }
      footer={<><button className="btn" onClick={onClose}>취소</button><button className="btn primary" disabled={saving || uploading} onClick={save}>{saving ? '저장 중…' : '저장'}</button></>}
    >
      {tab === 'card' ? (
        <>
          <div className="field">
            <label>이름 *</label>
            <input value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={FIELD_LIMITS.name} />
            <FieldCount value={d.name} field="name" />
          </div>
          <div className="field">
            <label>한 줄 소개</label>
            <input value={d.tagline} onChange={(e) => set('tagline', e.target.value)} maxLength={FIELD_LIMITS.tagline} />
            <FieldCount value={d.tagline} field="tagline" />
          </div>
          <div className="field"><label>아바타 URL (선택)</label><input value={d.avatar ?? ''} onChange={(e) => set('avatar', e.target.value || null)} placeholder="비워두면 이니셜 표시" maxLength={FIELD_LIMITS.avatar} /></div>
          {character && character.id !== FROST_CHARACTER_ID && (
            <div className="field">
              <label>아바타 파일</label>
              <input
                type="file"
                accept={AVATAR_ACCEPT}
                disabled={uploading}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  if (file.size > AVATAR_MAX_BYTES) {
                    ui.toast(`파일이 ${AVATAR_MAX_BYTES / 1024 / 1024}MB를 넘습니다`, 'err');
                    return;
                  }
                  setUploading(true);
                  try {
                    const saved = await postBinary<Character>(`/api/characters/${character.id}/avatar`, file, file.type || 'application/octet-stream');
                    set('avatar', saved.avatar);
                    ui.toast('아바타 업로드됨');
                  } catch (err) {
                    ui.toast((err as Error).message, 'err');
                  } finally {
                    setUploading(false);
                  }
                }}
              />
              <span className="hint">jpeg/png/webp · 최대 {AVATAR_MAX_BYTES / 1024 / 1024}MB. 변환 없음.</span>
            </div>
          )}
          <div className="field">
            <label>설명 / 배경</label>
            <textarea value={d.description} onChange={(e) => set('description', e.target.value)} maxLength={FIELD_LIMITS.description} />
            <FieldCount value={d.description} field="description" />
          </div>
          <div className="field">
            <label>성격</label>
            <textarea value={d.personality} onChange={(e) => set('personality', e.target.value)} maxLength={FIELD_LIMITS.personality} />
            <FieldCount value={d.personality} field="personality" />
          </div>
          <div className="field">
            <label>말투</label>
            <textarea value={d.speech_style} onChange={(e) => set('speech_style', e.target.value)} maxLength={FIELD_LIMITS.speech_style} placeholder="예: 반말, 짧고 툭툭 던지는 말투. 문장 끝을 흐림." />
            <FieldCount value={d.speech_style} field="speech_style" />
          </div>
          <div className="field">
            <label>기본 장면 / 시나리오</label>
            <textarea value={d.scenario} onChange={(e) => set('scenario', e.target.value)} maxLength={FIELD_LIMITS.scenario} />
            <FieldCount value={d.scenario} field="scenario" />
          </div>
          <div className="field">
            <label>첫 메시지</label>
            <textarea value={d.first_message} onChange={(e) => set('first_message', e.target.value)} maxLength={FIELD_LIMITS.first_message} placeholder="{{char}}, {{user}} 치환 가능" />
            <FieldCount value={d.first_message} field="first_message" />
          </div>
          <div className="field">
            <label>예시 대화</label>
            <textarea value={d.example_dialogue} onChange={(e) => set('example_dialogue', e.target.value)} maxLength={FIELD_LIMITS.example_dialogue} style={{ minHeight: 120 }} placeholder={'{{user}}: ...\n{{char}}: ...'} />
            <FieldCount value={d.example_dialogue} field="example_dialogue" />
            <span className="hint">컨텍스트가 부족하면 이 블록이 먼저 잘립니다.</span>
          </div>
          <div className="field">
            <label>금기 / 하지 말 것</label>
            <textarea value={d.taboos} onChange={(e) => set('taboos', e.target.value)} maxLength={FIELD_LIMITS.taboos} />
            <FieldCount value={d.taboos} field="taboos" />
          </div>
          <div className="field">
            <label>태그</label>
            <div className="row"><input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())} placeholder="입력 후 Enter" /><button className="btn sm" onClick={addTag}>추가</button></div>
            <div className="tags" style={{ marginTop: 6 }}>{d.tags.map((t) => <span key={t} className="tag" onClick={() => set('tags', d.tags.filter((x) => x !== t))}>{t} ✕</span>)}</div>
          </div>
        </>
      ) : (
        character && <LorePanel createUrl={`/api/characters/${character.id}/lore`} lore={lore} setLore={setLore} />
      )}
    </Modal>
  );
}

