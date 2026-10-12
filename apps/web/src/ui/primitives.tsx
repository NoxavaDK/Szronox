import type { ReactNode } from 'react';
import type { Priority } from '@szronox/contracts';
import type { EditorView } from './screen-contracts.js';
import { priorityColor, priorityLabel } from './tokens.js';
import { BroadcastIcon, CoverPictogramIcon, PlusIcon, WarningIcon } from './icons.js';
import styles from './primitives.module.css';

export function Avatar({ user, size = 28 }: { user: EditorView; size?: number }) {
  const initial = user.name.charAt(0);
  return (
    <span
      className={styles.avatar}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      role="img"
      aria-label={user.name}
    >
      {user.avatarUrl ? (
        <img className={styles.avatarImage} src={user.avatarUrl} alt="" />
      ) : (
        initial
      )}
    </span>
  );
}

type Tone = 'default' | 'quiet' | 'danger';

export function TextAction({
  children,
  onClick,
  disabled,
  tone = 'default',
  ariaLabel,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: Tone;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className ? `${styles.textAction} ${className}` : styles.textAction}
      data-tone={tone === 'default' ? undefined : tone}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  fullWidth,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  fullWidth?: boolean;
}) {
  return (
    <button
      type="button"
      className={styles.button}
      data-full-width={fullWidth ? 'true' : undefined}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/**
 * UI-02 semantic action button: one component for every emphasised action, so a role always
 * looks the same. `primary` = filled action colour, `attention` = amber tint with its own
 * wording, `danger` = filled red (final destructive confirmation), `quiet` = text action.
 */
export function ActionButton({
  children, onClick, tone = 'primary', disabled, className, ariaLabel,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: 'primary' | 'attention' | 'danger' | 'quiet';
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className={className ? `${styles.actionButton} ${className}` : styles.actionButton}
      data-tone={tone}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

const priorityGlyph: Record<Priority, string> = { urgent: '!', normal: '●', evergreen: '∞' };

/** Passive priority indicator (glyph + label) for metadata clusters and list rows. */
export function PriorityGlyph({ priority }: { priority: Priority }) {
  return (
    <span
      className={styles.priorityGlyph}
      style={{ color: priorityColor[priority] }}
      aria-hidden
    >
      {priorityGlyph[priority]}
    </span>
  );
}

const PRIORITIES: Priority[] = ['urgent', 'normal', 'evergreen'];

/** The Quick Add priority row: "! Pilne  ● Normalne  ∞ Evergreen" — not generic radio circles. */
export function PrioritySelector({
  value,
  onChange,
}: {
  value: Priority;
  onChange: (priority: Priority) => void;
}) {
  return (
    <div className={styles.prioritySelector} role="radiogroup" aria-label="Priorytet">
      {PRIORITIES.map((priority) => (
        <button
          key={priority}
          type="button"
          role="radio"
          aria-checked={value === priority}
          aria-pressed={value === priority}
          className={styles.prioritySelectorOption}
          style={{ color: value === priority ? priorityColor[priority] : undefined }}
          onClick={() => onChange(priority)}
        >
          <PriorityGlyph priority={priority} />
          {priorityLabel[priority]}
        </button>
      ))}
    </div>
  );
}

export function SectionRow({
  label,
  summary,
  expanded,
  onClick,
}: {
  label: string;
  summary?: ReactNode;
  expanded?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={styles.sectionRow} onClick={onClick} aria-expanded={expanded}>
      <span className={styles.sectionRowLabel}>{label}</span>
      <span className={styles.sectionRowRight}>
        {summary ? <span>{summary}</span> : null}
        <span className={expanded ? styles.sectionChevronOpen : styles.sectionChevron}><ChevronGlyph /></span>
      </span>
    </button>
  );
}

function ChevronGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M7.5 4.5 13 10l-5.5 5.5" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FloatingAddButton({ onClick, label = 'Dodaj' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className={styles.floatingAddButton} onClick={onClick} aria-label={label}>
      <PlusIcon size={22} />
    </button>
  );
}

export type BannerTone = 'loading' | 'empty' | 'offline' | 'error' | 'conflict';

export function StatusBanner({
  tone,
  message,
  actionLabel,
  onAction,
}: {
  tone: BannerTone;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className={styles.banner} data-tone={tone} role={tone === 'error' || tone === 'conflict' ? 'alert' : 'status'}>
      <div className={styles.bannerRow}>
        {tone === 'offline' || tone === 'error' || tone === 'conflict' ? <WarningIcon /> : null}
        <span>{message}</span>
      </div>
      {actionLabel && onAction ? (
        <TextAction onClick={onAction}>{actionLabel}</TextAction>
      ) : null}
    </div>
  );
}

export function AttentionStrip({ count, onClick }: { count: number; onClick: () => void }) {
  if (count <= 0) return null;
  return (
    <button type="button" className={styles.attentionStrip} onClick={onClick}>
      <WarningIcon size={13} /> {count} wymagają uwagi
    </button>
  );
}

/**
 * Feed-cover state: neutral pictogram = not ready, pictogram + check = ready.
 * No "OKŁ" text. Accessible name is always "Okładka do feedu" (frozen-visual-spec.md sec. 4).
 */
export function CoverIndicator({
  done,
  onClick,
  size = 20,
}: {
  done: boolean;
  onClick?: () => void;
  size?: number;
}) {
  const label = done ? 'Okładka do feedu: gotowa' : 'Okładka do feedu: brak';
  if (!onClick) {
    return (
      <span role="img" aria-label={label} style={{ color: done ? 'var(--sz-color-success)' : 'var(--sz-color-text-secondary)' }}>
        <CoverPictogramIcon size={size} done={done} />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{
        appearance: 'none',
        border: 'none',
        background: 'none',
        padding: 0,
        display: 'inline-flex',
        color: done ? 'var(--sz-color-success)' : 'var(--sz-color-text-secondary)',
        cursor: 'pointer',
        minWidth: 'var(--sz-touch-target)',
        minHeight: 'var(--sz-touch-target)',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <CoverPictogramIcon size={size} done={done} />
    </button>
  );
}

/**
 * STREAM-01 (D1): the stream marker, used identically in list rows, planner cards and the
 * Reel Detail title row — the icon is always paired with the word "Stream" (never alone,
 * since colour/icon-only signals are never the only cue). Accessible name is "Stream".
 */
export function StreamMarker({ className }: { className?: string }) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--sz-color-text-secondary)', flexShrink: 0 }}>
      <BroadcastIcon size={14} aria-hidden="true" />
      <span>Stream</span>
    </span>
  );
}

export function CompactTabs<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className={styles.compactTabs} role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={styles.compactTab}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
