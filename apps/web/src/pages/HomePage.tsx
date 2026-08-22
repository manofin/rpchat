import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { get, post } from '../lib/api';
import { navigate } from '../lib/router';
import type { Character, Health } from '../types';
import { Avatar, relTime } from '../components/view';
import { CharacterEditor } from '../components/CharacterEditor';
import { Spinner, useUi } from '../components/ui';

export function HomePage() {
  const ui = useUi();
  const [chars, setChars] = useState<Character[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [editor, setEditor] = useState<{ open: boolean; character: Character | null }>({ open: false, character: null });
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  async function load() {
    try {
      setChars(await get<Character[]>('/api/characters'));
    } catch (e) {
      ui.toast((e as Error).message, 'err');
      setChars([]);
    }
  }
  useEffect(() => {
    load();
    get<Health>('/api/health').then(setHealth).catch(() => {});
  }, []);

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // 같은 파일 재선택 허용
    if (!file) return;
    setImporting(true);
    try {
      const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
      let body: { pngBase64?: string; json?: unknown };
      if (isPng) {
        body = { pngBase64: await fileToBase64(file) };
      } else {
        const text = await file.text();
        body = { json: JSON.parse(text) };
      }
      const r = await post<{ character: Character; warnings: string[]; imported: { loreCount: number; specVersion: string } }>('/api/characters/import', body);
      await load();
      if (r.warnings.length) ui.toast(`가져옴 · 참고 ${r.warnings.length}건 (로어 ${r.imported.loreCount})`, 'warn');
      else ui.toast(`'${r.character.name}' 가져옴 (로어 ${r.imported.loreCount})`);
      navigate(`/character/${r.character.id}`);
    } catch (err) {
      const msg = err instanceof SyntaxError ? 'JSON 파싱 실패 — 올바른 카드 파일인지 확인' : (err as Error).message;
      ui.toast(msg, 'err');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="screen">
      <div className="topbar">
        <div className="title"><h1>캐릭터</h1><div className="sub">{modelLine(health)}</div></div>
        <button className="btn ghost icon" onClick={() => navigate('/search')} aria-label="검색">🔍</button>
        <button className="btn ghost icon" onClick={() => navigate('/settings')} aria-label="설정">⚙</button>
        <button className="btn ghost icon" onClick={() => fileRef.current?.click()} disabled={importing} aria-label="카드 가져오기">{importing ? '…' : '📥'}</button>
        <button className="btn primary icon" onClick={() => setEditor({ open: true, character: null })} aria-label="새 캐릭터">＋</button>
      </div>
      <input ref={fileRef} type="file" accept="image/png,.png,.json,application/json" onChange={onPickFile} style={{ display: 'none' }} />
      <div className="content">
        {health && !health.model.ok && (
          <div className="banner warn">모델 서버에 연결되지 않았습니다. 대화 전송이 비활성화됩니다. (설정에서 상태 확인)</div>
        )}
        {chars === null ? (
          <Spinner />
        ) : chars.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 28 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🎭</div>
            <div style={{ marginBottom: 12 }}>첫 캐릭터를 만들어 대화를 시작하세요.</div>
            <button className="btn primary" onClick={() => setEditor({ open: true, character: null })}>새 캐릭터 만들기</button>
          </div>
        ) : (
          <div className="grid">
            {chars.map((c) => (
              <div key={c.id} className="card tap" onClick={() => navigate(`/character/${c.id}`)}>
                <Avatar name={c.name} avatar={c.avatar} />
                <div className="char-name">{c.name}</div>
                <div className="char-tag">{c.tagline || ' '}</div>
                <div className="small muted" style={{ marginTop: 6 }}>{c.conversation_count ? `대화 ${c.conversation_count}개 · ${relTime(c.last_chat_at)}` : '새 캐릭터'}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <CharacterEditor
        open={editor.open}
        character={editor.character}
        onClose={() => setEditor({ open: false, character: null })}
        onSaved={(c) => { setEditor({ open: false, character: null }); load(); navigate(`/character/${c.id}`); }}
      />
    </div>
  );
}

function modelLine(h: Health | null): string {
  if (!h) return '연결 확인 중…';
  if (!h.model.ok) return '모델 오프라인';
  return `${h.model.resolvedModel || '모델'} · ${Math.round(h.model.contextTokens / 1000)}K`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('파일 읽기 실패'));
    r.readAsDataURL(file);
  });
}
