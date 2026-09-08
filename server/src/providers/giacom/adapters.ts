import {
  formatPostcode,
  normaliseCli,
  type AccessTechnology,
  type AddressRecord,
  type AvailabilityStatus,
  type BroadbandOffer,
  type LineRecord,
  type LineStatus,
  type NetworkOperator,
} from '@sw/shared';
import { config } from '../../config';
import { TtlCache } from '../../lib/cache';
import { giacomCall, giacomReady } from './client';
import type { LineProvider, OfferProvider } from '../types';

/**
 * Giacom (formerly Digital Wholesale Solutions) adapters.
 *
 * The second wholesale supplier, and the reason it matters: Zen answers for
 * Openreach and nothing else, while Giacom carry BT Wholesale, CityFibre,
 * TalkTalk Business, Virgin Media Business and Sky Business. The same
 * premises can be sellable through both accounts at different prices, so
 * their answers are *merged* into the report as separate rows tagged by
 * supplier rather than one replacing the other.
 *
 * Built against their published OpenAPI document, which is TM Forum Open API
 * shaped. What is in it, and what this uses:
 *
 * | Endpoint | Used for |
 * | --- | --- |
 * | `GET /service`, `GET /service/{id}` | Service inventory — live *and* ceased lines |
 * | `POST /geographicAddressValidation` | Address matching, returning the Openreach ALK |
 * | `GET /serviceSpecification` | The product catalogue |
 *
 * **Two gaps worth knowing about**, both established by reading their spec
 * rather than assumed:
 *
 * 1. There is **no trouble-ticket or diagnostics endpoint** — no TMF621, no
 *    service test. A Giacom-supplied line can be listed and inspected here
 *    but faults and line tests stay with Zen-supplied lines only.
 * 2. `serviceQualification.read` and `.submit` appear in their OAuth scope
 *    list, but **no path for ServiceQualification appears in the public
 *    document**. So per-address serviceability exists as an entity and is
 *    granted per tenant. `GIACOM_QUALIFICATION_PATH` turns it on the moment
 *    Giacom confirm the path — until then this adapter reads inventory and
 *    catalogue only, and never guesses at availability.
 */

/* ------------------------------------------------------------------ *
 * Tolerant reading
 *
 * TM Forum leaves a lot to the implementer, and Giacom's own field naming is
 * only partly visible in the public document, so the same discipline applies
 * as for Zen: accept several spellings, treat the literal "string" as
 * absent, and fall back rather than guess.
 * ------------------------------------------------------------------ */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const squash = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

function pick(source: unknown, ...keys: string[]): unknown {
  if (!isObject(source)) return undefined;
  const flat = new Map<string, unknown>();
  for (const [k, v] of Object.entries(source)) flat.set(squash(k), v);
  for (const key of keys) {
    const hit = flat.get(squash(key));
    if (hit !== undefined && hit !== null && hit !== '') return hit;
  }
  return undefined;
}

function str(source: unknown, ...keys: string[]): string | undefined {
  const v = pick(source, ...keys);
  if (typeof v === 'string') {
    const t = v.trim();
    return t && t.toLowerCase() !== 'string' ? t : undefined;
  }
  if (typeof v === 'number') return String(v);
  return undefined;
}

function num(source: unknown, ...keys: string[]): number | undefined {
  const v = pick(source, ...keys);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const parsed = Number.parseFloat(v.replace(/[^\d.]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function arr(source: unknown, ...keys: string[]): unknown[] {
  const v = pick(source, ...keys);
  if (Array.isArray(v)) return v;
  return [];
}

/**
 * TM Forum models most detail as `characteristic: [{name, value}]`, so the
 * interesting fields are one level down from where you would expect them.
 */
function characteristic(source: unknown, ...names: string[]): string | undefined {
  const wanted = names.map(squash);
  for (const key of ['serviceCharacteristic', 'characteristic', 'resourceCharacteristic', 'attributes']) {
    for (const entry of arr(source, key)) {
      const name = str(entry, 'name', 'id');
      if (name && wanted.includes(squash(name))) {
        const value = pick(entry, 'value');
        if (typeof value === 'string' || typeof value === 'number') return String(value).trim() || undefined;
        // A nested `{value: {value: …}}` is common in TMF payloads.
        const inner = str(value, 'value', 'name');
        if (inner) return inner;
      }
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Service inventory → lines
 * ------------------------------------------------------------------ */

/** TMF `state` plus Giacom's own wording, mapped to our line status. */
function lineStatusFrom(raw: unknown): LineStatus {
  const v = (str(raw, 'state', 'status', 'serviceState', 'lifecycleState') ?? '').toUpperCase();
  if (v.includes('TERMINAT') || v.includes('CEASE') || v.includes('INACTIVE')) return 'ceased';
  if (v.includes('SUSPEND')) return 'suspended';
  // TMF states do not distinguish provide from cease from modify, so the
  // least specific of ours is the honest mapping.
  if (v.includes('PENDING') || v.includes('DESIGN') || v.includes('RESERVED') || v.includes('FEASIB')) {
    return 'pending_provide';
  }
  if (v.includes('ACTIVE') || v.includes('LIVE')) return 'active';
  return 'unknown';
}

function technologyFromName(name: string): AccessTechnology {
  const v = name.toUpperCase().replace(/[\s._-]/g, '');
  // Order matters: the more specific product name has to be tested first,
  // because several contain the others as substrings. `EoFTTC` contains
  // `FTTC`, and matching FTTC first quietly mislabels every Ethernet
  // first-mile circuit as a broadband line.
  if (v.includes('EOFTTC')) return 'EoFTTC';
  if (v.includes('XGSPON')) return 'XGS-PON';
  if (v.includes('SOGFAST')) return 'SOGFAST';
  if (v.includes('SOGEA')) return 'SOGEA';
  if (v.includes('FTTP') || v.includes('FULLFIBRE') || v.includes('GEAFTTP')) return 'FTTP';
  if (v.includes('GFAST')) return 'GFAST';
  if (v.includes('FTTC') || v.includes('GEAFTTC') || v.includes('VDSL')) return 'FTTC';
  if (v.includes('SOADSL') || v.includes('ADSL')) return 'ADSL2+';
  if (v.includes('DOCSIS') || v.includes('CABLE')) return 'DOCSIS3.1';
  if (v.includes('EAD')) return 'EAD';
  if (v.includes('ETHERNET') || v.includes('LEASED')) return 'Leased Line';
  return 'Unknown';
}

function mapService(raw: unknown, fallbackAddress?: AddressRecord): LineRecord | null {
  const id = str(raw, 'id', 'serviceId', 'href');
  if (!id) return null;

  const name = str(raw, 'name', 'serviceType', 'category') ?? '';
  const cli = normaliseCli(
    str(raw, 'phoneNumber', 'cli', 'telephoneNumber') ?? characteristic(raw, 'phoneNumber', 'cli', 'telephoneNumber') ?? '',
  );
  const accessLineId = str(raw, 'accessLineId') ?? characteristic(raw, 'accessLineId', 'alk', 'addressKey');
  const supplier = str(raw, 'supplier', 'vendor') ?? characteristic(raw, 'supplier', 'network', 'carrier');
  const downstream = num(raw, 'downstreamSpeed') ?? Number.parseFloat(characteristic(raw, 'downstreamSpeed', 'downloadSpeed') ?? '');
  const upstream = num(raw, 'upstreamSpeed') ?? Number.parseFloat(characteristic(raw, 'upstreamSpeed', 'uploadSpeed') ?? '');
  const ip = characteristic(raw, 'ipAddress', 'wanIp', 'staticIp');

  return {
    id,
    ...(cli ? { cli } : {}),
    ...(accessLineId ? { lineAccessId: accessLineId } : {}),
    ...(str(raw, 'serviceId', 'externalId') ? { serviceId: str(raw, 'serviceId', 'externalId') } : {}),
    ...(str(raw, 'id') ? { orderRef: str(raw, 'id') } : {}),
    technology: technologyFromName(`${name} ${characteristic(raw, 'productName', 'product') ?? ''}`),
    status: lineStatusFrom(raw),
    // The supplier is the point of this integration: it is what tells you
    // which account a line is on, and therefore who to ring about it.
    provider: supplier ? `Giacom (${supplier})` : 'Giacom',
    address: fallbackAddress ?? {
      singleLine: str(raw, 'address', 'installationAddress') ?? 'Address not returned',
      lines: [],
      postTown: '',
      postcode: formatPostcode(str(raw, 'postcode', 'postCode') ?? ''),
      // Giacom's inventory carries no UPRN and no full address breakdown, so
      // this is a stub the caller replaces with the resolved premises.
      source: 'zen',
    },
    ...(str(raw, 'startDate', 'serviceDate', 'activationDate')
      ? { activatedAt: str(raw, 'startDate', 'serviceDate', 'activationDate') }
      : {}),
    ...(Number.isFinite(downstream) || Number.isFinite(upstream)
      ? {
          sync: {
            ...(Number.isFinite(downstream) ? { downstreamSyncKbps: Math.round(downstream * 1000) } : {}),
            ...(Number.isFinite(upstream) ? { upstreamSyncKbps: Math.round(upstream * 1000) } : {}),
          },
        }
      : {}),
    ...(ip ? { ipAddresses: [{ family: 'IPv4' as const, value: ip, assignment: 'static' as const }] } : {}),
    discoveredVia: 'giacom',
    notes: [
      ...(supplier ? [`Supplied through Giacom on ${supplier}.`] : ['Supplied through Giacom.']),
      // Said on the record, because someone will open this line looking for a
      // test button and needs to know why there isn't one.
      'Giacom publish no fault or diagnostics API, so line tests and fault raising are not available for this service.',
    ],
  };
}

// Ceased services are in here too, so the cache is short: an operator
// checking a line they have just ordered must not see a stale answer.
const serviceCache = new TtlCache<LineRecord[]>(5 * 60 * 1000, 500);

async function servicesBy(params: Record<string, string | undefined>, address?: AddressRecord): Promise<LineRecord[]> {
  const key = JSON.stringify(params);
  const hit = serviceCache.get(key);
  if (hit) return hit;

  const json = await giacomCall<unknown>('/service', {
    scope: 'integrations/serviceInventory.read',
    query: { ...params, limit: 50 },
    emptyAsNull: true,
  });

  const rows = Array.isArray(json) ? json : arr(json, 'service', 'services', 'results', 'items', 'data');
  const lines = rows.map((r) => mapService(r, address)).filter((l): l is LineRecord => l !== null);
  serviceCache.set(key, lines);
  return lines;
}

/**
 * Giacom-supplied lines, so a premises shows every service on it regardless
 * of which of the two accounts it was bought through.
 *
 * Giacom's inventory has no UPRN key — TM Forum addresses here are keyed on
 * the Openreach ALK — so a UPRN lookup falls back to the postcode and the
 * caller filters. That is the same compromise the Zen line provider makes.
 */
export function createGiacomLineProvider(): LineProvider {
  return {
    name: 'giacom-services',
    label: 'Giacom service inventory',
    configured: giacomReady('integrations/serviceInventory.read'),
    mode: 'live',
    byCli: (cli) => servicesBy({ phoneNumber: cli }),
    byAccessId: (accessLineId) => servicesBy({ accessLineId }),
    byServiceId: (serviceId) => servicesBy({ id: serviceId }),
    // Giacom key nothing on an ONT serial, so this is honestly empty rather
    // than a postcode sweep that would return unrelated lines.
    byOntSerial: async () => [],
    byUprn: async () => [],
    byPostcode: (postcode) => servicesBy({ postcode: formatPostcode(postcode) }),
  };
}

/* ------------------------------------------------------------------ *
 * Address validation → the Openreach ALK
 * ------------------------------------------------------------------ */

export interface GiacomAddressMatch {
  alk?: string;
  singleLine?: string;
  postcode?: string;
  /** Alternatives, when Giacom cannot resolve to one premises. */
  alternatives: Array<{ alk?: string; singleLine?: string }>;
  source: string;
}

/**
 * A second opinion on the Openreach address key.
 *
 * Giacom validate against BT Wholesale's address database, so where their
 * ALK differs from the one Zen returns, that disagreement is the usual
 * reason an order is rejected. Worth having both on one screen.
 */
export async function validateGiacomAddress(address: {
  postcode: string;
  buildingNumber?: string;
  buildingName?: string;
  thoroughfare?: string;
  postTown?: string;
}): Promise<GiacomAddressMatch> {
  const json = await giacomCall<unknown>('/geographicAddressValidation', {
    scope: 'integrations/address.manage',
    method: 'POST',
    body: {
      submittedGeographicAddress: {
        postcode: address.postcode,
        ...(address.buildingNumber ? { streetNr: address.buildingNumber } : {}),
        ...(address.buildingName ? { streetName: address.buildingName } : {}),
        ...(address.thoroughfare ? { streetName: address.thoroughfare } : {}),
        ...(address.postTown ? { city: address.postTown } : {}),
      },
    },
    emptyAsNull: true,
  });

  const best = pick(json, 'validGeographicAddress', 'bestMatchGeographicAddress', 'geographicAddress');
  const alternatives = arr(json, 'alternateGeographicAddress', 'alternatives', 'geographicAddress').map((a) => ({
    ...(str(a, 'alk', 'addressKey', 'id') ? { alk: str(a, 'alk', 'addressKey', 'id') } : {}),
    ...(str(a, 'formattedAddress', 'singleLine', 'streetName')
      ? { singleLine: str(a, 'formattedAddress', 'singleLine', 'streetName') }
      : {}),
  }));

  return {
    ...(str(best, 'alk', 'addressKey', 'id') ? { alk: str(best, 'alk', 'addressKey', 'id') } : {}),
    ...(str(best, 'formattedAddress', 'singleLine') ? { singleLine: str(best, 'formattedAddress', 'singleLine') } : {}),
    ...(str(best, 'postcode', 'postCode') ? { postcode: str(best, 'postcode', 'postCode') } : {}),
    alternatives,
    source: 'giacom',
  };
}

/* ------------------------------------------------------------------ *
 * Service qualification → offers
 * ------------------------------------------------------------------ */

function operatorFromSupplier(supplier: string): { operator: NetworkOperator; label: string } {
  const v = squash(supplier);
  if (v.includes('CITYFIBRE')) return { operator: 'cityfibre', label: 'CityFibre' };
  if (v.includes('VIRGIN') || v.includes('VMO2') || v.includes('NEXFIBRE')) {
    return { operator: 'virgin-media', label: 'Virgin Media O2' };
  }
  // BT Wholesale, TalkTalk and Sky all resell the Openreach access network,
  // so the operator is Openreach and the supplier is the commercial route.
  return { operator: 'openreach', label: 'Openreach' };
}

function statusFromQualification(raw: unknown): AvailabilityStatus {
  const v = (str(raw, 'state', 'qualificationResult', 'serviceQualificationResult', 'result') ?? '').toUpperCase();
  if (v.includes('UNQUALIF') || v.includes('UNAVAIL') || v.includes('REJECT') || v.includes('FAIL')) {
    return 'not_available';
  }
  if (v.includes('CONDITION') || v.includes('PARTIAL')) return 'on_demand';
  if (v.includes('QUALIF') || v.includes('AVAIL') || v.includes('DONE') || v.includes('SUCCESS')) return 'available';
  return 'unknown';
}

const qualificationCache = new TtlCache<BroadbandOffer[]>(6 * 60 * 60 * 1000, 1000);

/**
 * Per-address serviceability through Giacom.
 *
 * Off until `GIACOM_QUALIFICATION_PATH` is set, because the scope exists in
 * Giacom's OAuth list but no path for it appears in their public document —
 * it is granted and documented per tenant. Guessing the path would produce
 * confident 404s that look like "no coverage", which is the worst possible
 * failure for this particular screen.
 */
async function qualifyAddress(address: AddressRecord): Promise<BroadbandOffer[]> {
  const giacom = config().giacom;
  if (!giacom.qualificationPath) return [];

  const key = address.addressKey ?? address.uprn ?? address.singleLine;
  const hit = qualificationCache.get(key);
  if (hit) return hit;

  const json = await giacomCall<unknown>(giacom.qualificationPath, {
    scope: 'integrations/serviceQualification.submit',
    method: 'POST',
    body: {
      // TMF645 shape. The address key is what Giacom's own address
      // validation returns, so an order can be built from the same value.
      serviceQualificationItem: [
        {
          service: {
            place: [
              {
                '@type': 'GeographicAddress',
                postcode: address.postcode,
                ...(address.addressKey ? { alk: address.addressKey } : {}),
                ...(address.uprn ? { uprn: address.uprn } : {}),
              },
            ],
          },
        },
      ],
    },
    emptyAsNull: true,
  });

  const items = arr(json, 'serviceQualificationItem', 'qualificationItem', 'results', 'items');
  const offers: BroadbandOffer[] = [];
  let index = 0;

  for (const item of items) {
    const status = statusFromQualification(item);
    if (status === 'not_available' || status === 'unknown') continue;

    const productName =
      str(item, 'productName', 'name') ?? characteristic(item, 'productName', 'product') ?? str(item, 'serviceSpecification');
    const supplier = str(item, 'supplier', 'network', 'carrier') ?? characteristic(item, 'supplier', 'network') ?? '';
    const { operator, label } = operatorFromSupplier(supplier);
    const down = num(item, 'downstreamSpeed', 'maxDownload') ?? Number.parseFloat(characteristic(item, 'downstreamSpeed') ?? '');
    const up = num(item, 'upstreamSpeed', 'maxUpload') ?? Number.parseFloat(characteristic(item, 'upstreamSpeed') ?? '');

    offers.push({
      id: `giacom-${(index += 1)}`,
      operator,
      operatorLabel: label,
      // The whole point of showing both suppliers: which account to buy on.
      retailer: 'giacom',
      technology: technologyFromName(`${productName ?? ''} ${supplier}`),
      status,
      // Qualification is a per-address answer, which is exactly what
      // `confirmed` means — unlike a postcode-level coverage feed.
      serviceability: 'confirmed',
      speeds: {
        ...(Number.isFinite(down) ? { downMbpsHigh: down } : {}),
        ...(Number.isFinite(up) ? { upMbpsHigh: up } : {}),
        basis: 'headline',
      },
      ...(productName ? { productName } : {}),
      ...(str(item, 'productCode', 'serviceSpecificationId', 'id') ? { productCode: str(item, 'productCode', 'serviceSpecificationId', 'id') } : {}),
      orderable: status === 'available',
      notes: [
        supplier ? `Available through Giacom on ${supplier}.` : 'Available through Giacom.',
        ...(str(item, 'note', 'description') ? [str(item, 'note', 'description')!] : []),
      ],
      source: 'giacom:qualification',
    });
  }

  qualificationCache.set(key, offers);
  return offers;
}

export function createGiacomOfferProvider(): OfferProvider {
  const giacom = config().giacom;
  return {
    name: 'giacom-qualification',
    label: 'Giacom serviceability',
    // Both the scope and a confirmed path are required — see `qualifyAddress`.
    configured: giacomReady('integrations/serviceQualification.submit') && Boolean(giacom.qualificationPath),
    mode: 'live',
    forAddress: qualifyAddress,
  };
}

/** Recovery hook — drops cached Giacom results. */
export function clearGiacomCaches(): void {
  serviceCache.clear();
  qualificationCache.clear();
}

/** Test hooks. */
export const __giacomTesting = {
  mapService,
  lineStatusFrom,
  technologyFromName,
  operatorFromSupplier,
  statusFromQualification,
  characteristic,
};
