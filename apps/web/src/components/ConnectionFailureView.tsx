import React from 'react';

export function ConnectionFailureView({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="center">
      <div style={{ fontSize: 40 }}>⚠</div>
      <h1 style={{ margin: 0 }}>연결 실패</h1>
      <div className="card">
        <div className="small">서버에 연결할 수 없습니다</div>
        <button className="btn block" style={{ marginTop: 12 }} onClick={onRetry}>다시 시도</button>
      </div>
    </div>
  );
}
