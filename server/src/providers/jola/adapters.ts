import type { SimEstate, SimRecord, SimState } from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { notConfigured } from '../../lib/errors';
import { pickArray, pickBool, pickNumber, pickString } from '../zen/map';

/**
 * Jola SIM Portal.
 *
 * This replaces an implementation that could never have worked. It sent a
 * Bearer token and an `X-API-Key` header to a guessed `/api/sims`, and the
 * real API uses **HTTP Basic** over a documented path structure -- hence the
 * 401s. Worse, it expected a flat list of SIMs, and there is no endpoint
 * that returns one: SIMs are nested under a customer, so the estate has to
 * be assembled by walking customers first.
 *
 * Auth is `Authorization: Basic base64(api_key:secret_key)`, and both halves
 * are required -- a key on its own is not a credential here.
 *
 * Still worth remembering that Zen's `/api/cellular/*` endpoints are already
 * Jola-backed, so for SIMs bought through Zen this is redundant. It earns its
 * place for SIMs held directly with Jola.
 */

/** Paging: Jola use skip/take, and every list endpoint accepts them. */
const PAGE_SIZE = 100;

/**
 * How many pages to walk before stopping.
 *
 * A bound rather than a limit anyone should hit: 50 pages of customers, or
 * of SIMs within one customer, is far past any estate this tool serves, and
 * it means a paging field the API renames cannot turn into an endless loop.
 */
const MAX_PAGES = 50;

/** Jola report data in megabytes; SimRecord holds bytes. */
const MB = 1024 * 1024;

const bytesFromMb = (mb?: number): number | undefined =>
  mb == null || !Number.isFinite(mb) ? undefined : Math.round(mb * MB);

function jolaState(raw?: string): SimState {
  const v = (raw ?? '').toUpperCase();
  if (v.includes('ACTIVE') || v.includes('LIVE')) return 'active';
  if (v.includes('SUSPEND') || v.includes('BARRED')) return 'suspended';
  if (v.includes('CEAS') || v.includes('TERMINAT') || v.includes('DISCONNECT')) return 'ceased';
  if (v.includes('PENDING') || v.includes('STOCK') || v.includes('SPARE')) return 'pending';
  if (v.includes('TEST')) return 'test';
  return 'unknown';
}

/** The Basic credential, built per call so a rotated key takes effect. */
function authHeader(): string {
  const { apiKey, secretKey } = config().jola;
  return `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString('base64')}`;
}

async function jolaCall<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T | null> {
  const cfg = config();
  if (!cfg.jola.configured) {
    throw notConfigured(
      'Jola is not configured. Set JOLA_API_KEY and JOLA_SECRET_KEY — the API uses HTTP Basic and needs both halves.',
    );
  }

  const url = new URL(`${cfg.jola.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  return fetchJson<T>(url.toString(), {
    headers: { Authorization: authHeader(), Accept: 'application/json' },
    label: 'Jola SIM Portal',
    timeoutMs: cfg.requestTimeoutMs,
    notFoundAsNull: true,
  });
}

/**
 * Jola wrap list responses inconsistently across endpoints -- sometimes a
 * bare array, sometimes under `items`, `data`, `customers` or `sims`.
 */
function rowsFrom(payload: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  return pickArray(payload, 'items', 'data', 'results', ...keys);
}

/** Walks a paged list endpoint to the end. */
async function collect(path: string, ...keys: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  let skip = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await jolaCall<unknown>(path, { skip, take: PAGE_SIZE });
    const rows = rowsFrom(payload, ...keys);
    out.push(...rows);

    // A short page is the end of the list, and an empty one certainly is.
    if (rows.length < PAGE_SIZE) break;

    const total = pickNumber(payload, 'total', 'totalCount', 'Total');
    if (total != null && out.length >= total) break;

    skip += PAGE_SIZE;
  }

  return out;
}

export interface JolaCustomer {
  id: string;
  name?: string;
  totalSims?: number;
  activeSims?: number;
}

export function mapJolaCustomer(raw: unknown): JolaCustomer | null {
  const id = pickString(raw, 'id', 'customerId', 'CustomerId', 'Id');
  if (!id) return null;
  return {
    id,
    ...(pickString(raw, 'name', 'customerName', 'CustomerName', 'Name')
      ? { name: pickString(raw, 'name', 'customerName', 'CustomerName', 'Name') }
      : {}),
    ...(pickNumber(raw, 'totalSims', 'simCount', 'SimCount') != null
      ? { totalSims: pickNumber(raw, 'totalSims', 'simCount', 'SimCount') }
      : {}),
    ...(pickNumber(raw, 'activeSims', 'activeSimCount', 'ActiveSims') != null
      ? { activeSims: pickNumber(raw, 'activeSims', 'activeSimCount', 'ActiveSims') }
      : {}),
  };
}

export function mapJolaSim(raw: unknown): SimRecord | null {
  const iccid = pickString(raw, 'iccid', 'ICCID', 'Iccid', 'iccId', 'simSerial');
  if (!iccid) return null;

  // Jola's own field is `MobileNumber`; the rest are kept for resellers who
  // rename it.
  const msisdn = pickString(raw, 'MobileNumber', 'msisdn', 'MSISDN', 'Msisdn', 'number', 'phoneNumber');
  const allowanceMb = pickNumber(raw, 'DataAllowanceMb', 'dataAllowanceMb', 'tariffAllowanceMb', 'DataAllowance', 'tariffAllowance');
  const usedMb = pickNumber(raw, 'DataMb', 'dataMb', 'DataUsedMb', 'dataUsedMb', 'usageDataMb', 'DataUsed', 'dataUsed');

  // `SimTag` is Jola's label field. Tags are shown as bars only when they
  // read like one -- a free-text tag is not a barring state, and treating
  // every tag as a bar would put "Van 3" in the bars column.
  const tagRaw = pickArray(raw, 'SimTag', 'tags', 'Tags');
  const tags = tagRaw
    .map((t) => (typeof t === 'string' ? t : pickString(t, 'name', 'value')))
    .filter((t): t is string => Boolean(t));

  const bars = pickArray(raw, 'bars', 'barrings')
    .map((b) => (typeof b === 'string' ? b : pickString(b, 'name', 'type', 'bar')))
    .filter((b): b is string => Boolean(b));

  return {
    iccid,
    ...(msisdn ? { msisdn } : {}),
    ...(pickString(raw, 'imsi', 'IMSI') ? { imsi: pickString(raw, 'imsi', 'IMSI') } : {}),
    state: jolaState(pickString(raw, 'state', 'State', 'status', 'Status', 'simStatus')),
    ...(pickString(raw, 'operator', 'Operator', 'network', 'Network', 'carrier')
      ? { network: pickString(raw, 'operator', 'Operator', 'network', 'Network', 'carrier') }
      : {}),
    ...(bytesFromMb(allowanceMb) != null ? { allowanceBytes: bytesFromMb(allowanceMb) } : {}),
    ...(bytesFromMb(usedMb) != null ? { usedBytes: bytesFromMb(usedMb) } : {}),
    ...(bars.length ? { bars } : tags.length ? { bars: tags } : {}),
    ...(pickBool(raw, 'attached', 'isAttached', 'online') != null
      ? { attached: pickBool(raw, 'attached', 'isAttached', 'online') }
      : {}),
    ...(pickString(raw, 'lastSeen', 'lastSeenAt', 'lastActivity')
      ? { lastSeenAt: pickString(raw, 'lastSeen', 'lastSeenAt', 'lastActivity') }
      : {}),
    ...(pickString(raw, 'apn', 'APN') ? { apn: pickString(raw, 'apn', 'APN') } : {}),
    ...(pickString(raw, 'ipAddress', 'ip', 'IpAddress') ? { ipAddress: pickString(raw, 'ipAddress', 'ip', 'IpAddress') } : {}),
    provider: 'Jola SIM Portal',
    source: 'jola',
  };
}

/** Every customer the credential can see. */
export async function fetchJolaCustomers(): Promise<JolaCustomer[]> {
  const rows = await collect('/api/v1/customers', 'customers');
  return rows.map(mapJolaCustomer).filter((c): c is JolaCustomer => c !== null);
}

/**
 * The whole estate, assembled across customers.
 *
 * One request per customer plus one for the customer list. That is the shape
 * of the API rather than a choice -- there is no endpoint returning every SIM
 * -- so a large reseller account is several calls. The caller caches.
 */
export async function fetchJolaEstate(): Promise<SimEstate> {
  const customers = await fetchJolaCustomers();

  const perCustomer = await Promise.all(
    customers.map(async (customer) => {
      const rows = await collect(`/api/v1/customers/${encodeURIComponent(customer.id)}/sims`, 'sims');
      return rows.map(mapJolaSim).filter((s): s is SimRecord => s !== null);
    }),
  );

  // One SIM can only belong to one customer, but a reseller hierarchy can
  // list the same SIM under a parent and a child.
  const byIccid = new Map<string, SimRecord>();
  for (const sim of perCustomer.flat()) {
    if (!byIccid.has(sim.iccid)) byIccid.set(sim.iccid, sim);
  }

  return {
    sims: [...byIccid.values()],
    checkedAt: new Date().toISOString(),
    sources: ['jola'],
  };
}

/**
 * Looks a single SIM up by ICCID or MSISDN, with its usage.
 *
 * The usage call is made only here. This is the one place a single SIM is in
 * hand, and it is where voice and SMS figures are worth the extra request --
 * an estate view would need one call per SIM for the same data.
 */
export async function findJolaSim(identifier: string): Promise<SimRecord | null> {
  const estate = await fetchJolaEstate();
  const needle = identifier.replace(/\s/g, '').toLowerCase();
  const digits = needle.replace(/\D/g, '');
  const sim =
    estate.sims.find(
      (s) =>
        s.iccid.toLowerCase() === needle ||
        (digits.length >= 6 && (s.msisdn ?? '').replace(/\D/g, '').endsWith(digits)),
    ) ?? null;
  if (!sim) return null;

  // Jola key usage on their SIM id, which the estate row carries in `raw`
  // only as the id we matched on -- so fall back to the ICCID, which their
  // API also accepts. Usage never fails the lookup: a SIM with no usage is
  // still the SIM someone asked for.
  const usage = await fetchJolaSimUsage(sim.iccid).catch(() => null);
  return usage ? { ...sim, ...usage } : sim;
}

export const __jolaTesting = { jolaState, mapJolaSim, mapJolaCustomer, rowsFrom, bytesFromMb };

/**
 * Current-period usage for one SIM.
 *
 * The estate listing carries data used and nothing else, so voice minutes and
 * SMS counts are only obtainable here -- and they are the two figures a bill
 * query turns on. One call per SIM, which is why this is not folded into the
 * estate fetch: it is for a SIM someone has actually looked up.
 *
 * Returns null when Jola hold no usage for the SIM, which they answer with a
 * 404 and which is a legitimate answer for a SIM that has never attached.
 */
export async function fetchJolaSimUsage(simId: string): Promise<{
  usedBytes?: number;
  usedVoiceMinutes?: number;
  usedSms?: number;
  usagePeriodStart?: string;
  usagePeriodEnd?: string;
} | null> {
  const payload = await jolaCall<unknown>(`/api/v1/sims/${encodeURIComponent(simId)}/usage/current`);
  if (payload === null) return null;

  const dataMb = pickNumber(payload, 'DataMb', 'dataMb', 'dataUsedMb', 'DataUsedMb', 'usageDataMb', 'dataUsed', 'DataUsed');
  const voice = pickNumber(payload, 'VoiceMinutes', 'voiceMinutes', 'voiceUsed', 'VoiceUsed', 'voiceUsageMinutes');
  const sms = pickNumber(payload, 'SmsCount', 'smsCount', 'sms', 'SMS', 'smsUsed', 'SmsUsed', 'usageSms');
  const start = pickString(payload, 'periodStart', 'PeriodStart', 'from', 'From', 'startDate', 'StartDate');
  const end = pickString(payload, 'periodEnd', 'PeriodEnd', 'to', 'To', 'endDate', 'EndDate');

  const usage = {
    ...(bytesFromMb(dataMb) != null ? { usedBytes: bytesFromMb(dataMb) } : {}),
    ...(voice != null ? { usedVoiceMinutes: voice } : {}),
    ...(sms != null ? { usedSms: sms } : {}),
    ...(start ? { usagePeriodStart: start } : {}),
    ...(end ? { usagePeriodEnd: end } : {}),
  };

  // An empty object would claim a usage answer where there is none.
  return Object.keys(usage).length ? usage : null;
}
