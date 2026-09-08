import type { AddressRecord } from './types';

/**
 * Ranking free-text address searches against what the provider returned.
 *
 * OS Places `/find` is a fuzzy search: it scores the query as a whole and is
 * happy to return a strong match on one word while ignoring the rest. Searching
 * `megans richmond` came back with Megans in Wimbledon, Lincomb, Chiswick and
 * Lurgan -- every one a good match for "megans" and none of them in Richmond.
 *
 * So the provider's order is treated as a candidate list, not an answer. Every
 * token the person typed has to be accounted for somewhere in the address, and
 * results that account for all of them come first. Nobody types a second word
 * hoping for fewer constraints.
 */

/** Street-type abbreviations, so `13 hill st` matches `13 Hill Street`. */
const SYNONYMS: Record<string, string[]> = {
  st: ['street', 'saint'],
  str: ['street'],
  rd: ['road'],
  ave: ['avenue'],
  av: ['avenue'],
  ln: ['lane'],
  cl: ['close'],
  dr: ['drive'],
  ct: ['court'],
  pl: ['place'],
  sq: ['square'],
  cres: ['crescent'],
  gdns: ['gardens'],
  gdn: ['garden'],
  pk: ['park'],
  ter: ['terrace'],
  bldg: ['building'],
  blvd: ['boulevard'],
  hse: ['house'],
  pde: ['parade'],
  wy: ['way'],
  yd: ['yard'],
  mt: ['mount'],
  gr: ['grove'],
  gt: ['great'],
  ind: ['industrial'],
  est: ['estate'],
  biz: ['business'],
  // The other direction, so typing the full word still matches an
  // abbreviation the address itself uses.
  street: ['st'],
  road: ['rd'],
  avenue: ['ave', 'av'],
  saint: ['st'],
};

/** Words that carry no distinguishing information in a UK address. */
const NOISE = new Set(['the', 'of', 'and', 'at', 'in', 'on', 'to', 'nr', 'near']);

/**
 * Splits what the person typed into tokens worth matching.
 *
 * Punctuation goes -- commas especially, since `13 Hill St, Richmond` is how
 * people actually type an address -- and so do filler words, which would
 * otherwise be impossible to satisfy and would sink every result to a partial
 * match.
 */
export function tokeniseQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !NOISE.has(t));
}

/** Every word in the address, including postcode, locality and post town. */
export function addressWords(address: AddressRecord): string[] {
  const parts = [
    address.singleLine,
    address.organisation,
    address.subBuilding,
    address.buildingName,
    address.buildingNumber,
    address.dependentThoroughfare,
    address.thoroughfare,
    address.doubleDependentLocality,
    address.dependentLocality,
    address.postTown,
    address.postcode,
    address.county,
    address.localAuthority,
  ];
  return parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * Does one typed token appear in this address?
 *
 * Numbers are matched strictly: `13` must not be satisfied by `130`, or
 * searching for a house number would pull in the whole street. A trailing
 * letter is still allowed, because 13 and 13A are the same doorstep to
 * whoever is typing.
 *
 * Words are matched on prefix, which is what makes a search usable while
 * someone is still typing, and lets `richmond` match `Richmond upon Thames`.
 * Short words must match whole, since a two-letter prefix matches far too
 * much to mean anything.
 */
export function tokenMatches(token: string, words: string[]): boolean {
  const candidates = [token, ...(SYNONYMS[token] ?? [])];

  for (const candidate of candidates) {
    if (/^\d+$/.test(candidate)) {
      if (words.some((w) => w === candidate || new RegExp(`^${candidate}[a-z]$`).test(w))) return true;
      continue;
    }
    if (candidate.length <= 2) {
      if (words.some((w) => w === candidate)) return true;
      continue;
    }
    if (words.some((w) => w.startsWith(candidate))) return true;
  }
  return false;
}

export interface AddressQueryMatch {
  address: AddressRecord;
  /** How many of the typed tokens this address accounts for. */
  matched: number;
  /** True when it accounts for all of them. */
  complete: boolean;
}

/** Scores one address without reordering anything. */
export function matchAddress(address: AddressRecord, tokens: string[]): AddressQueryMatch {
  const words = addressWords(address);
  let matched = 0;
  for (const token of tokens) if (tokenMatches(token, words)) matched += 1;
  return { address, matched, complete: tokens.length > 0 && matched === tokens.length };
}

/**
 * Orders provider results by how completely they answer the query.
 *
 * Addresses accounting for every token come first, in the order the provider
 * gave them -- OS Places' own relevance is worth keeping within a tier, it is
 * only across tiers that it misleads. Partial matches follow, best first, so a
 * search that cannot be satisfied exactly degrades to "closest we have"
 * instead of an empty result.
 */
export function rankAddressMatches(addresses: AddressRecord[], query: string): AddressQueryMatch[] {
  const tokens = tokeniseQuery(query);
  if (tokens.length === 0) {
    return addresses.map((address) => ({ address, matched: 0, complete: false }));
  }

  const scored = addresses.map((address) => matchAddress(address, tokens));
  // A stable sort on match count alone: equal scores keep provider order.
  return scored
    .map((m, index) => ({ m, index }))
    .sort((a, b) => b.m.matched - a.m.matched || a.index - b.index)
    .map((x) => x.m);
}

/**
 * The list to show for a free-text search.
 *
 * When anything accounts for every token, only those are shown: a person who
 * typed a town does not want another town, and padding the list back up to
 * `limit` with near-misses is how `megans richmond` ended up showing Lurgan.
 */
export function rankAddresses(addresses: AddressRecord[], query: string, limit: number): AddressRecord[] {
  const ranked = rankAddressMatches(addresses, query);
  const complete = ranked.filter((m) => m.complete);
  const chosen = complete.length > 0 ? complete : ranked;
  return chosen.slice(0, limit).map((m) => m.address);
}
