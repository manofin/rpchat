import React from 'react';
import type { UiState } from '../../lib/sceneStatusCatalog';

export function EmptyHint({
  message,
  uiState = 'empty',
}: {
  message?: string;
  uiState?: UiState;
}) {
  return (
    <div
      className={`empty-state compact scene-empty-hint is-${uiState}`}
      data-catalog-type="EmptyHint"
      data-ui-state={uiState}
    >
      <p className="empty-state-sub">{message || '표시할 내용이 없습니다.'}</p>
    </div>
  );
}
