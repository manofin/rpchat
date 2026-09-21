import React from 'react';
import type { CastMember, UiState } from '../../lib/sceneStatusCatalog';
import { EmptyHint } from './EmptyHint';

export function CastRow({
  members = [],
  uiState = 'default',
}: {
  members?: CastMember[];
  uiState?: UiState;
}) {
  if (!members.length) {
    return <EmptyHint message="등장 인물이 없습니다." uiState="empty" />;
  }
  return (
    <div
      className={`scene-cast-row is-${uiState}`}
      data-catalog-type="CastRow"
      data-ui-state={uiState}
      aria-label="장면 화자"
    >
      {members.map((m) => (
        <span
          key={m.id}
          className={`scene-cast-chip${m.presence === 'speaking' ? ' is-speaking' : ''}${m.presence === 'away' ? ' is-away' : ''}`}
          data-presence={m.presence || 'present'}
        >
          {m.name}
        </span>
      ))}
    </div>
  );
}
