import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { TtlCache } from '../../lib/cache';

/**
 * postcodes.io is a free, key-less service over ONS/OS open data. It does not
 * give us premises-level addresses or UPRNs, but it does give real post town,
 * county, ward, constituency and coordinates for any live UK postcode — which
 * is what makes fixture premises look and behave like real ones, and what
 * enriches live premises that come back without geo data.
 */
export interface PostcodeMeta {
  postcode: string;
  postTown: string;
  county?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  eastings?: number;
  northings?: number;
  ward?: string;
  constituency?: string;
  localAuthority?: string;
}

interface PostcodesIoResult {
  result?: {
    postcode?: string;
    eastings?: number | null;
    northings?: number | null;
    country?: string | null;
    admin_district?: string | null;
    admin_ward?: string | null;
    parliamentary_constituency?: string | null;
    region?: string | null;
    longitude?: number | null;
    latitude?: number | null;
  } | null;
}

const cache = new TtlCache<PostcodeMeta | null>(24 * 60 * 60 * 1000, 5000);

export async function lookupPostcodeMeta(postcode: string): Promise<PostcodeMeta | null> {
  const cfg = config();
  if (!cfg.postcodesIo.enabled) return null;
  const key = postcode.toUpperCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  try {
    const url = `${cfg.postcodesIo.baseUrl}/postcodes/${encodeURIComponent(postcode.replace(/\s+/g, ''))}`;
    const json = await fetchJson<PostcodesIoResult>(url, {
      label: 'postcodes.io',
      timeoutMs: Math.min(cfg.requestTimeoutMs, 6000),
      retries: 1,
      notFoundAsNull: true,
    });
    const r = json?.result;
    if (!r) {
      cache.set(key, null);
      return null;
    }
    const meta: PostcodeMeta = {
      postcode: r.postcode ?? postcode,
      // postcodes.io exposes no PAF post town, so the admin district is the
      // closest equivalent for display.
      postTown: (r.admin_district ?? r.region ?? '').toUpperCase(),
      ...(r.admin_district ? { county: r.admin_district } : {}),
      ...(r.country ? { country: r.country } : {}),
      ...(r.latitude != null ? { latitude: r.latitude } : {}),
      ...(r.longitude != null ? { longitude: r.longitude } : {}),
      ...(r.eastings != null ? { eastings: r.eastings } : {}),
      ...(r.northings != null ? { northings: r.northings } : {}),
      ...(r.admin_ward ? { ward: r.admin_ward } : {}),
      ...(r.parliamentary_constituency ? { constituency: r.parliamentary_constituency } : {}),
      ...(r.admin_district ? { localAuthority: r.admin_district } : {}),
    };
    cache.set(key, meta);
    return meta;
  } catch {
    // Never let enrichment failure break a lookup.
    cache.set(key, null, 60_000);
    return null;
  }
}

/** Drops the cache. Used by the recovery supervisor. */
export function clearPostcodeCache(): void {
  cache.clear();
}

/** Autocomplete partial postcodes, used by the search box typeahead. */
export async function autocompletePostcode(partial: string): Promise<string[]> {
  const cfg = config();
  if (!cfg.postcodesIo.enabled) return [];
  try {
    const url = `${cfg.postcodesIo.baseUrl}/postcodes/${encodeURIComponent(partial.replace(/\s+/g, ''))}/autocomplete`;
    const json = await fetchJson<{ result?: string[] | null }>(url, {
      label: 'postcodes.io',
      timeoutMs: 4000,
      retries: 0,
      notFoundAsNull: true,
    });
    return json?.result ?? [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Place names to postcode districts
 * ------------------------------------------------------------------ */

const placeCache = new TtlCache<string[]>(7 * 24 * 60 * 60 * 1000, 500);

interface PlacesResult {
  result?: Array<{ name_1?: string | null; longitude?: number | null; latitude?: number | null }> | null;
}

interface NearestResult {
  result?: Array<{ outcode?: string | null; postcode?: string | null }> | null;
}

/**
 * The postcode districts a place name covers.
 *
 * The reason this exists: a free-text address search ranks on relevance and
 * is entitled to ignore a word. Searching `megans richmond` came back with
 * nine Megan's in nine other towns and not one in Richmond, because "megans"
 * on its own scores well enough on ninety-nine namesakes to fill the results
 * before the premises that satisfies both words is reached. Re-ranking a page
 * that does not contain the answer cannot produce it.
 *
 * A postcode district can be searched for, where a place name cannot. So the
 * place is resolved to a point (OS Open Names, through postcodes.io), the
 * point to its nearest live postcodes, and those to their districts -- and
 * the address search is asked again with the district in place of the word it
 * dropped.
 *
 * Two calls, cached for a week, and only made for a query that has already
 * failed. Returns an empty list rather than throwing: this is a second
 * chance, not a dependency.
 */
export async function districtsForPlace(place: string): Promise<string[]> {
  const cfg = config();
  if (!cfg.postcodesIo.enabled) return [];

  const key = place.trim().toLowerCase();
  if (key.length < 3) return [];
  const hit = placeCache.get(key);
  if (hit !== undefined) return hit;

  try {
    const places = await fetchJson<PlacesResult>(
      `${cfg.postcodesIo.baseUrl}/places?q=${encodeURIComponent(key)}&limit=5`,
      { label: 'postcodes.io', timeoutMs: 5000, retries: 0, notFoundAsNull: true },
    );

    // Only a place whose own name is what was typed. A fuzzy match on a
    // village three counties away would send the second search somewhere
    // worse than the first.
    const match = (places?.result ?? []).find(
      (p) => (p.name_1 ?? '').trim().toLowerCase() === key && p.latitude != null && p.longitude != null,
    );
    if (!match) {
      placeCache.set(key, []);
      return [];
    }

    const nearest = await fetchJson<NearestResult>(
      `${cfg.postcodesIo.baseUrl}/postcodes?lon=${match.longitude}&lat=${match.latitude}&limit=100&radius=2000`,
      { label: 'postcodes.io', timeoutMs: 6000, retries: 0, notFoundAsNull: true },
    );

    // Districts in order of how many of the nearest postcodes fall in them,
    // so the town centre's own district comes first rather than whichever
    // neighbour happens to sort earliest.
    const counts = new Map<string, number>();
    for (const row of nearest?.result ?? []) {
      const outcode = (row.outcode ?? row.postcode?.split(/\s+/)[0] ?? '').toUpperCase();
      if (outcode) counts.set(outcode, (counts.get(outcode) ?? 0) + 1);
    }
    const districts = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([outcode]) => outcode);

    placeCache.set(key, districts);
    return districts;
  } catch {
    // A failed second chance is not a failure.
    placeCache.set(key, [], 60_000);
    return [];
  }
}

/** Drops the place cache alongside the postcode one. */
export function clearPlaceCache(): void {
  placeCache.clear();
}
