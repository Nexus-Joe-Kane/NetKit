import { useCallback, useState, type ReactNode } from 'react';
import type { ReactElement } from 'react';

/** The small-caps field label used throughout the brand system. */
export function Label({ children }: { children: ReactNode }): ReactElement {
  return <span className="sw-label">{children}</span>;
}

export type ChipTone = 'ok' | 'warn' | 'crit' | 'info' | 'idle' | 'slate';

export function Chip({
  tone = 'idle',
  dot = false,
  children,
  title,
}: {
  tone?: ChipTone;
  dot?: boolean;
  children: ReactNode;
  title?: string;
}): ReactElement {
  return (
    <span className={`chip chip--${tone}`} {...(title ? { title } : {})}>
      {dot && <span className="chip__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Copy-to-clipboard button with a transient confirmation. */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }): ReactElement {
  const [done, setDone] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access can be refused; fall back to a hidden selection.
      const el = document.createElement('textarea');
      el.value = value;
      el.setAttribute('readonly', '');
      el.style.position = 'absolute';
      el.style.left = '-9999px';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  }, [value]);

  return (
    <button type="button" className={`copy${done ? ' copy--done' : ''}`} onClick={copy} title={`Copy ${value}`}>
      {done ? 'Copied' : label}
    </button>
  );
}

/** A labelled cell in a key/value grid. Renders an explicit absence. */
export function Cell({
  label,
  value,
  mono = false,
  copy = false,
}: {
  label: string;
  value?: string | number | null | boolean;
  mono?: boolean;
  copy?: boolean;
}): ReactElement {
  const present = value !== undefined && value !== null && value !== '';
  const text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value ?? '');
  return (
    <div className="kv__cell">
      <Label>{label}</Label>
      <div
        className={`kv__value${mono ? ' kv__value--mono' : ''}${present ? '' : ' kv__value--absent'}`}
        {...(present ? {} : { title: 'Not reported by the provider' })}
      >
        {present ? text : '—'}
        {present && copy && <CopyButton value={text} />}
      </div>
    </div>
  );
}

export function Card({
  title,
  eyebrow,
  index,
  accent,
  meta,
  tabs,
  flush = false,
  children,
}: {
  title: string;
  eyebrow?: string;
  /** Section number, mirroring how the brand guide numbers its sections. */
  index?: string;
  accent?: 1 | 2 | 3 | 4;
  meta?: ReactNode;
  /** A `Tabs` rail, rendered flush beneath the header. */
  tabs?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <section className={`card${accent ? ` card--accent-${accent}` : ''}`}>
      <header className="card__head">
        <div>
          {eyebrow && (
            <span className="sw-label section-eyebrow" {...(index ? { 'data-index': index } : {})}>
              {eyebrow}
            </span>
          )}
          <h2>{title}</h2>
        </div>
        {meta && <div className="card__head-meta">{meta}</div>}
      </header>
      {tabs}
      <div className={`card__body${flush ? ' card__body--flush' : ''}`}>{children}</div>
    </section>
  );
}

/**
 * A toggle switch. Shows state rather than an instruction, which matters in
 * a table where the same control repeats down a column.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  busy = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible name — the visible text is just On/Off. */
  label: string;
  busy?: boolean;
}): ReactElement {
  return (
    <label className="switch" onClick={(event) => event.stopPropagation()}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled || busy}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
      <span className="switch__label">{busy ? '…' : checked ? 'On' : 'Off'}</span>
    </label>
  );
}

export function Alert({
  tone,
  children,
}: {
  tone: 'error' | 'ok' | 'warn' | 'info';
  children: ReactNode;
}): ReactElement {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span>{children}</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }): ReactElement {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }): ReactElement {
  return (
    <span className="row" role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span className="muted">{label}</span>}
    </span>
  );
}

/**
 * A horizontal speed bar. Scaled against 1000 Mbps on a square-root curve so
 * the difference between 20 and 80 Mbps stays visible next to a gigabit line.
 */
export function SpeedBar({
  down,
  up,
  kind = 'copper',
}: {
  down?: number;
  up?: number;
  kind?: 'fibre' | 'copper' | 'cable';
}): ReactElement {
  if (down == null) return <span className="muted">—</span>;
  const pct = Math.max(3, Math.min(100, Math.sqrt(down / 1000) * 100));
  return (
    <span className="speed">
      <span className="speed__track">
        <span className={`speed__fill speed__fill--${kind}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="speed__value">
        {formatMbps(down)}
        {up != null && <span className="muted"> / {formatMbps(up)}</span>}
      </span>
    </span>
  );
}

export function formatMbps(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)} Gb`;
  return `${v % 1 === 0 ? v : v.toFixed(1)} Mb`;
}

export function formatDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** `1234567` → `1.23 GB`. */
export function formatBytes(bytes?: number): string | undefined {
  if (bytes == null) return undefined;
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

/** `86400` → `1 day`. */
export function formatDuration(seconds?: number): string | undefined {
  if (seconds == null) return undefined;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} day${days === 1 ? '' : 's'}${hours ? `, ${hours} hr` : ''}`;
  if (hours) return `${hours} hr${minutes ? ` ${minutes} min` : ''}`;
  return `${minutes} min`;
}
