import { useEffect, useState } from 'react';

/**
 * Android Chrome 가상 키보드 대응.
 * 1차: <meta viewport interactive-widget=resizes-content> 로 레이아웃 뷰포트 자체가 줄어든다.
 * 2차(삼성 인터넷 등 미지원 브라우저): visualViewport 높이를 --app-height 로 내려보내 화면 컨테이너가 따라가게 한다.
 */
export function useVisualViewport(): { keyboardOpen: boolean } {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    const apply = () => {
      const h = vv ? vv.height : window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${Math.round(h)}px`);
      const open = vv ? window.innerHeight - vv.height > 120 : false;
      setKeyboardOpen(open);
      if (vv && vv.offsetTop > 0) window.scrollTo(0, 0); // 키보드로 밀린 뷰포트 복귀
    };
    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    return () => {
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
    };
  }, []);
  return { keyboardOpen };
}
