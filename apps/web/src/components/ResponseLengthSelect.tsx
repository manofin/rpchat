import type { ResponseLength } from '../types';
import { RESPONSE_LENGTHS } from '../lib/responseControls';

export function ResponseLengthSelect({ value, disabled, onChange }: {
  value: ResponseLength;
  disabled?: boolean;
  onChange: (value: ResponseLength) => void;
}) {
  return <label className="field">
    <span>응답 길이</span>
    <select aria-label="응답 길이" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as ResponseLength)}>
      {RESPONSE_LENGTHS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <span className="hint">다음 응답부터 적용됩니다. 길게 쓰면 대화 맥락에 쓸 여유가 줄어듭니다. 출력/톤 프로필은 유지합니다.</span>
  </label>;
}
