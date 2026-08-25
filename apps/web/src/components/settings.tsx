import React, { type ReactNode } from 'react';
import { navigate } from '../lib/router';
import { applySceneImageToggle } from '../lib/conversationSettings';

export function SettingsPageLayout({
  header,
  children,
  footer,
}: {
  header: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="settings-screen">
      {header}
      <main className="settings-main">{children}</main>
      {footer ? <div className="settings-footer">{footer}</div> : null}
    </div>
  );
}

export function SettingsPageHeader({
  title,
  subtitle,
  avatar,
  onBack,
}: {
  title: string;
  subtitle?: string;
  avatar?: ReactNode;
  onBack: () => void;
}) {
  return (
    <header className="settings-header">
      <button type="button" className="btn ghost icon" onClick={onBack} aria-label="뒤로">‹</button>
      {avatar}
      <div className="title">
        <h1 className="settings-title">{title}</h1>
        {subtitle ? <div className="sub">{subtitle}</div> : null}
      </div>
    </header>
  );
}

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h2 className="section-title">{title}</h2>
      <div className="card settings-section-body">{children}</div>
    </section>
  );
}

export function SettingsBadge({ children }: { children: ReactNode }) {
  return <span className="settings-badge">{children}</span>;
}

export function SettingsNavigationRow({
  title,
  value,
  href,
  disabled,
  onNavigate,
}: {
  title: string;
  value?: string;
  href?: string;
  disabled?: boolean;
  onNavigate?: (href: string) => void;
}) {
  const go = () => {
    if (disabled || !href) return;
    if (onNavigate) onNavigate(href);
    else navigate(href);
  };
  return (
    <button
      type="button"
      className={`settings-row${disabled ? ' settings-row-disabled' : ''}`}
      style={{ minHeight: 44 }}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-label={value ? `${title}, ${value}` : title}
      onClick={go}
    >
      <span className="settings-row-title">{title}</span>
      {value ? <SettingsBadge>{value}</SettingsBadge> : null}
      {disabled ? <span className="settings-row-status">미연결</span> : <span className="settings-chevron" aria-hidden="true">›</span>}
    </button>
  );
}

export function SettingsToggleRow({
  title,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={title}
      disabled={disabled}
      className={`settings-row${disabled ? ' settings-row-disabled' : ''}`}
      onClick={() => {
        if (disabled) return;
        applySceneImageToggle();
        onChange?.(!checked);
      }}
    >
      <span className="settings-row-title">{title}</span>
      <span className="settings-switch" aria-hidden="true" />
      {disabled ? <span className="settings-row-status">미연결</span> : null}
    </button>
  );
}

export function SettingsValueRow({ title, value }: { title: string; value?: string }) {
  return (
    <div className="settings-row" style={{ minHeight: 44 }}>
      <span className="settings-row-title">{title}</span>
      {value ? <span className="settings-row-value">{value}</span> : null}
    </div>
  );
}

export function SettingsBottomAction({ children }: { children: ReactNode }) {
  return <div className="settings-footer-action">{children}</div>;
}

export function SettingsEmptyState({ message }: { message: string }) {
  return <div className="settings-empty">{message}</div>;
}
