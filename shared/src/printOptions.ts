import type { OpenreachDetail, SiteReport } from './types';

/**
 * What goes on the printed page.
 *
 * The printable report started as everything, always, which is fine for a
 * file copy and wrong for the two jobs people actually print for: a quote,
 * where a customer should see availability and not the neighbour's circuit,
 * and an engineer's job sheet, where nothing matters except the line and how
 * to find it.
 *
 * So it is a choice. Sections a report has no data for are offered as
 * unavailable rather than hidden, because "no mobile coverage was returned"
 * is itself worth knowing before you print.
 */

export type PrintSection =
  | 'identity'
  | 'headline'
  | 'options'
  | 'footprint'
  | 'predicted'
  | 'openreach'
  | 'signal'
  | 'lines'
  | 'nearbyLines';

export interface PrintSectionDef {
  id: PrintSection;
  label: string;
  /** One line on what it puts on the page. */
  hint: string;
  group: 'Premises' | 'Broadband' | 'Mobile' | 'Lines';
}

export const PRINT_SECTIONS: readonly PrintSectionDef[] = [
  { id: 'identity', label: 'Address details', hint: 'Full address, UPRN, postcode, premises type', group: 'Premises' },
  { id: 'headline', label: 'Best available', hint: 'The one-line summary of the fastest orderable option', group: 'Broadband' },
  { id: 'options', label: 'All options', hint: 'Every technology with speeds, status and product', group: 'Broadband' },
  { id: 'footprint', label: 'Other networks nearby', hint: 'Alt-nets in the area — not checked for this address', group: 'Broadband' },
  { id: 'predicted', label: 'Ofcom prediction', hint: "The regulator's own figure, naming no operator", group: 'Broadband' },
  { id: 'openreach', label: 'Openreach detail', hint: 'Exchange, cabinet, distance and flags', group: 'Broadband' },
  { id: 'signal', label: 'Mobile coverage', hint: 'Predicted voice and 4G per operator, indoor and out', group: 'Mobile' },
  { id: 'lines', label: 'Lines at this premises', hint: 'Services already in place', group: 'Lines' },
  {
    id: 'nearbyLines',
    label: 'Unmatched lines nearby',
    hint: 'Lines at the postcode that could not be tied to this premises',
    group: 'Lines',
  },
] as const;

/**
 * Whether the Openreach block has anything to put on a page.
 *
 * The object is often present but hollow -- the mapper builds it from
 * whatever the wholesale answer carried, and a thin answer leaves every
 * field undefined. Offering the tick anyway produced exactly the fault this
 * whole picker was meant to avoid: a section you can select that prints
 * nothing.
 */
export function hasOpenreachDetail(detail: OpenreachDetail | undefined): boolean {
  if (!detail) return false;
  return Boolean(
    detail.exchange?.name ||
      detail.exchange?.code ||
      detail.exchange?.tlc ||
      detail.exchange?.status ||
      detail.exchange?.distanceMetres != null ||
      detail.exchange?.wlrWithdrawalDate ||
      detail.exchange?.stopSellDate ||
      detail.cabinet?.id ||
      detail.cabinet?.technology ||
      detail.cabinet?.status ||
      detail.cabinet?.distanceMetres != null ||
      detail.fttp?.buildStatus ||
      detail.fttp?.rfsDate ||
      detail.fttp?.cbtId ||
      detail.fttp?.cbtSpareCapacity != null ||
      detail.fttp?.ontPresent !== undefined ||
      detail.fttp?.ontSerial ||
      detail.addressKey ||
      detail.alk ||
      detail.flags?.some((f) => f.level === 'critical' || f.level === 'warn'),
  );
}

/** Everything the report can actually fill in. */
export function availableSections(report: SiteReport): Set<PrintSection> {
  const out = new Set<PrintSection>(['identity']);
  const b = report.broadband;
  if (b?.headline) out.add('headline');
  if (b?.offers.some((o) => o.serviceability !== 'footprint')) out.add('options');
  if (b?.offers.some((o) => o.serviceability === 'footprint')) out.add('footprint');
  if (b?.predicted) out.add('predicted');
  if (hasOpenreachDetail(b?.openreach)) out.add('openreach');
  if (report.signal?.operators.length) out.add('signal');
  if (report.lines.length) out.add('lines');
  if (report.nearbyLines?.length) out.add('nearbyLines');
  return out;
}

/**
 * The default selection.
 *
 * Everything except the two that need a decision. A customer-facing print
 * should not carry the neighbour's circuits, and unmatched lines are a
 * diagnostic aid rather than part of the picture — so both are off until
 * asked for.
 */
export const DEFAULT_SECTIONS: readonly PrintSection[] = [
  'identity',
  'headline',
  'options',
  'predicted',
  'openreach',
  'signal',
  'lines',
];

export type PrintDensity = 'roomy' | 'normal' | 'tight';

/**
 * How tightly to set the page.
 *
 * A one-section print sitting in 12pt with generous leading reads as a
 * deliberate document; the same type with seven sections runs to three
 * sheets. So the density follows the count: few sections get room, many get
 * packed enough to land on one page.
 */
export function printDensity(sectionCount: number): PrintDensity {
  if (sectionCount <= 2) return 'roomy';
  if (sectionCount <= 4) return 'normal';
  return 'tight';
}
