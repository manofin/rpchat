import { useEffect, useState } from 'react';
import type { GenerationProgress } from '../types';

export function GenerationStatus({ progress }: { progress?: GenerationProgress | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const started = progress ? Date.parse(progress.startedAt) : NaN;
  const elapsed = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : null;
  const label = progress ? { queued: '대기 중', writing: '이야기 작성 중', validating: '비공개 내용 확인 중' }[progress.phase] : '진행 상태 확인 중';
  return <span>{label}{elapsed !== null ? ` · ${elapsed}초` : ''}</span>;
}
