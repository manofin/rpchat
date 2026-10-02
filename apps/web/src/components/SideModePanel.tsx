import { useState } from 'react';
import type { Message } from '../types';
import { sideModeLabel, type SideMode } from '../lib/responseControls';
import { MessageEvents } from './EventRenderer';
import { BottomSheet } from './ui';

export function SideModePanel({ open, mode, onModeChange, onClose, messages, loading, generating, disabled, error, onGenerate, onStop, onReload }: {
  open: boolean;
  mode: SideMode;
  onModeChange: (mode: SideMode) => void;
  onClose: () => void;
  messages: Message[];
  loading: boolean;
  generating: boolean;
  disabled: boolean;
  error: string | null;
  onGenerate: (mode: SideMode, prompt?: string) => Promise<boolean>;
  onStop: () => void;
  onReload: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  return <BottomSheet open={open} onClose={onClose}>
    <div className="sheet-body side-mode-panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>부가 모드</strong>
        <button className="btn ghost sm" onClick={onClose} aria-label="부가 모드 닫기">닫기</button>
      </div>
      <p className="small muted">본편 상태에 반영하지 않음 · 시간·장면·엔딩은 바뀌지 않습니다.</p>
      <p className="small muted">입력창에서 /요약 또는 /심층갤로도 실행할 수 있습니다. 귓속말 전송 설정은 적용하지 않습니다.</p>
      <div className="row" aria-label="부가 모드 선택">
        {(['summary', 'community'] as const).map((option) => <button key={option} type="button" className="btn sm" aria-pressed={mode === option} disabled={generating} onClick={() => onModeChange(option)}>{sideModeLabel(option)}</button>)}
      </div>
      <label className="field" style={{ marginTop: 12 }}>
        <span>추가 요청 (선택)</span>
        <textarea aria-label="부가 모드 추가 요청" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={2} maxLength={2000} disabled={generating} />
      </label>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {generating
          ? <button type="button" className="btn" onClick={onStop}>부가 모드 생성 중단</button>
          : <button type="button" className="btn primary" disabled={disabled || loading} onClick={() => void onGenerate(mode, prompt.trim() || undefined)}>{sideModeLabel(mode)} 생성</button>}
        <button type="button" className="btn ghost sm" disabled={generating} onClick={onReload}>저장된 결과 새로고침</button>
      </div>
      {loading ? <p role="status">저장된 결과를 불러오는 중…</p> : null}
      {error ? <p className="banner err" role="alert">{error}</p> : null}
      {!loading && messages.length === 0 ? <p className="muted">생성한 결과는 이곳에 따로 보관됩니다.</p> : null}
      <div className="side-mode-results" aria-label="부가 모드 결과" aria-live="polite">
        {[...messages].reverse().map((message) => <article key={message.id} className="card" style={{ padding: 12, marginTop: 12 }}>
          <strong>{sideModeLabel(message.meta.side_mode?.mode ?? 'summary')}</strong>
          <span className="small muted"> · {message.status === 'streaming' ? '생성 중' : message.status === 'complete' ? '완료' : message.status === 'interrupted' ? '중단됨' : '생성 실패'}</span>
          {message.meta.side_mode?.prompt ? <p className="small muted">요청: {message.meta.side_mode.prompt}</p> : null}
          <MessageEvents message={message} streaming={message.status === 'streaming'} />
          {message.meta.error ? <p className="banner err">{message.meta.error}</p> : null}
        </article>)}
      </div>
    </div>
  </BottomSheet>;
}
