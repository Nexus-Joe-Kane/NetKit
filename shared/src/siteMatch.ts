import type { AddressRecord } from './types';

/**
 * Matching one company, and one of its sites, across systems that do not
 * share an identifier.
 *
 * Zendesk has organisations, IT Glue has organisations, UniFi Site Manager
 * has sites, and none of them knows the others' ids. What they do share is
 * the name, roughly: "Willow Estate Agents Ltd" in one, "Willow Estate
 * Agents" in another, "Willow" in the third. So the join has to be done on
 * the name, carefully.
 *
 * Carefully means two things. Company suffixes carry no information — every
 * third client is a "Ltd" — so they are stripped before comparing, or "Ltd"
 * becomes the strongest shared token in the estate. And a match that is not
 * unique is not a match: two organisations containing "Willow" means asking,
 * not guessing, because attaching one customer's equipment list to another
 * customer's site report is worse than attaching none.
 *
 * Sites are the harder half. A company can have twenty, they are named by
 * whoever set them up ("Mayfair", "MARU MAYFAIR", "Head Office"), and the
 * only reliable tie to a premises is the address — where the system holds
 * one, which Site Manager often does not. So the site match is scored, and
 * says how sure it is rather than pretending.
 */

/**
 * Words that appear in company names without distinguishing them.
 *
 * Legal forms and the handful of generic words that follow them. Not
 * industry words — "Estate Agents" is generic in the abstract and is half of
 * what makes Willow Estate Agents findable.
 */
const COMPANY_NOISE = new Set([
  'ltd',
  'limited',
  'llp',
  'lp',
  'plc',
  'inc',
  'incorporated',
  'co',
  'company',
  'holdings',
  'group',
  'trading',
  'the',
  'and',
  't/a',
  'uk',
]);

/** Words that name a kind of site rather than identify one. */
const SITE_NOISE = new Set([
  'site',
  'office',
  'branch',
  'store',
  'shop',
  'unit',
  'the',
  'and',
  'main',
  'network',
  'wifi',
  'wi-fi',
  'guest',
  'ltd',
  'limited',
]);

const strip = (value: string): string =>
  value
    .replace(/['‘’ʼ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * A company name reduced to the words that identify it.
 *
 * Returns an empty array where the name is nothing but noise — "The Company
 * Ltd" identifies nobody, and returning `['company']` would match half the
 * book.
 */
export function clientTokens(name: string): string[] {
  return strip(name)
    .split(' ')
    .filter((w) => w.length > 1 && !COMPANY_NOISE.has(w));
}

/** The comparable form of a company name: identifying words, in order. */
export const clientKey = (name: string): string => clientTokens(name).join(' ');

export type MatchConfidence = 'exact' | 'strong' | 'weak' | 'none';

export interface ClientMatch<T> {
  record: T;
  name: string;
  confidence: MatchConfidence;
  /** How many identifying words of the query this record accounts for. */
  matched: number;
  /** Why it is being offered, for the UI to show rather than a bare score. */
  reason: string;
}

/**
 * Ranks candidate records against a company name.
 *
 * `exact` is the normalised names being equal — the same company under two
 * different legal-form spellings. `strong` is one containing all the
 * identifying words of the other, which is what "Willow" against "Willow
 * Estate Agents" is. `weak` is a partial overlap, offered but never taken
 * automatically.
 */
export function rankClients<T>(
  candidates: readonly T[],
  query: string,
  nameOf: (record: T) => string,
): Array<ClientMatch<T>> {
  const wanted = clientTokens(query);
  if (!wanted.length) return [];

  const scored = candidates.map((record) => {
    const name = nameOf(record);
    const tokens = clientTokens(name);
    const matched = wanted.filter((w) => tokens.includes(w)).length;

    let confidence: MatchConfidence = 'none';
    let reason = 'nothing in common';

    if (tokens.length && clientKey(name) === clientKey(query)) {
      confidence = 'exact';
      reason = 'same name';
    } else if (matched === wanted.length && wanted.length > 0) {
      confidence = 'strong';
      reason = `contains every word of “${query.trim()}”`;
    } else if (tokens.length && tokens.every((t) => wanted.includes(t))) {
      // The other direction: the record's name is a subset of the query, as
      // "Willow" is of "Willow Estate Agents Brockley".
      confidence = 'strong';
      reason = `“${name.trim()}” is contained in what you typed`;
    } else if (matched > 0) {
      confidence = 'weak';
      reason = `${matched} of ${wanted.length} words match`;
    }

    return { record, name, confidence, matched, reason };
  });

  const rank: Record<MatchConfidence, number> = { exact: 0, strong: 1, weak: 2, none: 3 };
  return scored
    .filter((m) => m.confidence !== 'none')
    .sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.matched - a.matched || a.name.localeCompare(b.name));
}

/**
 * The one record to use without asking, if there is one.
 *
 * Deliberately strict. A single exact match is taken. A single strong match
 * is taken. Anything else — two exacts, two strongs, only weak ones — is
 * handed back as a choice, because attaching one customer's equipment to
 * another customer's site report is worse than attaching none.
 */
export function resolveClient<T>(
  candidates: readonly T[],
  query: string,
  nameOf: (record: T) => string,
): { match: ClientMatch<T> | null; options: Array<ClientMatch<T>>; ambiguous: boolean } {
  const ranked = rankClients(candidates, query, nameOf);
  const exact = ranked.filter((m) => m.confidence === 'exact');
  if (exact.length === 1) return { match: exact[0]!, options: ranked, ambiguous: false };
  if (exact.length > 1) return { match: null, options: exact, ambiguous: true };

  const strong = ranked.filter((m) => m.confidence === 'strong');
  if (strong.length === 1) return { match: strong[0]!, options: ranked, ambiguous: false };

  return { match: null, options: ranked, ambiguous: ranked.length > 1 };
}

/* ------------------------------------------------------------------ *
 * Which of the company's sites is this premises?
 * ------------------------------------------------------------------ */

/** What a system tells us about one of a company's sites. */
export interface SiteCandidate {
  id: string;
  name: string;
  /** Where the system records one. Site Manager usually does not. */
  postcode?: string;
  /** A one-line address, where there is one. */
  address?: string;
  /** Extra words worth matching: a locality, a label, a description. */
  labels?: string[];
}

export interface SiteMatch {
  site: SiteCandidate;
  confidence: MatchConfidence;
  reason: string;
}

const postcodeKey = (value?: string): string => (value ?? '').replace(/\s+/g, '').toUpperCase();

/** Words from a premises worth looking for in a site name. */
export function premisesTokens(address: AddressRecord): string[] {
  const parts = [
    address.organisation,
    address.buildingName,
    address.dependentLocality,
    address.doubleDependentLocality,
    address.thoroughfare,
    address.postTown,
  ];
  const words = strip(parts.filter((p): p is string => Boolean(p)).join(' ')).split(' ');
  return [...new Set(words.filter((w) => w.length > 2 && !SITE_NOISE.has(w)))];
}

/**
 * Which of a company's sites is at this premises.
 *
 * The postcode decides it where both sides have one — that is what a
 * postcode is for, and it is the only field here that cannot be a matter of
 * opinion. Failing that, the site name is matched against the premises: a
 * site called "Mayfair" for an address in Mayfair is a strong signal, and a
 * company with one site and one premises is the easy case worth handling
 * explicitly.
 *
 * Everything else comes back weak. A weak site match is worth showing with
 * its reason and worth never acting on silently, because the failure mode is
 * showing one restaurant's kit under another's address.
 */
export function matchSites(
  sites: readonly SiteCandidate[],
  address: AddressRecord,
): { match: SiteMatch | null; options: SiteMatch[] } {
  if (!sites.length) return { match: null, options: [] };

  const premisesPostcode = postcodeKey(address.postcode);
  const wanted = premisesTokens(address);

  const scored: SiteMatch[] = sites.map((site) => {
    if (premisesPostcode && postcodeKey(site.postcode) === premisesPostcode) {
      return { site, confidence: 'exact', reason: `same postcode (${address.postcode})` };
    }

    const haystack = [site.name, site.address ?? '', ...(site.labels ?? [])].join(' ');
    const words = new Set(strip(haystack).split(' '));
    const hits = wanted.filter((w) => words.has(w));

    if (hits.length >= 2) {
      return { site, confidence: 'strong', reason: `name matches ${hits.slice(0, 3).join(', ')}` };
    }
    if (hits.length === 1) {
      return { site, confidence: 'weak', reason: `name mentions ${hits[0]}` };
    }
    return { site, confidence: 'none', reason: 'nothing ties it to this address' };
  });

  const rank: Record<MatchConfidence, number> = { exact: 0, strong: 1, weak: 2, none: 3 };
  const options = [...scored].sort(
    (a, b) => rank[a.confidence] - rank[b.confidence] || a.site.name.localeCompare(b.site.name),
  );

  const exact = options.filter((m) => m.confidence === 'exact');
  if (exact.length === 1) return { match: exact[0]!, options };
  if (exact.length > 1) return { match: null, options: exact };

  const strong = options.filter((m) => m.confidence === 'strong');
  if (strong.length === 1) return { match: strong[0]!, options };

  // One site, one premises: there is nothing else it could be, and making
  // somebody choose from a list of one is not caution, it is friction.
  if (sites.length === 1 && options[0] && options[0].confidence !== 'none') {
    return { match: { ...options[0], reason: `${options[0].reason} — the only site on this account` }, options };
  }
  if (sites.length === 1 && options[0]) {
    return {
      match: null,
      options: [{ ...options[0], confidence: 'weak', reason: 'the only site on this account, but nothing ties it to this address' }],
    };
  }

  return { match: null, options };
}

/* ------------------------------------------------------------------ *
 * What to tell the engineer about the join
 * ------------------------------------------------------------------ */

/**
 * Which banner the on-site panel shows, if any.
 *
 * A function rather than a chain of ternaries inside the JSX, because the
 * decision has four outcomes with a genuine order of precedence and one of
 * them was wrong: with neither system connected the panel said
 * "Nothing matched “supportwizard”" and offered a box to retype the company
 * name — sending somebody off guessing at names to fix a missing API key.
 *
 * `none` means say nothing. `matched` means say what to, quietly.
 */
export type MatchBanner = 'none' | 'matched' | 'ambiguous' | 'weak' | 'no-match';

export function matchBanner(context: {
  documented?: unknown;
  documentedOptions?: readonly unknown[];
  documentedLocation?: { confidence: MatchConfidence };
  networkSite?: { confidence: MatchConfidence };
  networkSites?: readonly unknown[];
  status: { documentation: { mode: string }; network: { mode: string } };
}): MatchBanner {
  const weak =
    context.documentedLocation?.confidence === 'weak' || context.networkSite?.confidence === 'weak';
  const ambiguous = (context.documentedOptions?.length ?? 0) > 0;

  // Ambiguity and a weak match are worth saying whatever else is true: both
  // mean something *was* found and somebody has to confirm it.
  if (ambiguous) return 'ambiguous';
  if (weak) return 'weak';

  const nothingConnected =
    context.status.documentation.mode === 'skipped' && context.status.network.mode === 'skipped';
  // Nothing to match against is not a failure to match. There is no name
  // that would have worked, and the panel already says why.
  if (nothingConnected) return 'none';

  const nothing = !context.documented && !context.networkSite && !context.networkSites?.length;
  if (nothing) return 'no-match';

  return 'matched';
}
