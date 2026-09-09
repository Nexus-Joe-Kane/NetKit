import {
  OFCOM_MOBILE_FIELDS,
  bandFromRating,
  mobileRatingLabel,
  toMobileRating,
  type MobileCoverage,
  type MobileOperator,
  type MobileRating,
} from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { TtlCache } from '../../lib/cache';

/**
 * Ofcom's Mobile Checker, per UPRN.
 *
 * The source that was missing. Everything else in this portal's mobile
 * picture comes from Connected Nations area files at parliamentary
 * constituency resolution — a constituency contains a city centre and a
 * valley with no signal, and cannot tell them apart. This answers per
 * address, per operator.
 *
 * A separate subscription from the broadband API, on a different host, with
 * its own key. Same Azure API Management gateway conventions, so the key
 * goes in `Ocp-Apim-Subscription-Key`.
 *
 * The published spec contradicts itself in three places, and the mapping
 * below reads both sides of each rather than picking one and finding out in
 * production:
 *
 *   1. The response schema is an object (`CoverageByPostCode`); the example
 *      is an array of them.
 *   2. The schema names the address field `AddressShortDescription`; the
 *      example calls it `address_short_description`.
 *   3. Every key in the example carries a leading and trailing space
 *      (`" uprn "`, `" Mc_EE "`). Almost certainly a documentation artefact,
 *      but trimming keys costs one line and guessing wrong costs a morning.
 */

const cache = new TtlCache<CheckerRow[]>(24 * 60 * 60 * 1000, 2000);

export const ofcomMobileConfigured = (): boolean => config().ofcomMobile.configured;

export function clearOfcomMobileCache(): void {
  cache.clear();
}

/** One address's coverage, after the shape has been normalised. */
export interface CheckerRow {
  uprn?: string;
  postcode?: string;
  address?: string;
  ratings: Partial<Record<MobileOperator, MobileRating>>;
  districtCode?: string;
  sectorCode?: string;
  createdAt?: string;
}

/** Trims the keys, so the example's stray spaces cannot matter. */
function normaliseKeys(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key.trim()] = value;
  }
  return out;
}

const text = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

/** Case-insensitive read, because the spec disagrees with itself on casing. */
function field(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (row[name] !== undefined) return row[name];
  }
  const lowered = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const name of names) {
    const actual = lowered.get(name.toLowerCase());
    if (actual !== undefined && row[actual] !== undefined) return row[actual];
  }
  return undefined;
}

function toRow(raw: unknown): CheckerRow | null {
  const row = normaliseKeys(raw);
  const ratings: Partial<Record<MobileOperator, MobileRating>> = {};
  for (const { field: name, operator } of OFCOM_MOBILE_FIELDS) {
    const rating = toMobileRating(field(row, name));
    if (rating !== undefined) ratings[operator] = rating;
  }

  const uprn = text(field(row, 'uprn', 'UPRN'));
  // A row with no operator figures at all is not an answer, and returning it
  // would have the caller report "coverage found" for an address with none.
  if (!Object.keys(ratings).length && !uprn) return null;

  return {
    ...(uprn ? { uprn } : {}),
    ...(text(field(row, 'postcode', 'PostCode')) ? { postcode: text(field(row, 'postcode', 'PostCode'))! } : {}),
    ...(text(field(row, 'AddressShortDescription', 'address_short_description'))
      ? { address: text(field(row, 'AddressShortDescription', 'address_short_description'))! }
      : {}),
    ratings,
    ...(text(field(row, 'district_code', 'DistrictCode')) ? { districtCode: text(field(row, 'district_code', 'DistrictCode'))! } : {}),
    ...(text(field(row, 'sector_code', 'SectorCode')) ? { sectorCode: text(field(row, 'sector_code', 'SectorCode'))! } : {}),
    ...(text(field(row, 'creation_date', 'CreationDate')) ? { createdAt: text(field(row, 'creation_date', 'CreationDate'))! } : {}),
  };
}

/**
 * Pulls the rows out of whichever shape came back.
 *
 * The schema says one object with an `Availability` array; the example says
 * an array of those. Both are handled, and so is a bare array of rows, which
 * is what a proxy that unwraps things would produce.
 */
export function extractRows(payload: unknown): CheckerRow[] {
  const envelopes = Array.isArray(payload) ? payload : [payload];
  const rows: CheckerRow[] = [];

  for (const envelope of envelopes) {
    const normalised = normaliseKeys(envelope);
    const availability = field(normalised, 'Availability', 'availability');

    if (Array.isArray(availability)) {
      for (const raw of availability) {
        const row = toRow(raw);
        if (row) rows.push(row);
      }
      continue;
    }

    // A bare row, or a bare array of rows.
    const row = toRow(envelope);
    if (row) rows.push(row);
  }

  return rows;
}

const normalisePostcode = (postcode: string): string => postcode.replace(/\s+/g, '').toUpperCase();

/** Every address in the postcode, with its per-operator ratings. */
export async function mobileCoverageByPostcode(postcode: string): Promise<CheckerRow[]> {
  const cfg = config().ofcomMobile;
  if (!cfg.configured) return [];

  const key = normalisePostcode(postcode);
  if (!key) return [];

  return cache.wrap(key, async () => {
    const payload = await fetchJson<unknown>(
      `${cfg.baseUrl.replace(/\/$/, '')}/UPRN/${encodeURIComponent(key)}`,
      {
        label: 'Ofcom Mobile Checker',
        headers: { 'Ocp-Apim-Subscription-Key': cfg.apiKey },
        // A postcode Ofcom has no data for is a 404, which is an answer
        // rather than a failure: new builds are routinely absent.
        notFoundAsNull: true,
        retries: 1,
      },
    );
    return extractRows(payload);
  });
}

/**
 * The row for one address, by UPRN, falling back to the postcode.
 *
 * A UPRN match is the point of this API. Without one the postcode's rows are
 * still worth something, but the caller is told which it got — "this address"
 * and "somewhere in this postcode" are different claims, and a postcode can
 * span a corner shop and a basement flat.
 */
export async function mobileCoverageForAddress(input: {
  postcode: string;
  uprn?: string;
}): Promise<{ row?: CheckerRow; exact: boolean; rowsInPostcode: number }> {
  const rows = await mobileCoverageByPostcode(input.postcode);
  if (!rows.length) return { exact: false, rowsInPostcode: 0 };

  if (input.uprn) {
    const exact = rows.find((r) => r.uprn === input.uprn);
    if (exact) return { row: exact, exact: true, rowsInPostcode: rows.length };
  }

  // No UPRN match. Take the worst rather than the first: a quote based on
  // the best address in a postcode is a quote that gets withdrawn on site.
  const worst = [...rows].sort((a, b) => bestRating(a) - bestRating(b))[0];
  return { ...(worst ? { row: worst } : {}), exact: false, rowsInPostcode: rows.length };
}

function bestRating(row: CheckerRow): number {
  return Math.max(-1, ...Object.values(row.ratings).map((r) => r ?? -1));
}

/**
 * The row as the portal's operator model.
 *
 * `voice` and `data4g` carry the same figure because Ofcom's June 2025
 * methodology merged them — one number now covers typical use. Filling them
 * identically and saying so is honest; deriving a voice figure and a data
 * figure from one number would invent a distinction Ofcom deliberately
 * removed. 3G is left absent for the same reason: it is no longer reported.
 */
export function asCoverage(row: CheckerRow): MobileCoverage[] {
  const out: MobileCoverage[] = [];
  for (const { operator } of OFCOM_MOBILE_FIELDS) {
    const rating = row.ratings[operator];
    if (rating === undefined) continue;
    const band = bandFromRating(rating);
    out.push({
      operator,
      voice: band,
      data4g: band,
      source: 'ofcom',
      notes: [
        mobileRatingLabel(rating),
        'Ofcom blend 4G and 5G into one figure and no longer split voice from data, so these two rows are the same measurement.',
        row.uprn
          ? 'Per-premises, from the Ofcom Mobile Checker.'
          : 'No UPRN match — this is the weakest address in the postcode, not this doorstep.',
      ],
    });
  }
  return out;
}
