/**
 * Are the suppliers having a bad morning?
 *
 * The first question when three sites go off within ten minutes of each
 * other, and the one that decides whether anybody bothers running tests: if
 * BT are down nationally then the tests will say what the status page already
 * said, and the useful work is telling the affected customers rather than
 * raising five faults that get closed as "known incident".
 *
 * Two deliberate limits.
 *
 * A supplier status is never evidence about one site. A national outage does
 * not prove this customer's fault is part of it, and a green status page does
 * not prove it is not — status pages lag, and a hundred customers on one
 * exchange is not a national event. So it is shown alongside a diagnosis and
 * never feeds into the attribution.
 *
 * And nothing here is load-bearing. The dashboard, the sweep and the
 * attribution all work with no status source configured at all. A decoration
 * that can take the outage board down with it is not a decoration.
 */

/** How a supplier's own view reads. */
export type ProviderState = 'ok' | 'degraded' | 'outage' | 'unknown';

/**
 * Which suppliers get a place on the dashboard.
 *
 * The ones whose bad morning is our bad morning: the two fixed-line
 * wholesalers everything runs over, the alt-nets we actually sell in London,
 * and the three mobile networks any 5G backup is on.
 *
 * `slug` is the identifier a status source knows them by; `aka` is what a
 * supplier field elsewhere in the portal might call them, so a circuit whose
 * supplier reads "Openreach (BT Wholesale)" still finds the right row.
 */
export interface MajorProvider {
  slug: string;
  name: string;
  kind: 'wholesale' | 'altnet' | 'isp' | 'mobile';
  aka: readonly string[];
}

export const MAJOR_PROVIDERS: readonly MajorProvider[] = [
  { slug: 'openreach', name: 'Openreach', kind: 'wholesale', aka: ['openreach', 'bt wholesale', 'bt openreach'] },
  { slug: 'bt', name: 'BT', kind: 'isp', aka: ['bt', 'bt business', 'british telecom'] },
  { slug: 'virgin-media', name: 'Virgin Media', kind: 'isp', aka: ['virgin', 'virgin media', 'virgin media business', 'vmo2'] },
  { slug: 'g-network', name: 'G.Network', kind: 'altnet', aka: ['g.network', 'g network', 'gnetwork'] },
  // Daisy Broadband is Giacom's former name; both are still used on the desk.
  {
    slug: 'giacom',
    name: 'Giacom',
    kind: 'wholesale',
    aka: ['giacom', 'cloud market', 'daisy', 'daisy broadband'],
  },
  { slug: 'zen', name: 'Zen Internet', kind: 'isp', aka: ['zen', 'zen internet'] },
  { slug: 'ee', name: 'EE', kind: 'mobile', aka: ['ee', 'everything everywhere', 'bt mobile'] },
  { slug: 'three', name: 'Three', kind: 'mobile', aka: ['three', 'three uk', '3', 'h3g'] },
  { slug: 'o2', name: 'O2', kind: 'mobile', aka: ['o2', 'o2 uk', 'telefonica', 'giffgaff'] },
];

/**
 * The provider a name refers to, or nothing.
 *
 * Whole-token matching, not `includes`. Substring matching on names this
 * short is a trap that has bitten this codebase more than once: `'3'` is
 * inside `'EE 3G'`, `'o2'` is inside `'moto2'`, and `'bt'` is inside
 * `'debt collection'`.
 */
export function providerFor(name: string | undefined): MajorProvider | undefined {
  const needle = (name ?? '').trim().toLowerCase();
  if (!needle) return undefined;

  // An exact alias first, so "BT" finds BT and not Openreach.
  for (const provider of MAJOR_PROVIDERS) {
    if (provider.aka.includes(needle) || provider.slug === needle) return provider;
  }

  // Then an alias appearing as a whole phrase inside a longer name, longest
  // alias first so "bt wholesale" beats "bt".
  const candidates = MAJOR_PROVIDERS.flatMap((provider) => provider.aka.map((alias) => ({ provider, alias })))
    .sort((a, b) => b.alias.length - a.alias.length);

  for (const { provider, alias } of candidates) {
    const pattern = new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (pattern.test(needle)) return provider;
  }
  return undefined;
}

/**
 * The mobile network a SIM is on.
 *
 * Jola resell across all three, and the tariff name is usually the only
 * place the network appears — "Three 100GB Pooled", "EE Unlimited". So the
 * tariff, the network field and the APN all get a look.
 */
export function operatorForSim(sim: {
  network?: string;
  operator?: string;
  tariff?: string;
  apn?: string;
}): MajorProvider | undefined {
  return (
    providerFor(sim.network) ??
    providerFor(sim.operator) ??
    providerFor(sim.tariff) ??
    providerFor(sim.apn)
  );
}

/* ------------------------------------------------------------------ *
 * Reading a report count
 * ------------------------------------------------------------------ */

/**
 * Reports against the baseline, as a state.
 *
 * Absolute counts are meaningless across providers — BT's quiet afternoon is
 * more reports than G.Network's worst day — so it is always a multiple of
 * that provider's own normal.
 *
 * The multipliers are deliberately not tight. A status board that goes amber
 * every time a few more people than usual complain is a board people learn
 * to ignore, and the cost of missing a small blip is nil because the site
 * checks catch it anyway.
 */
export const DEGRADED_MULTIPLE = 2.5;
export const OUTAGE_MULTIPLE = 6;

/** Below this, a multiple means nothing — three reports against a baseline of one. */
export const MIN_REPORTS = 25;

export function stateFromReports(reports: number | undefined, baseline: number | undefined): ProviderState {
  if (reports === undefined || !Number.isFinite(reports)) return 'unknown';
  if (reports < MIN_REPORTS) return 'ok';
  if (baseline === undefined || !Number.isFinite(baseline) || baseline <= 0) {
    // No baseline to compare against. A raw count cannot be graded, and
    // guessing a threshold per provider is worse than saying so.
    return 'unknown';
  }
  const multiple = reports / baseline;
  if (multiple >= OUTAGE_MULTIPLE) return 'outage';
  if (multiple >= DEGRADED_MULTIPLE) return 'degraded';
  return 'ok';
}

const STATE_LABEL: Record<ProviderState, string> = {
  ok: 'No problems reported',
  degraded: 'Some problems reported',
  outage: 'Widespread problems',
  unknown: 'Not known',
};

export const providerStateLabel = (state: ProviderState): string => STATE_LABEL[state];

/** Worst first, then alphabetically, so the dashboard strip reads itself. */
export function sortByTrouble<T extends { state: ProviderState; provider: string }>(rows: readonly T[]): T[] {
  const rank: Record<ProviderState, number> = { outage: 0, degraded: 1, unknown: 2, ok: 3 };
  return [...rows].sort((a, b) => rank[a.state] - rank[b.state] || a.provider.localeCompare(b.provider));
}

/**
 * Is anything bad enough to say so on the dashboard?
 *
 * Used to decide whether the strip gets a headline or stays a quiet row of
 * green. "Everything is fine" does not need a headline.
 */
export function troubleHeadline(rows: readonly { state: ProviderState; provider: string }[]): string | undefined {
  const out = rows.filter((r) => r.state === 'outage').map((r) => r.provider);
  const degraded = rows.filter((r) => r.state === 'degraded').map((r) => r.provider);
  if (out.length) {
    return `${out.join(', ')} ${out.length === 1 ? 'is' : 'are'} reporting widespread problems.`;
  }
  if (degraded.length) {
    return `${degraded.join(', ')} ${degraded.length === 1 ? 'is' : 'are'} seeing more reports than usual.`;
  }
  return undefined;
}
