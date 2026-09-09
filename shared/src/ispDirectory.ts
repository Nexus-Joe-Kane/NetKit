/**
 * Who provides the line, and who to ring about it.
 *
 * The gap this fills: a site whose connectivity we do not supply still shows
 * up on the console, and when it goes down the engineer needs the provider's
 * name, their support number and their portal — none of which is anywhere in
 * our systems, because the line is not ours.
 *
 * Two decisions worth stating.
 *
 * No support phone numbers are shipped. A wrong number that an engineer
 * dials while a customer is down is worse than no number, and support lines
 * change without announcement. So the directory ships identity — name, brand
 * colour, the provider's own domain — and the contact details are entered
 * once in the portal and shared by everybody. What is guessed is nothing.
 *
 * And an unknown provider is a first-class case. "Elevate" is not in any
 * list I could ship, and the honest answer is the name the console reported,
 * a neutral mark, and somewhere to put the details when somebody finds them.
 */

export interface IspEntry {
  key: string;
  name: string;
  /** The provider's own domain, which is stable where deep links are not. */
  domain?: string;
  /**
   * Brand colour, for the mark next to the name.
   *
   * Not decoration: an engineer scanning six WANs picks the one they are
   * looking for by colour before they read the word.
   */
  colour: string;
  /** What a supplier field elsewhere might call them. */
  aka: readonly string[];
}

/**
 * The ones seen often enough to be worth recognising.
 *
 * Deliberately short. A directory of two hundred alt-nets would be mostly
 * wrong within a year, and the unknown-provider path is good enough that
 * being absent from this list costs almost nothing.
 */
export const ISP_DIRECTORY: readonly IspEntry[] = [
  { key: 'bt', name: 'BT', domain: 'bt.com', colour: '#5514b4', aka: ['bt', 'bt business', 'british telecommunications'] },
  { key: 'openreach', name: 'Openreach', domain: 'openreach.com', colour: '#00a1de', aka: ['openreach', 'bt wholesale'] },
  {
    key: 'virgin-media',
    name: 'Virgin Media',
    domain: 'virginmediabusiness.co.uk',
    colour: '#cc0000',
    aka: ['virgin', 'virgin media', 'virgin media business', 'virgin media o2', 'vmo2'],
  },
  { key: 'g-network', name: 'G.Network', domain: 'g.network', colour: '#00b0b9', aka: ['g.network', 'g network', 'gnetwork'] },
  { key: 'zen', name: 'Zen Internet', domain: 'zen.co.uk', colour: '#e30613', aka: ['zen', 'zen internet'] },
  /*
   * Daisy and Giacom are the same wholesaler under two names -- Daisy
   * Broadband is what Giacom used to be called, and both are still in use on
   * the desk. One entry with both aliases, so a line filed under either
   * finds the same provider and the dashboard does not show two columns for
   * one supplier.
   */
  {
    key: 'giacom',
    name: 'Giacom',
    domain: 'giacom.com',
    colour: '#7a3ff2',
    aka: ['giacom', 'cloud market', 'cloudmarket', 'daisy', 'daisy broadband', 'daisy communications'],
  },
  { key: 'ee', name: 'EE', domain: 'ee.co.uk', colour: '#007b85', aka: ['ee', 'everything everywhere'] },
  { key: 'three', name: 'Three', domain: 'three.co.uk', colour: '#000000', aka: ['three', 'three uk', 'h3g'] },
  { key: 'o2', name: 'O2', domain: 'o2.co.uk', colour: '#0019a5', aka: ['o2', 'o2 uk', 'telefonica'] },
  { key: 'vodafone', name: 'Vodafone', domain: 'vodafone.co.uk', colour: '#e60000', aka: ['vodafone', 'vodafone uk'] },
  { key: 'sky', name: 'Sky', domain: 'business.sky.com', colour: '#0072c9', aka: ['sky', 'sky broadband', 'sky business'] },
  { key: 'talktalk', name: 'TalkTalk', domain: 'talktalkbusiness.co.uk', colour: '#7c2e8c', aka: ['talktalk', 'talk talk'] },
  { key: 'cityfibre', name: 'CityFibre', domain: 'cityfibre.com', colour: '#e4002b', aka: ['cityfibre', 'city fibre'] },
  { key: 'community-fibre', name: 'Community Fibre', domain: 'communityfibre.co.uk', colour: '#00c1d5', aka: ['community fibre'] },
  { key: 'hyperoptic', name: 'Hyperoptic', domain: 'hyperoptic.com', colour: '#ff5000', aka: ['hyperoptic', 'hyper optic'] },
  { key: 'colt', name: 'Colt', domain: 'colt.net', colour: '#00857d', aka: ['colt', 'colt technology'] },
  { key: 'gamma', name: 'Gamma', domain: 'gamma.co.uk', colour: '#00b0f0', aka: ['gamma', 'gamma telecom'] },
];

/** The colour an unrecognised provider gets: house grey, not a random hue. */
export const UNKNOWN_ISP_COLOUR = '#6b7a90';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The provider a name refers to, or nothing.
 *
 * Whole-phrase matching, not `includes`. Substring matching on names this
 * short is a trap this codebase has fallen into before: `'3'` sits inside
 * `'EE 3G'`, `'o2'` inside `'moto2'`, `'bt'` inside `'debt'`, and `'sky'`
 * inside `'Skyline Networks'`.
 */
export function ispFor(name: string | undefined): IspEntry | undefined {
  const needle = (name ?? '').trim().toLowerCase();
  if (!needle) return undefined;

  for (const entry of ISP_DIRECTORY) {
    if (entry.key === needle || entry.aka.includes(needle)) return entry;
  }

  // Longest alias first, so "virgin media business" beats "virgin".
  const candidates = ISP_DIRECTORY.flatMap((entry) => entry.aka.map((alias) => ({ entry, alias }))).sort(
    (a, b) => b.alias.length - a.alias.length,
  );
  for (const { entry, alias } of candidates) {
    if (new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}([^a-z0-9]|$)`, 'i').test(needle)) return entry;
  }
  return undefined;
}

/**
 * Up to two letters for the mark, from the words that carry meaning.
 *
 * `G.Network` gives `GN`, `Community Fibre` gives `CF`, `Elevate` gives `EL`
 * — a single-word name reads better as two letters than as one.
 */
const NOISE = /^(the|ltd|limited|plc|uk|group|business|networks?|telecom(?:s)?)$/i;

export function ispMonogram(name: string): string {
  const all = name
    .replace(/[^\p{L}\p{N}\s.]/gu, ' ')
    .split(/[\s.]+/)
    .filter(Boolean);
  const meaningful = all.filter((w) => !NOISE.test(w));

  /*
   * Prefer the words that carry meaning, but never let the filter produce a
   * one-letter mark when the full name has more to give. `G.Network` filters
   * down to `G`, which reads as a rendering bug rather than as a brand;
   * `Gamma Telecom` filters down to `Gamma`, which is right.
   */
  const source =
    meaningful.length >= 2
      ? meaningful
      : meaningful.length === 1 && meaningful[0]!.length >= 2
        ? meaningful
        : all.length >= 2
          ? all
          : meaningful.length
            ? meaningful
            : [name.trim() || '?'];

  if (source.length >= 2) return (source[0]![0]! + source[1]![0]!).toUpperCase();
  return (source[0] ?? '?').slice(0, 2).toUpperCase();
}

/** Identity for any provider name, recognised or not. */
export function ispIdentity(name: string | undefined): {
  name: string;
  colour: string;
  monogram: string;
  domain?: string;
  known: boolean;
} {
  const trimmed = (name ?? '').trim();
  const entry = ispFor(trimmed);
  if (entry) {
    return {
      name: entry.name,
      colour: entry.colour,
      monogram: ispMonogram(entry.name),
      ...(entry.domain ? { domain: entry.domain } : {}),
      known: true,
    };
  }
  const display = trimmed || 'Provider not reported';
  return { name: display, colour: UNKNOWN_ISP_COLOUR, monogram: ispMonogram(display), known: false };
}

/* ------------------------------------------------------------------ *
 * Contact details, entered rather than guessed
 * ------------------------------------------------------------------ */

/**
 * What somebody has filled in about how to reach a provider.
 *
 * Shared across the desk on purpose: whoever finds the right number for a
 * small alt-net at eight in the morning should be the last person who has to
 * find it.
 */
export interface IspContact {
  /** Matches `ispFor(...).key`, or a normalised name for an unknown one. */
  key: string;
  /** The name as it will be shown, for a provider not in the directory. */
  name?: string;
  supportPhone?: string;
  supportEmail?: string;
  /** Their portal, ticket system or status page. */
  supportUrl?: string;
  /** Our account or reference with them, which is what they ask for first. */
  accountRef?: string;
  notes?: string;
  updatedAt?: string;
  updatedBy?: string;
}

/** The key a contact is filed under, recognised provider or not. */
export function ispContactKey(name: string | undefined): string {
  const entry = ispFor(name);
  if (entry) return entry.key;
  return (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

/** True where there is actually something an engineer could use. */
export function hasUsableContact(contact: IspContact | undefined): boolean {
  if (!contact) return false;
  return Boolean(contact.supportPhone || contact.supportEmail || contact.supportUrl);
}
