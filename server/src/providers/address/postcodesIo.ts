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
