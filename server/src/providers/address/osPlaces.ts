import { finaliseAddress, formatPostcode, premisesTypeFor, sortAddresses, type AddressRecord } from '@sw/shared';
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

interface OsResponse {
  header?: { totalresults?: number };
  results?: Array<{ DPA?: OsDpa; LPI?: OsDpa }>;
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

/** OS returns SHOUTED addresses; the portal shows them in title case. */
function titleCase(v: string): string {
  return v
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Of|The|And|On|In|At|To)\b/g, (m) => m.toLowerCase())
    .replace(/^([a-z])/, (m) => m.toUpperCase());
}

const cache = new TtlCache<AddressRecord[]>(60 * 60 * 1000, 2000);

export function createOsPlacesProvider(): AddressProvider {
  const cfg = config();

  const call = async (path: string, params: Record<string, string>): Promise<AddressRecord[]> => {
    const qs = new URLSearchParams({ ...params, key: cfg.osPlaces.apiKey, output_srs: 'WGS84', dataset: 'DPA' });
    const url = `${cfg.osPlaces.baseUrl}${path}?${qs.toString()}`;
    const json = await fetchJson<OsResponse>(url, {
      label: 'OS Places',
      timeoutMs: cfg.requestTimeoutMs,
      notFoundAsNull: true,
    });
    const rows = json?.results ?? [];
    return rows
      .map((r) => r.DPA ?? r.LPI)
      .filter((d): d is OsDpa => Boolean(d))
      .map(toRecord);
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

    async search(query, limit) {
      const key = `q:${query}:${limit}`;
      return cache.wrap(key, () => call('/find', { query, maxresults: String(limit) }));
    },
  };
}
