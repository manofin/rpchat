import { useEffect, useState } from 'react';
import { get } from './lib/api';
import { UNAUTHORIZED_EVENT } from './lib/api';
import { match, useRoute } from './lib/router';
import { SearchPage } from './pages/SearchPage';
import { useVisualViewport } from './lib/viewport';
import { Spinner, UiProvider } from './components/ui';
import { HomePage } from './pages/HomePage';
import { CharacterPage } from './pages/CharacterPage';
import { ChatPage } from './pages/ChatPage';
import { SettingsPage } from './pages/SettingsPage';
import { LoginPage } from './pages/LoginPage';

interface Me {
  mode: 'tailscale' | 'token' | 'none';
  authenticated: boolean;
  login?: string;
}

export default function App() {
  useVisualViewport();
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  async function checkAuth() {
    try {
      const m = await get<Me>('/api/auth/me');
      setMe(m);
    } catch {
      setMe({ mode: 'token', authenticated: false });
    } finally {
      setChecked(true);
    }
  }
  useEffect(() => {
    checkAuth();
    const onUnauth = () => setMe((m) => (m ? { ...m, authenticated: false } : { mode: 'token', authenticated: false }));
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauth);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauth);
  }, []);

  if (!checked) return <UiProvider><Spinner label="시작하는 중…" /></UiProvider>;

  // token 모드에서 미인증이면 로그인. tailscale/none 은 서버가 판정하며, 미인증이면 안내만.
  if (me && !me.authenticated) {
    if (me.mode === 'token') return <UiProvider><LoginPage onLoggedIn={checkAuth} /></UiProvider>;
    return (
      <UiProvider>
        <div className="center">
          <div style={{ fontSize: 40 }}>🔒</div>
          <h1 style={{ margin: 0 }}>접근 불가</h1>
          <div className="card">
            <div className="small">
              {me.mode === 'tailscale'
                ? 'Tailscale Serve 를 통해, 허용된 계정으로 접속해야 합니다. 현재 신원이 확인되지 않았습니다.'
                : '서버 접근이 허용되지 않았습니다.'}
            </div>
            <button className="btn block" style={{ marginTop: 12 }} onClick={checkAuth}>다시 확인</button>
          </div>
        </div>
      </UiProvider>
    );
  }

  return (
    <UiProvider>
      <Router />
    </UiProvider>
  );
}

function Router() {
  const path = useRoute();
  const chat = match(path, '/chat/:id');
  if (chat) return <ChatPage id={chat.id} />;
  const character = match(path, '/character/:id');
  if (character) return <CharacterPage id={character.id} />;
  if (match(path, '/search')) return <SearchPage />;
  if (match(path, '/settings')) return <SettingsPage />;
  return <HomePage />;
}
