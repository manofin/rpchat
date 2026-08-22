import type { ReactNode } from 'react';

export function Avatar({ name, avatar, size }: { name: string; avatar?: string | null; size?: 'sm' | 'lg' }) {
  const cls = `avatar${size ? ` ${size}` : ''}`;
  if (avatar) return <div className={cls}><img src={avatar} alt="" loading="lazy" /></div>;
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return <div className={cls} aria-hidden>{initial}</div>;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
}

/**
 * *별표* 강조를 지문(이탤릭)으로 렌더. 그 외는 평문.
 * 매우 단순한 파서 — 짝이 맞지 않는 별표는 평문으로 남긴다.
 */
export function renderContent(text: string): ReactNode {
  if (!text.includes('*')) return text;
  const parts: ReactNode[] = [];
  const re = /\*([^*\n]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<em key={key++}>{m[1]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
