import {
  finaliseAddress,
  formatPostcode,
  premisesTypeFor,
  rankAddresses,
  sortAddresses,
  type AddressRecord,
} from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { TtlCache } from '../../lib/cache';
import type { AddressProvider } from '../types';

/**
 * Ordnance Survey Places API — the authoritative source for UK addresses and
 * UPRNs (it sits on AddressBase Premium). This is the provider that makes the
 * "everything returns a full address and UPRN" requirement actually true.
 */
interface OsDpa {
  UPRN?: string;
  UDPRN?: string;
  ADDRESS?: string;
  ORGANISATION_NAME?: string;
  SUB_BUILDING_NAME?: string;
  BUILDING_NAME?: string;
  BUILDING_NUMBER?: string;
  DEPENDENT_THOROUGHFARE_NAME?: string;
  THOROUGHFARE_NAME?: string;
  DOUBLE_DEPENDENT_LOCALITY?: string;
  DEPENDENT_LOCALITY?: string;
  POST_TOWN?: string;
  POSTCODE?: string;
  POSTAL_ADDRESS_CODE_DESCRIPTION?: string;
  CLASSIFICATION_CODE?: string;
  CLASSIFICATION_CODE_DESCRIPTION?: string;
  LOCAL_CUSTODIAN_CODE_DESCRIPTION?: string;
  X_COORDINATE?: number;
  Y_COORDINATE?: number;
  LNG?: number;
  LAT?: number;
}

/**
 * `LPI` in OS Places -- the Local Property Identifier view of the same UPRN,
 * with entirely different field names from DPA. It exists for premises Royal
 * Mail never gave a delivery point: sub-divided buildings, units on an
 * industrial estate, a shell record for a building whose flats are the real
 * addresses.
 */
interface OsLpi {
  UPRN?: string;
  ADDRESS?: string;
  ORGANISATION?: string;
  SAO_TEXT?: string;
  SAO_START_NUMBER?: number | string;
  SAO_START_SUFFIX?: string;
  PAO_TEXT?: string;
  PAO_START_NUMBER?: number | string;
  PAO_START_SUFFIX?: string;
  STREET_DESCRIPTION?: string;
  LOCALITY_NAME?: string;
  TOWN_NAME?: string;
  ADMINISTRATIVE_AREA?: string;
  POSTCODE_LOCATOR?: string;
  CLASSIFICATION_CODE?: string;
  LOCAL_CUSTODIAN_CODE_DESCRIPTION?: string;
  X_COORDINATE?: number;
  Y_COORDINATE?: number;
  LNG?: number;
  LAT?: number;
}

interface OsResponse {
  header?: { totalresults?: number };
  results?: Array<{ DPA?: OsDpa; LPI?: OsLpi }>;
}

function toRecord(dpa: OsDpa): AddressRecord {
  return finaliseAddress({
    ...(dpa.UPRN ? { uprn: String(dpa.UPRN) } : {}),
    ...(dpa.UDPRN ? { udprn: String(dpa.UDPRN) } : {}),
    ...(dpa.ORGANISATION_NAME ? { organisation: titleCase(dpa.ORGANISATION_NAME) } : {}),
    ...(dpa.SUB_BUILDING_NAME ? { subBuilding: titleCase(dpa.SUB_BUILDING_NAME) } : {}),
    ...(dpa.BUILDING_NAME ? { buildingName: titleCase(dpa.BUILDING_NAME) } : {}),
    ...(dpa.BUILDING_NUMBER ? { buildingNumber: String(dpa.BUILDING_NUMBER) } : {}),
    ...(dpa.DEPENDENT_THOROUGHFARE_NAME ? { dependentThoroughfare: titleCase(dpa.DEPENDENT_THOROUGHFARE_NAME) } : {}),
    ...(dpa.THOROUGHFARE_NAME ? { thoroughfare: titleCase(dpa.THOROUGHFARE_NAME) } : {}),
    ...(dpa.DOUBLE_DEPENDENT_LOCALITY ? { doubleDependentLocality: titleCase(dpa.DOUBLE_DEPENDENT_LOCALITY) } : {}),
    ...(dpa.DEPENDENT_LOCALITY ? { dependentLocality: titleCase(dpa.DEPENDENT_LOCALITY) } : {}),
    postTown: (dpa.POST_TOWN ?? '').toUpperCase(),
    postcode: dpa.POSTCODE ? formatPostcode(dpa.POSTCODE) : '',
    ...(dpa.LOCAL_CUSTODIAN_CODE_DESCRIPTION ? { localAuthority: titleCase(dpa.LOCAL_CUSTODIAN_CODE_DESCRIPTION) } : {}),
    ...(dpa.LAT != null ? { latitude: dpa.LAT } : {}),
    ...(dpa.LNG != null ? { longitude: dpa.LNG } : {}),
    ...(dpa.X_COORDINATE != null ? { easting: dpa.X_COORDINATE } : {}),
    ...(dpa.Y_COORDINATE != null ? { northing: dpa.Y_COORDINATE } : {}),
    ...(dpa.CLASSIFICATION_CODE ? { classificationCode: dpa.CLASSIFICATION_CODE } : {}),
    ...(dpa.CLASSIFICATION_CODE_DESCRIPTION ? { classificationLabel: dpa.CLASSIFICATION_CODE_DESCRIPTION } : {}),
    premisesType: premisesTypeFor(dpa.CLASSIFICATION_CODE),
    source: 'os-places',
  });
}

/**
 * LPI numbering is split across four fields: PAO is the building, SAO the
 * unit inside it, each with a number and an optional suffix. Recombined here
 * so "Flat 3, 12A" comes out as a person would write it.
 */
function joinNumber(num?: number | string, suffix?: string): string | undefined {
  const n = num == null || num === '' ? '' : String(num);
  const joined = `${n}${suffix ?? ''}`.trim();
  return joined.length ? joined : undefined;
}

function lpiToRecord(lpi: OsLpi): AddressRecord {
  const sao = joinNumber(lpi.SAO_START_NUMBER, lpi.SAO_START_SUFFIX);
  const subBuilding = [lpi.SAO_TEXT ? titleCase(lpi.SAO_TEXT) : undefined, sao].filter(Boolean).join(' ').trim();
  const pao = joinNumber(lpi.PAO_START_NUMBER, lpi.PAO_START_SUFFIX);

  return finaliseAddress({
    ...(lpi.UPRN ? { uprn: String(lpi.UPRN) } : {}),
    ...(lpi.ORGANISATION ? { organisation: titleCase(lpi.ORGANISATION) } : {}),
    ...(subBuilding ? { subBuilding } : {}),
    ...(lpi.PAO_TEXT ? { buildingName: titleCase(lpi.PAO_TEXT) } : {}),
    ...(pao ? { buildingNumber: pao } : {}),
    ...(lpi.STREET_DESCRIPTION ? { thoroughfare: titleCase(lpi.STREET_DESCRIPTION) } : {}),
    ...(lpi.LOCALITY_NAME ? { dependentLocality: titleCase(lpi.LOCALITY_NAME) } : {}),
    postTown: (lpi.TOWN_NAME ?? '').toUpperCase(),
    postcode: lpi.POSTCODE_LOCATOR ? formatPostcode(lpi.POSTCODE_LOCATOR) : '',
    ...(lpi.ADMINISTRATIVE_AREA ? { county: titleCase(lpi.ADMINISTRATIVE_AREA) } : {}),
    ...(lpi.LOCAL_CUSTODIAN_CODE_DESCRIPTION
      ? { localAuthority: titleCase(lpi.LOCAL_CUSTODIAN_CODE_DESCRIPTION) }
      : {}),
    ...(lpi.LAT != null ? { latitude: lpi.LAT } : {}),
    ...(lpi.LNG != null ? { longitude: lpi.LNG } : {}),
    ...(lpi.X_COORDINATE != null ? { easting: lpi.X_COORDINATE } : {}),
    ...(lpi.Y_COORDINATE != null ? { northing: lpi.Y_COORDINATE } : {}),
    ...(lpi.CLASSIFICATION_CODE ? { classificationCode: lpi.CLASSIFICATION_CODE } : {}),
    premisesType: premisesTypeFor(lpi.CLASSIFICATION_CODE),
    source: 'os-places',
  });
}

/** OS returns SHOUTED addresses; the portal shows them in title case. */
function titleCase(v: string): string {
  return v
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Of|The|And|On|In|At|To)\b/g, (m) => m.toLowerCase())
    .replace(/^([a-z])/, (m) => m.toUpperCase());
}

/**
 * One row per UPRN, preferring the DPA view.
 *
 * With both datasets requested, a premises Royal Mail does deliver to comes
 * back twice. DPA wins because it is the postal address -- the one a customer
 * would recognise -- and LPI fills in only the premises DPA has never heard
 * of.
 */
function dedupeByUprn(rows: Array<{ DPA?: OsDpa; LPI?: OsLpi }>): AddressRecord[] {
  const byUprn = new Map<string, AddressRecord>();
  const withoutUprn: AddressRecord[] = [];

  // DPA first so it claims the key, then LPI only adds what is missing.
  for (const row of rows) {
    if (!row.DPA) continue;
    const record = toRecord(row.DPA);
    if (record.uprn) byUprn.set(record.uprn, record);
    else withoutUprn.push(record);
  }
  for (const row of rows) {
    if (!row.LPI) continue;
    const record = lpiToRecord(row.LPI);
    if (!record.uprn) {
      withoutUprn.push(record);
      continue;
    }
    if (!byUprn.has(record.uprn)) byUprn.set(record.uprn, record);
  }

  // Preserve the order OS returned rather than Map insertion order, since
  // relevance still matters within a tier once ranking runs.
  const seen = new Set<string>();
  const ordered: AddressRecord[] = [];
  for (const row of rows) {
    const uprn = row.DPA?.UPRN ?? row.LPI?.UPRN;
    if (uprn == null) continue;
    const key = String(uprn);
    if (seen.has(key)) continue;
    seen.add(key);
    const record = byUprn.get(key);
    if (record) ordered.push(record);
  }
  return [...ordered, ...withoutUprn];
}

const cache = new TtlCache<AddressRecord[]>(60 * 60 * 1000, 2000);

/** Drops the cache. Used by the recovery supervisor. */
export function clearOsPlacesCache(): void {
  cache.clear();
}

export function createOsPlacesProvider(): AddressProvider {
  const cfg = config();

  /**
   * Every endpoint asks for both datasets.
   *
   * Asking only for DPA is what let the premises picker offer a UPRN the
   * detail lookup then could not resolve: searching `2 Doughty Street`
   * listed "Flat Basement And Ground Floor" at UPRN 5121368, and opening it
   * answered "No premises found". A UPRN that exists only in LPI is invisible
   * to a DPA-only lookup, so the two calls disagreed about the same premises.
   *
   * Consistency is the fix. Anything this provider is willing to show, it can
   * also resolve.
   */
  const call = async (path: string, params: Record<string, string>): Promise<AddressRecord[]> => {
    const qs = new URLSearchParams({
      ...params,
      key: cfg.osPlaces.apiKey,
      output_srs: 'WGS84',
      dataset: 'DPA,LPI',
    });
    const url = `${cfg.osPlaces.baseUrl}${path}?${qs.toString()}`;
    const json = await fetchJson<OsResponse>(url, {
      label: 'OS Places',
      timeoutMs: cfg.requestTimeoutMs,
      notFoundAsNull: true,
    });
    return dedupeByUprn(json?.results ?? []);
  };

  return {
    name: 'os-places',
    label: 'OS Places (AddressBase)',
    configured: cfg.osPlaces.configured,
    mode: 'live',

    async byPostcode(postcode) {
      const key = `pc:${postcode}`;
      return cache.wrap(key, async () =>
        sortAddresses(await call('/postcode', { postcode, maxresults: '100' })),
      );
    },

    async byUprn(uprn) {
      const key = `uprn:${uprn}`;
      const rows = await cache.wrap(key, () => call('/uprn', { uprn }));
      return rows[0] ?? null;
    },

    /**
     * Over-fetches on purpose.
     *
     * The ranking below can discard most of what OS returns -- that is the
     * point of it -- so asking for exactly `limit` rows would leave a short
     * list after filtering. OS caps `maxresults` at 100.
     */
    async search(query, limit) {
      const key = `q:${query}:${limit}`;
      return cache.wrap(key, async () => {
        const wanted = Math.min(100, Math.max(40, limit * 6));
        const candidates = await call('/find', { query, maxresults: String(wanted) });
        return rankAddresses(candidates, query, limit);
      });
    },
  };
}

/** Test hook. */
export const __osPlacesTesting = { dedupeByUprn, lpiToRecord, toRecord };
