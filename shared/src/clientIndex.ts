import { clientKey, clientTokens } from './siteMatch';

/**
 * A local index of who our customers are and where.
 *
 * The problem it solves: the suppliers' service searches match a reference, a
 * postcode or a phone number, and never a customer name. So searching
 * "willow" could find their building in AddressBase and their SIMs in the
 * mobile estate, but never their circuits — which is the thing an engineer
 * with a client on the phone actually wants.
 *
 * Rather than asking five suppliers per keystroke, the client list is pulled
 * once, kept in a small file, and searched locally. Typing a name searches
 * that file — no network at all — and picking a client substitutes the
 * postcode or UPRN behind it, which is something the suppliers *can* search
 * for. The API call that goes out is the same one as before; it just no
 * longer has to be a guess.
 *
 * Sources contribute what they can list. IT Glue is the best of them, being
 * organisations with locations and postcodes. Jola gives customers with their
 * SIMs' sites. Zendesk gives names, which are the join key even without an
 * address. Zen and Giacom cannot be listed by customer at all, so they fill
 * in from ordinary use: every premises somebody looks up teaches the index
 * what is there.
 */

export interface ClientSite {
  name: string;
  postcode?: string;
  uprn?: string;
  /** A single-line address where a source held one. */
  address?: string;
}

export interface ClientIndexEntry {
  /** The merge key: the name with legal forms stripped. */
  key: string;
  /** The best display name seen for this client. */
  name: string;
  /** Other spellings, so a search matches whichever one somebody types. */
  aliases: string[];
  sites: ClientSite[];
  /** Supplier references seen against this client, searchable upstream. */
  serviceRefs: string[];
  /** Which systems know about them. */
  sources: string[];
  /** When a source last confirmed them. */
  seenAt: string;
}

export interface ClientIndexSourceStatus {
  ok: boolean;
  /** Clients this source contributed. */
  count: number;
  detail?: string;
  at: string;
}

export interface ClientIndexFile {
  version: 1;
  builtAt?: string;
  entries: ClientIndexEntry[];
  sources: Record<string, ClientIndexSourceStatus>;
  /**
   * What changed at the last rebuild.
   *
   * Kept because it is the interesting part of a daily refresh: a client
   * appearing is usually a new customer, and one disappearing is usually a
   * cancellation nobody mentioned.
   */
  lastChange?: { added: string[]; removed: string[]; at: string };
}

export const emptyClientIndex = (): ClientIndexFile => ({ version: 1, entries: [], sources: {} });

/** How old the index may get before it is worth rebuilding. */
export const CLIENT_INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const clientIndexStale = (file: ClientIndexFile, now: Date = new Date()): boolean => {
  if (!file.builtAt) return true;
  const built = new Date(file.builtAt).getTime();
  if (Number.isNaN(built)) return true;
  return now.getTime() - built >= CLIENT_INDEX_MAX_AGE_MS;
};

const norm = (value: string): string => value.trim().replace(/\s+/g, ' ');
const postcodeKey = (value?: string): string => (value ?? '').replace(/\s+/g, '').toUpperCase();

/** One contribution from one source, before merging. */
export interface ClientContribution {
  name: string;
  source: string;
  sites?: ClientSite[];
  serviceRefs?: string[];
  aliases?: string[];
}

/**
 * Folds a contribution into an entry.
 *
 * Names merge on the key rather than the string, so "Willow Estate Agents
 * Ltd" from IT Glue and "Willow Estate Agents" from Zendesk are one client
 * rather than two. The longer name wins the display slot on the reasoning
 * that it is the more complete one, and the other is kept as an alias so
 * searching either finds them.
 *
 * Sites deduplicate on postcode where there is one and on name where there
 * is not. Two sources describing the same shop should not produce two rows,
 * and a source with no postcode should not silently overwrite one that has.
 */
export function foldContribution(
  existing: ClientIndexEntry | undefined,
  contribution: ClientContribution,
  now: string,
): ClientIndexEntry {
  const name = norm(contribution.name);
  const key = clientKey(name);

  const entry: ClientIndexEntry = existing
    ? { ...existing, sites: [...existing.sites], aliases: [...existing.aliases], serviceRefs: [...existing.serviceRefs], sources: [...existing.sources] }
    : { key, name, aliases: [], sites: [], serviceRefs: [], sources: [], seenAt: now };

  if (name.length > entry.name.length) {
    if (entry.name && entry.name !== name && !entry.aliases.includes(entry.name)) entry.aliases.push(entry.name);
    entry.name = name;
  } else if (name && name !== entry.name && !entry.aliases.includes(name)) {
    entry.aliases.push(name);
  }

  for (const alias of contribution.aliases ?? []) {
    const cleaned = norm(alias);
    if (cleaned && cleaned !== entry.name && !entry.aliases.includes(cleaned)) entry.aliases.push(cleaned);
  }

  for (const site of contribution.sites ?? []) {
    const siteName = norm(site.name);
    const pc = postcodeKey(site.postcode);
    const match = entry.sites.find((s) =>
      pc ? postcodeKey(s.postcode) === pc : norm(s.name).toLowerCase() === siteName.toLowerCase(),
    );

    if (!match) {
      entry.sites.push({
        name: siteName || (site.postcode ?? 'Unnamed site'),
        ...(site.postcode ? { postcode: site.postcode } : {}),
        ...(site.uprn ? { uprn: site.uprn } : {}),
        ...(site.address ? { address: site.address } : {}),
      });
      continue;
    }

    // Fill gaps rather than overwrite: a source with a UPRN improves a row
    // that only had a postcode, and one with neither must not blank it.
    if (!match.postcode && site.postcode) match.postcode = site.postcode;
    if (!match.uprn && site.uprn) match.uprn = site.uprn;
    if (!match.address && site.address) match.address = site.address;
    if (siteName && match.name !== siteName && siteName.length > match.name.length) match.name = siteName;
  }

  for (const ref of contribution.serviceRefs ?? []) {
    const cleaned = norm(ref);
    if (cleaned && !entry.serviceRefs.includes(cleaned)) entry.serviceRefs.push(cleaned);
  }

  if (!entry.sources.includes(contribution.source)) entry.sources.push(contribution.source);
  entry.seenAt = now;
  return entry;
}

/**
 * Merges a whole set of contributions into an index.
 *
 * Returns the entries and what changed, because the change is the point of a
 * daily refresh — a client appearing is usually a new customer and one
 * disappearing is usually a cancellation nobody mentioned.
 *
 * Entries only known from ordinary use are kept rather than pruned: they were
 * never in a source list to begin with, so their absence from one is not
 * evidence of anything.
 */
export function buildIndex(
  previous: readonly ClientIndexEntry[],
  contributions: readonly ClientContribution[],
  now: string,
): { entries: ClientIndexEntry[]; added: string[]; removed: string[] } {
  const byKey = new Map<string, ClientIndexEntry>();

  // Learned entries survive a rebuild; listed ones are replaced by the list.
  for (const entry of previous) {
    if (entry.sources.length === 1 && entry.sources[0] === 'learned') byKey.set(entry.key, { ...entry });
  }

  for (const contribution of contributions) {
    const key = clientKey(contribution.name);
    if (!key) continue; // A name that is nothing but legal forms identifies nobody.
    byKey.set(key, foldContribution(byKey.get(key), contribution, now));
  }

  const entries = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  const before = new Set(previous.map((e) => e.key));
  const after = new Set(entries.map((e) => e.key));

  return {
    entries,
    added: entries.filter((e) => !before.has(e.key)).map((e) => e.name),
    removed: previous.filter((e) => !after.has(e.key)).map((e) => e.name),
  };
}

/* ------------------------------------------------------------------ *
 * Searching it
 * ------------------------------------------------------------------ */

const searchable = (entry: ClientIndexEntry): string =>
  [
    entry.name,
    ...entry.aliases,
    ...entry.sites.map((s) => [s.name, s.postcode, s.address].filter(Boolean).join(' ')),
    ...entry.serviceRefs,
  ]
    .join(' ')
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ');

/**
 * Clients matching what was typed.
 *
 * Every word has to appear somewhere in the entry, so a second word narrows.
 * A name match ranks above a site or reference match, because somebody typing
 * "willow" means the client and somebody typing "brockley" means the shop,
 * and putting the client first costs the second case one row.
 */
export function searchClients(
  entries: readonly ClientIndexEntry[],
  term: string,
  limit = 6,
): ClientIndexEntry[] {
  const wanted = clientTokens(term).length ? clientTokens(term) : tokenise(term);
  if (!wanted.length) return [];

  const scored: Array<{ entry: ClientIndexEntry; rank: number }> = [];
  for (const entry of entries) {
    const haystack = searchable(entry);
    if (!wanted.every((word) => haystack.includes(word))) continue;

    const nameText = [entry.name, ...entry.aliases].join(' ').toLowerCase();
    const inName = wanted.every((word) => nameText.includes(word));
    scored.push({ entry, rank: inName ? 0 : 1 });
  }

  /*
   * Within a rank, the entry you can actually do something with wins.
   *
   * Alphabetical alone put a client with no known address above the one with
   * three sites, which is the wrong way round: a row that cannot be looked
   * up is the last thing an engineer wants offered first.
   */
  return scored
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        lookupableSites(b.entry).length - lookupableSites(a.entry).length ||
        a.entry.name.localeCompare(b.entry.name),
    )
    .slice(0, limit)
    .map((s) => s.entry);
}

/** Words worth matching, keeping numbers a postcode or a reference needs. */
function tokenise(term: string): string[] {
  return term
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 1);
}

/**
 * What to send upstream for a site.
 *
 * A UPRN if there is one, because it is exact; otherwise the postcode, which
 * every supplier can search. Nothing where the site has neither — a site name
 * on its own is not something an API can be asked about, and pretending
 * otherwise would send a lookup that quietly finds nothing.
 */
export function siteIdentifier(site: ClientSite): { kind: 'uprn' | 'postcode'; value: string } | null {
  if (site.uprn) return { kind: 'uprn', value: site.uprn };
  if (site.postcode) return { kind: 'postcode', value: site.postcode };
  return null;
}

/**
 * The sites worth offering when a client is picked.
 *
 * Only those that can actually be looked up, ordered so the ones with a UPRN
 * come first. A client with exactly one is opened directly; more than one and
 * the engineer picks, because a company with twenty shops has twenty answers
 * and guessing one is worse than asking.
 */
export function lookupableSites(entry: ClientIndexEntry): ClientSite[] {
  return entry.sites
    .filter((site) => siteIdentifier(site) !== null)
    .sort((a, b) => Number(Boolean(b.uprn)) - Number(Boolean(a.uprn)) || a.name.localeCompare(b.name));
}
