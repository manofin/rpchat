import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

// ---- 바텀 시트 ----
export function BottomSheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="handle" onClick={onClose} />
        {children}
      </div>
    </>
  );
}

// ---- 전체화면 모달(편집 폼용) ----
export function Modal({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  if (!open) return null;
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" style={{ maxHeight: '94%' }} role="dialog" aria-modal="true">
        <div className="handle" onClick={onClose} />
        <div className="row" style={{ padding: '0 14px 8px' }}>
          <strong style={{ flex: 1 }}>{title}</strong>
          <button className="btn ghost icon" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <div className="sheet-body" style={{ flex: 1 }}>{children}</div>
        {footer && <div className="row end" style={{ padding: '10px 14px', borderTop: '1px solid var(--bg-3)', gap: 8 }}>{footer}</div>}
      </div>
    </>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <div className="center" style={{ height: 'auto', padding: 24 }}><div className="muted small">{label ?? '불러오는 중…'}</div></div>;
}

// ---- 토스트 / 확인 다이얼로그 컨텍스트 ----
interface ToastCtx {
  toast: (msg: string, kind?: 'ok' | 'err' | 'warn') => void;
  confirm: (msg: string, opts?: { danger?: boolean; okLabel?: string }) => Promise<boolean>;
}
const Ctx = createContext<ToastCtx | null>(null);
export const useUi = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('UiProvider 필요');
  return c;
};

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; kind: string }>>([]);
  const [ask, setAsk] = useState<{ msg: string; danger?: boolean; okLabel?: string; resolve: (v: boolean) => void } | null>(null);
  const idRef = useRef(0);

  const toast = useCallback((msg: string, kind: 'ok' | 'err' | 'warn' = 'ok') => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const confirm = useCallback(
    (msg: string, opts?: { danger?: boolean; okLabel?: string }) => new Promise<boolean>((resolve) => setAsk({ msg, danger: opts?.danger, okLabel: opts?.okLabel, resolve })),
    [],
  );

  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 'calc(16px + var(--safe-bottom))', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', zIndex: 40, pointerEvents: 'none' }}>
        {toasts.map((t) => (
          <div key={t.id} className={`banner ${t.kind === 'err' ? 'err' : t.kind === 'warn' ? 'warn' : 'ok'}`} style={{ margin: 0, maxWidth: 360, boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>{t.msg}</div>
        ))}
      </div>
      {ask && (
        <>
          <div className="sheet-backdrop" style={{ zIndex: 50 }} onClick={() => { ask.resolve(false); setAsk(null); }} />
          <div className="card" style={{ position: 'fixed', top: '40%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 51, width: '90%', maxWidth: 360 }}>
            <div style={{ marginBottom: 14, whiteSpace: 'pre-wrap' }}>{ask.msg}</div>
            <div className="row end" style={{ gap: 8 }}>
              <button className="btn" onClick={() => { ask.resolve(false); setAsk(null); }}>취소</button>
              <button className={`btn ${ask.danger ? 'danger' : 'primary'}`} onClick={() => { ask.resolve(true); setAsk(null); }}>{ask.okLabel ?? '확인'}</button>
            </div>
          </div>
        </>
      )}
    </Ctx.Provider>
  );
}
