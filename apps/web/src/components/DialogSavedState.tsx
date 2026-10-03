import { savedDialogStateRows } from '../lib/dialogInfo';
import type { Message } from '../types';

export function DialogSavedState({ message }: { message: Pick<Message, 'role' | 'status'> & { meta?: Record<string, unknown> } }) {
  const rows = savedDialogStateRows(message);
  if (!rows.length) return null;
  return <section className="beat-info" aria-label="저장된 사용자 상태">
    <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '4px 12px' }}>
      {rows.map(row => <div key={row.label} style={{ display: 'contents' }}>
        <dt>{row.label}</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{row.value}</dd>
      </div>)}
    </dl>
  </section>;
}
