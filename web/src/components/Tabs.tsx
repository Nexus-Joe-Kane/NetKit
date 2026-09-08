import { useId, useRef, type ReactElement, type ReactNode } from 'react';

/**
 * Tab strip.
 *
 * Two levels — `primary` (segmented control) and `sub` (underline rail) — so
 * nesting is always legible. Keyboard behaviour follows the WAI-ARIA tabs
 * pattern: arrows move between tabs, Home and End jump to the ends.
 */

export interface TabDef<T extends string> {
  id: T;
  label: string;
  /** Shown as a small pill after the label. Zero and undefined are hidden. */
  count?: number;
  /**
   * Colours the active underline — used to flag a section with a problem.
   *
   * `warn` earns its place next to `crit`: a barred SIM needs looking at and
   * one over its allowance costs money, and flagging both the same red makes
   * neither mean anything.
   */
  tone?: 'crit' | 'warn';
  disabled?: boolean;
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  variant = 'primary',
  label,
}: {
  tabs: ReadonlyArray<TabDef<T>>;
  active: T;
  onChange: (id: T) => void;
  variant?: 'primary' | 'sub';
  label: string;
}): ReactElement {
  const groupId = useId();
  const refs = useRef(new Map<T, HTMLButtonElement>());

  const move = (from: T, delta: number) => {
    const enabled = tabs.filter((t) => !t.disabled);
    const index = enabled.findIndex((t) => t.id === from);
    if (index < 0) return;
    const next = enabled[(index + delta + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.id);
    refs.current.get(next.id)?.focus();
  };

  const jump = (to: 'first' | 'last') => {
    const enabled = tabs.filter((t) => !t.disabled);
    const target = to === 'first' ? enabled[0] : enabled[enabled.length - 1];
    if (!target) return;
    onChange(target.id);
    refs.current.get(target.id)?.focus();
  };

  return (
    <div className={`tabs tabs--${variant}`} role="tablist" aria-label={label}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${groupId}-${tab.id}`}
            className="tab"
            aria-selected={selected}
            aria-controls={`${groupId}-${tab.id}-panel`}
            // Only the active tab is in the tab order; arrows move within.
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            {...(tab.tone ? { 'data-tone': tab.tone } : {})}
            ref={(node) => {
              if (node) refs.current.set(tab.id, node);
              else refs.current.delete(tab.id);
            }}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                move(tab.id, 1);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                move(tab.id, -1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                jump('first');
              } else if (event.key === 'End') {
                event.preventDefault();
                jump('last');
              }
            }}
          >
            {tab.label}
            {tab.count ? <span className="tab__count">{tab.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** The panel a tab controls. Keeps the aria wiring in one place. */
export function TabPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div role="tabpanel" tabIndex={-1} className={`tabpanel${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}
