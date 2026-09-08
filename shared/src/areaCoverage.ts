/**
 * Area-level mobile coverage, from Ofcom's Connected Nations files.
 *
 * This exists because Ofcom publish no postcode-level mobile file and, until
 * the mobile API request comes back, the dataset is the only free source. It
 * is a genuinely weaker answer than a per-address check and the types say so
 * rather than letting it pass for one.
 *
 * Two limitations, both structural:
 *
 * 1. **It is an area, not an address.** The finest Ofcom publish is a
 *    parliamentary constituency — tens of thousands of premises. "97% of
 *    premises here have indoor 4G" says nothing certain about this doorstep.
 * 2. **It counts networks, it does not name them.** The columns are
 *    "how many of the four operators cover this", so the file cannot answer
 *    "does EE work here". Anything claiming otherwise from this source would
 *    be inventing it.
 */

export type CoverageTechnology = '2G' | '3G' | '4G' | '5G';
export type CoverageMeasure = 'premises' | 'geographic';
export type CoveragePlacement = 'indoor' | 'outdoor';

/** Percentage of the area covered by exactly this many operators. */
export interface CoverageBand {
  /** 0 to 4. Four is every network. */
  operators: number;
  percent: number;
}

export interface AreaCoverageRow {
  technology: CoverageTechnology;
  measure: CoverageMeasure;
  placement: CoveragePlacement;
  /**
   * Ofcom's confidence qualifier, on the 5G rows only.
   *
   * They publish 5G twice — "high confidence" and "very high confidence" —
   * because the prediction is less certain than for 4G. Both are kept and
   * labelled. Picking one would be choosing a number on the reader's behalf,
   * and it is always the optimistic one that gets picked.
   */
  confidence?: 'high' | 'very-high';
  /** Ascending by operator count. */
  bands: CoverageBand[];
}

export type AreaKind = 'constituency' | 'local-authority' | 'devolved-constituency' | 'area';

export interface AreaCoverage {
  /** Human name, e.g. "Lewisham West and East Dulwich". */
  areaName: string;
  areaCode?: string;
  kind: AreaKind;
  /** Premises in the area, where the file states it — the denominator. */
  premisesCount?: number;
  rows: AreaCoverageRow[];
  /** The Ofcom release, from the file name, e.g. `2025-07`. */
  release?: string;
  /** The file it came from, so the admin board can name it. */
  file?: string;
}

const KIND_LABEL: Record<AreaKind, string> = {
  constituency: 'parliamentary constituency',
  'local-authority': 'local authority',
  'devolved-constituency': 'devolved constituency',
  area: 'area',
};

export const areaKindLabel = (kind: AreaKind): string => KIND_LABEL[kind];

/** The band for "every network", which is the figure worth leading with. */
export function allNetworks(row: AreaCoverageRow): number | undefined {
  const highest = row.bands.reduce<CoverageBand | undefined>(
    (best, band) => (best === undefined || band.operators > best.operators ? band : best),
    undefined,
  );
  return highest?.percent;
}

/** The band for "no network at all". */
export function noNetwork(row: AreaCoverageRow): number | undefined {
  return row.bands.find((b) => b.operators === 0)?.percent;
}

/**
 * Percentage covered by at least one operator.
 *
 * Summed rather than read off a column, because the file publishes the
 * distribution and not the cumulative figure. Where the zero band is absent
 * — Ofcom leave the cell empty rather than writing 0 — this is the sum of
 * every band above zero, which is the same answer.
 */
export function atLeastOneNetwork(row: AreaCoverageRow): number | undefined {
  const above = row.bands.filter((b) => b.operators > 0);
  if (above.length === 0) return undefined;
  return Math.round(above.reduce((sum, b) => sum + b.percent, 0) * 100) / 100;
}

/** How a row reads in a table: "5G (very high confidence)". */
export function rowLabel(row: AreaCoverageRow): string {
  if (!row.confidence) return row.technology;
  return `${row.technology} (${row.confidence === 'very-high' ? 'very high' : 'high'} confidence)`;
}

/**
 * The one line to read out.
 *
 * 4G premises indoors, because that is the practical question — somebody
 * asking about a site cares about buildings, and indoors is where the phone
 * that is not working is. 5G is not preferred despite being newer: Ofcom
 * publish it outdoors only, so there is no indoor 5G figure to lead with.
 */
export function summariseArea(coverage: AreaCoverage): string | undefined {
  const preferred =
    coverage.rows.find((r) => r.technology === '4G' && r.measure === 'premises' && r.placement === 'indoor') ??
    coverage.rows.find((r) => r.technology === '4G' && r.measure === 'premises') ??
    coverage.rows.find((r) => r.measure === 'premises');
  if (!preferred) return undefined;

  const all = allNetworks(preferred);
  const any = atLeastOneNetwork(preferred);
  if (all === undefined && any === undefined) return undefined;

  const parts: string[] = [];
  const where = preferred.placement === 'indoor' ? 'indoor' : 'outdoor';
  if (any !== undefined) {
    parts.push(`${any}% of premises get ${where} ${rowLabel(preferred)} from at least one network`);
  }
  if (all !== undefined) parts.push(`${all}% from all four`);
  return parts.join(', ');
}
