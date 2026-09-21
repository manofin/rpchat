import React from 'react';
import type { UiState } from '../../lib/sceneStatusCatalog';
import { EmptyHint } from './EmptyHint';

export function LocationPill({
  name,
  traversable,
  uiState = 'default',
}: {
  name?: string;
  traversable?: boolean | null;
  uiState?: UiState;
}) {
  const text = (name || '').trim();
  if (!text) return <EmptyHint title="위치가 없습니다." uiState="empty" />;
  return (
    <span
      className={`scene-location-pill is-${uiState}`}
      data-catalog-type="LocationPill"
      data-ui-state={uiState}
      data-traversable={traversable === true ? 'true' : traversable === false ? 'false' : 'unknown'}
    >
      {text}
    </span>
  );
}
