import { useEffect, useState } from 'react';
import { DESKTOP_MQ, isDesktopLayout } from './chatLayout';

export function useDesktopLayout(): boolean {
  const [desktop, setDesktop] = useState(isDesktopLayout);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_MQ);
    const onChange = () => setDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    onChange();
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return desktop;
}
