import type { AddressRecord } from './types';

/**
 * Which unit did they mean?
 *
 * The problem, in one sentence: somebody types "Market Halls, Oxford
 * Street", the address search returns the door number, and the customer is
 * actually in Unit 4 on the second floor. Every lookup after that — the
 * UPRN, the lines, the availability — is about the wrong premises, and
 * nothing says so because a plausible answer came back.
 *
 * Buildings in the UK are routinely one street address and forty premises:
 * a market hall, an office block, a shopping centre, a converted mill. The
 * postcode is shared, the thoroughfare is shared, and the only thing that
 * separates them is the sub-building — which is exactly the part somebody
 * leaves out when they type.
 *
 * So: where a query resolves to several premises that differ only in their
 * sub-building or organisation, ask. Where it resolves to one, or to several
 * that differ in something the person did type, do not — a confirmation
 * nobody needed is a confirmation they learn to click through.
 */

/** What distinguishes a set of candidates from each other. */
export type UnitDistinction = 'sub-building' | 'organisation' | 'number' | 'street' | 'mixed' | 'none';

const clean = (value: string | undefined): string => (value ?? '').trim();
const lower = (value: string | undefined): string => clean(value).toLowerCase();

/** The part of the address that names a unit within a building. */
export function unitLabel(address: AddressRecord): string | undefined {
  const sub = clean(address.subBuilding);
  const org = clean(address.organisation);
  if (sub && org) return `${sub} — ${org}`;
  return sub || org || undefined;
}

/**
 * Do these all sit at the same street address?
 *
 * The precondition for asking about units at all. Two premises on different
 * streets are a different question — that is an ambiguous search, not a
 * building with units in it, and the existing address picker already handles
 * it better than a unit prompt would.
 */
export function shareStreetAddress(addresses: readonly AddressRecord[]): boolean {
  if (addresses.length < 2) return false;
  const first = addresses[0]!;
  const key = (a: AddressRecord): string =>
    [lower(a.postcode).replace(/\s+/g, ''), lower(a.thoroughfare), lower(a.buildingNumber), lower(a.buildingName)].join('|');
  const wanted = key(first);
  return addresses.every((a) => key(a) === wanted);
}

/** What actually differs between the candidates. */
export function distinguishedBy(addresses: readonly AddressRecord[]): UnitDistinction {
  if (addresses.length < 2) return 'none';

  const differs = (get: (a: AddressRecord) => string): boolean =>
    new Set(addresses.map((a) => lower(get(a) as unknown as string | undefined))).size > 1;

  const sub = differs((a) => a.subBuilding ?? '');
  const org = differs((a) => a.organisation ?? '');
  const number = differs((a) => a.buildingNumber ?? '');
  const street = differs((a) => a.thoroughfare ?? '');

  if (street) return 'street';
  if (number) return 'number';
  if (sub && org) return 'mixed';
  if (sub) return 'sub-building';
  if (org) return 'organisation';
  return 'none';
}

export interface UnitQuestion {
  /** Whether to ask at all. */
  ask: boolean;
  /** The question, phrased for what actually differs. */
  question?: string;
  /** Why this is being asked, so it does not read as an error. */
  because?: string;
  /** The candidates, each with the label that tells them apart. */
  options?: Array<{ address: AddressRecord; label: string }>;
  distinction: UnitDistinction;
}

/**
 * How many candidates is worth a question rather than a list.
 *
 * Above this the address picker is the better tool: forty radio buttons is
 * not a question, it is a list, and the picker already sorts and filters.
 */
export const MAX_UNIT_OPTIONS = 12;

/**
 * Whether to ask which unit, and how to phrase it.
 *
 * The phrasing matters more than it looks. "Which unit?" is right for a
 * market hall and wrong for two floors of an office, and asking "which door
 * number?" when the person typed the door number reads as though the search
 * did not work.
 */
export function unitQuestion(input: {
  addresses: readonly AddressRecord[];
  /** What the person typed, so a part they supplied is not asked about. */
  query?: string;
}): UnitQuestion {
  const addresses = input.addresses;
  const distinction = distinguishedBy(addresses);

  if (addresses.length < 2) return { ask: false, distinction: 'none' };
  if (addresses.length > MAX_UNIT_OPTIONS) return { ask: false, distinction };

  // Different streets or different door numbers is an ambiguous search, not
  // a building with units. The address picker handles that better.
  if (distinction === 'street' || distinction === 'number' || distinction === 'none') {
    return { ask: false, distinction };
  }
  if (!shareStreetAddress(addresses)) return { ask: false, distinction };

  // If they typed something that already names the unit, they have answered
  // it and being asked again is the search failing to listen.
  const typed = lower(input.query);
  if (typed) {
    const named = addresses.filter((a) => {
      const label = lower(unitLabel(a));
      return label ? typed.includes(label) : false;
    });
    if (named.length === 1) return { ask: false, distinction };
  }

  const options = addresses
    .map((a) => ({ address: a, label: unitLabel(a) ?? a.singleLine }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  const where = clean(addresses[0]!.buildingName) || clean(addresses[0]!.thoroughfare) || 'this address';

  const question =
    distinction === 'organisation'
      ? `Which business at ${where}?`
      : `Which unit at ${where}?`;

  return {
    ask: true,
    question,
    because:
      `${addresses.length} premises share this street address. Picking the wrong one means every lookup after ` +
      'it — the UPRN, the lines, the availability — is about the wrong place, and nothing would say so.',
    options,
    distinction,
  };
}

/**
 * The candidate a typed answer refers to, or nothing.
 *
 * Matched on the label rather than an index, so a stale list cannot select
 * the wrong premises — the failure mode where somebody's answer arrives
 * after the candidates were re-fetched in a different order.
 */
export function resolveUnitAnswer(
  question: UnitQuestion,
  answer: string,
): AddressRecord | undefined {
  const wanted = lower(answer);
  if (!wanted || !question.options) return undefined;
  const exact = question.options.find((o) => lower(o.label) === wanted);
  if (exact) return exact.address;
  const contains = question.options.filter((o) => lower(o.label).includes(wanted));
  return contains.length === 1 ? contains[0]!.address : undefined;
}
