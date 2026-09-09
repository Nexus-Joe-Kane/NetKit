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
/**
 * A UK postcode anywhere in a string, so it can be lifted out before the rest
 * of a formatted address is read as a name and a street.
 */
const POSTCODE_IN_TEXT = /([A-PR-UWYZ][A-HK-Y]?[0-9][0-9A-HJKPSTUW]?\s*[0-9][ABD-HJLNP-UW-Z]{2})/i;

/** The first standalone house number in a string: `45`, `12a`, `45-47`. */
function firstNumber(text: string): string {
  const m = /(?:^|[\s,])(\d+)\s*(?:-\s*\d+)?([a-z])?(?=$|[\s,])/i.exec(text);
  if (!m) return '';
  return `${m[1]}${(m[2] ?? '').toUpperCase()}`;
}

/**
 * What a premises comparison actually needs, read from the structured fields
 * where a provider gave them and parsed out of the formatted line where it
 * did not.
 *
 * The parsing half exists because of a real missing circuit. Some suppliers
 * hand back an address as one string and nothing else -- no building number,
 * no thoroughfare, sometimes not even an organisation -- so a comparison that
 * only ever looked at the structured fields had nothing on one side to
 * compare and gave up, which read on the report as "no lines found" at a
 * premises we demonstrably supply.
 *
 * Parsing a formatted address is guesswork in general. It is not guesswork
 * here, because it is only ever used to answer "is this the same doorstep as
 * that one", where the postcode is already known to agree and a wrong guess
 * has to survive the number, the unit and the street as well.
 */
interface PremisesFacts {
  postcode: string;
  /** House number, uppercased, suffix kept: `45`, `12A`. */
  number: string;
  /** What distinguishes a unit inside the building. */
  unit: string[];
  streetWords: string[];
  nameWords: string[];
}

function plainWords(value?: string): string[] {
  return deapostrophe(value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

export function premisesFacts(r: AddressRecord): PremisesFacts {
  const postcode = (r.postcode ?? '').replace(/\s+/g, '').toUpperCase();
  const street = r.thoroughfare ?? r.dependentThoroughfare;
  const structuredNumber = (r.buildingNumber ?? '').trim().toUpperCase().replace(/\s+/g, '');

  const facts: PremisesFacts = {
    postcode,
    number: structuredNumber,
    unit: unitKey(r.subBuilding),
    streetWords: plainWords(street),
    nameWords: [...plainWords(r.buildingName), ...plainWords(r.organisation)],
  };

  // Enough to work with already.
  if (facts.number && facts.streetWords.length) return facts;

  // Fall back to the formatted line. Postcode out first so `SE23` is not read
  // as a house number, and the post town dropped from the tail so a town does
  // not become part of the street it is not.
  const line = (r.singleLine ?? '').replace(POSTCODE_IN_TEXT, ' ');
  const town = (r.postTown ?? '').trim();
  const withoutTown = town
    ? line.replace(new RegExp(`(^|[\\s,])${town.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s,]|$)`, 'gi'), ' ')
    : line;

  if (!facts.number) facts.number = firstNumber(withoutTown);

  if (facts.number) {
    // Split the line at the number: what comes before names the premises,
    // what comes after names the street.
    const at = withoutTown.search(new RegExp(`(?:^|[\\s,])${facts.number.replace(/([A-Z])$/, '\\s*$1?')}(?=$|[\\s,])`, 'i'));
    if (at >= 0) {
      const before = withoutTown.slice(0, at);
      const after = withoutTown.slice(at).replace(/^[\s,]*\S+/, '');
      if (!facts.streetWords.length) facts.streetWords = plainWords(after);
      if (!facts.nameWords.length) facts.nameWords = plainWords(before);
    }
  } else if (!facts.nameWords.length) {
    // No number at all: the whole line, less the street where one is known,
    // is the best name we have.
    const known = new Set(facts.streetWords);
    facts.nameWords = plainWords(withoutTown).filter((w) => !known.has(w));
  }

  return facts;
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
  // A UPRN on both sides settles it outright -- when they agree.
  //
  // A disagreement used to settle it too, and that was wrong. A supplier
  // carries whatever UPRN it was handed at order time, which is routinely the
  // parent shell record for a building whose units are the real addresses, or
  // a record AddressBase has since superseded and replaced. Reading a
  // mismatch as proof of two different premises threw away a live circuit at
  // the right doorstep. A mismatch now falls through to the address
  // comparison, which is strict on its own account: the same postcode, the
  // same building number, the same street, and no disagreeing flat number.
  if (a.uprn && b.uprn && a.uprn === b.uprn) return true;

  const fa = premisesFacts(a);
  const fb = premisesFacts(b);

  // Without a postcode on both sides there is not enough to be sure.
  if (!fa.postcode || !fb.postcode || fa.postcode !== fb.postcode) return false;

  if (fa.number && fb.number && fa.number !== fb.number) return false;

  // Sub-building: a flat number both sides carry must agree, or two flats in
  // one block read as the same premises and a neighbour's circuit lands on
  // the report.
  //
  // Compared on what distinguishes the unit, not the whole string. "Flat 1"
  // and "Flat 2" share the word "flat", so a plain word-overlap test passes
  // them -- and dropping single characters, as the general tokeniser does,
  // throws away the only part that matters.
  if (fa.unit.length && fb.unit.length && !fa.unit.some((w) => fb.unit.includes(w))) return false;

  // Street, where both name one. Synonyms so `Rd` and `Road` agree.
  if (fa.streetWords.length && fb.streetWords.length) {
    if (!fa.streetWords.some((w) => tokenMatches(w, fb.streetWords))) return false;
  }

  // With a number agreeing on both sides, and postcode and street already
  // checked, this is the same doorstep.
  if (fa.number && fb.number) return true;

  // No number to go on: fall back to the premises name sharing a word.
  if (fa.nameWords.length && fb.nameWords.length) {
    return fa.nameWords.some((w) => tokenMatches(w, fb.nameWords));
  }

  // One side is a bare street and postcode. That is not enough to claim a
  // premises match, and claiming it would put a neighbour's circuit on the
  // report.
  return false;
}
