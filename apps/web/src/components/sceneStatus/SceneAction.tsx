import React from 'react';
import type { SceneActionIntent, UiState } from '../../lib/sceneStatusCatalog';

export function SceneAction({
  label,
  intent,
  uiState = 'default',
  onIntent,
}: {
  label?: string;
  intent?: SceneActionIntent;
  uiState?: UiState;
  onIntent?: (intent: SceneActionIntent) => void;
}) {
  const disabled = uiState === 'disabled' || !intent;
  return (
    <button
      type="button"
      className={`scene-action is-${uiState}`}
      data-catalog-type="SceneAction"
      data-ui-state={uiState}
      data-intent={intent || ''}
      disabled={disabled}
      aria-disabled={disabled}
      onClick={() => {
        if (disabled || !intent) return;
        onIntent?.(intent);
      }}
    >
      {label || '열기'}
    </button>
  );
}
