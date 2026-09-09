import {
  formatPostcode,
  identify,
  statusRank,
  technologyRank,
  toSuggestion,
  unitQuestion,
  unmatchedTokens,
  type AddressRecord,
  type AddressSuggestion,
  type BroadbandAvailability,
  type BroadbandOffer,
  type LineRecord,
  type LineSearchDiagnostic,
  type ResolvedIdentifier,
  type SearchResponse,
  type SectionStatus,
  type SignalReport,
  type SiteReport,
  samePremises,
} from '@sw/shared';
import { config } from '../config';
import { TtlCache } from '../lib/cache';
import { badRequest, notFound, uprnNotFound } from '../lib/errors';
import { firstResult, providers } from '../providers/registry';
import { predictedSpeedsFor } from '../providers/coverage/ofcomBroadband';
import { predictedFromDataset } from '../providers/coverage/ofcomFixedDataset';
import { mastsNear } from '../providers/signal/openCellId';
import { learnFromReport } from './clientIndex';

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

const ok = (mode: 'live' | 'skipped', durationMs: number): SectionStatus => ({ ok: true, mode, durationMs });

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

  // Every provider is asked, and the answers are merged.
  //
  // This was first-wins, which meant a CLI search that Zen answered never
  // reached Giacom and vice versa — so the two wholesale accounts could
  // never be searched in one place, which is the whole point of the box.
  const seen = new Map<string, LineRecord>();
  const errors: Error[] = [];
  let mode: 'live' | 'skipped' = 'skipped';
  let answered = false;

  await Promise.all(
    reg.lines.map(async (provider) => {
      try {
        for (const line of await runner(provider)) {
          const key = line.serviceId ?? line.lineAccessId ?? line.cli ?? line.id;
          if (!seen.has(key)) seen.set(key, line);
        }
        answered = true;
        if (provider.mode === 'live') mode = 'live';
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }),
  );

  const lines = [...seen.values()];
  // No line found is a legitimate answer, not a failure — the identifier may
  // simply not be ours. Only report an error if every provider threw.
  if (!answered && errors.length) return { lines, status: failed(errors) };
  return { lines, status: ok(mode, Date.now() - started) };
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
  // A UPRN agreeing on both sides settles it. A UPRN *disagreeing* does not:
  // a supplier carries whatever UPRN it was handed at order time, often the
  // parent shell record for a building, and reading that as "different
  // premises" threw away a live circuit at the right doorstep. See
  // samePremises, which the mismatch now falls through to.
  if (address.uprn && line.address.uprn && line.address.uprn === address.uprn) return true;

  // The Openreach address key, which is what Giacom return and what an order
  // is built from — so a match here is as good as a UPRN match.
  const premisesKey = address.addressKey?.trim().toUpperCase();
  const lineKey = line.lineAccessId?.trim().toUpperCase();
  if (premisesKey && lineKey && premisesKey === lineKey) return true;

  // Field by field, rather than comparing formatted strings. The previous
  // fallback demanded byte equality of the whole single line, which a Zen
  // address and an OS Places address for the same building never satisfy —
  // so a real Openreach circuit was reported as "no lines found".
  return samePremises(line.address, address);
}

/**
 * Names to try in a supplier's own inventory search when nothing else found
 * the site.
 *
 * A supplier files an account under the customer's name, so a name is often
 * the only key that works when a postcode search comes back empty. Generic
 * company suffixes are dropped: searching a supplier for "Ltd" would match
 * half its book.
 */
const COMPANY_NOISE = /\b(ltd|limited|llp|plc|uk|group|holdings|company|co)\b/gi;

export function premisesNames(address: AddressRecord): string[] {
  const names = [address.organisation, address.buildingName]
    .map((n) => (n ?? '').replace(COMPANY_NOISE, ' ').replace(/[^A-Za-z0-9&' ]+/g, ' ').replace(/\s+/g, ' ').trim())
    // A one-word fragment of two characters is not a search, it is a wildcard.
    .filter((n) => n.length >= 3);
  return [...new Set(names)];
}

export async function allLinesAtPremises(address: AddressRecord): Promise<{
  lines: LineRecord[];
  nearby: LineRecord[];
  status: SectionStatus;
  diagnostics: LineSearchDiagnostic[];
}> {
  const reg = providers();
  const started = Date.now();
  const seen = new Map<string, LineRecord>();
  const unmatched = new Map<string, LineRecord>();
  const errors: Error[] = [];
  const diagnostics: LineSearchDiagnostic[] = [];
  let mode: 'live' | 'skipped' = 'skipped';
  let answered = false;

  const identity = (line: LineRecord): string =>
    line.serviceId ?? line.lineAccessId ?? line.cli ?? line.id;

  const add = (line: LineRecord) => {
    // Prefer a live record over a fixture for the same line identity.
    const key = identity(line);
    // First writer wins: every record is live now, so there is no
    // fixture to prefer against.
    if (!seen.has(key)) seen.set(key, line);
  };

  await Promise.all(
    reg.lines.map(async (p) => {
      const note: LineSearchDiagnostic = {
        provider: p.label ?? p.name,
        tried: [],
        candidates: 0,
        matched: 0,
        excluded: 0,
      };

      /** Files one batch of candidates, counting what happened to each. */
      const consider = (rows: LineRecord[], strict: boolean): number => {
        let kept = 0;
        note.candidates += rows.length;
        for (const line of rows) {
          if (!strict || belongsToPremises(line, address)) {
            if (!seen.has(identity(line))) kept += 1;
            add(line);
            note.matched += 1;
            continue;
          }
          // Kept rather than discarded. A line at this postcode that cannot
          // be tied to this premises is usually a neighbour — but it is
          // sometimes this customer with an address the supplier records
          // differently, and silently dropping it is what made a real
          // circuit look like no circuit at all. Shown separately so it is
          // never mistaken for a line at this address.
          unmatched.set(identity(line), line);
          note.excluded += 1;
        }
        return kept;
      };

      try {
        // UPRN first where the provider supports it, then a postcode sweep
        // narrowed back to this premises — Zen has no UPRN search key.
        let found = 0;
        if (address.uprn) {
          note.tried.push(`UPRN ${address.uprn}`);
          found += consider(await p.byUprn(address.uprn), false);
        }

        if (!found && p.byPostcode && address.postcode) {
          note.tried.push(`postcode ${address.postcode}`);
          found += consider(await p.byPostcode(address.postcode), true);
        }

        // Last resort: the customer's own name. A supplier whose postcode
        // search comes back empty for a site we demonstrably supply will
        // often find the circuit under the name the account is filed under.
        // Still put through the premises test, so a namesake in another town
        // is excluded on its postcode.
        if (!found && p.byFreeText) {
          for (const name of premisesNames(address)) {
            note.tried.push(`name “${name}”`);
            found += consider(await p.byFreeText(name), true);
            if (found) break;
          }
        }

        answered = true;
        if (p.mode === 'live') mode = 'live';
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push(error);
        note.error = error.message;
      }

      diagnostics.push(note);
    }),
  );

  const lines = [...seen.values()];
  // Anything that did match is not also "nearby".
  const nearby = [...unmatched.values()].filter((line) => !seen.has(identity(line)));
  diagnostics.sort((a, b) => a.provider.localeCompare(b.provider));

  if (!answered && errors.length) return { lines, nearby, status: failed(errors), diagnostics };
  return { lines, nearby, status: ok(mode, Date.now() - started), diagnostics };
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
  const [result, supplemental, predicted] = await Promise.all([
    firstResult(
      providers().availability,
      (p) => p.forAddress(address),
      (v) => v.offers.length > 0 || Boolean(v.openreach),
    ),
    supplementalOffersFor(address),
    // The regulator's own prediction. Independent of both chains, and never
    // allowed to fail the section — it is context, not the answer.
    //
    // The API first, then the Connected Nations file on disk. Same publisher,
    // and the API is months fresher, so the file is a failover rather than a
    // second opinion: it answers when there is no key yet or the endpoint is
    // down, and everything it returns is stamped as a dated file.
    predictedSpeedsFor(address)
      .catch(() => null)
      .then((live) => live ?? predictedFromDataset(address))
      .catch(() => null),
  ]);

  if (result.value === null) {
    // Coverage alone is still worth showing — it answers "is there any
    // gigabit here at all" even when the wholesale check failed.
    //
    // The regulator's own figures count as coverage for this purpose. With
    // only Ofcom configured the section used to be dropped entirely and the
    // tab read "no provider returned a result" while holding a perfectly
    // good postcode answer — the same fault the mobile side had.
    if (!supplemental.offers.length && !predicted) {
      return { value: null, status: failed(result.errors) };
    }
    const coverageOnly = sortOffers(supplemental.offers);
    const coverageHeadline = headlineFrom(coverageOnly);
    return {
      value: {
        ...(address.uprn ? { uprn: address.uprn } : {}),
        address,
        offers: coverageOnly,
        ...(coverageHeadline ? { headline: coverageHeadline } : {}),
        ...(predicted ? { predicted } : {}),
        checkedAt: new Date().toISOString(),
        sources: supplemental.sources,
      },
      // Coverage is showing, but the wholesale check still failed and the
      // operator has to know that — reporting this as a healthy section
      // makes "no options here" indistinguishable from "Zen returned 503".
      status: { ...failed(result.errors), durationMs: Date.now() - started },
    };
  }

  const merged = sortOffers([...markConfirmed(result.value.offers), ...supplemental.offers]);
  const headline = headlineFrom(merged) ?? result.value.headline;
  const value: BroadbandAvailability = {
    ...result.value,
    offers: merged,
    ...(headline ? { headline } : {}),
    ...(predicted ? { predicted } : {}),
    sources: [...result.value.sources, ...supplemental.sources, ...(predicted ? ['ofcom:broadband-api'] : [])],
  };
  return { value, status: ok(result.mode, Date.now() - started) };
}

/**
 * Marks a wholesale availability answer as what it is: an address check.
 *
 * A wholesale check *is* per-premises, so these rows were left with
 * `serviceability` absent and the sort compensated. That worked for ordering
 * but read badly to a person: the detail panel for a genuinely orderable
 * Openreach product showed SERVICEABILITY "—" and ORDERABLE "—" beside an
 * enabled Order button, which is exactly the ambiguity the field exists to
 * remove. An implicit "absent means confirmed" rule had already caused one
 * inverted-sort bug, so it is now stated rather than inferred.
 *
 * A provider that has set the field itself is left alone -- Giacom already
 * says `confirmed`, and nothing here should promote a footprint row.
 */
function markConfirmed(offers: BroadbandOffer[]): BroadbandOffer[] {
  return offers.map((offer) =>
    offer.serviceability
      ? offer
      : {
          ...offer,
          serviceability: 'confirmed' as const,
          // Orderable is about this product at this address, not about
          // whether the ordering switch is on -- that is a separate gate in
          // the UI, and conflating them would claim a product cannot be had
          // when it merely cannot be had by clicking here.
          orderable: offer.status === 'available',
          ...(offer.status === 'available'
            ? {}
            : { orderableReason: `Not orderable while the product reads "${offer.status}".` }),
        },
  );
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

  // Coverage and cell sites are independent upstreams. Masts are never
  // allowed to fail the section: they are context for a coverage figure, not
  // the figure itself, and a premises with no recorded sites nearby is a
  // legitimate answer rather than an error.
  const [result, masts] = await Promise.all([
    firstResult(
      providers().signal,
      (p) => p.forAddress(address),
      // A report is usable if it names per-operator coverage *or* carries
      // Ofcom's area-level figures. Testing only for operators threw away
      // the whole area-level answer, because that source counts networks
      // rather than naming them and so has no operator rows at all — the
      // section then reported "no provider returned a result" while holding
      // a perfectly good answer.
      (v) => v.operators.length > 0 || Boolean(v.areaCoverage),
    ),
    mastsNear(address).catch(() => null),
  ]);

  if (result.value === null) return { value: null, status: failed(result.errors) };
  return {
    value: { ...result.value, ...(masts && masts.length ? { masts } : {}) },
    status: ok(result.mode, Date.now() - started),
  };
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
    ...(lines.nearby.length ? { nearbyLines: lines.nearby } : {}),
    ...(lines.diagnostics.length ? { lineSearch: lines.diagnostics } : {}),
    siblings: siblings
      .filter((a) => a.uprn !== address.uprn)
      .slice(0, 60)
      .map(toSuggestion),
    status: {
      address: { ok: true, mode: 'live' },
      broadband: availability.status,
      signal: signal.status,
      lines: lines.status,
    },
    generatedAt: new Date().toISOString(),
  };

  reportCache.set(cacheKey, report);

  /*
   * Teach the client index what this lookup just proved.
   *
   * This is what covers Zen and Giacom, who publish no customer-list
   * endpoint: a premises report establishes the client name, the postcode,
   * the UPRN and every service reference at it, confirmed against live data.
   * Fire and forget — it must never delay or fail the report it rode in on.
   */
  learnFromReport(report);

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
    if (!address) throw uprnNotFound(opts.uprn);
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
      if (!address) throw uprnNotFound(query.normalised);
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
      const unmatched = unmatchedTokens(list, query.normalised);
      /*
       * Ask which unit before offering the address list, where the
       * candidates differ by nothing but their sub-building or their
       * business name. A building of forty premises shares one street
       * address, and picking the door number means every lookup after it is
       * about the wrong place with nothing to say so.
       *
       * Decided here rather than in the browser because a suggestion carries
       * only a label — the sub-building exists solely on the full record.
       */
      const unit = unitQuestion({ addresses: list, query: query.normalised });
      return {
        query,
        suggestions: list.map(toSuggestion),
        ...(unmatched.length ? { unmatched } : {}),
        ...(unit.ask ? { unitChoice: unit } : {}),
      };
    }
  }
}

/** Typeahead: fast, suggestion-only, no report building. */
export async function suggest(
  rawQuery: string,
  limit = 12,
): Promise<{ query: ResolvedIdentifier; suggestions: AddressSuggestion[]; unmatched?: string[] }> {
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
    const unmatched = unmatchedTokens(list, query.normalised);
    return { query, suggestions: list.map(toSuggestion), ...(unmatched.length ? { unmatched } : {}) };
  }
  // CLIs and line IDs have no address suggestions — the caller submits them.
  return { query, suggestions: [] };
}

/** Test hook. */
export function clearReportCache(): void {
  reportCache.clear();
}

/** Test hooks for the merge and ordering rules, which are easy to regress. */
export const __resolveTesting = { dedupeKey, confidenceRank, sellRank, sortOffers, headlineFrom, belongsToPremises, markConfirmed };
