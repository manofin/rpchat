import { useEffect, useRef, useState } from 'react';
import { ApiError, del, get, post } from '../lib/api';
import { back, navigate } from '../lib/router';
import type { Character, Conversation, Story, StoryCharacter, StoryInjectPreview } from '../types';
import { StoryEditor } from '../components/StoryEditor';
import { BottomSheet, Spinner, useUi } from '../components/ui';

const ARCHIVED_START_MSG = '보관된 스토리에서는 새 대화를 시작할 수 없습니다.\n스토리를 다시 활성화한 뒤 시도해 주세요.';

type PreviewKind = 'idle' | 'loading' | 'ok' | 'archived' | 'missing' | 'error';

function isArchivedError(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 409) return false;
  if (e.message === 'archived') return true;
  const body = e.body;
  return typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'archived';
}

export function StoryPage({ id }: { id: string }) {
  const ui = useUi();
  const [story, setStory] = useState<Story | null>(null);
  const [chars, setChars] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pickId, setPickId] = useState('');
  const [starter, setStarter] = useState(false);
  const [startPick, setStartPick] = useState('');
  const [previewKind, setPreviewKind] = useState<PreviewKind>('idle');
  const [preview, setPreview] = useState<StoryInjectPreview | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [starting, setStarting] = useState(false);
  const previewSeq = useRef(0);

  async function load(opts?: { quiet?: boolean }) {
    if (!opts?.quiet) setLoading(true);
    try {
      const [s, list] = await Promise.all([get<Story>(`/api/stories/${id}`), get<Character[]>('/api/characters')]);
      setStory(s);
      setChars(list);
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    } finally {
      if (!opts?.quiet) setLoading(false);
    }
  }
  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (!starter || !startPick) {
      previewSeq.current += 1;
      setPreviewKind('idle');
      setPreview(null);
      return;
    }
    const seq = ++previewSeq.current;
    setPreviewKind('loading');
    setPreview(null);
    let cancelled = false;
    void (async () => {
      try {
        const data = await get<StoryInjectPreview>(
          `/api/stories/${id}/inject-preview?characterId=${encodeURIComponent(startPick)}`,
        );
        if (cancelled || seq !== previewSeq.current) return;
        setPreview(data);
        setPreviewKind('ok');
      } catch (e) {
        if (cancelled || seq !== previewSeq.current) return;
        if (isArchivedError(e)) {
          setPreviewKind('archived');
          void load({ quiet: true });
          return;
        }
        if (e instanceof ApiError && e.status === 404) {
          setPreviewKind('missing');
          return;
        }
        setPreviewKind('error');
      }
    })();
    return () => { cancelled = true; };
  }, [starter, startPick, id, previewRetry]);

  async function archiveStory() {
    if (!(await ui.confirm(`'${story?.name}' 스토리를 보관할까요? 목록에서 숨겨집니다.`, { danger: true, okLabel: '보관' }))) return;
    await del(`/api/stories/${id}`);
    navigate('/', { replace: true });
  }

  async function addMain() {
    if (!pickId) return;
    try {
      await post(`/api/stories/${id}/characters`, { characterId: pickId, role: 'main' });
      setPickId('');
      await load();
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    }
  }

  async function removeMain(characterId: string) {
    if (!(await ui.confirm('이 메인 캐릭터를 스토리에서 뺄까요? 캐릭터 자체는 남습니다.', { okLabel: '빼기' }))) return;
    try {
      await del(`/api/stories/${id}/characters/${characterId}`);
      await load();
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    }
  }

  async function startChat() {
    if (!startPick || previewKind !== 'ok') return;
    setStarting(true);
    try {
      const conv = await post<Conversation>('/api/conversations', {
        characterId: startPick,
        storyId: id,
        mode: 'story',
      });
      setStarter(false);
      navigate(`/chat/${conv.id}`);
    } catch (e) {
      if (isArchivedError(e)) {
        setPreviewKind('archived');
        setPreview(null);
        void load({ quiet: true });
        return;
      }
      ui.toast((e as Error).message, 'err');
    } finally {
      setStarting(false);
    }
  }

  if (loading || !story) return <div className="screen"><div className="topbar"><button className="btn ghost icon" onClick={() => back('/')}>‹</button></div><Spinner /></div>;

  const hosted: StoryCharacter[] = story.characters ?? [];
  const hostedIds = new Set(hosted.map((c) => c.character_id));
  const available = chars.filter((c) => !hostedIds.has(c.id));
  const startReady = Boolean(startPick) && previewKind === 'ok' && !starting;

  return (
    <div className="screen">
      <div className="topbar">
        <button className="btn ghost icon" onClick={() => back('/')} aria-label="뒤로">‹</button>
        <div className="title"><h1>{story.name}</h1><div className="sub">{story.tagline}</div></div>
        <button className="btn ghost icon" onClick={() => setEditorOpen(true)} aria-label="편집">✎</button>
      </div>
      <div className="content">
        {story.setting ? <div className="card" style={{ marginBottom: 12, whiteSpace: 'pre-wrap' }}>{story.setting}</div> : <div className="muted small" style={{ marginBottom: 12 }}>설정이 없습니다.</div>}

        <div className="section-title">조연</div>
        {story.minor_cast.length === 0 ? (
          <div className="muted small" style={{ marginBottom: 12 }}>조연 없음</div>
        ) : (
          <div className="list" style={{ marginBottom: 12 }}>
            {story.minor_cast.map((m, i) => (
              <div key={`${m.name}-${i}`} className="list-item">
                <div className="body">
                  <div className="t">{m.name}</div>
                  <div className="p">{m.note || ' '}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="section-title">메인 캐릭터 {hosted.length > 0 && `(${hosted.length})`}</div>
        {hosted.length === 0 ? (
          <div className="muted small" style={{ marginBottom: 12 }}>메인 캐릭터를 추가하세요.</div>
        ) : (
          <div className="list" style={{ marginBottom: 12 }}>
            {hosted.map((c) => (
              <div key={c.character_id} className="list-item" onClick={() => navigate(`/character/${c.character_id}`)}>
                <div className="body">
                  <div className="t">{c.name}</div>
                  <div className="p muted">메인</div>
                </div>
                <button className="btn ghost icon" onClick={(e) => { e.stopPropagation(); void removeMain(c.character_id); }} aria-label="빼기">✕</button>
              </div>
            ))}
          </div>
        )}

        {available.length > 0 && (
          <div className="field">
            <label>메인 캐릭터 추가</label>
            <select value={pickId} onChange={(e) => setPickId(e.target.value)}>
              <option value="">선택</option>
              {available.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="btn block" style={{ marginTop: 8 }} disabled={!pickId} onClick={() => void addMain()}>추가</button>
          </div>
        )}

        {!story.archived && (
          <button
            className="btn primary block"
            disabled={hosted.length === 0}
            onClick={() => {
              setStartPick(hosted.length === 1 ? hosted[0].character_id : '');
              setStarter(true);
            }}
            style={{ marginTop: 18 }}
          >
            이 스토리로 대화 시작
          </button>
        )}
        <button className="btn danger block sm" onClick={() => void archiveStory()} style={{ marginTop: 18 }}>스토리 보관</button>
      </div>
      <StoryEditor open={editorOpen} story={story} onClose={() => setEditorOpen(false)} onSaved={() => { setEditorOpen(false); load(); }} />
      <BottomSheet open={starter} onClose={() => setStarter(false)}>
        <div className="sheet-body">
          <strong>이 스토리로 대화 시작</strong>
          <div className="field" style={{ marginTop: 12 }}>
            <label>메인 캐릭터</label>
            <select value={startPick} onChange={(e) => setStartPick(e.target.value)}>
              <option value="">선택</option>
              {hosted.map((c) => (
                <option key={c.character_id} value={c.character_id}>{c.name}</option>
              ))}
            </select>
          </div>
          <StartPreview
            kind={previewKind}
            preview={preview}
            onRetry={() => setPreviewRetry((n) => n + 1)}
          />
          <button className="btn primary block" disabled={!startReady} onClick={() => void startChat()}>
            {starting ? '생성 중…' : '시작'}
          </button>
        </div>
      </BottomSheet>
    </div>
  );
}

function StartPreview({
  kind,
  preview,
  onRetry,
}: {
  kind: PreviewKind;
  preview: StoryInjectPreview | null;
  onRetry: () => void;
}) {
  if (kind === 'idle') {
    return <p className="muted small" role="status" aria-live="polite">캐릭터를 선택하면 적용될 스토리 설정을 확인할 수 있습니다.</p>;
  }
  if (kind === 'loading') {
    return <div role="status" aria-live="polite" aria-busy="true"><Spinner label="미리보기를 불러오는 중…" /></div>;
  }
  if (kind === 'archived') {
    return (
      <div className="banner err" role="alert" style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>
        {ARCHIVED_START_MSG}
      </div>
    );
  }
  if (kind === 'missing' || kind === 'error') {
    return (
      <div className="banner err" role="alert" style={{ marginBottom: 12 }}>
        <div>{kind === 'missing' ? '미리보기를 불러올 수 없습니다.' : '미리보기를 불러오지 못했습니다.'}</div>
        <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={onRetry}>다시 시도</button>
      </div>
    );
  }
  if (!preview) return null;
  const included = preview.cast.filter((c) => c.included).length;
  const excluded = preview.cast.filter((c) => !c.included).length;
  const excerpt = preview.settingExcerpt.trim();
  return (
    <div className="card" role="status" aria-live="polite" style={{ marginBottom: 12 }}>
      <div className="small" style={{ marginBottom: 8 }}>대화에 적용될 스토리 설정</div>
      {excerpt
        ? <div style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>{excerpt}</div>
        : <div className="muted small" style={{ marginBottom: 8 }}>설정이 없습니다.</div>}
      <div className="muted small">설정: {preview.settingTruncated ? '일부 잘림' : '전체 포함'}</div>
      <div className="muted small">
        {preview.cast.length === 0
          ? '조연: 없음'
          : `조연: ${included}명 포함, ${excluded}명 제외`}
      </div>
      <div className="muted small">예상 사용량: 약 {preview.estTokens} 토큰</div>
      <div className="muted small" style={{ marginTop: 8 }}>
        대화를 시작하면 현재 설정이 이 대화에 동결됩니다.
        이후 스토리를 수정해도 이미 시작한 대화에는 반영되지 않습니다.
      </div>
    </div>
  );
}
