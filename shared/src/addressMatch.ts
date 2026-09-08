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
 * Apostrophes are removed rather than split on.
 *
 * `Megan's` split on punctuation gives `megan` and `s`, and that orphan `s`
 * can never match anything -- a one-character token has to match a whole
 * word, and no address contains the word "s". So every search for a
 * possessive name failed to match completely and fell back to guesswork.
 * Removing the apostrophe first gives `megans`, and doing the same to the
 * address means `Megans` and `Megan's` match each other in both directions.
 *
 * Both straight and curly apostrophes, because a name typed on a phone and
 * the same name in AddressBase rarely agree about which one to use.
 */
const deapostrophe = (value: string): string => value.replace(/['\u2018\u2019\u02BC]/g, '');

/**
 * Splits what the person typed into tokens worth matching.
 *
 * Punctuation goes -- commas especially, since `13 Hill St, Richmond` is how
 * people actually type an address -- and so do filler words, which would
 * otherwise be impossible to satisfy and would sink every result to a partial
 * match.
 *
 * Single characters go too. They carry no signal on their own and, being
 * matched whole, are usually impossible to satisfy.
 */
export function tokeniseQuery(query: string): string[] {
  return deapostrophe(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !NOISE.has(t));
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
  return deapostrophe(
    parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' '),
  )
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
    // And the other direction, by one character only: someone typing
    // `Maru's Mayfair` produces `marus`, which is not a prefix of the
    // `Maru` in the address. A possessive or a plural the address does not
    // carry should not lose the match. One character, so `richmond` still
    // cannot match `richmon`.
    if (words.some((w) => w.length >= 3 && candidate.startsWith(w) && candidate.length - w.length <= 1)) {
      return true;
    }
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

/* ------------------------------------------------------------------ *
 * Is this the same premises?
 * ------------------------------------------------------------------ */

/** Words that name a kind of unit rather than identify one. */
const UNIT_WORDS = new Set([
  'flat',
  'apartment',
  'apt',
  'unit',
  'room',
  'suite',
  'floor',
  'the',
  'no',
  'number',
]);

/**
 * What distinguishes one unit within a building.
 *
 * Single characters are kept here, unlike the general tokeniser: in
 * "Flat 1" the `1` is the whole point. Generic words are dropped so the
 * comparison is between `1` and `2` rather than between two strings that
 * both contain "flat".
 */
function unitKey(value?: string): string[] {
  return deapostrophe(value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !UNIT_WORDS.has(w));
}

/**
 * Whether two address records describe the same doorstep.
 *
 * This exists because a real line went missing. Willow Estate Agents have an
 * Openreach fibre circuit through Zen, and the site report said "No lines
 * found" -- because the only fallback for matching a line to a premises was
 * exact string equality on the whole formatted address. Zen's address for a
 * service and OS Places' address for the same building are never byte
 * identical: OS carry the organisation name and Zen do not, capitalisation
 * differs, and street types are abbreviated on one side and not the other.
 * So the comparison could only ever succeed by accident.
 *
 * The order below is deliberate. Postcode is a gate, not a score: two
 * different postcodes are two different premises, always. Within a postcode
 * the building number is the strongest signal, and where a number is absent
 * on both sides the building name stands in. The street is checked only to
 * separate the rare case of the same number on two streets sharing one
 * postcode.
 *
 * Where a field is missing on one side it is not held against the match --
 * Zen routinely omit a flat number that AddressBase carries -- but a field
 * present on both and disagreeing is decisive.
 */
export function samePremises(a: AddressRecord, b: AddressRecord): boolean {
  // A UPRN on both sides settles it outright.
  if (a.uprn && b.uprn) return a.uprn === b.uprn;

  const postcode = (v?: string): string => (v ?? '').replace(/\s+/g, '').toUpperCase();
  const pcA = postcode(a.postcode);
  const pcB = postcode(b.postcode);
  // Without a postcode on both sides there is not enough to be sure.
  if (!pcA || !pcB || pcA !== pcB) return false;

  const numberOf = (r: AddressRecord): string =>
    (r.buildingNumber ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const numA = numberOf(a);
  const numB = numberOf(b);
  if (numA && numB && numA !== numB) return false;

  const words = (v?: string): string[] =>
    deapostrophe(v ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1);

  // Sub-building: a flat number both sides carry must agree, or two flats in
  // one block read as the same premises and a neighbour's circuit lands on
  // the report.
  //
  // Compared on what distinguishes the unit, not the whole string. "Flat 1"
  // and "Flat 2" share the word "flat", so a plain word-overlap test passes
  // them -- and dropping single characters, as the general tokeniser does,
  // throws away the only part that matters.
  const subA = unitKey(a.subBuilding);
  const subB = unitKey(b.subBuilding);
  if (subA.length && subB.length && !subA.some((w) => subB.includes(w))) return false;

  // Street, where both name one. Synonyms so `Rd` and `Road` agree.
  const streetA = a.thoroughfare ?? a.dependentThoroughfare;
  const streetB = b.thoroughfare ?? b.dependentThoroughfare;
  if (streetA && streetB) {
    const bWords = words(streetB);
    const shared = words(streetA).some((w) => tokenMatches(w, bWords));
    if (!shared) return false;
  }

  // With a number agreeing on both sides, and postcode and street already
  // checked, this is the same doorstep.
  if (numA && numB) return true;

  // No number to go on: fall back to the building name sharing a word.
  const nameA = [...words(a.buildingName), ...words(a.organisation)];
  const nameB = [...words(b.buildingName), ...words(b.organisation)];
  if (nameA.length && nameB.length) return nameA.some((w) => nameB.includes(w));

  // One side is a bare street and postcode. That is not enough to claim a
  // premises match, and claiming it would put a neighbour's circuit on the
  // report.
  return false;
}
