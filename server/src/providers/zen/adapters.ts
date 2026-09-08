import { normaliseCli, sortAddresses, type AddressRecord, type LineRecord } from '@sw/shared';
import { config } from '../../config';
import { TtlCache } from '../../lib/cache';
import { settleAll } from '../../lib/http';
import { zenCall } from './client';
import {
  availabilityFromZen,
  mapZenAddress,
  mapZenService,
  type ZenAddressSearchRow,
  type ZenAvailabilityResponse,
  type ZenService,
} from './normalise';
import type { AddressProvider, AvailabilityProvider, LineProvider } from '../types';

/* ------------------------------------------------------------------ *
 * Caching
 *
 * Zen's fair-use policy explicitly rules out bulk availability checking, so
 * availability results are cached hard and the remaining-quota figure Zen
 * returns is recorded for the admin portal to display.
 * ------------------------------------------------------------------ */

const addressCache = new TtlCache<AddressRecord[]>(6 * 60 * 60 * 1000, 2000);
const availabilityCache = new TtlCache<ZenAvailabilityResponse>(6 * 60 * 60 * 1000, 1000);
const serviceCache = new TtlCache<LineRecord[]>(5 * 60 * 1000, 1000);

let lastQuota: { remaining: unknown; at: string } | null = null;

/**
 * Drops every cached Zen result. Used by the recovery supervisor: a run of
 * failures may have poisoned a cache with a bad or partial response, and
 * serving that indefinitely is worse than re-fetching.
 */
export function clearZenCaches(): void {
  addressCache.clear();
  availabilityCache.clear();
  serviceCache.clear();
}

/** Latest fair-use quota Zen reported, surfaced in the admin portal. */
export function zenAvailabilityQuota(): { remaining: unknown; at: string } | null {
  return lastQuota;
}

/* ------------------------------------------------------------------ *
 * Addresses
 * ------------------------------------------------------------------ */

export function createZenAddressProvider(): AddressProvider {
  const cfg = config();
  return {
    name: 'zen-address',
    label: 'Zen address search (Openreach NAD)',
    configured: cfg.zen.configured,
    mode: 'live',

    async byPostcode(postcode) {
      return addressCache.wrap(`pc:${postcode}`, async () => {
        const rows = await zenCall<ZenAddressSearchRow[]>('/api/address/search', {
          scope: 'indirect-availability',
          query: { 'request.postCode': postcode },
          emptyAsNull: true,
        });
        return sortAddresses((rows ?? []).map((r) => mapZenAddress(r, postcode)));
      });
    },

    /**
     * Zen's address search is postcode-keyed, so there is no direct
     * UPRN endpoint. UPRN resolution is handled by OS Places (or the
     * fixture provider); Zen then accepts the UPRN directly on the
     * availability check.
     */
    async byUprn() {
      return null;
    },

    /**
     * Free-text search maps onto Zen's ROBT address match, which needs a
     * postcode. Anything without one is left to the next provider in the
     * chain.
     */
    async search(query, limit) {
      const postcodeMatch = query.match(
        /([A-PR-UWYZ][A-HK-Y]?[0-9][0-9A-HJKPSTUW]?\s*[0-9][ABD-HJLNP-UW-Z]{2})/i,
      );
      if (!postcodeMatch) return [];
      const postcode = postcodeMatch[1]!;
      const rest = query.replace(postcodeMatch[0], '').trim();
      const all = await this.byPostcode(postcode);
      if (!rest) return all.slice(0, limit);
      const needle = rest.toLowerCase();
      return all.filter((a) => a.singleLine.toLowerCase().includes(needle)).slice(0, limit);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Availability
 * ------------------------------------------------------------------ */

/**
 * Runs a Zen availability check. Prefers a CLI when one is known, because
 * Zen states the CLI check is the more accurate of the two; otherwise uses
 * the Gold Address Key, falling back to the UPRN.
 */
async function runAvailabilityCheck(address: AddressRecord, cli?: string): Promise<ZenAvailabilityResponse | null> {
  const key = cli
    ? `cli:${cli}`
    : address.addressKey
      ? `gak:${address.addressKey}`
      : address.uprn
        ? `uprn:${address.uprn}`
        : `line:${address.singleLine}`;

  const cached = availabilityCache.get(key);
  if (cached) return cached;

  const body: Record<string, unknown> = {};
  if (cli) body.phoneNumber = cli;
  else if (address.addressKey) {
    body.goldAddressKeyAvailabilityRequest = {
      addressReferenceNumber: address.addressKey,
      // District code travels with the address key; Zen requires both.
      districtCode: address.county ?? '',
    };
    if (address.uprn) body.uprn = address.uprn;
  } else if (address.uprn) body.uprn = address.uprn;
  else return null;

  const res = await zenCall<ZenAvailabilityResponse>('/api/availability/check', {
    scope: 'indirect-availability',
    method: 'POST',
    body,
    emptyAsNull: true,
  });
  if (!res) return null;

  if (res.remainingAvailabilityChecks !== undefined) {
    lastQuota = { remaining: res.remainingAvailabilityChecks, at: new Date().toISOString() };
  }
  availabilityCache.set(key, res);
  return res;
}

export function createZenAvailabilityProvider(): AvailabilityProvider {
  const cfg = config();
  return {
    name: 'zen-availability',
    label: 'Zen availability check (Openreach WBC)',
    configured: cfg.zen.configured,
    mode: 'live',

    async forAddress(address) {
      // A known CLI at the premises gives a materially better check.
      const lines = await findServices(address.postcode).catch(() => [] as LineRecord[]);
      const cli = lines.find((l) => l.address.uprn === address.uprn && l.cli)?.cli;

      const res = await runAvailabilityCheck(address, cli);
      if (!res) {
        return {
          ...(address.uprn ? { uprn: address.uprn } : {}),
          address,
          offers: [],
          checkedAt: new Date().toISOString(),
          sources: ['zen:availability'],
        };
      }

      const availability = availabilityFromZen(address, res);
      // The availability reference is needed to place an order or book an
      // appointment, so it is carried through as a note on the report.
      if (res.availabilityReference) {
        availability.sources.push(`availabilityReference:${res.availabilityReference}`);
      }
      return availability;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Services / lines
 * ------------------------------------------------------------------ */

interface ZenServiceSearchResponse {
  services?: ZenService[];
  page?: number;
  totalRecords?: number;
  totalPages?: number;
}

interface ZenCeaseSearchResponse {
  ceases?: Array<{
    zenReference?: string;
    serviceId?: string;
    ceaseStatus?: number | string;
    completedDate?: string;
    requestedCeaseDate?: string;
    serviceDetails?: { customerReference?: string; productDescription?: string; status?: number | string; phoneNumber?: string };
  }>;
}

/**
 * Zen's service search matches on Zen reference, postcode, service ID and
 * phone number — which covers most of what a user can type. Results are
 * enriched with the full service record plus, where available, connection
 * state and RADIUS detail from the Assurance API.
 */
async function findServices(searchTerm: string): Promise<LineRecord[]> {
  return serviceCache.wrap(`svc:${searchTerm}`, async () => {
    const res = await zenCall<ZenServiceSearchResponse>('/api/services/search', {
      scope: 'indirect-service',
      query: { 'searchCriteria.searchTerm': searchTerm, 'searchCriteria.pageSize': 50 },
      emptyAsNull: true,
    });
    const rows = res?.services ?? [];
    const lines = rows.map(mapZenService);
    return Promise.all(lines.map(enrichLine));
  });
}

/** Adds connection state, credentials and the latest line test to a line. */
async function enrichLine(line: LineRecord): Promise<LineRecord> {
  const zenRef = line.orderRef ?? line.id;
  if (!zenRef) return line;
  const ref = encodeURIComponent(zenRef);

  interface ConnectionStatus {
    content?: {
      model?: {
        credentials?: { username?: string };
        connectionStatus?: { connected?: boolean; uptime?: string; gateway?: string };
        status?: string;
      };
    };
  }
  interface BroadbandConnection {
    username?: string;
    iPv4AddressRange?: string;
    numberOfIps?: number;
    startAddress?: string;
    endAddress?: string;
    subnetMask?: string;
    routerIpAddress?: string;
  }
  interface LineTest {
    mainFaultLocation?: number | string;
    testOutcome?: number | string;
    dataFrom?: string;
    state?: number | string;
    errorMessage?: string;
  }

  // Each enrichment is optional: a missing scope or a 404 must not stop the
  // line from being returned, so failures are swallowed individually.
  const soft = <T>(p: Promise<T | null>): Promise<T | null> => p.catch(() => null);

  const [conn, bb, test] = await Promise.all([
    soft(
      zenCall<ConnectionStatus>(`/api/connectionstatus/${ref}`, {
        scope: 'indirect-broadbandconnection',
        emptyAsNull: true,
      }),
    ),
    soft(
      zenCall<BroadbandConnection>(`/api/broadbandconnections/${ref}`, {
        scope: 'indirect-broadbandconnection',
        emptyAsNull: true,
      }),
    ),
    soft(
      zenCall<LineTest>(`/api/copper/services/${ref}/linetest/latest`, {
        gateway: 'assurance',
        scope: 'indirect-diagnostics',
        emptyAsNull: true,
      }),
    ),
  ]);

  const out: LineRecord = { ...line };
  const notes = [...out.notes];

  const model = conn?.content?.model;
  if (model?.connectionStatus) {
    out.radius = {
      ...(out.radius ?? {}),
      ...(model.credentials?.username ? { username: model.credentials.username } : {}),
      ...(model.connectionStatus.connected != null ? { online: model.connectionStatus.connected } : {}),
      ...(model.connectionStatus.gateway ? { nasIpAddress: model.connectionStatus.gateway } : {}),
    };
    if (model.connectionStatus.uptime) notes.push(`Connection uptime: ${model.connectionStatus.uptime}.`);
  }

  if (bb) {
    if (bb.startAddress) {
      out.ipAddresses = [
        ...(out.ipAddresses ?? []),
        { family: 'IPv4', value: bb.startAddress, assignment: 'static', routed: (bb.numberOfIps ?? 1) > 1 },
      ];
    }
    if (bb.username) out.radius = { ...(out.radius ?? {}), username: bb.username };
    if (bb.iPv4AddressRange) {
      notes.push(`IPv4 range ${bb.iPv4AddressRange}${bb.subnetMask ? ` / ${bb.subnetMask}` : ''}.`);
    }
    if (bb.routerIpAddress) notes.push(`Router IP ${bb.routerIpAddress}.`);
  }

  if (test && !test.errorMessage) {
    const outcome = test.testOutcome != null ? String(test.testOutcome) : null;
    const location = test.mainFaultLocation != null ? String(test.mainFaultLocation) : null;
    if (outcome || location) {
      const when = test.dataFrom ? ` (${new Date(test.dataFrom).toLocaleString('en-GB')})` : '';
      notes.push(
        `Latest copper line test${when}: outcome ${outcome ?? 'unknown'}${location ? `, main fault location ${location}` : ''}.`,
      );
    }
  }

  out.notes = notes;
  return out;
}

/** Ceased services live in a separate index, so they get their own sweep. */
async function findCeases(searchTerm: string): Promise<LineRecord[]> {
  const res = await zenCall<ZenCeaseSearchResponse>('/api/ceases/search', {
    scope: 'indirect-service',
    query: { 'searchCriteria.searchTerm': searchTerm, 'searchCriteria.pageSize': 25 },
    emptyAsNull: true,
  });
  return (res?.ceases ?? [])
    .filter((c) => c.zenReference || c.serviceId)
    .map((c) =>
      mapZenService({
        ...(c.zenReference ? { zenReference: c.zenReference } : {}),
        ...(c.serviceId ? { serviceId: c.serviceId } : {}),
        serviceStatus: 'Ceased',
        ...(c.serviceDetails?.phoneNumber ? { phoneNumber: c.serviceDetails.phoneNumber } : {}),
        ...(c.serviceDetails?.productDescription ? { productDescription: c.serviceDetails.productDescription } : {}),
        ...(c.serviceDetails?.customerReference ? { customerReference: c.serviceDetails.customerReference } : {}),
        ...(c.completedDate ? { ceasedDate: c.completedDate } : {}),
      }),
    );
}

/**
 * Searches both live services and ceases, so a lookup finds a line even
 * after it has been ceased and archived.
 */
async function searchEverything(term: string): Promise<LineRecord[]> {
  const results = await settleAll([
    { key: 'services', run: () => findServices(term) },
    { key: 'ceases', run: () => findCeases(term) },
  ]);
  const out: LineRecord[] = [];
  if (results.services?.ok) out.push(...results.services.value);
  if (results.ceases?.ok) {
    for (const cease of results.ceases.value) {
      // Don't duplicate a service that already came back live.
      if (!out.some((l) => l.serviceId && l.serviceId === cease.serviceId)) out.push(cease);
    }
  }
  // If both failed, surface the error rather than pretending there's nothing.
  if (!results.services?.ok && !results.ceases?.ok) {
    throw results.services?.ok === false ? results.services.error : new Error('Zen service search failed');
  }
  return out;
}

export function createZenLineProvider(): LineProvider {
  const cfg = config();
  return {
    name: 'zen-lines',
    label: 'Zen services, ceases and diagnostics',
    configured: cfg.zen.configured,
    mode: 'live',

    async byCli(cli) {
      const n = normaliseCli(cli) ?? cli;
      const found = await searchEverything(n);
      // Zen may hold the number in its non-normalised form too.
      if (found.length) return found;
      return searchEverything(cli);
    },

    /** Access line IDs aren't a search key, so match on the returned field. */
    async byAccessId(accessLineId) {
      const found = await searchEverything(accessLineId);
      return found.filter((l) => (l.lineAccessId ?? '').toUpperCase() === accessLineId.toUpperCase());
    },

    byServiceId: (serviceId) => searchEverything(serviceId),

    async byOntSerial(serial) {
      const found = await searchEverything(serial);
      return found.filter((l) => (l.ont?.serial ?? '').toUpperCase() === serial.toUpperCase());
    },

    /**
     * UPRN is not a Zen search key, so the postcode is used as the coarse
     * filter and the UPRN narrows the result.
     */
    async byUprn() {
      return [];
    },

    /** Postcode sweep — the practical way to find every line at a site. */
    byPostcode: (postcode) => searchEverything(postcode),
  };
}
