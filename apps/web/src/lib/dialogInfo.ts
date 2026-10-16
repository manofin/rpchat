import type { Message } from '../types';

export type DialogStateRow = { label: string; value: string };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function savedDialogStateRows(message: Pick<Message, 'role' | 'status'> & { meta?: Record<string, unknown> }): DialogStateRow[] {
  if (message.role !== 'assistant' || message.status !== 'complete' || message.meta?.block_kind !== 'info') return [];
  const snapshot = message.meta.scene_state;
  if (!object(snapshot) || snapshot.schema_version !== 1 || !object(snapshot.before_delta) || !object(snapshot.after_delta)) return [];
  const scene = snapshot.after_delta;
  if (scene.format !== 'dialog') return [];
  if (object(scene.adventure) && scene.adventure.version === 1) {
    const a = scene.adventure;
    return [
      { label: '소지금', value: `${a.balance} ${a.currency}` },
      { label: '등록', value: object(a.registration) ? `${a.registration.organization} 등록 완료` : '미등록' },
      { label: '경지·경험치', value: `${a.rank || '미정'} · ${a.experience}` },
    ];
  }
  if (!object(scene.user_sheet)) return [];
  const sheet = scene.user_sheet;
  const rows: DialogStateRow[] = [];
  for (const [key, label] of [['hp', '체력'], ['money', '소지금']] as const) {
    const value = sheet[key];
    if (value === null || (typeof value === 'number' && Number.isFinite(value))) {
      rows.push({ label, value: value === null ? '—' : String(value) });
    }
  }
  for (const [key, label] of [['gear', '장비'], ['inventory', '소지품'], ['traits', '능력']] as const) {
    const value = sheet[key];
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) continue;
    const items = value.map(item => item.trim()).filter(Boolean);
    rows.push({ label, value: items.length ? items.join(' · ') : '없음' });
  }
  const confirmedRoles = snapshot.confirmed_roles;
  if (Array.isArray(confirmedRoles) && confirmedRoles.every(item => typeof item === 'string')) {
    const items = confirmedRoles.map(item => item.trim()).filter(Boolean);
    if (items.length) rows.push({ label: '역할', value: items.join(' · ') });
  }
  return rows;
}
