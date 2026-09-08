import {
  boundingBox,
  distanceMetres,
  type AddressRecord,
  type MastSite,
  type MobileOperator,
} from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { TtlCache } from '../../lib/cache';

/**
 * Nearest cell sites, from OpenCelliD.
 *
 * This answers the question Ofcom's data cannot. Their mobile figures are
 * published per constituency, and a constituency contains a city centre and
 * a valley with no signal -- so "coverage here is good" and "this customer
 * has no bars" are both true and the report cannot reconcile them. The
 * distance and direction to the nearest site for their network can.
 *
 * The provenance is stated everywhere it surfaces, because it matters:
 * OpenCelliD positions are inferred from handset reports, not taken from an
 * operator's asset register. A site is roughly where this says, sometimes
 * less roughly than that, and occasionally is not there any more. It is
 * evidence for a conversation, not a fact to quote.
 *
 * Free with a registration. The endpoint and the search path are
 * configurable because they come from OpenCelliD's public documentation
 * rather than from a response anyone here has seen -- the first live call is
 * still the test, and a path that moves should be a config change rather
 * than a release.
 */

/** UK mobile network codes. MCC 234 and 235 are both British. */
const OPERATOR_BY_MNC: Record<string, MobileOperator> = {
  '02': 'O2',
  '10': 'O2',
  '11': 'O2',
  '15': 'Vodafone',
  '20': 'Three',
  '30': 'EE',
  '33': 'EE',
  '34': 'EE',
};

/** How many sites to report. Beyond a handful nobody reads them. */
const LIMIT = 12;

const cache = new TtlCache<MastSite[]>(24 * 60 * 60 * 1000, 500);

interface OpenCellIdCell {
  lat?: number | string;
  lon?: number | string;
  mcc?: number | string;
  mnc?: number | string;
  net?: number | string;
  radio?: string;
  cellid?: number | string;
  cid?: number | string;
  lac?: number | string;
  area?: number | string;
  range?: number | string;
  samples?: number | string;
}

interface OpenCellIdResponse {
  cells?: OpenCellIdCell[];
  /** Some deployments wrap the list differently. */
  result?: OpenCellIdCell[];
  count?: number;
}

const numeric = (v?: number | string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
};

/** MNCs are two digits and a leading zero is significant: `02` is not `2`. */
const mncKey = (v?: number | string): string | undefined => {
  const n = numeric(v);
  if (n === undefined) return undefined;
  return String(Math.trunc(n)).padStart(2, '0');
};

export function mapCell(raw: OpenCellIdCell, from: { latitude: number; longitude: number }): MastSite | null {
  const latitude = numeric(raw.lat);
  const longitude = numeric(raw.lon);
  // A site with no position is not a site we can measure a distance to.
  if (latitude === undefined || longitude === undefined) return null;
  if (latitude === 0 && longitude === 0) return null;

  const mnc = mncKey(raw.mnc ?? raw.net);
  const operator = mnc ? OPERATOR_BY_MNC[mnc] : undefined;
  const samples = numeric(raw.samples);
  const range = numeric(raw.range);
  const cellId = numeric(raw.cellid ?? raw.cid);
  const areaCode = numeric(raw.lac ?? raw.area);

  return {
    ...(operator ? { operator } : {}),
    // Kept even when unmapped, so an operator we do not recognise is still
    // visible as a code rather than silently dropped.
    ...(mnc ? { networkCode: mnc } : {}),
    ...(raw.radio ? { radio: String(raw.radio).toUpperCase() } : {}),
    latitude,
    longitude,
    distanceMetres: distanceMetres(from, { latitude, longitude }),
    ...(samples !== undefined ? { samples } : {}),
    ...(range !== undefined ? { rangeMetres: range } : {}),
    ...(cellId !== undefined ? { cellId: String(cellId) } : {}),
    ...(areaCode !== undefined ? { areaCode: String(areaCode) } : {}),
  };
}

/**
 * Picks what to show.
 *
 * Closest first, and no more than three per network: twelve EE sites and
 * nothing else answers nobody's question, whereas the nearest three for each
 * of the four networks is exactly the comparison being made.
 */
export function chooseSites(sites: MastSite[]): MastSite[] {
  const perNetwork = new Map<string, number>();
  const out: MastSite[] = [];

  for (const site of [...sites].sort((a, b) => a.distanceMetres - b.distanceMetres)) {
    const key = site.operator ?? site.networkCode ?? 'unknown';
    const used = perNetwork.get(key) ?? 0;
    if (used >= 3) continue;
    perNetwork.set(key, used + 1);
    out.push(site);
    if (out.length >= LIMIT) break;
  }

  return out;
}

export function openCellIdConfigured(): boolean {
  return config().openCellId.configured;
}

/** Nearest cell sites to a premises, or null when there is nothing to ask. */
export async function mastsNear(address: AddressRecord): Promise<MastSite[] | null> {
  const cfg = config().openCellId;
  if (!cfg.configured) return null;

  const { latitude, longitude } = address;
  // OS Places give coordinates; postcodes.io give them too. Without them
  // there is no question to ask, and guessing a centroid would put a site
  // "400 m away" from somewhere that is not the premises.
  if (latitude === undefined || longitude === undefined) return null;

  const centre = { latitude, longitude };
  // Rounded to about 100 m so neighbouring premises share a cache entry.
  const key = `${latitude.toFixed(3)},${longitude.toFixed(3)},${cfg.radiusMetres}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const box = boundingBox(centre, cfg.radiusMetres);
  const url = new URL(`${cfg.baseUrl.replace(/\/$/, '')}${cfg.searchPath}`);
  url.searchParams.set('key', cfg.apiKey);
  url.searchParams.set('BBOX', `${box.south},${box.west},${box.north},${box.east}`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '200');

  const payload = await fetchJson<OpenCellIdResponse>(url.toString(), {
    label: 'OpenCelliD',
    timeoutMs: Math.min(config().requestTimeoutMs, 8000),
    retries: 1,
    // An area with no recorded sites is a legitimate answer.
    notFoundAsNull: true,
  });

  const rows = payload?.cells ?? payload?.result ?? [];
  const sites = chooseSites(
    rows.map((row) => mapCell(row, centre)).filter((s): s is MastSite => s !== null),
  );

  cache.set(key, sites);
  return sites;
}

/** Recovery hook. */
export function clearOpenCellIdCache(): void {
  cache.clear();
}

export const __openCellIdTesting = { mapCell, chooseSites, mncKey, OPERATOR_BY_MNC };
