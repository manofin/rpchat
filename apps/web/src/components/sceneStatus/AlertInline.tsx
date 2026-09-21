import React from 'react';
import type { AlertTone, UiState } from '../../lib/sceneStatusCatalog';

export function AlertInline({
  message,
  tone = 'info',
  actionLabel,
  uiState = 'error',
}: {
  message?: string;
  tone?: AlertTone;
  actionLabel?: string;
  uiState?: UiState;
}) {
  const banner = tone === 'error' ? 'banner err' : tone === 'warn' ? 'banner warn' : 'banner';
  return (
    <div
      className={`${banner} scene-alert-inline is-${uiState}`}
      data-catalog-type="AlertInline"
      data-ui-state={uiState}
      data-tone={tone}
      role="status"
    >
      <span>{message || '오류가 발생했습니다.'}</span>
      {actionLabel ? <span className="scene-alert-action">{actionLabel}</span> : null}
    </div>
  );
}
