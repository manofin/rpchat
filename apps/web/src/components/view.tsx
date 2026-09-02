import type { ReactNode } from 'react';

export function Avatar({ name, avatar, size }: { name: string; avatar?: string | null; size?: 'sm' | 'lg' }) {
  const cls = `avatar${size ? ` ${size}` : ''}`;
  if (avatar) return <div className={cls}><img src={avatar} alt="" loading="lazy" /></div>;
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return <div className={cls} aria-hidden>{initial}</div>;
}

/** F9F — party speaker header. Bubble + renderContent stay on MessageView. */
export function SpeakerHeader({ name, avatar }: { name: string; avatar?: string | null }) {
  return (
    <div className="speaker-header">
      <Avatar name={name} avatar={avatar} size="sm" />
      <span className="speaker-name">{name}</span>
    </div>
  );
}

/**
 * f9-swap-passes — the §6 blocks the server assembles.
 *
 * These are presentational only. Order comes from `beat_seq`, the roster chips and
 * numbers come from the `ui` block's JSON, and the portrait comes from
 * `meta.image_url` — a path the server picked from emotion × outfit. The client
 * never parses a header, a chip or an image out of generated prose, which is the
 * whole reason S1 shipped before any of this.
 */
export function BeatHeader({ text }: { text: string }) {
  return <div className="beat-header">{text}</div>;
}

export function BeatNarration({ text }: { text: string }) {
  return <div className="beat-narration">{text}</div>;
}

export function BeatThought({ name, text }: { name: string; text: string }) {
  return (
    <div className="beat-thought">
      <span className="beat-thought-mark">💭</span>
      <span className="beat-thought-who">{name}</span>
      <span className="beat-thought-text">{text}</span>
    </div>
  );
}

export type BeatUiData = {
  location_badge?: string | null;
  user_sheet?: {
    hp?: number | null; money?: number | null;
    gear?: string[]; inventory?: string[]; traits?: string[];
  } | null;
  roster?: Array<{ id: string; name: string; chip: string; locked: boolean; in_room: boolean }>;
  intent_hint?: string | null;
};

/** Parses the `ui` block payload. A damaged payload renders nothing, never a crash. */
export function parseBeatUi(content: string): BeatUiData | null {
  try {
    const v: unknown = JSON.parse(content);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as BeatUiData) : null;
  } catch {
    return null;
  }
}

export function BeatUiPanel({ ui }: { ui: BeatUiData }) {
  const sheet = ui.user_sheet;
  const stats: string[] = [];
  if (sheet) {
    if (typeof sheet.hp === 'number') stats.push(`HP ${sheet.hp}`);
    if (typeof sheet.money === 'number') stats.push(`₩ ${sheet.money.toLocaleString()}`);
    for (const g of sheet.gear ?? []) stats.push(g);
  }
  return (
    <div className="beat-ui">
      {ui.location_badge ? <span className="beat-ui-badge">{ui.location_badge}</span> : null}
      {stats.length ? <span className="beat-ui-stats">{stats.join(' · ')}</span> : null}
      {ui.roster?.length ? (
        <span className="beat-ui-roster">
          {ui.roster.map((r) => (
            <span key={r.id} className={`beat-chip ${r.locked ? 'locked' : ''}`} title={r.name}>
              {r.chip} {r.name}
            </span>
          ))}
        </span>
      ) : null}
      {ui.intent_hint ? <span className="beat-ui-hint">{ui.intent_hint}</span> : null}
    </div>
  );
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
