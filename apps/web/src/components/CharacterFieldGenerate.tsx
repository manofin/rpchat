import type { AuthoringTargetField } from '../lib/characterGenerate';
import { AUTHORING_FIELD_LABELS } from '../lib/characterGenerate';

export function AuthoringDraftButton({
  field,
  disabled,
  onOpen,
}: {
  field: AuthoringTargetField;
  disabled?: boolean;
  onOpen: (field: AuthoringTargetField) => void;
}) {
  return (
    <button
      type="button"
      className="btn sm ghost"
      disabled={disabled}
      onClick={() => onOpen(field)}
    >
      초안
    </button>
  );
}

export function AuthoringGeneratePanel({
  field,
  busy,
  prompt,
  preview,
  hasExisting,
  onPrompt,
  onGenerate,
  onReplace,
  onAppend,
  onInsert,
  onClose,
}: {
  field: AuthoringTargetField;
  busy: boolean;
  prompt: string;
  preview: string | null;
  hasExisting: boolean;
  onPrompt: (value: string) => void;
  onGenerate: () => void;
  onReplace: () => void;
  onAppend: () => void;
  onInsert: () => void;
  onClose: () => void;
}) {
  return (
    <div className="banner" role="region" aria-label="필드 초안 생성" aria-busy={busy}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <strong>{AUTHORING_FIELD_LABELS[field]} 초안</strong>
        <button type="button" className="btn ghost sm" disabled={busy} onClick={onClose}>닫기</button>
      </div>
      <label className="hint" style={{ display: 'block', marginTop: 8 }}>지시</label>
      <textarea
        value={prompt}
        onChange={(e) => onPrompt(e.target.value)}
        maxLength={2000}
        disabled={busy}
        placeholder="이 필드에 넣고 싶은 방향"
        style={{ minHeight: 72, marginTop: 4 }}
      />
      <div className="row" style={{ marginTop: 8, gap: 8 }}>
        <button type="button" className="btn sm primary" disabled={busy || !prompt.trim()} onClick={onGenerate}>
          {busy ? '생성 중…' : '생성'}
        </button>
      </div>
      {preview != null ? (
        <>
          <div className="hint" style={{ marginTop: 10 }}>미리보기</div>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{preview}</div>
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            {hasExisting ? (
              <>
                <button type="button" className="btn sm" disabled={busy} onClick={onReplace}>대체</button>
                <button type="button" className="btn sm" disabled={busy} onClick={onAppend}>덧붙이기</button>
              </>
            ) : (
              <button type="button" className="btn sm primary" disabled={busy} onClick={onInsert}>넣기</button>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
