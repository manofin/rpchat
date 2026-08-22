import { useState } from 'react';
import { post } from '../lib/api';

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!token.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await post('/api/auth/login', { token: token.trim() });
      onLoggedIn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <div style={{ fontSize: 44 }}>🎭</div>
      <h1 style={{ margin: 0 }}>RP Chat</h1>
      <div className="card">
        <div className="field">
          <label>접근 토큰</label>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="APP_TOKEN" autoFocus />
        </div>
        {err && <div className="banner err">{err}</div>}
        <button className="btn primary block" disabled={busy} onClick={submit}>{busy ? '확인 중…' : '로그인'}</button>
        <div className="small muted" style={{ marginTop: 10 }}>이 앱은 Tailscale 사설망 안에서만 접근하도록 설계되었습니다.</div>
      </div>
    </div>
  );
}
