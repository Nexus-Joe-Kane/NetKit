import type { LookupKind } from '@sw/shared';
import type { ReactElement } from 'react';

/**
 * Which kind of thing a lookup row is, at a glance.
 *
 * An office for a premises, a globe for a broadband service, a handset for a
 * mobile. Drawn rather than pulled from an icon font: three shapes is not
 * worth a dependency, and inline SVG inherits the row's colour so a
 * highlighted row's icon highlights with it.
 *
 * `aria-hidden`, with the kind spelled out in text beside it. An icon is a
 * shortcut for somebody who can see it and nothing at all otherwise.
 */
export function LookupIcon({ kind }: { kind: LookupKind }): ReactElement {
  const common = {
    width: 15,
    height: 15,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    className: 'lookup-icon',
  };

  if (kind === 'broadband') {
    // A globe: the internet, as every browser has drawn it for thirty years.
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12" />
        <path d="M8 2c1.9 2 1.9 10 0 12M8 2c-1.9 2-1.9 10 0 12" />
      </svg>
    );
  }

  if (kind === 'mobile') {
    // A handset, with the speaker slot so it is not mistaken for a card.
    return (
      <svg {...common}>
        <rect x="4.5" y="1.5" width="7" height="13" rx="1.6" />
        <path d="M6.8 3.6h2.4" />
        <path d="M8 12.2h.01" />
      </svg>
    );
  }

  // An office block: a premises, which is what the box was originally for.
  return (
    <svg {...common}>
      <path d="M2.5 14V4.2l5-2.2v12" />
      <path d="M7.5 6.4l6 1.6V14" />
      <path d="M2.5 14h11.5" />
      <path d="M4.4 6.6h1.2M4.4 9h1.2M4.4 11.4h1.2M9.6 9.6h1.8M9.6 11.8h1.8" />
    </svg>
  );
}

/** What to call each kind in text, since the icon says nothing on its own. */
export const KIND_LABEL: Record<LookupKind, string> = {
  address: 'Premises',
  broadband: 'Broadband',
  mobile: 'Mobile',
};
