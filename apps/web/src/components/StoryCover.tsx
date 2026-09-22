import type { CSSProperties } from 'react';
import { softHue } from './view';

export function StoryCover({ name, cover }: { name: string; cover?: string | null }) {
  return <div className={`story-cover${cover ? '' : ' is-empty'}`} style={{ '--story-hue': softHue(name) } as CSSProperties}>
    {cover ? <img src={cover} alt="" loading="lazy" /> : <span aria-hidden>📖</span>}
  </div>;
}
