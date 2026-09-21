import React, { useState } from 'react';
import type { Scene } from '../../types';
import type { SceneActionIntent } from '../../lib/sceneStatusCatalog';
import { buildSceneStatusSpec } from '../../lib/sceneStatusSpec';
import { SceneStatusRenderer } from './SceneStatusRenderer';

export function SceneStatusPanel({
  conversationId,
  scene,
  characterName,
  hasBeatRoster,
  focusId,
  generating,
  loadError,
  conversationEnded,
  placement,
  onIntent,
}: {
  conversationId: string;
  scene: Scene;
  characterName?: string;
  hasBeatRoster: boolean;
  focusId?: string | null;
  generating?: boolean;
  loadError?: string | null;
  conversationEnded?: boolean;
  placement: 'desktop' | 'mobile';
  onIntent?: (intent: SceneActionIntent) => void;
}) {
  const spec = buildSceneStatusSpec({
    conversationId,
    scene,
    characterName,
    hasBeatRoster,
    focusId,
    generating,
    loadError,
    conversationEnded,
  });
  const uiState = String(spec.elements[spec.root]?.props.uiState || 'default');
  const title = String(spec.elements[spec.root]?.props.title || '장면');
  const placeEl = Object.values(spec.elements).find((el) => el.type === 'LocationPill');
  const place = typeof placeEl?.props.name === 'string' ? placeEl.props.name : '';
  const [open, setOpen] = useState(false);
  const collapsed = placement === 'mobile' && !open;

  return (
    <section
      className={`scene-status-panel is-${uiState} is-${placement}${collapsed ? ' is-collapsed' : ' is-expanded'}`}
      data-test="scene-status-panel"
      data-placement={placement}
      data-ui-state={uiState}
      aria-label="장면 상태"
    >
      {placement === 'mobile' ? (
        <button
          type="button"
          className="scene-status-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="scene-status-toggle-title">{title}</span>
          {place ? <span className="scene-status-toggle-place">{place}</span> : null}
        </button>
      ) : null}
      {collapsed ? null : <SceneStatusRenderer spec={spec} onIntent={onIntent} />}
    </section>
  );
}
