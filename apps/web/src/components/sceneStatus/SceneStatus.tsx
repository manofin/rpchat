import React, { type ReactNode } from 'react';
import type { SceneProgress, UiState } from '../../lib/sceneStatusCatalog';
import { EmptyHint } from './EmptyHint';
import { AlertInline } from './AlertInline';

const PROGRESS_LABEL: Record<SceneProgress, string> = {
  idle: '대기',
  active: '진행',
  paused: '일시정지',
  ended: '종료',
};

export function SceneStatus({
  title,
  progress = 'idle',
  summary,
  uiState = 'default',
  children,
}: {
  title?: string;
  progress?: SceneProgress;
  summary?: string;
  uiState?: UiState;
  children?: ReactNode;
}) {
  const hideCatalogChildren = uiState === 'loading' || uiState === 'empty';
  return (
    <div
      className={`scene-status is-${uiState}`}
      data-catalog-type="SceneStatus"
      data-ui-state={uiState}
      data-progress={progress}
    >
      <div className="scene-status-head">
        <strong className="scene-status-title">{title || '장면'}</strong>
        <span className="scene-status-progress">{PROGRESS_LABEL[progress]}</span>
      </div>
      {summary ? <p className="scene-status-summary">{summary}</p> : null}
      {uiState === 'loading' ? <EmptyHint message="장면을 불러오는 중…" uiState="loading" /> : null}
      {uiState === 'empty' ? <EmptyHint message="장면 정보가 없습니다." uiState="empty" /> : null}
      {uiState === 'error' ? <AlertInline message="장면을 불러오지 못했습니다." severity="error" uiState="error" /> : null}
      {uiState === 'refreshing' ? <div className="scene-status-refresh" aria-hidden="true" /> : null}
      {hideCatalogChildren ? null : <div className="scene-status-body">{children}</div>}
    </div>
  );
}
