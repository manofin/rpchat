import { useState } from 'react';
import {
  INJECT_INSTRUCTION_MAX,
  SHORTCUT_MAX,
  persistShortcuts,
  readShortcuts,
  removeShortcut,
  upsertShortcut,
  type ShortcutMode,
} from '../lib/shortcutMacro';
import { TopNav } from '../components/TopNav';
import { useUi } from '../components/ui';

/**
 * Global command hub — the only CRUD entry for A9 shortcuts.
 * Reuses readShortcuts/persistShortcuts (key rpchat.shortcuts). No new storage key.
 */
export function ShortcutsPage() {
  const ui = useUi();
  const [shortcuts, setShortcuts] = useState(() => readShortcuts());
  const [shortcutName, setShortcutName] = useState('');
  const [shortcutText, setShortcutText] = useState('');
  const [shortcutMode, setShortcutMode] = useState<ShortcutMode>('insert');

  function failToast(reason: string | undefined) {
    if (reason === 'inject_too_long') {
      ui.toast(`지침 주입 텍스트는 ${INJECT_INSTRUCTION_MAX}자를 넘을 수 없습니다`, 'err');
    } else if (reason === 'full' || shortcuts.length >= SHORTCUT_MAX) {
      ui.toast(`최대 ${SHORTCUT_MAX}개`, 'err');
    } else {
      ui.toast('이름과 텍스트를 확인하세요', 'err');
    }
  }

  return (
    <div className="screen">
      <TopNav />
      <div className="content">
        <div className="section-title" style={{ marginTop: 4 }}>명령어</div>
        <div className="small muted" style={{ marginBottom: 8 }}>
          입력창에서 <code>/이름</code> 을 치면 모드에 따라 동작합니다. <strong>입력창에 넣기</strong>는 텍스트로 치환되고, <strong>지침으로 주입</strong>은 메시지 본문에 넣지 않고 이번 턴 지침으로만 보냅니다. 보내기는 직접 합니다. 이 기기에만 저장됩니다 (최대 {SHORTCUT_MAX}개).
        </div>
        {shortcuts.map((s) => {
          const mode: ShortcutMode = s.mode === 'inject' ? 'inject' : 'insert';
          return (
            <div key={s.name} className="card" style={{ marginBottom: 8 }}>
              <div className="field"><label>/{s.name}</label>
                <textarea
                  value={s.text}
                  onChange={(e) => {
                    const next = upsertShortcut(shortcuts, s.name, e.target.value, mode);
                    if (!next.ok) {
                      if (next.reason === 'inject_too_long') {
                        ui.toast(`지침 주입 텍스트는 ${INJECT_INSTRUCTION_MAX}자를 넘을 수 없습니다`, 'err');
                      }
                      return;
                    }
                    setShortcuts(next.entries);
                    persistShortcuts(next.entries);
                  }}
                />
              </div>
              <div className="field"><label>모드</label>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button
                    className={`btn sm ${mode === 'insert' ? '' : 'ghost'}`}
                    type="button"
                    onClick={() => {
                      const next = upsertShortcut(shortcuts, s.name, s.text, 'insert');
                      if (!next.ok) return;
                      setShortcuts(next.entries);
                      persistShortcuts(next.entries);
                    }}
                  >입력창에 넣기</button>
                  <button
                    className={`btn sm ${mode === 'inject' ? '' : 'ghost'}`}
                    type="button"
                    onClick={() => {
                      const next = upsertShortcut(shortcuts, s.name, s.text, 'inject');
                      if (!next.ok) {
                        if (next.reason === 'inject_too_long') {
                          ui.toast(`지침 주입 텍스트는 ${INJECT_INSTRUCTION_MAX}자를 넘을 수 없습니다`, 'err');
                        }
                        return;
                      }
                      setShortcuts(next.entries);
                      persistShortcuts(next.entries);
                    }}
                  >지침으로 주입</button>
                </div>
                <div className="small muted" style={{ marginTop: 4 }}>
                  {mode === 'inject'
                    ? '보낼 때 본문에는 넣지 않고 inject_instruction 으로만 전달합니다.'
                    : '입력창 텍스트로 치환합니다 (기존 동작).'}
                </div>
              </div>
              <button
                className="btn ghost sm"
                type="button"
                onClick={() => {
                  const next = removeShortcut(shortcuts, s.name);
                  setShortcuts(next);
                  persistShortcuts(next);
                }}
              >이 명령어 빼기</button>
            </div>
          );
        })}
        {shortcuts.length < SHORTCUT_MAX && (
          <>
            <div className="field"><label>이름 (슬래시 없이)</label>
              <input value={shortcutName} onChange={(e) => setShortcutName(e.target.value)} maxLength={32} placeholder="예: 요약" />
            </div>
            <div className="field"><label>모드</label>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button
                  className={`btn sm ${shortcutMode === 'insert' ? '' : 'ghost'}`}
                  type="button"
                  onClick={() => setShortcutMode('insert')}
                >입력창에 넣기</button>
                <button
                  className={`btn sm ${shortcutMode === 'inject' ? '' : 'ghost'}`}
                  type="button"
                  onClick={() => setShortcutMode('inject')}
                >지침으로 주입</button>
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>
                {shortcutMode === 'inject'
                  ? `지침은 최대 ${INJECT_INSTRUCTION_MAX}자. 메시지 내용과 분리됩니다.`
                  : '입력창에 치환 텍스트를 넣습니다.'}
              </div>
            </div>
            <div className="field"><label>{shortcutMode === 'inject' ? '지침 텍스트' : '치환 텍스트'}</label>
              <textarea
                value={shortcutText}
                onChange={(e) => setShortcutText(e.target.value)}
                placeholder={shortcutMode === 'inject' ? '이번 턴에만 주입할 지침' : '입력창에 넣을 내용'}
              />
            </div>
            <button
              className="btn block"
              type="button"
              onClick={() => {
                const next = upsertShortcut(shortcuts, shortcutName, shortcutText, shortcutMode);
                if (!next.ok) {
                  failToast(next.reason);
                  return;
                }
                setShortcuts(next.entries);
                persistShortcuts(next.entries);
                setShortcutName('');
                setShortcutText('');
                setShortcutMode('insert');
              }}
            >＋ 명령어 추가</button>
          </>
        )}
      </div>
    </div>
  );
}
