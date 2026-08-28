import React, { useState } from 'react';
import { back } from '../lib/router';
import { SettingsPageHeader, SettingsPageLayout } from '../components/settings';
import { settingsBackFallback } from '../lib/conversationSettings';
import {
  applyFontPreset,
  parseFontPreset,
  persistFontPreset,
  readFontPreset,
  type FontPreset,
} from '../lib/conversationFont';

export { applyFontPreset, parseFontPreset };

export function StyleView({
  preset,
  onChange,
  onBack,
}: {
  preset: FontPreset;
  onChange: (next: FontPreset) => void;
  onBack: () => void;
}) {
  return (
    <SettingsPageLayout header={<SettingsPageHeader title="글꼴" onBack={onBack} />}>
      <section className="card settings-section-body" style={{ padding: 16 }}>
        <label className="sub" htmlFor="font-preset">
          글꼴
        </label>
        <select
          id="font-preset"
          className="input"
          value={preset}
          onChange={(e) => onChange(parseFontPreset(e.target.value))}
        >
          <option value="kami">kami</option>
          <option value="system">system</option>
        </select>
        <p className="sub">이 기기에만 적용됩니다. 웹폰트 엔진은 쓰지 않습니다.</p>
      </section>
    </SettingsPageLayout>
  );
}

export function ConversationStylePage({ conversationId }: { conversationId: string }) {
  const [preset, setPreset] = useState<FontPreset>(() => readFontPreset());
  const onBack = () => back(settingsBackFallback(conversationId, 'leaf'));

  function onChange(next: FontPreset) {
    setPreset(next);
    applyFontPreset(next);
    persistFontPreset(next);
  }

  return <StyleView preset={preset} onChange={onChange} onBack={onBack} />;
}
