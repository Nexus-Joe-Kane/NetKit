import type { AccessTechnology, AddressRecord, AvailabilityStatus, BroadbandOffer, NetworkOperator } from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { TtlCache } from '../../lib/cache';
import type { OfferProvider } from '../types';

/**
 * thinkbroadband's UK Broadband Availability API.
 *
 * The reason this exists: no wholesale chain we buy from knows about
 * CityFibre, Virgin Media, Community Fibre and G.Network at once. Zen answers
 * authoritatively for Openreach and nothing else. thinkbroadband aggregate
 * availability across the alt-nets and cable, keyed by postcode and UPRN,
 * which is the one commercially obtainable source that covers all of them
 * without a wholesale agreement per network.
 *
 * It is a *data* licence, not a carrier contract: it tells you who could
 * serve a premises, not how to order it. That is exactly the gap the site
 * report had — an operator would otherwise ring round to find out.
 *
 * ---
 *
 * **The response shape is not publicly documented.** The API page is behind
 * bot protection and thinkbroadband publish field specifications only to
 * licensees. So this mapper is deliberately tolerant in the same way the Zen
 * and BT mappers are:
 *
 * - Several plausible spellings are accepted per field.
 * - Both a flat `{ virginmedia: {...} }` shape and a `{ networks: [...] }`
 *   array shape are read, because either is a reasonable API design and we
 *   cannot yet know which one arrives.
 * - Anything unrecognised is ignored rather than guessed at.
 * - An operator we do not recognise is still surfaced, under its own name,
 *   rather than dropped — a new alt-net appearing is the normal case.
 *
 * When the first live response lands, `__thinkbroadbandTesting.mapPayload`
 * is the single function to adjust, and its tests pin the current behaviour.
 */

/** Operator names the domain model knows, matched loosely against the feed. */
const OPERATOR_ALIASES: Array<[NetworkOperator, string[]]> = [
  ['virgin-media', ['VIRGINMEDIA', 'VIRGIN', 'VMO2', 'VIRGINMEDIAO2', 'NEXFIBRE']],
  ['cityfibre', ['CITYFIBRE', 'CITY']],
  ['community-fibre', ['COMMUNITYFIBRE', 'COMMUNITY']],
  ['hyperoptic', ['HYPEROPTIC', 'HYPER']],
  ['netomnia', ['NETOMNIA', 'YOUFIBRE', 'YOU']],
  ['gigaclear', ['GIGACLEAR']],
  ['trooli', ['TROOLI']],
  ['zzoomm', ['ZZOOMM']],
  ['openreach', ['OPENREACH', 'BTOPENREACH', 'BT']],
];

/**
 * Alt-nets with no slot in `NetworkOperator` yet. They are surfaced under
 * `other` with their real name kept in `operatorLabel`, so a network we have
 * never heard of still shows up correctly rather than being discarded.
 */
const KNOWN_LABELS: Record<string, string> = {
  GNETWORK: 'G.Network',
  GNETWORKCOMMUNICATIONS: 'G.Network',
  FREEDOMFIBRE: 'Freedom Fibre',
  TRUESPEED: 'Truespeed',
  COUNTYBROADBAND: 'County Broadband',
  INTERNETTY: 'Internetty',
  LIGHTSPEED: 'LightSpeed Broadband',
  TOOB: 'toob',
  OGI: 'Ogi',
  GRAIN: 'Grain',
  FIBRUS: 'Fibrus',
  QUICKLINE: 'Quickline',
  MS3: 'MS3',
  AIRBAND: 'Airband',
  GLIDE: 'Glide',
  KCOM: 'KCOM',
  ITS: 'ITS Technology',
  FULLFIBRE: 'Full Fibre Ltd',
  SWISHFIBRE: 'Swish Fibre',
  WESSEXINTERNET: 'Wessex Internet',
  BRSK: 'brsk',
  NETSPEED: 'Netspeed',
};

const squash = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Falls back to the feed's own spelling rather than dropping the operator. */
function identifyOperator(raw: string): { operator: NetworkOperator; label: string } {
  const key = squash(raw);
  for (const [operator, aliases] of OPERATOR_ALIASES) {
    if (aliases.some((a) => key === a)) return { operator, label: prettyLabel(operator, raw) };
  }
  // Substring only after exact match fails, and only for names long enough
  // that a coincidence is unlikely — `BT` inside `GIGABIT` is the trap here.
  for (const [operator, aliases] of OPERATOR_ALIASES) {
    if (aliases.some((a) => a.length >= 6 && key.includes(a))) return { operator, label: prettyLabel(operator, raw) };
  }
  return { operator: 'other', label: KNOWN_LABELS[key] ?? tidy(raw) };
}

const PRETTY: Partial<Record<NetworkOperator, string>> = {
  'virgin-media': 'Virgin Media O2',
  cityfibre: 'CityFibre',
  'community-fibre': 'Community Fibre',
  hyperoptic: 'Hyperoptic',
  netomnia: 'Netomnia / YouFibre',
  gigaclear: 'Gigaclear',
  trooli: 'Trooli',
  zzoomm: 'Zzoomm',
  openreach: 'Openreach',
};

const prettyLabel = (operator: NetworkOperator, raw: string): string => PRETTY[operator] ?? tidy(raw);

/** `community_fibre` → `Community Fibre`, for names we have no entry for. */
function tidy(raw: string): string {
  const words = raw
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return raw;
  return words
    .map((w) =>
      // A word the feed already wrote in capitals is an acronym — ITS, KCOM,
      // MS3 — and stays as it is. Everything else is title-cased. Length is
      // the wrong test: it turns "new" into "NEW".
      w === w.toUpperCase() && /[A-Z]/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(' ');
}

/* ------------------------------------------------------------------ *
 * Tolerant field reading
 * ------------------------------------------------------------------ */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function pick(source: unknown, ...keys: string[]): unknown {
  if (!isObject(source)) return undefined;
  // Case- and separator-insensitive, because feeds disagree about
  // `maxDownload` vs `max_download` vs `maxdownload`.
  const flat = new Map<string, unknown>();
  for (const [k, v] of Object.entries(source)) flat.set(squash(k), v);
  for (const key of keys) {
    const hit = flat.get(squash(key));
    if (hit !== undefined && hit !== null && hit !== '') return hit;
  }
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

function str(source: unknown, ...keys: string[]): string | undefined {
  const v = pick(source, ...keys);
  if (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return undefined;
}

function bool(source: unknown, ...keys: string[]): boolean | undefined {
  const v = pick(source, ...keys);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v > 0;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'available', 'rfs', 'live'].includes(t)) return true;
    if (['false', 'no', 'n', '0', 'unavailable', 'none'].includes(t)) return false;
  }
  return undefined;
}

/**
 * Status from whatever the feed offers.
 *
 * Absent is treated as *available* only when the operator appeared at all —
 * a feed that lists an operator for an address is asserting something. A
 * build/planned marker downgrades it.
 */
function statusFrom(raw: unknown): AvailabilityStatus {
  const text = (str(raw, 'status', 'state', 'availability', 'serviceStatus') ?? '').toUpperCase();
  if (text.includes('WAIT') || text.includes('REGISTER') || text.includes('INTEREST')) return 'waiting_list';
  if (text.includes('PLAN') || text.includes('FUTURE') || text.includes('SURVEY')) return 'build_planned';
  if (text.includes('BUILD') || text.includes('SOON') || text.includes('PROGRESS')) return 'available_soon';
  if (text.includes('DEMAND') || text.includes('ONDEMAND')) return 'on_demand';
  if (text.includes('NOT') || text.includes('UNAVAIL')) return 'not_available';
  if (text.includes('AVAIL') || text.includes('RFS') || text.includes('LIVE') || text.includes('SERVICE')) {
    return 'available';
  }

  // No status string: fall back to the flags a feed of this kind carries.
  if (bool(raw, 'available', 'isAvailable', 'serviceable', 'rfs') === true) return 'available';
  if (bool(raw, 'available', 'isAvailable', 'serviceable', 'rfs') === false) return 'not_available';
  if (bool(raw, 'planned', 'inBuild', 'building', 'underConstruction') === true) return 'available_soon';
  return 'unknown';
}

/** Cable is DOCSIS, everything else in this feed is PON of some flavour. */
function technologyFrom(operator: NetworkOperator, raw: unknown): AccessTechnology {
  const text = (str(raw, 'technology', 'tech', 'product', 'type') ?? '').toUpperCase().replace(/[\s._-]/g, '');
  if (text.includes('DOCSIS') || text.includes('CABLE') || text.includes('HFC')) return 'DOCSIS3.1';
  if (text.includes('XGSPON') || text.includes('XGS')) return 'XGS-PON';
  if (text.includes('GPON') || text.includes('FTTP') || text.includes('FIBRE') || text.includes('FIBER')) return 'FTTP';
  if (text.includes('FWA') || text.includes('WIRELESS')) return 'FWA';
  if (text.includes('FTTC') || text.includes('VDSL')) return 'FTTC';
  return operator === 'virgin-media' ? 'DOCSIS3.1' : 'XGS-PON';
}

/**
 * Maps one payload to offers.
 *
 * Accepts either shape, because the feed's own is unknown until a licence
 * exists: a keyed object of operators, or an array under `networks`.
 */
function mapPayload(payload: unknown): BroadbandOffer[] {
  const entries: Array<{ name: string; detail: unknown }> = [];

  const arrayish =
    pick(payload, 'networks', 'operators', 'providers', 'results', 'availability', 'wholesale') ?? payload;

  if (Array.isArray(arrayish)) {
    for (const row of arrayish) {
      const name = str(row, 'operator', 'network', 'provider', 'name', 'brand');
      if (name) entries.push({ name, detail: row });
    }
  } else if (isObject(arrayish)) {
    for (const [key, value] of Object.entries(arrayish)) {
      // Skip envelope fields; an operator entry is an object or a flag.
      if (['postcode', 'uprn', 'address', 'status', 'error', 'message', 'timestamp', 'query'].includes(squash(key).toLowerCase())) {
        continue;
      }
      if (isObject(value) || typeof value === 'boolean') entries.push({ name: key, detail: value });
    }
  }

  const offers: BroadbandOffer[] = [];
  let index = 0;

  for (const { name, detail } of entries) {
    const { operator, label } = identifyOperator(name);
    // Openreach comes from Zen, authoritatively and with engineering detail.
    // A second opinion here would only ever contradict it confusingly.
    if (operator === 'openreach') continue;

    const status = typeof detail === 'boolean' ? (detail ? 'available' : 'not_available') : statusFrom(detail);
    if (status === 'not_available') continue;

    const down = num(detail, 'maxDownload', 'downloadSpeed', 'speed', 'maxSpeed', 'downMbps', 'download');
    const up = num(detail, 'maxUpload', 'uploadSpeed', 'upMbps', 'upload');

    offers.push({
      id: `tbb-${(index += 1)}`,
      operator,
      operatorLabel: label,
      technology: technologyFrom(operator, detail),
      status,
      // A postcode-keyed aggregate is footprint, not a serviceability check.
      // Only an explicit per-premises answer earns `confirmed`.
      serviceability: bool(detail, 'premisesConfirmed', 'addressChecked', 'serviceable') === true ? 'confirmed' : 'footprint',
      speeds: {
        ...(down != null ? { downMbpsHigh: down } : {}),
        ...(up != null ? { upMbpsHigh: up } : {}),
        basis: 'headline',
      },
      ...(str(detail, 'productName', 'product', 'package') ? { productName: str(detail, 'productName', 'product', 'package') } : {}),
      ...(str(detail, 'readyDate', 'rfsDate', 'expectedDate') ? { rfsDate: str(detail, 'readyDate', 'rfsDate', 'expectedDate') } : {}),
      notes: [
        ...(str(detail, 'note', 'notes', 'comment') ? [str(detail, 'note', 'notes', 'comment')!] : []),
        // Said plainly on every row, because it is the thing that gets
        // forgotten between the screen and the customer.
        'Coverage data only — not resellable through our wholesale account. Confirm with the network before quoting.',
      ],
      source: 'thinkbroadband',
    });
  }

  return offers;
}

/* ------------------------------------------------------------------ *
 * The provider
 * ------------------------------------------------------------------ */

// Alt-net footprints move in months, not minutes, and the licence is metered.
const cache = new TtlCache<BroadbandOffer[]>(12 * 60 * 60 * 1000, 2000);

async function fetchOffers(address: AddressRecord): Promise<BroadbandOffer[]> {
  const cfg = config().thinkbroadband;
  // UPRN is the more precise key where we have one; postcode is the fallback.
  const key = address.uprn ? `uprn:${address.uprn}` : `pc:${address.postcode.replace(/\s+/g, '').toUpperCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const query = new URLSearchParams({
    ...(address.uprn ? { uprn: address.uprn } : {}),
    postcode: address.postcode,
    ...(cfg.apiKeyInQuery ? { key: cfg.apiKey } : {}),
  });

  const payload = await fetchJson<unknown>(`${cfg.baseUrl}${cfg.availabilityPath}?${query.toString()}`, {
    label: 'thinkbroadband',
    // Both auth styles are sent unless the key goes in the query string.
    // Which one the licence uses is not published; an unused header is
    // harmless, and this avoids a failed first call on day one.
    headers: cfg.apiKeyInQuery
      ? {}
      : { Authorization: `Bearer ${cfg.apiKey}`, 'X-API-Key': cfg.apiKey },
    timeoutMs: Math.min(config().requestTimeoutMs, 8000),
    retries: 1,
    notFoundAsNull: true,
  });

  const offers = payload ? mapPayload(payload) : [];
  cache.set(key, offers);
  return offers;
}

export function createThinkbroadbandProvider(): OfferProvider {
  const cfg = config().thinkbroadband;
  return {
    name: 'thinkbroadband',
    label: 'thinkbroadband alt-net & cable coverage',
    configured: cfg.configured,
    mode: 'live',
    forAddress: fetchOffers,
  };
}

/** Drops the cache, for the recovery supervisor. */
export function clearThinkbroadbandCache(): void {
  cache.clear();
}

/** Test hook. */
export const __thinkbroadbandTesting = { mapPayload, identifyOperator, statusFrom, technologyFrom, tidy };
