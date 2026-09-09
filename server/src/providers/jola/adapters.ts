import { looksSpare, type SimEstate, type SimRecord, type SimState } from '@sw/shared';
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

/**
 * Paging: skip and take, not page and pageSize.
 *
 * Their documented default `take` is **10**, which is small enough to look
 * like a truncated estate if it is left to default, so it is always sent.
 * There is no total-count header on the SIM or customer endpoints — only on
 * orders — so the end of the list is a short page and nothing else.
 */
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

/**
 * Jola's `SimState`, which is an integer in JSON.
 *
 * This is the cause of a page of SIMs reading "unknown". Their documented
 * enum is `Active = 0, Unactivated = 1, Decommissioned = 2, ActiveTest = 3`,
 * and it serialises as the *number* in JSON — so reading it as a string got
 * nothing, and every live SIM on the account rendered as no state at all.
 * Worse, `Active` being zero means any `state || 'unknown'` treatment is
 * wrong for exactly the SIMs that matter.
 *
 * The XML representation does use the names, which is a good way to be
 * misled by their own documentation: the samples show
 * `<State>Active</State>` next to `"State": 0`.
 *
 * `Unactivated` is the bag of stock — a real state, not a missing one — so it
 * maps to `spare` rather than being guessed at from a label.
 *
 * There is no `Barred` or `Suspended` member. A barred SIM is `State = 0`
 * with a separate `Barred: true` boolean, which is why the caller has to
 * apply that on top rather than expecting it here.
 */
const JOLA_STATE_BY_NUMBER: Record<number, SimState> = {
  0: 'active',
  1: 'spare',
  2: 'ceased',
  3: 'test',
};

function jolaState(raw: unknown): SimState {
  // The number is the documented form, so it is tried first.
  if (typeof raw === 'number' && JOLA_STATE_BY_NUMBER[raw]) return JOLA_STATE_BY_NUMBER[raw]!;
  // A numeric string, because a proxy or an export can stringify it.
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const mapped = JOLA_STATE_BY_NUMBER[Number(raw.trim())];
    if (mapped) return mapped;
  }

  // And the names, for the XML form and for resellers who rename it.
  const v = typeof raw === 'string' ? raw.toUpperCase() : '';
  if (v.includes('UNACTIVATED') || v.includes('STOCK') || v.includes('SPARE')) return 'spare';
  if (v.includes('ACTIVETEST') || v.includes('TEST')) return 'test';
  if (v.includes('ACTIVE') || v.includes('LIVE')) return 'active';
  if (v.includes('SUSPEND') || v.includes('BARRED')) return 'suspended';
  if (v.includes('DECOMMISSION') || v.includes('CEAS') || v.includes('TERMINAT') || v.includes('DISCONNECT')) {
    return 'ceased';
  }
  if (v.includes('PENDING')) return 'pending';
  return 'unknown';
}

/** Reads a field without deciding what type it is. */
function rawField(value: unknown, ...keys: string[]): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
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

/**
 * Words that mean a restriction rather than a label.
 *
 * `SimTag` is free text. Jola's portal is used for both -- some resellers put
 * a barring state in it, most put the van or the shop -- so a tag becomes a
 * bar only if it reads like one. Everything else stays a tag, which is where
 * the site name usually is.
 */
const BAR_WORDS = /\b(bar|barred|barring|block|blocked|suspend|suspended|restrict|restricted|capped|disabled)\b/i;

export function mapJolaSim(raw: unknown, customer?: JolaCustomer): SimRecord | null {
  const iccid = pickString(raw, 'iccid', 'ICCID', 'Iccid', 'iccId', 'simSerial');
  if (!iccid) return null;

  // Jola's own field is `MobileNumber`; the rest are kept for resellers who
  // rename it.
  const msisdn = pickString(raw, 'MobileNumber', 'msisdn', 'MSISDN', 'Msisdn', 'number', 'phoneNumber');
  /*
   * `Allownace`. Their spelling, not a typo of mine.
   *
   * It is misspelled in the live contract on both the SIM list and the
   * single-SIM endpoint, and correctly spelled as `Allowance` on the model
   * the pool endpoints return — the two genuinely disagree, so both are read.
   * Missing this is why every allowance came back empty.
   */
  const allowanceMb = pickNumber(
    raw,
    'Allownace',
    'Allowance',
    'TariffAllowance',
    'DataAllowanceMb',
    'dataAllowanceMb',
  );
  /* Usage is `Usage`, plus `AllowanceUsed` on the pool model. */
  const usedMb = pickNumber(raw, 'Usage', 'AllowanceUsed', 'DataMb', 'dataMb', 'DataUsedMb');
  /*
   * The percentage, straight from the provider.
   *
   * Preferred over dividing the two figures above, because Jola do not
   * document what unit either is in. A percentage needs no unit, so the
   * "near or over allowance" alerting stays correct even if the sizes are
   * displayed wrong by a factor of 1024 — and being wrong about the size is
   * visible and reportable, where being wrong about the alert is not.
   */
  const usedPercent = pickNumber(raw, 'AllowanceUsedPercent', 'allowanceUsedPercent');
  const boltOnMb = pickNumber(raw, 'BoltonAllowance', 'boltOnAllowance');

  const tagRaw = pickArray(raw, 'SimTag', 'tags', 'Tags', 'Labels');
  const tags = tagRaw
    .map((t) => (typeof t === 'string' ? t : pickString(t, 'name', 'value', 'tag')))
    .filter((t): t is string => Boolean(t));
  // Some accounts put one label in a string rather than an array. Consulted
  // only when the array form gave nothing: `pickString` on an array hands
  // back its joined form, so reading both produced a phantom label of
  // "Data barred,Head office" — which then matched the bar words and became
  // a bar of its own.
  if (tags.length === 0) {
    const singleTag = pickString(raw, 'SimTag', 'tag', 'Tag', 'label', 'Label');
    if (singleTag) tags.push(singleTag);
  }

  const declaredBars = pickArray(raw, 'bars', 'barrings', 'Bars', 'Barrings')
    .map((b) => (typeof b === 'string' ? b : pickString(b, 'name', 'type', 'bar')))
    .filter((b): b is string => Boolean(b));

  // Tags that read like a restriction join the bars; the rest stay labels.
  const bars = [...declaredBars, ...tags.filter((t) => BAR_WORDS.test(t))];
  const labels = tags.filter((t) => !BAR_WORDS.test(t));

  /*
   * The site.
   *
   * An explicit field if the account has one; otherwise the first label,
   * because that is where a site name lands in practice -- "Willow —
   * Brockley Rise" typed into SimTag. A postcode-looking label is taken as
   * the postcode instead, since that is a better answer to "where".
   */
  const explicitSite = pickString(raw, 'site', 'Site', 'siteName', 'SiteName', 'location', 'Location', 'group', 'Group');
  const postcodeLike = labels.find((l) => /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(l.trim()));
  const site = explicitSite ?? labels.find((l) => l !== postcodeLike);

  const record: SimRecord = {
    iccid,
    ...(msisdn ? { msisdn } : {}),
    ...(pickString(raw, 'imsi', 'IMSI') ? { imsi: pickString(raw, 'imsi', 'IMSI') } : {}),
    state: jolaState(rawField(raw, 'State', 'state', 'status', 'Status', 'simStatus')),
    ...(pickString(raw, 'operator', 'Operator', 'network', 'Network', 'carrier')
      ? { network: pickString(raw, 'operator', 'Operator', 'network', 'Network', 'carrier') }
      : {}),
    ...(bytesFromMb(allowanceMb) != null ? { allowanceBytes: bytesFromMb(allowanceMb) } : {}),
    ...(bytesFromMb(usedMb) != null ? { usedBytes: bytesFromMb(usedMb) } : {}),
    ...(bytesFromMb(boltOnMb) != null ? { boltOnBytes: bytesFromMb(boltOnMb) } : {}),
    ...(usedPercent != null ? { usedPercentReported: usedPercent } : {}),
    ...(bars.length ? { bars } : {}),
    ...(labels.length ? { tags: labels } : {}),
    // Whose SIM it is. Known from the customer this list was fetched under,
    // so it is never a guess.
    ...(customer ? { clientId: customer.id } : {}),
    ...(customer?.name ? { clientName: customer.name } : {}),
    ...(site ? { site } : {}),
    ...(pickBool(raw, 'attached', 'isAttached', 'online') != null
      ? { attached: pickBool(raw, 'attached', 'isAttached', 'online') }
      : {}),
    ...(pickString(raw, 'lastSeen', 'lastSeenAt', 'lastActivity')
      ? { lastSeenAt: pickString(raw, 'lastSeen', 'lastSeenAt', 'lastActivity') }
      : {}),
    ...(pickString(raw, 'postcode', 'Postcode', 'postCode', 'sitePostcode')
      ? { postcode: pickString(raw, 'postcode', 'Postcode', 'postCode', 'sitePostcode') }
      : postcodeLike
        ? { postcode: postcodeLike.trim().toUpperCase() }
        : {}),
    ...(pickString(raw, 'tariff', 'Tariff', 'tariffName', 'TariffName', 'bundle', 'Bundle', 'plan', 'Plan')
      ? { tariff: pickString(raw, 'tariff', 'Tariff', 'tariffName', 'TariffName', 'bundle', 'Bundle', 'plan', 'Plan') }
      : {}),
    // Cost, only where Jola publish it. A pounds figure is converted rather
    // than rounded, and an absent one stays absent — a cost column of zeroes
    // is worse than one that admits the provider gives us nothing.
    ...(pickNumber(raw, 'monthlyCostPence', 'MonthlyCostPence') != null
      ? { monthlyCostPence: Math.round(pickNumber(raw, 'monthlyCostPence', 'MonthlyCostPence')!) }
      : pickNumber(raw, 'monthlyCost', 'MonthlyCost', 'recurringCost', 'RecurringCost', 'price', 'Price') != null
        ? {
            monthlyCostPence: Math.round(
              pickNumber(raw, 'monthlyCost', 'MonthlyCost', 'recurringCost', 'RecurringCost', 'price', 'Price')! * 100,
            ),
          }
        : {}),
    ...(pickString(raw, 'apn', 'APN') ? { apn: pickString(raw, 'apn', 'APN') } : {}),
    ...(pickString(raw, 'ipAddress', 'ip', 'IpAddress') ? { ipAddress: pickString(raw, 'ipAddress', 'ip', 'IpAddress') } : {}),
    provider: 'Jola SIM Portal',
    source: 'jola',
  };

  /*
   * A spare is a spare, not an unknown.
   *
   * An estate of 236 SIMs with 124 in a drawer was rendering 124 rows
   * reading "unknown" with no number and no usage, which looks like a broken
   * integration rather than a bag of stock. Reclassified only where the
   * provider gave no state, there is no number and no usage — a SIM with a
   * number is somebody's, whatever it is tagged.
   */
  if (looksSpare(record)) record.state = 'spare';

  /*
   * Barred is a separate boolean, not a state.
   *
   * Jola's state enum has no `Barred` or `Suspended` member at all: a barred
   * SIM is `State = 0` — active — with `Barred: true` beside it. So the bar
   * has to be applied on top, or a barred SIM reads as live and the Barred
   * tab stays empty while the customer cannot get online.
   */
  if (pickBool(raw, 'Barred', 'barred') === true) {
    record.state = 'suspended';
    record.bars = [...new Set([...(record.bars ?? []), 'Barred at the network'])];
  }

  return record;
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
      return rows.map((row) => mapJolaSim(row, customer)).filter((s): s is SimRecord => s !== null);
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
 * hand.
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
  // Everything Jola publish about a SIM is already on the estate row: the
  // per-SIM usage call this used to make does not exist, and there are no
  // voice or SMS figures on this API at all.
  return sim;
}

export const __jolaTesting = { jolaState, mapJolaSim, mapJolaCustomer, rowsFrom, bytesFromMb };

/*
 * There is no per-SIM usage endpoint at Jola, and this used to call one.
 *
 * `GET /api/v1/sims/{id}/usage` answers 404 while every real route answers
 * 401 unauthenticated — auth runs before the action there, so the 404 is a
 * genuine absence rather than a permissions artefact. So the extra request
 * this made per SIM was always going to come back empty, and the voice and
 * SMS figures it claimed to fetch do not exist on this API at all.
 *
 * What Jola do publish per SIM is `Usage` on the SIM record itself, which the
 * estate listing already carries, plus a pool-wide figure on
 * `GET /api/v1/pools/{id}/usage`. There is no voice or SMS anywhere.
 *
 * Removed rather than left in place returning null, because a function that
 * always answers "no usage" reads on screen as "this SIM has never been
 * used", which is a different and wrong statement.
 */
