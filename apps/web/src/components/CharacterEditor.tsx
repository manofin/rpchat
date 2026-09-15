import { useEffect, useRef, useState } from 'react';
import { del, get, post, postBinary, put } from '../lib/api';
import {
  FIELD_LIMITS,
  fieldCountTone,
  formatFieldCount,
  overLimitFields,
  type LimitedField,
} from '../lib/characterFieldLimits';
import {
  CHARACTER_DRAFT_DEBOUNCE_MS,
  flushCharacterDraft,
  readCharacterDraft,
  removeCharacterDraft,
} from '../lib/characterDraftStore';
import {
  hasIncompleteExamplePairs,
  initialExampleEditorState,
  serializeExamplePairs,
  type ExamplePair,
} from '../lib/characterExamplePairs';
import {
  INSERTABLE_TOKENS,
  applyTokenCaretRestore,
  insertCharacterToken,
  type InsertableToken,
  type TokenChipField,
} from '../lib/characterTokenInsert';
import { isAvatarFileInputVisible, validateStagedAvatarFile } from '../lib/characterAvatarStaging';
import {
  AUTHORING_TARGET_FIELDS,
  applyAndClipGeneratedField,
  generateCharacterField,
  type AuthoringTargetField,
} from '../lib/characterGenerate';
import type { Character, CharacterStoryLink } from '../types';
import { CharacterPromptPreview } from './CharacterPromptPreview';
import { AuthoringDraftButton, AuthoringGeneratePanel } from './CharacterFieldGenerate';
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
  first_message: '', example_dialogue: '', taboos: '', play_guide: '', tags: DEFAULT_TAGS, // scene/voice optional
};

/** C1 tab-shell reflow only — no new field, no payload change. */
type Tab = 'setup' | 'intro' | 'prompt' | 'detail' | 'lore';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'setup', label: '설정' },
  { key: 'intro', label: '인트로' },
  { key: 'prompt', label: '프롬프트' },
  { key: 'detail', label: '상세' },
  { key: 'lore', label: '로어' },
];

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

function TokenChips({
  field,
  onInsert,
}: {
  field: TokenChipField;
  onInsert: (field: TokenChipField, token: InsertableToken) => void;
}) {
  return (
    <div className="row" style={{ gap: 6, marginTop: 6 }}>
      {INSERTABLE_TOKENS.map((tok) => (
        <button
          key={tok}
          type="button"
          className="btn sm ghost"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onInsert(field, tok)}
        >
          {tok}
        </button>
      ))}
    </div>
  );
}

type ExamplePairRow = ExamplePair & { id: string };
type ExamplePairSide = 'user' | 'char';
type ExampleEditorMode = 'structured' | 'raw';

let exampleRowSeq = 0;
function allocExampleRowId(): string {
  exampleRowSeq += 1;
  return `exrow-${exampleRowSeq}`;
}

function createExampleRow(user = '', char = ''): ExamplePairRow {
  return { id: allocExampleRowId(), user, char };
}

/* C4-story-link-helpers */
export async function loadCharacterStoryLinks(
  characterId: string | null | undefined,
  getFn: <T>(path: string) => Promise<T>,
): Promise<CharacterStoryLink[]> {
  if (!characterId) return [];
  try {
    return await getFn<CharacterStoryLink[]>(`/api/characters/${characterId}/stories`);
  } catch {
    return [];
  }
}

export async function loadCharacterStoryUi(
  characterId: string | null | undefined,
  getFn: <T>(path: string) => Promise<T>,
): Promise<{ links: CharacterStoryLink[]; catalog: Array<{ id: string; name: string }> }> {
  if (!characterId) return { links: [], catalog: [] };
  const links = await loadCharacterStoryLinks(characterId, getFn);
  try {
    const stories = await getFn<Array<{ id: string; name: string }>>('/api/stories');
    return { links, catalog: stories.map((s) => ({ id: s.id, name: s.name })) };
  } catch {
    return { links, catalog: [] };
  }
}

export async function addCharacterStoryLink(
  storyId: string,
  characterId: string,
  postFn: (path: string, body: unknown) => Promise<unknown>,
  getFn: <T>(path: string) => Promise<T>,
): Promise<CharacterStoryLink[]> {
  await postFn(`/api/stories/${storyId}/characters`, { characterId });
  return loadCharacterStoryLinks(characterId, getFn);
}

export async function removeCharacterStoryLink(
  storyId: string,
  characterId: string,
  delFn: (path: string) => Promise<unknown>,
  getFn: <T>(path: string) => Promise<T>,
  confirmFn: (msg: string, opts?: { danger?: boolean; okLabel?: string }) => Promise<boolean>,
): Promise<CharacterStoryLink[] | null> {
  if (!(await confirmFn('이 스토리에서 뺄까요? 스토리 자체는 남습니다.', { okLabel: '빼기' }))) return null;
  await delFn(`/api/stories/${storyId}/characters/${characterId}`);
  return loadCharacterStoryLinks(characterId, getFn);
}
/* C4-story-link-helpers-end */

function pairRefKey(rowId: string, side: ExamplePairSide): string {
  return `${rowId}:${side}`;
}

function PairUtteranceChips({ onInsert }: { onInsert: (token: InsertableToken) => void }) {
  return (
    <div className="row" style={{ gap: 6, marginTop: 6 }}>
      {INSERTABLE_TOKENS.map((tok) => (
        <button
          key={tok}
          type="button"
          className="btn sm ghost"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onInsert(tok)}
        >
          {tok}
        </button>
      ))}
    </div>
  );
}

export function CharacterEditor({ open, character, onClose, onSaved }: { open: boolean; character: Character | null; onClose: () => void; onSaved: (c: Character) => void }) {
  const ui = useUi();
  const [d, setD] = useState<Draft>(EMPTY);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [lore, setLore] = useState<LoreEntry[]>([]);
  const [tab, setTab] = useState<Tab>('setup');
  const [uploading, setUploading] = useState(false);
  const [stagedAvatar, setStagedAvatar] = useState<File | null>(null);
  const [stagedAvatarPreview, setStagedAvatarPreview] = useState<string | null>(null);
  const stagedFileRef = useRef<File | null>(null);
  const stagedPreviewRef = useRef<string | null>(null);
  const [pendingDraft, setPendingDraft] = useState<Draft | null>(null);
  const dirtyRef = useRef(false);
  const suppressRef = useRef(false);
  const dRef = useRef(d);
  dRef.current = d;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fieldRefs = useRef<Partial<Record<TokenChipField, HTMLInputElement | HTMLTextAreaElement | null>>>({});
  const [exampleMode, setExampleMode] = useState<ExampleEditorMode>('structured');
  const [exampleRows, setExampleRows] = useState<ExamplePairRow[]>(() => [createExampleRow()]);
  const exampleRowsRef = useRef(exampleRows);
  exampleRowsRef.current = exampleRows;
  const pairFieldRefs = useRef<Map<string, HTMLTextAreaElement | null>>(new Map());
  const [genField, setGenField] = useState<AuthoringTargetField | null>(null);
  const [genPrompt, setGenPrompt] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genPreview, setGenPreview] = useState<string | null>(null);
  const [linkedStories, setLinkedStories] = useState<CharacterStoryLink[]>([]);
  const [storyCatalog, setStoryCatalog] = useState<Array<{ id: string; name: string }>>([]);
  const [storyPickId, setStoryPickId] = useState('');

  function applyExampleSource(raw: string) {
    const init = initialExampleEditorState(raw);
    if (init.mode === 'structured') {
      const rows = init.pairs.map((p) => createExampleRow(p.user, p.char));
      exampleRowsRef.current = rows;
      setExampleRows(rows);
      setExampleMode('structured');
      return;
    }
    exampleRowsRef.current = [];
    setExampleRows([]);
    setExampleMode('raw');
  }

  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  useEffect(() => {
    if (!open) return;
    const id = character?.id ?? null;
    dirtyRef.current = false;
    suppressRef.current = false;
    clearTimer();
    setTab('setup');
    setPendingDraft(readCharacterDraft(id));
    setGenField(null);
    setGenPrompt('');
    setGenPreview(null);
    setGenBusy(false);
    if (character) {
      const { id, created_at, updated_at, archived, conversation_count, last_chat_at, ...rest } = character;
      setD(rest as Draft);
      applyExampleSource(rest.example_dialogue);
      get<LoreEntry[]>(`/api/characters/${character.id}/lore`).then(setLore).catch(() => setLore([]));
    } else {
      setD(EMPTY);
      applyExampleSource(EMPTY.example_dialogue);
      setLore([]);
    }
    return () => {
      clearTimer();
      flushCharacterDraft(id, dRef.current, { dirty: dirtyRef.current, suppress: suppressRef.current });
    };
  }, [open, character]);

  useEffect(() => {
    return () => {
      const prev = stagedPreviewRef.current;
      stagedPreviewRef.current = null;
      stagedFileRef.current = null;
      if (!prev) return;
      try {
        URL.revokeObjectURL(prev);
      } catch {
        /* revoke must not throw the editor */
      }
    };
  }, []);

  useEffect(() => {
    if (!open || !character?.id) {
      setLinkedStories([]);
      setStoryCatalog([]);
      setStoryPickId('');
      return;
    }
    let cancelled = false;
    const characterId = character.id;
    void (async () => {
      try {
        const data = await loadCharacterStoryUi(characterId, get);
        if (cancelled) return;
        setLinkedStories(data.links);
        setStoryCatalog(data.catalog);
      } catch {
        if (!cancelled) {
          setLinkedStories([]);
          setStoryCatalog([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [open, character?.id]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    dirtyRef.current = true;
    suppressRef.current = false;
    setD((p) => ({ ...p, [k]: v }));
    clearTimer();
    const id = character?.id ?? null;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flushCharacterDraft(id, dRef.current, { dirty: dirtyRef.current, suppress: suppressRef.current });
    }, CHARACTER_DRAFT_DEBOUNCE_MS);
  };

  function insertToken(field: TokenChipField, token: InsertableToken) {
    const el = fieldRefs.current[field] ?? null;
    const current = dRef.current[field] ?? '';
    let start: number | null = null;
    let end: number | null = null;
    try {
      if (el && typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
        start = el.selectionStart;
        end = el.selectionEnd;
      }
    } catch {
      start = null;
      end = null;
    }
    const inserted = insertCharacterToken(current, token, start, end);
    if (inserted.text.length > FIELD_LIMITS[field]) return;
    set(field, inserted.text);
    const expectedNode = el;
    const caret = inserted.caret;
    requestAnimationFrame(() => {
      applyTokenCaretRestore(fieldRefs.current[field] ?? null, expectedNode, caret);
    });
  }

  function revokeCurrentPreview() {
    const prev = stagedPreviewRef.current;
    stagedPreviewRef.current = null;
    if (!prev) return;
    try {
      URL.revokeObjectURL(prev);
    } catch {
      /* revoke must not throw the editor */
    }
  }

  function clearStagedAvatar() {
    stagedFileRef.current = null;
    revokeCurrentPreview();
    setStagedAvatar(null);
    setStagedAvatarPreview(null);
  }

  async function onAvatarFileChosen(file: File) {
    if (character) {
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
      return;
    }
    const reject = validateStagedAvatarFile(file);
    if (reject === 'too-large') {
      ui.toast(`파일이 ${AVATAR_MAX_BYTES / 1024 / 1024}MB를 넘습니다`, 'err');
      return;
    }
    if (reject === 'bad-type') {
      ui.toast('jpeg/png/webp만 사용할 수 있습니다', 'err');
      return;
    }
    revokeCurrentPreview();
    let next: string | null = null;
    try {
      next = URL.createObjectURL(file);
    } catch {
      next = null;
    }
    stagedPreviewRef.current = next;
    stagedFileRef.current = file;
    setStagedAvatar(file);
    setStagedAvatarPreview(next);
  }

  async function save() {
    if (!d.name.trim()) return ui.toast('이름은 필수', 'err');
    if (exampleMode === 'structured' && hasIncompleteExamplePairs(exampleRows)) {
      ui.toast('예시 대화의 사용자 발화와 캐릭터 발화를 모두 입력하거나, 미완성 쌍을 삭제해 주세요.');
      return;
    }
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
      play_guide: d.play_guide,
    });
    if (overs.length) {
      ui.toast(`글자 수 초과: ${overs.join(', ')} (그래도 저장 시도)`, 'warn');
    }
    setSaving(true);
    try {
      let saved = character ? await put<Character>(`/api/characters/${character.id}`, d) : await post<Character>('/api/characters', d);
      if (!character) {
        const file = stagedFileRef.current;
        if (file) {
          saved = await postBinary<Character>(`/api/characters/${saved.id}/avatar`, file, file.type || 'application/octet-stream').catch(() => {
            ui.toast('캐릭터는 저장됐지만 이미지 업로드에 실패했습니다', 'warn');
            return saved;
          });
        }
        clearStagedAvatar();
      }
      suppressRef.current = true;
      dirtyRef.current = false;
      clearTimer();
      removeCharacterDraft(character?.id ?? null);
      setPendingDraft(null);
      ui.toast('저장됨');
      onSaved(saved);
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  }

  function restoreDraft() {
    if (!pendingDraft) return;
    setD({ ...EMPTY, ...pendingDraft, play_guide: pendingDraft.play_guide ?? '' });
    applyExampleSource(pendingDraft.example_dialogue);
    setPendingDraft(null);
  }

  function discardDraft() {
    suppressRef.current = true;
    dirtyRef.current = false;
    clearTimer();
    removeCharacterDraft(character?.id ?? null);
    setPendingDraft(null);
  }

  function openAuthoringGenerate(field: AuthoringTargetField) {
    setGenField(field);
    setGenPrompt('');
    setGenPreview(null);
  }

  function closeAuthoringGenerate() {
    if (genBusy) return;
    setGenField(null);
    setGenPrompt('');
    setGenPreview(null);
  }

  function authoringContext(): Partial<Record<AuthoringTargetField, string>> {
    const cur = dRef.current;
    const ctx: Partial<Record<AuthoringTargetField, string>> = {};
    for (const field of AUTHORING_TARGET_FIELDS) {
      const v = cur[field];
      if (typeof v === 'string' && v.trim()) ctx[field] = v;
    }
    return ctx;
  }

  function currentAuthoringValue(field: AuthoringTargetField): string {
    const v = dRef.current[field];
    return typeof v === 'string' ? v : '';
  }

  function injectAuthoringText(field: AuthoringTargetField, generated: string, mode: 'replace' | 'append') {
    const next = applyAndClipGeneratedField(field, currentAuthoringValue(field), generated, mode);
    set(field, next);
    if (field === 'example_dialogue') applyExampleSource(next);
    setGenPreview(null);
    setGenField(null);
    setGenPrompt('');
  }

  async function runAuthoringGenerate() {
    if (!genField || genBusy) return;
    const prompt = genPrompt.trim();
    if (!prompt) return;
    setGenBusy(true);
    setGenPreview(null);
    try {
      const res = await generateCharacterField({
        targetField: genField,
        prompt,
        name: dRef.current.name || undefined,
        characterId: character?.id,
        context: authoringContext(),
      });
      setGenPreview(res.text);
    } catch (err) {
      ui.toast((err as Error).message, 'err');
    } finally {
      setGenBusy(false);
    }
  }

  function addTag() {
    const t = tagInput.trim();
    if (t && !d.tags.includes(t)) set('tags', [...d.tags, t]);
    setTagInput('');
  }

  function commitExampleRows(next: ExamplePairRow[]) {
    const rows = next.length === 0 ? [createExampleRow()] : next;
    exampleRowsRef.current = rows;
    setExampleRows(rows);
    set('example_dialogue', serializeExamplePairs(rows));
  }

  function insertPairToken(rowId: string, side: ExamplePairSide, token: InsertableToken) {
    const key = pairRefKey(rowId, side);
    const el = pairFieldRefs.current.get(key) ?? null;
    const row = exampleRowsRef.current.find((r) => r.id === rowId);
    if (!row) return;
    const current = side === 'user' ? row.user : row.char;
    let start: number | null = null;
    let end: number | null = null;
    try {
      if (el && typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
        start = el.selectionStart;
        end = el.selectionEnd;
      }
    } catch {
      start = null;
      end = null;
    }
    const inserted = insertCharacterToken(current, token, start, end);
    const next = exampleRowsRef.current.map((r) => (
      r.id === rowId ? { ...r, [side]: inserted.text } : r
    ));
    const serialized = serializeExamplePairs(next);
    if (serialized.length > FIELD_LIMITS.example_dialogue) return;
    commitExampleRows(next);
    const expectedNode = el;
    requestAnimationFrame(() => {
      const live = pairFieldRefs.current.get(key) ?? null;
      applyTokenCaretRestore(live, expectedNode, inserted.caret);
    });
  }

  function addExamplePair() {
    commitExampleRows([...exampleRowsRef.current, createExampleRow()]);
  }

  function removeExamplePair(rowId: string) {
    commitExampleRows(exampleRowsRef.current.filter((r) => r.id !== rowId));
  }

  const setupIncomplete = !d.name.trim();
  const tabIndex = TABS.findIndex((t) => t.key === tab);
  const linkedIds = new Set(linkedStories.map((s) => s.id));
  const availableStories = storyCatalog.filter((s) => !linkedIds.has(s.id));

  async function addLinkedStory() {
    if (!character?.id || !storyPickId) return;
    try {
      const next = await addCharacterStoryLink(storyPickId, character.id, post, get);
      setStoryPickId('');
      setLinkedStories(next);
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    }
  }

  async function removeLinkedStory(storyId: string) {
    if (!character?.id) return;
    try {
      const next = await removeCharacterStoryLink(storyId, character.id, del, get, ui.confirm);
      if (next === null) return;
      setLinkedStories(next);
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    }
  }

  return (
    <Modal
      open={open}
      title={character ? '캐릭터 편집' : '새 캐릭터'}
      onClose={() => { clearStagedAvatar(); onClose(); }}
      toolbar={
        <div className="tabs" style={{ padding: '0 0 10px' }}>
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={tab === t.key ? 'active' : ''}
              disabled={t.key === 'lore' && !character}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {t.key === 'setup' && setupIncomplete ? ' *' : ''}
              {t.key === 'lore' ? (character ? ` (${lore.length})` : ' (저장 후)') : ''}
            </button>
          ))}
        </div>
      }
      footer={<><button className="btn" onClick={onClose}>취소</button><button className="btn primary" disabled={saving || uploading} onClick={save}>{saving ? '저장 중…' : '저장'}</button></>}
    >
      {pendingDraft ? (
        <div className="banner warn" role="status">
          <div>저장되지 않은 초안이 있습니다.</div>
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <button type="button" className="btn sm" onClick={restoreDraft}>복원</button>
            <button type="button" className="btn sm" onClick={discardDraft}>폐기</button>
          </div>
        </div>
      ) : null}

      {genField ? (
        <AuthoringGeneratePanel
          field={genField}
          busy={genBusy}
          prompt={genPrompt}
          preview={genPreview}
          hasExisting={currentAuthoringValue(genField).trim().length > 0}
          onPrompt={setGenPrompt}
          onGenerate={() => { void runAuthoringGenerate(); }}
          onReplace={() => { if (genPreview != null) injectAuthoringText(genField, genPreview, 'replace'); }}
          onAppend={() => { if (genPreview != null) injectAuthoringText(genField, genPreview, 'append'); }}
          onInsert={() => { if (genPreview != null) injectAuthoringText(genField, genPreview, 'replace'); }}
          onClose={closeAuthoringGenerate}
        />
      ) : null}

      {tab === 'setup' && (
        <>
          <div className="field">
            <label>이름 *</label>
            <input value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={FIELD_LIMITS.name} />
            <FieldCount value={d.name} field="name" />
          </div>
          <div className="field">
            <label>한 줄 소개</label>
            <input ref={(el) => { fieldRefs.current.tagline = el; }} value={d.tagline} onChange={(e) => set('tagline', e.target.value)} maxLength={FIELD_LIMITS.tagline} />
            <FieldCount value={d.tagline} field="tagline" />
            <AuthoringDraftButton field="tagline" disabled={genBusy} onOpen={openAuthoringGenerate} />
            <TokenChips field="tagline" onInsert={insertToken} />
          </div>
          <div className="field"><label>아바타 URL (선택)</label><input value={d.avatar ?? ''} onChange={(e) => set('avatar', e.target.value || null)} placeholder="비워두면 이니셜 표시" maxLength={FIELD_LIMITS.avatar} /></div>
          {isAvatarFileInputVisible(character?.id, FROST_CHARACTER_ID) && (
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
                  await onAvatarFileChosen(file);
                }}
              />
              {stagedAvatar && stagedAvatarPreview ? (
                <img src={stagedAvatarPreview} alt="" className="avatar" style={{ maxHeight: 96 }} />
              ) : null}
              <span className="hint">jpeg/png/webp · 최대 {AVATAR_MAX_BYTES / 1024 / 1024}MB. 변환 없음.</span>
            </div>
          )}
        </>
      )}

      {tab === 'intro' && (
        <>
          <div className="field">
            <label>플레이 가이드</label>
            <textarea value={d.play_guide ?? ''} onChange={(e) => set('play_guide', e.target.value)} maxLength={FIELD_LIMITS.play_guide} />
            <FieldCount value={d.play_guide ?? ''} field="play_guide" />
            <AuthoringDraftButton field="play_guide" disabled={genBusy} onOpen={openAuthoringGenerate} />
            <span className="hint">AI 에 전달되지 않음. 나만 보는 메모.</span>
          </div>
          <div className="field">
            <label>첫 메시지</label>
            <textarea ref={(el) => { fieldRefs.current.first_message = el; }} value={d.first_message} onChange={(e) => set('first_message', e.target.value)} maxLength={FIELD_LIMITS.first_message} placeholder="{{char}}, {{user}} 치환 가능" />
            <FieldCount value={d.first_message} field="first_message" />
            <AuthoringDraftButton field="first_message" disabled={genBusy} onOpen={openAuthoringGenerate} />
            <TokenChips field="first_message" onInsert={insertToken} />
          </div>
          <div className="field">
            <label>예시 대화</label>
            {exampleMode === 'raw' ? (
              <>
                <textarea ref={(el) => { fieldRefs.current.example_dialogue = el; }} value={d.example_dialogue} onChange={e => set('example_dialogue', e.target.value)} maxLength={FIELD_LIMITS.example_dialogue} style={{ minHeight: 120 }} placeholder={'{{user}}: ...\n{{char}}: ...'} />
                <TokenChips field="example_dialogue" onInsert={insertToken} />
              </>
            ) : (
              <>
                {exampleRows.map((row) => (
                  <div key={row.id} className="field">
                    <label>사용자 발화</label>
                    <textarea
                      ref={(el) => { pairFieldRefs.current.set(pairRefKey(row.id, 'user'), el); }}
                      value={row.user}
                      onChange={(e) => commitExampleRows(exampleRowsRef.current.map((r) => (r.id === row.id ? { ...r, user: e.target.value } : r)))}
                      style={{ minHeight: 64 }}
                    />
                    <PairUtteranceChips onInsert={(tok) => insertPairToken(row.id, 'user', tok)} />
                    <label>캐릭터 발화</label>
                    <textarea
                      ref={(el) => { pairFieldRefs.current.set(pairRefKey(row.id, 'char'), el); }}
                      value={row.char}
                      onChange={(e) => commitExampleRows(exampleRowsRef.current.map((r) => (r.id === row.id ? { ...r, char: e.target.value } : r)))}
                      style={{ minHeight: 64 }}
                    />
                    <PairUtteranceChips onInsert={(tok) => insertPairToken(row.id, 'char', tok)} />
                    <button type="button" className="btn sm" onClick={() => removeExamplePair(row.id)}>쌍 삭제</button>
                  </div>
                ))}
                <button type="button" className="btn sm" onClick={addExamplePair}>쌍 추가</button>
              </>
            )}
            <FieldCount value={d.example_dialogue} field="example_dialogue" />
            <AuthoringDraftButton field="example_dialogue" disabled={genBusy} onOpen={openAuthoringGenerate} />
            <span className="hint">컨텍스트가 부족하면 이 블록이 먼저 잘립니다.</span>
          </div>
        </>
      )}

      {tab === 'prompt' && (
        <>
          <div className="field">
            <label>성격</label>
            <textarea ref={(el) => { fieldRefs.current.personality = el; }} value={d.personality} onChange={(e) => set('personality', e.target.value)} maxLength={FIELD_LIMITS.personality} />
            <FieldCount value={d.personality} field="personality" />
            <AuthoringDraftButton field="personality" disabled={genBusy} onOpen={openAuthoringGenerate} />
            <TokenChips field="personality" onInsert={insertToken} />
          </div>
          <div className="field">
            <label>말투</label>
            <textarea ref={(el) => { fieldRefs.current.speech_style = el; }} value={d.speech_style} onChange={(e) => set('speech_style', e.target.value)} maxLength={FIELD_LIMITS.speech_style} placeholder="예: 반말, 짧고 툭툭 던지는 말투. 문장 끝을 흐림." />
            <FieldCount value={d.speech_style} field="speech_style" />
            <AuthoringDraftButton field="speech_style" disabled={genBusy} onOpen={openAuthoringGenerate} />
            <TokenChips field="speech_style" onInsert={insertToken} />
          </div>
          <div className="field">
            <label>기본 장면 / 시나리오</label>
            <textarea ref={(el) => { fieldRefs.current.scenario = el; }} value={d.scenario} onChange={(e) => set('scenario', e.target.value)} maxLength={FIELD_LIMITS.scenario} />
            <FieldCount value={d.scenario} field="scenario" />
            <AuthoringDraftButton field="scenario" disabled={genBusy} onOpen={openAuthoringGenerate} />
            <TokenChips field="scenario" onInsert={insertToken} />
          </div>
          <div className="field">
            <label>금기 / 하지 말 것</label>
            <textarea ref={(el) => { fieldRefs.current.taboos = el; }} value={d.taboos} onChange={(e) => set('taboos', e.target.value)} maxLength={FIELD_LIMITS.taboos} />
            <FieldCount value={d.taboos} field="taboos" />
            <AuthoringDraftButton field="taboos" disabled={genBusy} onOpen={openAuthoringGenerate} />
            <TokenChips field="taboos" onInsert={insertToken} />
          </div>
          <CharacterPromptPreview characterId={character?.id} />
        </>
      )}

      {tab === 'detail' && (
        <>
          <div className="field">
            <label>설명 / 배경</label>
            <textarea ref={(el) => { fieldRefs.current.description = el; }} value={d.description} onChange={(e) => set('description', e.target.value)} maxLength={FIELD_LIMITS.description} />
            <FieldCount value={d.description} field="description" />
            <AuthoringDraftButton field="description" disabled={genBusy} onOpen={openAuthoringGenerate} />
            <TokenChips field="description" onInsert={insertToken} />
          </div>
          <div className="field">
            <label>태그</label>
            <div className="row"><input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())} placeholder="입력 후 Enter" /><button className="btn sm" onClick={addTag}>추가</button></div>
            <div className="tags" style={{ marginTop: 6 }}>{d.tags.map((t) => <span key={t} className="tag" onClick={() => set('tags', d.tags.filter((x) => x !== t))}>{t} ✕</span>)}</div>
          </div>
          <div className="field">
            <label>연결된 스토리</label>
            {!character ? (
              <div className="muted small">캐릭터를 저장한 뒤 스토리에 연결할 수 있습니다.</div>
            ) : (
              <>
                {linkedStories.length === 0 ? (
                  <div className="muted small">연결된 스토리가 없습니다.</div>
                ) : (
                  <div className="list" style={{ marginBottom: 8 }}>
                    {linkedStories.map((s) => (
                      <div key={s.id} className="list-item">
                        <div className="body">
                          <div className="t">{s.name}</div>
                          <div className="p">{s.tagline || ' '}</div>
                        </div>
                        <button type="button" className="btn ghost icon" onClick={() => { void removeLinkedStory(s.id); }} aria-label="빼기">✕</button>
                      </div>
                    ))}
                  </div>
                )}
                {availableStories.length > 0 && (
                  <div className="row" style={{ gap: 8 }}>
                    <select value={storyPickId} onChange={(e) => setStoryPickId(e.target.value)}>
                      <option value="">스토리 선택</option>
                      {availableStories.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <button type="button" className="btn sm" disabled={!storyPickId} onClick={() => { void addLinkedStory(); }}>추가</button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {tab === 'lore' && (
        character && <LorePanel createUrl={`/api/characters/${character.id}/lore`} lore={lore} setLore={setLore} />
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
