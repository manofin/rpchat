import { useEffect, useState } from 'react';
import { del, get, post, put } from '../lib/api';
import { back } from '../lib/router';
import type { Health, ModelProfile, Persona } from '../types';
import { BottomSheet, Spinner, useUi } from '../components/ui';
import { applyTheme, persistTheme, readTheme, type Theme } from '../lib/theme';

export function SettingsPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function loadHealth() {
    setRefreshing(true);
    try {
      setHealth(await get<Health>('/api/health'));
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => { loadHealth(); }, []);

  return (
    <div className="screen">
      <div className="topbar">
        <button className="btn ghost icon" onClick={() => back('/')} aria-label="뒤로">‹</button>
        <div className="title"><h1>설정</h1></div>
      </div>
      <div className="content">
        <div className="section-title">모델 상태</div>
        <div className="card">
          {!health ? <div className="muted small">확인 중…</div> : (
            <>
              <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                <span className={`dot ${health.model.ok ? 'ok' : 'bad'}`} />
                <b>{health.model.ok ? '연결됨' : '연결 실패'}</b>
                <span className="spacer" />
                <button className="btn sm" onClick={loadHealth} disabled={refreshing}>{refreshing ? '…' : '새로고침'}</button>
              </div>
              {health.model.ok ? (
                <div className="small muted">
                  모델: {health.model.resolvedModel || '(미해석)'}<br />
                  컨텍스트: {health.model.contextTokens.toLocaleString()}t · 지연 {health.model.latencyMs}ms<br />
                  사용 가능: {health.model.models.join(', ') || '—'}
                </div>
              ) : (
                <div className="small" style={{ color: 'var(--danger)' }}>{health.model.error}</div>
              )}
              <div className="small muted" style={{ marginTop: 6 }}>인증: {health.authMode} · 프롬프트 {health.promptVersion}{health.generation.active.length ? ` · 생성 중 ${health.generation.active.length}` : ''}</div>
            </>
          )}
        </div>

        <ThemeSection />
        <PersonasSection />
        <ProfilesSection />
        <ContentPolicySection />

        {health?.authMode === 'token' && (
          <>
            <div className="section-title">세션</div>
            <LogoutButtons />
          </>
        )}
        <div style={{ height: 24 }} />
      </div>
    </div>
  );
}

function ThemeSection() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  function choose(next: Theme) {
    if (next === theme) return;
    persistTheme(next);
    applyTheme(next);
    setTheme(next);
  }

  return (
    <>
      <div className="section-title">화면</div>
      <div className="row" style={{ gap: 8 }} role="radiogroup" aria-label="테마">
        <button
          type="button"
          role="radio"
          aria-checked={theme === 'dark'}
          className={`btn sm block${theme === 'dark' ? ' primary' : ''}`}
          onClick={() => choose('dark')}
        >
          다크
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={theme === 'light'}
          className={`btn sm block${theme === 'light' ? ' primary' : ''}`}
          onClick={() => choose('light')}
        >
          라이트
        </button>
      </div>
    </>
  );
}

function PersonasSection() {
  const ui = useUi();
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [edit, setEdit] = useState<Persona | null>(null);
  const [open, setOpen] = useState(false);

  async function load() {
    setPersonas(await get<Persona[]>('/api/personas'));
  }
  useEffect(() => { load(); }, []);

  const blank: Persona = { id: '', name: '', address_as: '', appearance: '', personality: '', relationship: '', is_default: false };

  async function save(p: Persona) {
    if (!p.name.trim()) return ui.toast('이름 필요', 'err');
    const body = { name: p.name, address_as: p.address_as, appearance: p.appearance, personality: p.personality, relationship: p.relationship, is_default: p.is_default };
    try {
      if (p.id) await put(`/api/personas/${p.id}`, body);
      else await post('/api/personas', body);
      setOpen(false);
      await load();
      ui.toast('저장됨');
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    }
  }
  async function remove(id: string) {
    if (!(await ui.confirm('이 페르소나를 삭제할까요?', { danger: true, okLabel: '삭제' }))) return;
    try {
      await del(`/api/personas/${id}`);
      await load();
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    }
  }

  return (
    <>
      <div className="section-title">내 페르소나</div>
      {personas === null ? <div className="muted small">…</div> : (
        <div className="list">
          {personas.map((p) => (
            <div key={p.id} className="list-item" onClick={() => { setEdit(p); setOpen(true); }}>
              <div className="body"><div className="t">{p.is_default ? '★ ' : ''}{p.name}</div><div className="p">{p.relationship || p.personality || '설명 없음'}</div></div>
              <button className="btn ghost icon" onClick={(e) => { e.stopPropagation(); remove(p.id); }}>🗑</button>
            </div>
          ))}
          <button className="btn sm block" onClick={() => { setEdit(blank); setOpen(true); }}>+ 페르소나 추가</button>
        </div>
      )}
      <BottomSheet open={open} onClose={() => setOpen(false)}>
        {edit && (
          <div className="sheet-body">
            <strong>{edit.id ? '페르소나 편집' : '새 페르소나'}</strong>
            <div className="field" style={{ marginTop: 12 }}><label>이름</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="field"><label>호칭 (캐릭터가 나를 부르는 법)</label><input value={edit.address_as} onChange={(e) => setEdit({ ...edit, address_as: e.target.value })} /></div>
            <div className="field"><label>외형</label><textarea value={edit.appearance} onChange={(e) => setEdit({ ...edit, appearance: e.target.value })} /></div>
            <div className="field"><label>성격</label><textarea value={edit.personality} onChange={(e) => setEdit({ ...edit, personality: e.target.value })} /></div>
            <div className="field"><label>관계/배경</label><textarea value={edit.relationship} onChange={(e) => setEdit({ ...edit, relationship: e.target.value })} /></div>
            <label className="row" style={{ gap: 8, marginBottom: 14 }}><input type="checkbox" checked={edit.is_default} onChange={(e) => setEdit({ ...edit, is_default: e.target.checked })} style={{ width: 'auto', minHeight: 0 }} /> 기본 페르소나로</label>
            <button className="btn primary block" onClick={() => save(edit)}>저장</button>
          </div>
        )}
      </BottomSheet>
    </>
  );
}

function ProfilesSection() {
  const ui = useUi();
  const [profiles, setProfiles] = useState<ModelProfile[] | null>(null);
  const [edit, setEdit] = useState<ModelProfile | null>(null);

  async function load() {
    setProfiles(await get<ModelProfile[]>('/api/profiles'));
  }
  useEffect(() => { load(); }, []);

  async function save(p: ModelProfile) {
    try {
      await put(`/api/profiles/${p.name}`, { model: p.model, temperature: p.temperature, top_p: p.top_p, max_tokens: p.max_tokens, stop: p.stop, system_mode: p.system_mode, notes: p.notes });
      setEdit(null);
      await load();
      ui.toast('프로필 저장됨');
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    }
  }

  return (
    <>
      <div className="section-title">모델 프로필</div>
      {profiles === null ? <div className="muted small">…</div> : (
        <div className="list">
          {profiles.map((p) => (
            <div key={p.name} className="list-item" onClick={() => setEdit({ ...p })}>
              <div className="body"><div className="t">{p.name}</div><div className="p">temp {p.temperature} · top_p {p.top_p} · max {p.max_tokens}{p.model ? ` · ${p.model}` : ''}</div></div>
            </div>
          ))}
        </div>
      )}
      <BottomSheet open={!!edit} onClose={() => setEdit(null)}>
        {edit && (
          <div className="sheet-body">
            <strong>{edit.name}</strong>
            <div className="field" style={{ marginTop: 12 }}><label>모델 이름 (비우면 서버 기본)</label><input value={edit.model ?? ''} onChange={(e) => setEdit({ ...edit, model: e.target.value || null })} placeholder="예: gemma-3-27b-it" /></div>
            <div className="row wrap">
              <div className="field" style={{ flex: 1, minWidth: 100 }}><label>temperature</label><input type="number" step="0.05" value={edit.temperature} onChange={(e) => setEdit({ ...edit, temperature: Number(e.target.value) })} /></div>
              <div className="field" style={{ flex: 1, minWidth: 100 }}><label>top_p</label><input type="number" step="0.05" value={edit.top_p} onChange={(e) => setEdit({ ...edit, top_p: Number(e.target.value) })} /></div>
              <div className="field" style={{ flex: 1, minWidth: 100 }}><label>max_tokens</label><input type="number" value={edit.max_tokens} onChange={(e) => setEdit({ ...edit, max_tokens: Number(e.target.value) })} /></div>
            </div>
            <div className="field">
              <label>시스템 주입 방식</label>
              <select value={edit.system_mode} onChange={(e) => setEdit({ ...edit, system_mode: e.target.value as 'system' | 'merge' })}>
                <option value="system">system 역할 사용</option>
                <option value="merge">첫 user 메시지에 병합 (system 미지원 모델용)</option>
              </select>
            </div>
            <button className="btn primary block" onClick={() => save(edit)}>저장</button>
          </div>
        )}
      </BottomSheet>
    </>
  );
}

function ContentPolicySection() {
  const ui = useUi();
  const [val, setVal] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    get<{ content_policy: string }>('/api/settings').then((s) => { setVal(s.content_policy ?? ''); setLoaded(true); });
  }, []);
  async function save() {
    try {
      await put('/api/settings', { content_policy: val });
      ui.toast('저장됨');
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    }
  }
  if (!loaded) return null;
  return (
    <>
      <div className="section-title">콘텐츠 지침</div>
      <div className="field">
        <textarea value={val} onChange={(e) => setVal(e.target.value)} placeholder="모든 대화의 시스템 규칙에 추가할 지침 (톤, 수위, 금지 등). 미성년자 관련 안전 규칙은 항상 강제됩니다." style={{ minHeight: 90 }} />
        <span className="hint">전 대화 공통으로 프롬프트 규칙에 삽입됩니다.</span>
      </div>
      <button className="btn sm block" onClick={save}>지침 저장</button>
    </>
  );
}

function LogoutButtons() {
  const ui = useUi();
  async function logout(all: boolean) {
    await post(all ? '/api/auth/logout-all' : '/api/auth/logout');
    ui.toast('로그아웃됨');
    setTimeout(() => window.location.assign('/'), 400);
  }
  return (
    <div className="row" style={{ gap: 8 }}>
      <button className="btn sm block" onClick={() => logout(false)}>로그아웃</button>
      <button className="btn sm danger block" onClick={() => logout(true)}>모든 기기 로그아웃</button>
    </div>
  );
}
