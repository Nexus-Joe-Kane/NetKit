import {
  formatPostcode,
  identify,
  statusRank,
  technologyRank,
  toSuggestion,
  type AddressRecord,
  type AddressSuggestion,
  type BroadbandAvailability,
  type BroadbandOffer,
  type LineRecord,
  type ResolvedIdentifier,
  type SearchResponse,
  type SectionStatus,
  type SignalReport,
  type SiteReport,
} from '@sw/shared';
import { config } from '../config';
import { TtlCache } from '../lib/cache';
import { badRequest, notFound } from '../lib/errors';
import { firstResult, providers } from '../providers/registry';

/**
 * The resolver.
 *
 * One entry point takes whatever the user typed and works out what to do
 * with it. This is where the "type a postcode, a first line of address, a
 * UPRN, a CLI or a line ID and get the whole site" promise is kept.
 */

const reportCache = new TtlCache<SiteReport>(config().cacheTtlSeconds * 1000, 500);

const failed = (errors: Error[]): SectionStatus => ({
  ok: false,
  mode: 'skipped',
  error: errors[0]?.message ?? 'No provider returned a result',
});

const ok = (mode: 'live' | 'mock', durationMs: number): SectionStatus => ({ ok: true, mode, durationMs });

/* ------------------------------------------------------------------ *
 * Address resolution
 * ------------------------------------------------------------------ */

export async function addressesByPostcode(postcode: string): Promise<AddressRecord[]> {
  const reg = providers();
  const result = await firstResult(
    reg.address,
    (p) => p.byPostcode(formatPostcode(postcode)),
    (v) => v.length > 0,
  );
  return result.value ?? [];
}

export async function addressByUprn(uprn: string): Promise<AddressRecord | null> {
  const reg = providers();
  const result = await firstResult(
    reg.address,
    (p) => p.byUprn(uprn),
    (v) => v !== null,
  );
  return result.value ?? null;
}

export async function searchAddresses(query: string, limit = 25): Promise<AddressRecord[]> {
  const reg = providers();
  const result = await firstResult(
    reg.address,
    (p) => p.search(query, limit),
    (v) => v.length > 0,
  );
  return result.value ?? [];
}

/* ------------------------------------------------------------------ *
 * Line resolution
 * ------------------------------------------------------------------ */

/** Looks a line up by whichever identifier we were given. */
export async function findLines(id: ResolvedIdentifier): Promise<{ lines: LineRecord[]; status: SectionStatus }> {
  const reg = providers();
  const started = Date.now();

  const runner = (() => {
    switch (id.kind) {
      case 'cli':
        return (p: (typeof reg.lines)[number]) => p.byCli(id.normalised);
      case 'lineAccessId':
        return (p: (typeof reg.lines)[number]) => p.byAccessId(id.normalised);
      case 'serviceId':
        return (p: (typeof reg.lines)[number]) => p.byServiceId(id.normalised);
      case 'ontSerial':
        return (p: (typeof reg.lines)[number]) => p.byOntSerial(id.normalised);
      case 'uprn':
        return (p: (typeof reg.lines)[number]) => p.byUprn(id.normalised);
      default:
        return null;
    }
  })();

  if (!runner) return { lines: [], status: { ok: true, mode: 'skipped' } };

  const result = await firstResult(reg.lines, runner, (v) => v.length > 0);
  if (result.value === null) {
    // No line found is a legitimate answer, not a failure — the premises may
    // simply not be ours. Only report an error if a provider actually threw.
    return {
      lines: [],
      status: result.errors.length ? failed(result.errors) : ok('mock', Date.now() - started),
    };
  }
  return { lines: result.value, status: ok(result.mode, Date.now() - started) };
}

/**
 * Cross-provider sweep for a premises: every line we can find at a UPRN,
 * from every configured source, deduplicated. This is the "everything
 * lookup" that finds lines Zen doesn't own.
 */
/**
 * Whether a line found by a postcode sweep is actually at this premises.
 *
 * Three keys, in descending order of certainty. The third exists because
 * Giacom's service inventory carries neither a UPRN nor a full address —
 * TM Forum keys their addresses on the Openreach ALK — so without it every
 * Giacom-supplied line was silently dropped from every site report and half
 * that integration was inert.
 *
 * A line that matches none of them is excluded rather than guessed at: a
 * neighbour's circuit appearing on a site report is worse than a missing one.
 */
function belongsToPremises(line: LineRecord, address: AddressRecord): boolean {
  if (address.uprn && line.address.uprn) return line.address.uprn === address.uprn;

  // The Openreach address key, which is what Giacom return and what an order
  // is built from — so a match here is as good as a UPRN match.
  const premisesKey = address.addressKey?.trim().toUpperCase();
  const lineKey = line.lineAccessId?.trim().toUpperCase();
  if (premisesKey && lineKey && premisesKey === lineKey) return true;

  if (!line.address.uprn && line.address.singleLine) {
    return line.address.singleLine.trim().toLowerCase() === address.singleLine.trim().toLowerCase();
  }
  return false;
}

export async function allLinesAtPremises(
  address: AddressRecord,
): Promise<{ lines: LineRecord[]; status: SectionStatus }> {
  const reg = providers();
  const started = Date.now();
  const seen = new Map<string, LineRecord>();
  const errors: Error[] = [];
  let mode: 'live' | 'mock' = 'mock';
  let answered = false;

  const add = (line: LineRecord) => {
    // Prefer a live record over a fixture for the same line identity.
    const key = line.serviceId ?? line.lineAccessId ?? line.cli ?? line.id;
    const existing = seen.get(key);
    if (!existing || (existing.discoveredVia === 'mock' && line.discoveredVia !== 'mock')) {
      seen.set(key, line);
    }
  };

  await Promise.all(
    reg.lines.map(async (p) => {
      try {
        // UPRN first where the provider supports it, then a postcode sweep
        // narrowed back to this premises — Zen has no UPRN search key.
        const direct = address.uprn ? await p.byUprn(address.uprn) : [];
        for (const line of direct) add(line);

        if (!direct.length && p.byPostcode && address.postcode) {
          for (const line of await p.byPostcode(address.postcode)) {
            if (belongsToPremises(line, address)) add(line);
          }
        }
        answered = true;
        if (p.mode === 'live') mode = 'live';
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }),
  );

  const lines = [...seen.values()];
  if (!answered && errors.length) return { lines, status: failed(errors) };
  return { lines, status: ok(mode, Date.now() - started) };
}

/* ------------------------------------------------------------------ *
 * The composite site report
 * ------------------------------------------------------------------ */

/**
 * Alt-net and cable coverage, merged across every provider that answers.
 *
 * First-usable-wins is right for wholesale availability and wrong here. No
 * single source knows about CityFibre *and* Virgin Media *and* Community
 * Fibre *and* G.Network, so a second answer adds networks rather than
 * replacing the first. A provider that fails is skipped: partial coverage
 * beats none, and the report says which sources answered.
 */
async function supplementalOffersFor(address: AddressRecord): Promise<{ offers: BroadbandOffer[]; sources: string[] }> {
  const chain = providers().offers;
  if (!chain.length) return { offers: [], sources: [] };

  const settled = await Promise.all(
    chain.map(async (provider) => {
      try {
        return { name: provider.name, offers: await provider.forAddress(address) };
      } catch {
        // A coverage panel is not worth failing a site report over.
        return { name: provider.name, offers: [] as BroadbandOffer[] };
      }
    }),
  );

  const sources: string[] = [];
  const seen = new Map<string, BroadbandOffer>();

  for (const { name, offers: found } of settled) {
    if (!found.length) continue;
    sources.push(name);
    for (const offer of found) {
      const key = dedupeKey(offer);
      const existing = seen.get(key);
      if (!existing || confidenceRank(offer) > confidenceRank(existing)) seen.set(key, offer);
    }
  }

  return { offers: [...seen.values()], sources };
}

/**
 * What counts as the same option twice.
 *
 * Two *coverage* feeds reporting CityFibre XGS-PON at one address are the
 * same fact, and should merge. Two *sellable products* that happen to share
 * an operator and technology are not — SOGEA through BT Wholesale and SOGEA
 * through TalkTalk are different commercial routes at different prices, and
 * collapsing them would delete exactly the comparison this feature exists to
 * show. So the retailer and product code join the key when present, and
 * coverage rows (which have neither) still merge as before.
 */
const dedupeKey = (offer: BroadbandOffer): string =>
  [offer.operator, offer.technology, offer.retailer ?? '', offer.productCode ?? ''].join('|');

/**
 * Which of two rows for the same option to keep: the one that actually
 * checked this address beats one that only knows the area.
 */
const confidenceRank = (offer: BroadbandOffer): number =>
  offer.serviceability === 'confirmed' ? 2 : offer.serviceability === 'footprint' ? 1 : 0;

/**
 * Where a row sorts, which is a different question from which row to keep.
 *
 * `serviceability` is absent on everything from the wholesale chain, because
 * a wholesale availability answer *is* an address check — so absent must
 * rank with `confirmed`, not below `footprint`. Ranking it 0 put unchecked
 * alt-net footprints above genuinely orderable Openreach products, which is
 * precisely backwards.
 */
const sellRank = (offer: BroadbandOffer): number => (offer.serviceability === 'footprint' ? 0 : 1);

async function availabilityFor(
  address: AddressRecord,
): Promise<{ value: BroadbandAvailability | null; status: SectionStatus }> {
  const started = Date.now();
  // Wholesale and alt-net are fetched together: they are independent
  // upstreams and one should never wait on the other.
  const [result, supplemental] = await Promise.all([
    firstResult(
      providers().availability,
      (p) => p.forAddress(address),
      (v) => v.offers.length > 0 || Boolean(v.openreach),
    ),
    supplementalOffersFor(address),
  ]);

  if (result.value === null) {
    // Coverage alone is still worth showing — it answers "is there any
    // gigabit here at all" even when the wholesale check failed.
    if (!supplemental.offers.length) return { value: null, status: failed(result.errors) };
    const coverageOnly = sortOffers(supplemental.offers);
    const coverageHeadline = headlineFrom(coverageOnly);
    return {
      value: {
        ...(address.uprn ? { uprn: address.uprn } : {}),
        address,
        offers: coverageOnly,
        ...(coverageHeadline ? { headline: coverageHeadline } : {}),
        checkedAt: new Date().toISOString(),
        sources: supplemental.sources,
      },
      // Coverage is showing, but the wholesale check still failed and the
      // operator has to know that — reporting this as a healthy section
      // makes "no options here" indistinguishable from "Zen returned 503".
      status: { ...failed(result.errors), durationMs: Date.now() - started },
    };
  }

  const merged = sortOffers([...result.value.offers, ...supplemental.offers]);
  const headline = headlineFrom(merged) ?? result.value.headline;
  const value: BroadbandAvailability = {
    ...result.value,
    offers: merged,
    ...(headline ? { headline } : {}),
    sources: [...result.value.sources, ...supplemental.sources],
  };
  return { value, status: ok(result.mode, Date.now() - started) };
}

/** Sellable first, then by status, then by technology. */
function sortOffers(offers: BroadbandOffer[]): BroadbandOffer[] {
  return [...offers].sort(
    (a, b) =>
      sellRank(b) - sellRank(a) ||
      statusRank(b.status) - statusRank(a.status) ||
      technologyRank(b.technology) - technologyRank(a.technology),
  );
}

/**
 * The "best available" summary, recomputed after merging.
 *
 * Carrying the wholesale provider's own headline through was wrong once a
 * second supplier could beat it: a Giacom-confirmed gigabit product would
 * never reach the summary strip or the copy-as-text header. Footprint rows
 * are excluded — the headline is what you can sell, not what passes nearby.
 */
function headlineFrom(offers: BroadbandOffer[]): BroadbandAvailability['headline'] | undefined {
  const best = offers
    .filter((o) => o.status === 'available' && o.serviceability !== 'footprint')
    .sort(
      (a, b) =>
        technologyRank(b.technology) - technologyRank(a.technology) ||
        (b.speeds.downMbpsHigh ?? 0) - (a.speeds.downMbpsHigh ?? 0),
    )[0];
  if (!best) return undefined;
  return {
    technology: best.technology,
    ...(best.speeds.downMbpsHigh != null ? { downMbps: best.speeds.downMbpsHigh } : {}),
    ...(best.speeds.upMbpsHigh != null ? { upMbps: best.speeds.upMbpsHigh } : {}),
    operatorLabel: best.operatorLabel,
  };
}

async function signalFor(address: AddressRecord): Promise<{ value: SignalReport | null; status: SectionStatus }> {
  const started = Date.now();
  const result = await firstResult(
    providers().signal,
    (p) => p.forAddress(address),
    (v) => v.operators.length > 0,
  );
  if (result.value === null) return { value: null, status: failed(result.errors) };
  return { value: result.value, status: ok(result.mode, Date.now() - started) };
}

/**
 * Builds the full report for a premises. Every section is fetched in
 * parallel and degrades independently, so one dead upstream never blanks
 * the page.
 */
export async function buildSiteReport(
  address: AddressRecord,
  query: ResolvedIdentifier,
  opts: { includeSiblings?: boolean; budget?: BudgetHook } = {},
): Promise<SiteReport> {
  const cacheKey = `report:${address.uprn ?? address.singleLine}`;
  const cached = reportCache.get(cacheKey);
  if (cached) return { ...cached, query, generatedAt: cached.generatedAt };

  // Fair use is charged here rather than at the route, because this is the
  // only place that knows the answer was not already in hand. A second look
  // at a premises an operator opened ten minutes ago is free.
  opts.budget?.();

  const [availability, signal, lines, siblings] = await Promise.all([
    availabilityFor(address),
    signalFor(address),
    allLinesAtPremises(address),
    opts.includeSiblings !== false && address.postcode
      ? addressesByPostcode(address.postcode).catch(() => [] as AddressRecord[])
      : Promise.resolve([] as AddressRecord[]),
  ]);

  const report: SiteReport = {
    query,
    address,
    ...(address.uprn ? { uprn: address.uprn } : {}),
    ...(availability.value ? { broadband: availability.value } : {}),
    ...(signal.value ? { signal: signal.value } : {}),
    lines: lines.lines,
    siblings: siblings
      .filter((a) => a.uprn !== address.uprn)
      .slice(0, 60)
      .map(toSuggestion),
    status: {
      address: { ok: true, mode: address.source === 'mock' ? 'mock' : 'live' },
      broadband: availability.status,
      signal: signal.status,
      lines: lines.status,
    },
    generatedAt: new Date().toISOString(),
  };

  reportCache.set(cacheKey, report);
  return report;
}

/* ------------------------------------------------------------------ *
 * The single entry point
 * ------------------------------------------------------------------ */

/**
 * Called once per uncached premises, immediately before the upstream calls.
 *
 * Throwing refuses the lookup — that is how the fair-use budget says no.
 * Passing no hook means no rationing, which is what the internal callers
 * (self-test, supervisor) want.
 */
export type BudgetHook = () => void;

export interface ResolveOptions {
  /** Set when the user has already picked an address from the dropdown. */
  uprn?: string;
  /** Cap on returned suggestions. */
  limit?: number;
  budget?: BudgetHook;
}

export async function resolveQuery(rawQuery: string, opts: ResolveOptions = {}): Promise<SearchResponse> {
  const budget = opts.budget ? { budget: opts.budget } : {};
  // An explicit UPRN from the dropdown short-circuits everything.
  if (opts.uprn) {
    const address = await addressByUprn(opts.uprn);
    if (!address) throw notFound(`No premises found for UPRN ${opts.uprn}.`);
    const query = identify(opts.uprn);
    return { query, suggestions: [], report: await buildSiteReport(address, query, budget) };
  }

  const query = identify(rawQuery);
  if (query.kind === 'unknown') {
    throw badRequest(
      'Enter a postcode, the first line of an address, a UPRN, a phone number (CLI) or an Openreach line ID.',
      { reason: query.reason },
    );
  }

  const limit = opts.limit ?? 25;

  switch (query.kind) {
    // ---- Postcode: always return the address picker -------------------
    case 'postcode': {
      const list = await addressesByPostcode(query.normalised);
      if (!list.length) throw notFound(`No premises found at ${query.normalised}.`);
      // A single premises at a postcode needs no disambiguation.
      if (list.length === 1) {
        return { query, suggestions: [], report: await buildSiteReport(list[0]!, query, budget) };
      }
      return { query, suggestions: list.map(toSuggestion) };
    }

    // ---- UPRN: exact premises ----------------------------------------
    case 'uprn': {
      const address = await addressByUprn(query.normalised);
      if (!address) throw notFound(`No premises found for UPRN ${query.normalised}.`);
      return { query, suggestions: [], report: await buildSiteReport(address, query, budget) };
    }

    // ---- Line identifiers: find the line, then the site --------------
    case 'cli':
    case 'lineAccessId':
    case 'serviceId':
    case 'ontSerial': {
      const { lines } = await findLines(query);
      if (!lines.length) {
        throw notFound(
          `No line found for ${query.normalised}. It may belong to another provider, or have been ceased and archived.`,
        );
      }
      // Land the user on the site the line sits at.
      const address = lines[0]!.address;
      const report = await buildSiteReport(address, query, budget);
      // Make sure the line we searched for is definitely in the report.
      const merged = [...lines];
      for (const l of report.lines) {
        if (!merged.some((m) => (m.serviceId ?? m.id) === (l.serviceId ?? l.id))) merged.push(l);
      }
      return { query, suggestions: [], report: { ...report, lines: merged }, lines: merged };
    }

    // ---- Free text: address search -----------------------------------
    default: {
      const list = await searchAddresses(query.normalised, limit);
      if (!list.length) throw notFound(`No premises matched "${query.normalised}".`);
      if (list.length === 1) {
        return { query, suggestions: [], report: await buildSiteReport(list[0]!, query, budget) };
      }
      return { query, suggestions: list.map(toSuggestion) };
    }
  }
}

/** Typeahead: fast, suggestion-only, no report building. */
export async function suggest(rawQuery: string, limit = 12): Promise<{ query: ResolvedIdentifier; suggestions: AddressSuggestion[] }> {
  const query = identify(rawQuery);
  if (rawQuery.trim().length < 2) return { query, suggestions: [] };

  if (query.kind === 'postcode') {
    const list = await addressesByPostcode(query.normalised);
    return { query, suggestions: list.slice(0, 100).map(toSuggestion) };
  }
  if (query.kind === 'uprn') {
    const address = await addressByUprn(query.normalised);
    return { query, suggestions: address ? [toSuggestion(address)] : [] };
  }
  if (query.kind === 'address') {
    const list = await searchAddresses(query.normalised, limit);
    return { query, suggestions: list.map(toSuggestion) };
  }
  // CLIs and line IDs have no address suggestions — the caller submits them.
  return { query, suggestions: [] };
}

/** Test hook. */
export function clearReportCache(): void {
  reportCache.clear();
}

/** Test hooks for the merge and ordering rules, which are easy to regress. */
export const __resolveTesting = { dedupeKey, confidenceRank, sellRank, sortOffers, headlineFrom, belongsToPremises };
