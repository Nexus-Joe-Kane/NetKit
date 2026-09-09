import {
  finaliseAddress,
  formatPostcode,
  premisesTypeFor,
  rankAddresses,
  rankAddressMatches,
  unmatchedTokens,
  sortAddresses,
  type AddressRecord,
} from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { TtlCache } from '../../lib/cache';
import { districtsForPlace } from './postcodesIo';
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

/**
 * How deep to page a free-text search before giving up.
 *
 * Three hundred rows is enough to reach the premises behind a common name --
 * "Maru" and "Megans" both have well over a hundred namesakes nationally --
 * and few enough that a hopeless query costs three requests rather than ten.
 */
const MAX_SEARCH_PAGES = 3;

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
     * Over-fetches, and pages when it has to.
     *
     * Two separate problems, both of which showed up as the same symptom --
     * `maru mayfair` listing a Maru in Carlisle and one in Dover.
     *
     * The first is that ranking discards most of what OS returns, so asking
     * for exactly `limit` rows leaves a short list after filtering. OS caps
     * `maxresults` at 100, so the first page is always the full 100.
     *
     * The second is that OS orders `/find` by its own relevance, and for a
     * name plus a locality the premises that satisfies *both* words can sit
     * past the first hundred behind ninety-nine that satisfy only the name.
     * No amount of re-ranking a page that does not contain the answer will
     * produce it. So when nothing on the page accounts for every word typed,
     * the next page is fetched -- and only then, which means the extra
     * requests happen exactly in the case that was broken and never in the
     * common one.
     */
    async search(query, limit) {
      const key = `q:${query}:${limit}`;
      return cache.wrap(key, async () => {
        const perPage = 100;
        const collected: AddressRecord[] = [];
        const seen = new Set<string>();

        const gather = (rows: AddressRecord[]): number => {
          let added = 0;
          for (const row of rows) {
            // Pages overlap in practice, and the same premises can arrive
            // from both datasets.
            const id = row.uprn ?? row.singleLine.toUpperCase();
            if (seen.has(id)) continue;
            seen.add(id);
            collected.push(row);
            added += 1;
          }
          return added;
        };

        const answered = (): boolean => rankAddressMatches(collected, query).some((m) => m.complete);

        for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
          const rows = await call('/find', {
            query,
            maxresults: String(perPage),
            ...(page > 0 ? { offset: String(page * perPage) } : {}),
          });
          gather(rows);

          // A short page is the end of the results.
          if (rows.length < perPage) break;
          // Something accounts for every word typed. Further pages can only
          // be worse matches.
          if (answered()) break;
        }

        /*
         * The word OS dropped, searched again as a postcode district.
         *
         * Paging cannot fix a query whose answer OS never ranked: `megans
         * richmond` filled three hundred rows with Megan's in nine other
         * towns, because "megans" alone scores well enough on a hundred
         * namesakes to bury the one premises that satisfies both words.
         *
         * A place name is a word a relevance search may ignore. A postcode
         * district is not -- it is in the address text OS indexes. So the
         * word nothing accounted for is resolved to the districts it covers
         * and the search is run again with the district standing in for it.
         *
         * Two districts at most, and only for a query that has already come
         * back without an answer, so the common case costs nothing. If OS
         * ignores the district too, the extra rows simply fail the same
         * ranking and nothing is made worse.
         */
        if (!answered()) {
          const missing = unmatchedTokens(collected, query);
          for (const token of missing.slice(0, 1)) {
            const districts = await districtsForPlace(token);
            const rest = query
              .split(/[^A-Za-z0-9']+/)
              .filter((w) => w && w.toLowerCase() !== token)
              .join(' ');
            if (!rest) break;

            for (const district of districts.slice(0, 2)) {
              gather(await call('/find', { query: `${rest} ${district}`, maxresults: String(perPage) }));
              if (answered()) break;
            }
            if (answered()) break;
          }
        }

        return rankAddresses(collected, query, limit);
      });
    },
  };
}

/** Test hook. */
export const __osPlacesTesting = { dedupeByUprn, lpiToRecord, toRecord };
