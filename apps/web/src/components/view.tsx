import type { CSSProperties, ReactNode } from 'react';

export function Avatar({ name, avatar, size }: { name: string; avatar?: string | null; size?: 'sm' | 'lg' }) {
  const cls = `avatar${size ? ` ${size}` : ''}`;
  if (avatar) return <div className={cls}><img src={avatar} alt="" loading="lazy" /></div>;
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return <div className={cls} aria-hidden>{initial}</div>;
}

export function SpeakerHeader({ name, avatar, focused }: { name: string; avatar?: string | null; focused?: boolean }) {
  return (
    <div className={`speaker-header${focused ? ' is-focus' : ''}`}>
      <Avatar name={name} avatar={avatar} size="sm" />
      <span className="speaker-name">{name}</span>
      {focused ? <span className="speaker-focus-tag">포커스</span> : null}
    </div>
  );
}

export type BeatUiData = {
  location_badge?: string | null;
  user_sheet?: {
    hp?: number | null; money?: number | null;
    gear?: string[]; inventory?: string[]; traits?: string[];
  } | null;
  custom_stats?: Array<{ label: string; value: number }>;
  roster?: Array<{ id: string; name: string; chip: string; locked: boolean; in_room: boolean }>;
  intent_hint?: string | null;
  focus_id?: string | null;
};

export function BeatUiPanel({ ui }: { ui: BeatUiData }) {
  const sheet = ui.user_sheet;
  const stats: string[] = [];
  if (sheet) {
    if (typeof sheet.hp === 'number') stats.push(`HP ${sheet.hp}`);
    if (typeof sheet.money === 'number') stats.push(`₩ ${sheet.money.toLocaleString()}`);
    if (sheet.gear?.length) stats.push(`장비 ${sheet.gear.join(', ')}`);
    if (sheet.inventory?.length) stats.push(`보유 ${sheet.inventory.join(', ')}`);
    if (sheet.traits?.length) stats.push(`특수 ${sheet.traits.join(', ')}`);
  }
  for (const s of ui.custom_stats ?? []) {
    if (typeof s.value === 'number' && s.label) stats.push(`${s.label} ${s.value}`);
  }
  const badge = typeof ui.location_badge === 'string' ? ui.location_badge.trim() : ui.location_badge;
  const hasStrip = Boolean(badge || stats.length);
  const hasRoster = Boolean(ui.roster?.length);
  if (!hasStrip && !hasRoster && !ui.intent_hint) return null;
  return (
    <div className="beat-ui beat-ui-panel">
      {hasStrip ? (
        <div className="beat-ui-strip">
          {badge ? <span className="beat-ui-badge">{badge}</span> : null}
          {stats.length ? <span className="beat-ui-stats">{stats.join(' · ')}</span> : null}
        </div>
      ) : null}
      {hasRoster ? (
        <div className="beat-ui-roster">
          {(ui.roster ?? []).map((r) => {
            const isFocus = Boolean(ui.focus_id && r.id === ui.focus_id);
            const label = `${r.name}${r.locked ? ' 잠금' : ''}${isFocus && !r.locked ? ' 포커스' : ''}`;
            return (
              <span
                key={r.id}
                className={`beat-chip${r.locked ? ' locked' : ''}${isFocus && !r.locked ? ' is-focus' : ''}`}
                title={label}
                aria-label={label}
              >
                {r.chip} {r.name}
                {r.locked ? <span className="beat-chip-tag">잠금</span> : null}
                {isFocus && !r.locked ? <span className="beat-chip-tag">포커스</span> : null}
              </span>
            );
          })}
        </div>
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

/** Soft hue 0–359 from name — Stable placeholder color without hardcoding per card. */
export function softHue(name: string): number {
  let h = 0;
  const s = name || '?';
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/**
 * StoryForge-style discovery cover: avatar as cover when present,
 * otherwise soft wash + glyph/initial with name overlay (not a huge letter tile).
 */
export function DiscCover({
  name,
  avatar,
  kind = 'character',
}: {
  name: string;
  avatar?: string | null;
  kind?: 'character' | 'story';
}) {
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const hue = softHue(name);
  return (
    <div
      className={`disc-cover${kind === 'story' ? ' is-story' : ''}`}
      style={{ '--disc-hue': String(hue) } as CSSProperties}
    >
      {avatar ? (
        <img className="disc-cover-img" src={avatar} alt="" loading="lazy" />
      ) : (
        <div className="disc-cover-soft" aria-hidden>
          <span className="disc-cover-glyph">{kind === 'story' ? '📖' : initial}</span>
        </div>
      )}
      <div className="disc-cover-scrim">
        <div className="disc-card-name">{name}</div>
      </div>
    </div>
  );
}
