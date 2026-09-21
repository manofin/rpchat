import React from 'react';
import type { AlertSeverity, UiState } from '../../lib/sceneStatusCatalog';

export function AlertInline({
  message,
  severity = 'info',
  uiState = 'error',
}: {
  message?: string;
  severity?: AlertSeverity;
  uiState?: UiState;
}) {
  const banner = severity === 'error' ? 'banner err' : 'banner';
  return (
    <div
      className={`${banner} scene-alert-inline is-${uiState}`}
      data-catalog-type="AlertInline"
      data-ui-state={uiState}
      data-severity={severity}
      role="status"
    >
      {message || '오류가 발생했습니다.'}
    </div>
  );
}
