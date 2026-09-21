import React from 'react';
import type { SceneActionIntent, SceneActionItem, UiState } from '../../lib/sceneStatusCatalog';

export function SceneAction({
  actions = [],
  uiState = 'default',
  onIntent,
}: {
  actions?: SceneActionItem[];
  uiState?: UiState;
  onIntent?: (intent: SceneActionIntent) => void;
}) {
  if (!actions.length) return null;
  return (
    <div
      className={`scene-action-row is-${uiState}`}
      data-catalog-type="SceneAction"
      data-ui-state={uiState}
    >
      {actions.map((a) => {
        const disabled = uiState === 'disabled' || a.enabled === false || !a.intent;
        return (
          <button
            key={a.id}
            type="button"
            className={`scene-action is-${uiState}`}
            data-intent={a.intent}
            disabled={disabled}
            aria-disabled={disabled}
            onClick={() => {
              if (disabled || !a.intent) return;
              onIntent?.(a.intent);
            }}
          >
            {a.label || '열기'}
          </button>
        );
      })}
    </div>
  );
}
