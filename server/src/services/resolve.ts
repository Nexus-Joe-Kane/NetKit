import {
  formatPostcode,
  identify,
  toSuggestion,
  type AddressRecord,
  type AddressSuggestion,
  type BroadbandAvailability,
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
            // Keep only lines that actually belong to this premises. Where a
            // line carries no UPRN, fall back to matching the address text.
            const sameUprn = address.uprn && line.address.uprn === address.uprn;
            const sameAddress =
              !line.address.uprn && line.address.singleLine
                ? line.address.singleLine.toLowerCase() === address.singleLine.toLowerCase()
                : false;
            if (sameUprn || sameAddress) add(line);
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

async function availabilityFor(
  address: AddressRecord,
): Promise<{ value: BroadbandAvailability | null; status: SectionStatus }> {
  const started = Date.now();
  const result = await firstResult(
    providers().availability,
    (p) => p.forAddress(address),
    (v) => v.offers.length > 0 || Boolean(v.openreach),
  );
  if (result.value === null) return { value: null, status: failed(result.errors) };
  return { value: result.value, status: ok(result.mode, Date.now() - started) };
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
  opts: { includeSiblings?: boolean } = {},
): Promise<SiteReport> {
  const cacheKey = `report:${address.uprn ?? address.singleLine}`;
  const cached = reportCache.get(cacheKey);
  if (cached) return { ...cached, query, generatedAt: cached.generatedAt };

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

export interface ResolveOptions {
  /** Set when the user has already picked an address from the dropdown. */
  uprn?: string;
  /** Cap on returned suggestions. */
  limit?: number;
}

export async function resolveQuery(rawQuery: string, opts: ResolveOptions = {}): Promise<SearchResponse> {
  // An explicit UPRN from the dropdown short-circuits everything.
  if (opts.uprn) {
    const address = await addressByUprn(opts.uprn);
    if (!address) throw notFound(`No premises found for UPRN ${opts.uprn}.`);
    const query = identify(opts.uprn);
    return { query, suggestions: [], report: await buildSiteReport(address, query) };
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
        return { query, suggestions: [], report: await buildSiteReport(list[0]!, query) };
      }
      return { query, suggestions: list.map(toSuggestion) };
    }

    // ---- UPRN: exact premises ----------------------------------------
    case 'uprn': {
      const address = await addressByUprn(query.normalised);
      if (!address) throw notFound(`No premises found for UPRN ${query.normalised}.`);
      return { query, suggestions: [], report: await buildSiteReport(address, query) };
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
      const report = await buildSiteReport(address, query);
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
        return { query, suggestions: [], report: await buildSiteReport(list[0]!, query) };
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
