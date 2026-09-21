import React from 'react';
import type { UiState } from '../../lib/sceneStatusCatalog';

export function EmptyHint({
  title,
  body,
  uiState = 'empty',
}: {
  title?: string;
  body?: string | null;
  uiState?: UiState;
}) {
  return (
    <div
      className={`empty-state compact scene-empty-hint is-${uiState}`}
      data-catalog-type="EmptyHint"
      data-ui-state={uiState}
    >
      <p className="empty-state-title">{title || '표시할 내용이 없습니다.'}</p>
      {body ? <p className="empty-state-sub">{body}</p> : null}
    </div>
  );
}
