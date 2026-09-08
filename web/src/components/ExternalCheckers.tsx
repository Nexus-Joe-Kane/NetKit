import type { ReactElement } from 'react';
import { Label } from './ui';

/**
 * Links out to the networks' own availability checkers.
 *
 * These exist because of a hard limit, not a missing feature: G.Network,
 * Community Fibre and Virgin Media will not tell you whether they can serve
 * a specific address without a wholesale agreement, and no data licence
 * covers per-premises serviceability for all of them. Their public checkers
 * *will* answer, in about ten seconds, if a person clicks.
 *
 * So rather than pretend, the panel hands the operator straight there with
 * the postcode already in the URL where the site supports it. It turns "ring
 * round four networks" into four clicks.
 *
 * Every link opens in a new tab: an operator mid-lookup should never lose
 * the site report they are working from.
 */

interface Checker {
  name: string;
  /** Why you would click this one rather than another. */
  hint: string;
  /**
   * Builds the URL. Only G.Network's postcode parameter is confirmed against
   * a live example, so it is the only one prefilled — sending a made-up
   * query string to the others risks a broken page, which is worse than one
   * extra paste.
   */
  href: (postcode: string) => string;
  prefills: boolean;
}

const CHECKERS: Checker[] = [
  {
    name: 'G.Network',
    hint: "London full fibre. The biggest alt-net we cannot see through any wholesale account — this is the only way to check it.",
    href: (postcode) => `https://www.g.network/address-checker?postcode=${encodeURIComponent(postcode)}`,
    prefills: true,
  },
  {
    name: 'Openreach',
    hint: 'Openreach’s own FTTP checker. A second opinion when our availability data looks wrong.',
    href: () => 'https://www.openreach.com/fibre-checker',
    prefills: false,
  },
  {
    name: 'Virgin Media',
    hint: 'Cable and nexfibre. Reachable through Giacom commercially, but their checker is quicker for a straight yes/no.',
    href: () => 'https://www.virginmedia.com/broadband/postcode-checker',
    prefills: false,
  },
  {
    name: 'Ofcom',
    hint: 'Every network at once, from Ofcom’s own data. Slower and less precise, but it names nobody wrongly.',
    href: () => 'https://checker.ofcom.org.uk/en-gb/broadband-coverage',
    prefills: false,
  },
];

export function ExternalCheckers({ postcode }: { postcode: string }): ReactElement {
  return (
    <div>
      <Label>Check a network directly</Label>
      <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 10px', maxWidth: 640 }}>
        These networks will not confirm a specific address through any account we hold. Their own checkers will, in
        seconds. Opens in a new tab — you will not lose this report.
      </p>
      <div className="search__examples" style={{ marginTop: 0 }}>
        {CHECKERS.map((checker) => (
          <a
            key={checker.name}
            className="btn btn--ghost btn--small"
            href={checker.href(postcode)}
            target="_blank"
            rel="noreferrer noopener"
            title={`${checker.hint}${checker.prefills ? ` Opens with ${postcode} filled in.` : ` You will need to paste ${postcode}.`}`}
          >
            {checker.name}
            <span aria-hidden="true" style={{ marginLeft: 5, opacity: 0.55 }}>
              ↗
            </span>
          </a>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 11.5, margin: '9px 0 0' }}>
        G.Network opens with the postcode filled in. The others need it pasted — it is on the clipboard button at the
        top of the report. Check you are on their <strong>business</strong> tab before quoting.
      </p>
    </div>
  );
}
